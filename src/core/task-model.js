/**
 * Task model v2: what a task carries, and the parser that turns an untrusted
 * request body into it.
 *
 * A task is one of two kinds:
 * - `text`: the single provider call that existed before v2. Carries only the common fields.
 * - `coding`: a poteto-mode playbook run against a repository. Adds
 *   `repo`, `base`, `instruction`, `issue`, `playbook`, `step`, `budget` and `pr_url`,
 *   plus `setup_command` and `test_command`: what the harness runs to install the
 *   repo's dependencies and the one test command the evidence gate accepts, and
 *   `handle`, the task's name outside this database (see newHandle).
 *   Its lifecycle: queued → executing → pr-opened | completed | failed | cancelled, with
 *   `needs-approval` while a host action waits for the operator (see autonomy.js).
 *
 * @typedef {'bug-fix'|'feature'|'refactoring'|'investigation'|'perf-issue'} Playbook
 * @typedef {{ kind: 'text', title: string, type?: string, priority?: string, agent_id?: string }} TextTaskInput
 * @typedef {{ kind: 'coding', title: string, type?: string, priority?: string, agent_id?: string,
 *   repo: string, base: string, instruction: string, issue: number|null, playbook: Playbook,
 *   budget: number|null, setup_command: string, test_command: string }} CodingTaskInput
 * @typedef {TextTaskInput|CodingTaskInput} TaskInput
 */

import { randomBytes } from 'node:crypto';

export const PLAYBOOKS = Object.freeze(['bug-fix', 'feature', 'refactoring', 'investigation', 'perf-issue']);

export const TASK_KINDS = Object.freeze(['text', 'coding']);

export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'pr-opened', 'cancelled']);

export const CODING_FIELDS = Object.freeze([
  'repo', 'base', 'instruction', 'issue', 'playbook', 'step', 'budget', 'pr_url', 'setup_command', 'test_command', 'approval', 'handle',
]);

/**
 * A coding task's handle: its id plus 32 random bits. Every database numbers
 * tasks from t1, so the id alone collides on a GitHub repo or Docker daemon that
 * another instance, or this one before a database reset, also uses.
 */
export const newHandle = (id) => `${id}-${randomBytes(4).toString('hex')}`;

/** Commands a coding task runs when its repository configures none. */
export const DEFAULT_COMMANDS = Object.freeze({ setup_command: 'npm ci', test_command: 'npm test' });

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const TITLE_MAX = 120;

const isText = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Parse a POST /api/tasks body into a TaskInput.
 * @param {unknown} body
 * @returns {{ ok: true, value: TaskInput } | { ok: false, error: string }}
 */
export function parseTaskInput(body) {
  const raw = body && typeof body === 'object' ? body : {};
  const kind = raw.kind ?? 'text';
  if (!TASK_KINDS.includes(kind)) {
    return { ok: false, error: `\`kind\` must be one of: ${TASK_KINDS.join(', ')}` };
  }
  const common = { type: raw.type, priority: raw.priority, agent_id: raw.agent_id };

  if (kind === 'text') {
    if (!raw.title) return { ok: false, error: '`title` is required' };
    return { ok: true, value: { kind, title: raw.title, ...common } };
  }

  const missing = ['repo', 'base', 'instruction', 'playbook'].filter((f) => !isText(raw[f]));
  if (missing.length) {
    return { ok: false, error: `a coding task requires ${missing.map((f) => `\`${f}\``).join(', ')}` };
  }
  const problems = [];
  if (!REPO_PATTERN.test(raw.repo)) problems.push('`repo` must be "owner/name"');
  if (!PLAYBOOKS.includes(raw.playbook)) problems.push(`\`playbook\` must be one of: ${PLAYBOOKS.join(', ')}`);
  if (raw.issue != null && !(Number.isInteger(raw.issue) && raw.issue > 0)) {
    problems.push('`issue` must be a positive integer');
  }
  if (raw.budget != null && !(typeof raw.budget === 'number' && Number.isFinite(raw.budget) && raw.budget > 0)) {
    problems.push('`budget` must be a positive number of USD');
  }
  for (const f of Object.keys(DEFAULT_COMMANDS)) {
    if (raw[f] != null && !isText(raw[f])) problems.push(`\`${f}\` must be a non-empty string`);
  }
  if (problems.length) return { ok: false, error: problems.join('; ') };

  const instruction = raw.instruction.trim();
  return {
    ok: true,
    value: {
      kind,
      title: isText(raw.title) ? raw.title : instruction.split('\n')[0].slice(0, TITLE_MAX),
      ...common,
      repo: raw.repo,
      base: raw.base.trim(),
      instruction,
      issue: raw.issue ?? null,
      playbook: raw.playbook,
      budget: raw.budget ?? null,
      setup_command: raw.setup_command?.trim() ?? DEFAULT_COMMANDS.setup_command,
      test_command: raw.test_command?.trim() ?? DEFAULT_COMMANDS.test_command,
    },
  };
}

/**
 * The identity a coding task has for intake: at most one live task per
 * (repo, issue, playbook). Tasks without an issue have no key and never collide.
 * @returns {string|null}
 */
export function admissionKey(task) {
  if (task.kind !== 'coding' || task.issue == null) return null;
  return `${task.repo}#${task.issue}:${task.playbook}`;
}
