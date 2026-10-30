import { renderTrail } from '../core/trail.js';
import { hostRunner } from './host-runner.js';
import { branchFor } from './names.js';
import { verdictAt } from './verify.js';

/** @typedef {import('./host-runner.js').Runner} Runner */

/**
 * What the evidence gate decided about one run.
 * @typedef {{
 *   pass: boolean,
 *   cancelled: boolean,
 *   commits: Array<{ sha: string, subject: string }>,
 *   testRun: { command: string, sha: string, counts: { pass: number|null, fail: number|null } | null } | null,
 * }} Verdict
 */

/**
 * Push the task's branch to GitHub and open its PR, or return the open PR that
 * already exists for that branch. Pushes the last commit the gate checked.
 * Refuses when the remote branch holds a commit this run did not make, or when
 * the branch already had a PR that is closed or merged.
 *
 * @param {{
 *   task: { id: string, title: string, repo: string, base: string, issue: number|null,
 *           playbook: string, status: string, cost: number, tokens_in: number, tokens_out: number },
 *   clone: { dir: string },
 *   verdict: Verdict,
 *   queue: { updateStatus(id: string, status: string, extra: object): object },
 *   trail?: import('../core/trail.js').TrailEntry[],
 *   run?: Runner,
 * }} opts
 * @returns {Promise<string>} the PR URL
 */
export async function publish({ task, clone, verdict, queue, trail = [], run = hostRunner }) {
  if (verdict.cancelled !== false) throw new Error(`task ${task.id}: refusing to publish a cancelled run`);
  if (verdict.pass !== true) throw new Error(`task ${task.id}: refusing to publish, the evidence gate did not pass`);
  if (!verdict.commits.length) throw new Error(`task ${task.id}: refusing to publish, no commits`);

  const branch = branchFor(task);
  const remote = `https://github.com/${task.repo}.git`;
  const sha = verdict.commits.at(-1).sha;

  const remoteSha = (await run('git', ['ls-remote', remote, `refs/heads/${branch}`], { cwd: clone.dir })).split('\t')[0];
  if (remoteSha && !verdict.commits.some((c) => c.sha === remoteSha)) {
    throw new Error(`task ${task.id}: refusing to publish, ${branch} on GitHub is at ${remoteSha.slice(0, 7)}, a commit this run did not make`);
  }
  const prs = JSON.parse(await run('gh', [
    'pr', 'list', '--repo', task.repo, '--head', branch, '--state', 'all', '--json', 'url,state',
  ]));
  const ended = prs.find((pr) => pr.state !== 'OPEN');
  if (ended) throw new Error(`task ${task.id}: refusing to publish, ${branch} already had ${ended.url} (${String(ended.state).toLowerCase()})`);

  if (remoteSha !== sha) {
    await run('git', ['push', `--force-with-lease=refs/heads/${branch}:${remoteSha}`, remote, `${sha}:refs/heads/${branch}`], { cwd: clone.dir });
  }
  const url = prs[0]?.url ?? (await run('gh', [
    'pr', 'create', '--repo', task.repo, '--base', task.base, '--head', branch,
    '--title', task.title, '--body', prBody(task, verdict, trail),
  ])).split('\n').at(-1).trim();

  queue.updateStatus(task.id, task.status, { pr_url: url });
  return url;
}

/**
 * Push a fix round's commits onto the task's own PR branch, which publish
 * created. A plain push, so it only fast-forwards from the previous round's
 * head: a branch someone else moved is refused, never overwritten.
 * @param {{ task: { id: string, repo: string, handle: string }, clone: { dir: string }, verdict: Verdict, branch: string, run?: Runner }} opts
 * @returns {Promise<string>} the sha now at the head of `branch`
 */
export async function pushFix({ task, clone, verdict, branch, run = hostRunner }) {
  if (verdict.cancelled !== false) throw new Error(`task ${task.id}: refusing to push a cancelled run`);
  if (verdict.pass !== true) throw new Error(`task ${task.id}: refusing to push, the evidence gate did not pass`);
  if (!verdict.commits.length) throw new Error(`task ${task.id}: refusing to push, no commits`);
  if (branch !== branchFor(task)) throw new Error(`task ${task.id}: refusing to push to ${branch}, not its branch ${branchFor(task)}`);
  const sha = verdict.commits.at(-1).sha;
  await run('git', ['push', `https://github.com/${task.repo}.git`, `${sha}:refs/heads/${branch}`], { cwd: clone.dir });
  return sha;
}

/**
 * Squash-merge the task's PR at the head a passing verification verdict covers,
 * or do nothing when it is already merged. AgentForge calls this only after the
 * operator approved the merge. Reads the PR head right before merging and passes
 * it to `--match-head-commit`, so a push in between makes GitHub refuse too.
 * Throws a MergeRefused when no passing verdict covers the current head:
 * `head-moved` when the head moved past the one AgentForge last knew, else `no-verdict`.
 * @param {{ url: string, verification: import('./verify.js').Verification|null, run?: Runner }} opts
 */
export async function merge({ url, verification, run = hostRunner }) {
  const { state, headRefOid: head } = JSON.parse(await run('gh', ['pr', 'view', url, '--json', 'state,headRefOid']));
  if (state === 'MERGED') return;
  if (state !== 'OPEN') throw new Error(`${url} is ${String(state).toLowerCase()}`);
  const verdict = verdictAt(verification, head);
  if (!verdict?.pass) {
    const moved = !verdict && verification?.head != null && verification.head !== head;
    const why = verdict ? `the verdict at ${head.slice(0, 7)} failed`
      : moved ? `the head moved from ${verification.head.slice(0, 7)} to ${head.slice(0, 7)} after verification`
        : `no verification verdict at ${head.slice(0, 7)}`;
    throw new MergeRefused(`refusing to merge ${url}: ${why}`, moved ? 'head-moved' : 'no-verdict', head);
  }
  await run('gh', ['pr', 'merge', url, '--squash', '--match-head-commit', head]);
}

/** Merge would land a head that no passing verdict covers. */
export class MergeRefused extends Error {
  /** @param {string} message @param {'head-moved'|'no-verdict'} reason @param {string} head */
  constructor(message, reason, head) {
    super(message);
    this.name = 'MergeRefused';
    this.reason = reason;
    this.head = head;
  }
}

const passSummary =(counts) => (counts?.pass != null ? `: ${counts.pass} passed, ${counts.fail ?? 0} failed` : '');

function prBody(task, verdict, trail) {
  const short = (sha) => sha.slice(0, 7);
  const { testRun } = verdict;
  return [
    ...(task.issue != null ? [`Closes #${task.issue}`, ''] : []),
    `AgentForge task \`${task.id}\` ran the \`${task.playbook}\` playbook.`,
    '',
    '## Commits',
    ...verdict.commits.map((c) => `- ${short(c.sha)} ${c.subject}`),
    '',
    '## Tests',
    testRun ? `\`${testRun.command}\` passed after ${short(testRun.sha)}${passSummary(testRun.counts)}.` : 'No test run recorded.',
    '',
    '## Cost',
    `$${(task.cost ?? 0).toFixed(2)}, ${task.tokens_in ?? 0} tokens in, ${task.tokens_out ?? 0} tokens out.`,
    '',
    ...(trail.length ? [renderTrail(trail), ''] : []),
    '---',
    `Opened by AgentForge for task \`${task.id}\`.`,
  ].join('\n');
}
