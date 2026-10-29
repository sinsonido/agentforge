import { renderTrail } from '../core/trail.js';
import { hostRunner } from './host-runner.js';

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
 * Push agentforge/<taskId> to GitHub and open its PR, or return the PR that
 * already exists for that branch. Pushes the last commit the gate checked.
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

  const branch = `agentforge/${task.id}`;
  const remote = `https://github.com/${task.repo}.git`;
  const sha = verdict.commits.at(-1).sha;

  const remoteSha = (await run('git', ['ls-remote', remote, `refs/heads/${branch}`], { cwd: clone.dir })).split('\t')[0];
  if (remoteSha !== sha) {
    await run('git', ['push', `--force-with-lease=refs/heads/${branch}:${remoteSha}`, remote, `${sha}:refs/heads/${branch}`], { cwd: clone.dir });
  }

  const existing = JSON.parse(await run('gh', [
    'pr', 'list', '--repo', task.repo, '--head', branch, '--state', 'all', '--json', 'url', '--limit', '1',
  ]));
  const url = existing[0]?.url ?? (await run('gh', [
    'pr', 'create', '--repo', task.repo, '--base', task.base, '--head', branch,
    '--title', task.title, '--body', prBody(task, verdict, trail),
  ])).split('\n').at(-1).trim();

  queue.updateStatus(task.id, task.status, { pr_url: url });
  return url;
}

const passSummary = (counts) => (counts?.pass != null ? `: ${counts.pass} passed, ${counts.fail ?? 0} failed` : '');

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
