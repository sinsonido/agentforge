import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseTaskInput } from './task-model.js';

const execFileAsync = promisify(execFile);

/** Issue label → playbook. The first row whose label the issue carries wins. */
export const LABEL_PLAYBOOKS = Object.freeze([
  ['bug', 'bug-fix'],
  ['enhancement', 'feature'],
  ['refactor', 'refactoring'],
]);

/**
 * Hidden line in the intake comment. An issue that carries it has been taken,
 * so intake never admits it again, even after its task ends or its labels change.
 */
export const MARKER = '<!-- agentforge:intake -->';

/** @typedef {(cmd: 'gh', args: string[]) => Promise<string>} Runner */

/** @type {Runner} */
async function hostRunner(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${(err.stderr || err.message).trim()}`, { cause: err });
  }
}

/** @param {Array<{ name: string }>} labels */
export function playbookFor(labels, fallback) {
  const names = new Set(labels.map((l) => l.name));
  return LABEL_PLAYBOOKS.find(([label]) => names.has(label))?.[1] ?? fallback;
}

/**
 * Poll GitHub for open issues labelled `intake.label` and admit one coding task per issue.
 *
 * Per issue: skip it if any comment carries MARKER; else admit (a live task for the
 * same repo, issue and playbook comes back instead of a new one) and post the
 * comment with MARKER. A crash between admit and comment leaves no marker, so the
 * next poll gets the same task back and posts the one missing comment.
 *
 * @param {{
 *   intake: { repos: Array<{ repo: string, base: string }>, label: string,
 *             interval_seconds: number, default_playbook: string },
 *   queue: { admit(input: object): { task: object, created: boolean } },
 *   run?: Runner,
 *   log?: Pick<Console, 'warn'>,
 * }} opts
 */
export function createIntake({ intake, queue, run = hostRunner, log = console }) {
  let timer = null;
  let running = false;
  let gen = 0;

  async function takeIssue(repo, base, issue) {
    if (issue.comments.some((c) => c.body.includes(MARKER))) return;
    const parsed = parseTaskInput({
      kind: 'coding',
      title: `#${issue.number} ${issue.title}`,
      repo,
      base,
      instruction: `${issue.title}\n\n${issue.body ?? ''}`.trim(),
      issue: issue.number,
      playbook: playbookFor(issue.labels, intake.default_playbook),
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const { task } = queue.admit(parsed.value);
    const body = `AgentForge task \`${task.id}\` runs the \`${task.playbook}\` playbook on this issue.\n\n${MARKER}`;
    await run('gh', ['issue', 'comment', String(issue.number), '--repo', repo, '--body', body]);
  }

  async function pollOnce() {
    for (const { repo, base } of intake.repos) {
      let issues;
      try {
        issues = JSON.parse(await run('gh', [
          'issue', 'list', '--repo', repo, '--label', intake.label, '--state', 'open',
          '--limit', '100', '--json', 'number,title,body,labels,comments',
        ]));
      } catch (err) {
        log.warn('[intake] %s: %s', repo, err.message);
        continue;
      }
      for (const issue of issues) {
        try {
          await takeIssue(repo, base, issue);
        } catch (err) {
          log.warn('[intake] %s#%d: %s', repo, issue.number, err.message);
        }
      }
    }
  }

  // A poll still in flight after stop() and start() belongs to an old generation and stops there.
  async function tick(generation) {
    await pollOnce();
    if (running && generation === gen) timer = setTimeout(tick, intake.interval_seconds * 1000, generation);
  }

  return {
    pollOnce,
    start() {
      if (running) return;
      running = true;
      tick(++gen);
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
}
