import { setTimeout as delay } from 'node:timers/promises';
import { hostRunner } from './host-runner.js';

/**
 * poteto-mode's Babysit playbook as host code: after AgentForge pushes a PR head,
 * it watches that head's CI. Green offers the merge. Red starts a fix round, a
 * fresh harness run on a fresh clone of the PR branch, until the round cap.
 *
 * The state lives on the task as `babysit` and survives a restart:
 *
 *   branch      the PR's head branch, the task's own (names.js)
 *   dir         the clone the last harness run used; a fix round deletes it first
 *   max_rounds  how many fix rounds this task may run
 *   rounds      one per head AgentForge pushed: n 0 is the published head, n k the
 *               head fix round k pushed. ci is pending until every check on that
 *               head finished; failing names the checks that failed.
 *   verdict     null while babysitting; then green, red (CI failed and AgentForge
 *               stopped fixing), merged or closed (outside AgentForge), timeout,
 *               or stopped (cancelled before CI finished)
 *
 * @typedef {'pending'|'pass'|'fail'} CiState
 * @typedef {{ name: string, url: string|null }} FailedCheck
 * @typedef {{ n: number, head: string, ci: CiState, failing: FailedCheck[], started_at: number, finished_at: number|null }} Round
 * @typedef {'green'|'red'|'merged'|'closed'|'timeout'|'stopped'} Verdict
 * @typedef {{ branch: string, dir: string|null, max_rounds: number, rounds: Round[], verdict: Verdict|null }} Babysit
 *
 * A check as `gh pr checks --json name,bucket,link` reports it.
 * @typedef {{ name: string, bucket: 'pass'|'fail'|'pending'|'skipping'|'cancel', link: string|null }} Check
 * @typedef {{ state: 'OPEN'|'MERGED'|'CLOSED', head: string, checks: Check[] }} PrState
 * @typedef {{ pr(url: string): Promise<PrState>, logTail(repo: string, url: string|null): Promise<string|null> }} CiReader
 */

export const BABYSIT_DEFAULTS = Object.freeze({ max_rounds: 2, timeout_minutes: 60, checks: 'all' });

const CHECK_SETS = ['all', 'required'];
/** Seconds between polls of one head: quick at first, then once a minute. */
const POLL_SECONDS = [10, 20, 30, 60];
/** A head with no checks after this long has no CI to wait for. */
const NO_CHECKS_GRACE_MS = 5 * 60_000;
const LOG_LINES = 60;
const LOG_CHARS = 3000;
const NO_CHECKS = /no (required )?checks reported/i;

/**
 * Parse the `babysit:` block. Missing keys take their default.
 * @returns {{ ok: true, value: typeof BABYSIT_DEFAULTS } | { ok: false, error: string }}
 */
export function parseBabysit(raw) {
  if (raw == null) return { ok: true, value: { ...BABYSIT_DEFAULTS } };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'babysit must be a mapping' };
  const value = { ...BABYSIT_DEFAULTS, ...raw };
  const errors = [];
  const unknown = Object.keys(raw).filter((k) => !(k in BABYSIT_DEFAULTS));
  if (unknown.length) errors.push(`unknown keys: ${unknown.join(', ')}`);
  if (!(Number.isInteger(value.max_rounds) && value.max_rounds >= 0)) errors.push('max_rounds must be a whole number, 0 or more');
  if (!(typeof value.timeout_minutes === 'number' && value.timeout_minutes > 0)) errors.push('timeout_minutes must be a positive number');
  if (!CHECK_SETS.includes(value.checks)) errors.push(`checks must be one of: ${CHECK_SETS.join(', ')}`);
  if (errors.length) return { ok: false, error: errors.join('; ') };
  return { ok: true, value };
}

/**
 * Read a PR's state and its head's checks with gh on the host.
 * `checks: 'required'` asks only for the checks branch protection requires.
 * @returns {CiReader}
 */
export function ghCiReader({ checks = 'all', run = hostRunner } = {}) {
  const listChecks = async (url) => {
    const args = ['pr', 'checks', url, ...(checks === 'required' ? ['--required'] : []), '--json', 'name,bucket,link'];
    try {
      return JSON.parse(await run('gh', args));
    } catch (err) {
      if (NO_CHECKS.test(err.message)) return [];
      throw err;
    }
  };
  return {
    async pr(url) {
      const view = JSON.parse(await run('gh', ['pr', 'view', url, '--json', 'state,headRefOid']));
      return { state: view.state, head: view.headRefOid, checks: view.state === 'OPEN' ? await listChecks(url) : [] };
    },
    async logTail(repo, url) {
      const job = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(url ?? '')?.[1];
      if (!job) return null;
      try {
        const log = await run('gh', ['run', 'view', '--job', job, '--repo', repo, '--log-failed']);
        return log.split('\n').slice(-LOG_LINES).join('\n').slice(-LOG_CHARS);
      } catch {
        return null;
      }
    },
  };
}

/** @returns {'none'|CiState} what a head's checks say once all of them finished */
export function classify(checks) {
  if (!checks.length) return 'none';
  if (checks.some((c) => c.bucket === 'pending')) return 'pending';
  return checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel') ? 'fail' : 'pass';
}

/**
 * The babysit state once AgentForge pushed `head`: a new pending round.
 * @param {Babysit|null} state
 * @returns {Babysit}
 */
export function startRound(state, { n, head, dir, branch, maxRounds }, now = Date.now()) {
  const round = { n, head, ci: 'pending', failing: [], started_at: now, finished_at: null };
  if (n === 0 || !state) return { branch, dir, max_rounds: maxRounds, rounds: [round], verdict: null };
  return { ...state, dir, rounds: [...state.rounds, round] };
}

/** @returns {Babysit} `state` with its last round replaced */
export const withLastRound = (state, round) => ({ ...state, rounds: [...state.rounds.slice(0, -1), round] });

/**
 * Poll the PR until the checks on `round.head` finish, the PR leaves OPEN, the
 * watch times out, or `signal` aborts. A pass needs the same set of checks on two
 * polls in a row, so a check that registers late is not missed. A gh error counts
 * as one more pending poll.
 *
 * @param {{ url: string, round: Round }} target
 * @param {{ ci: CiReader, timeoutMs: number, signal?: AbortSignal,
 *   wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>, now?: () => number }} deps
 * @returns {Promise<{ outcome: 'pass'|'fail'|'merged'|'closed'|'timeout'|'aborted',
 *   failing?: FailedCheck[], checks?: number }>}
 */
export async function watchCi({ url, round }, { ci, timeoutMs, signal, wait = delay, now = Date.now }) {
  let lastSeen = null;
  for (let poll = 0; ; poll++) {
    if (signal?.aborted) return { outcome: 'aborted' };
    let pr = null;
    try {
      pr = await ci.pr(url);
    } catch (err) {
      console.warn('[babysit] %s: %s', url, err.message);
    }
    if (pr) {
      if (pr.state === 'MERGED') return { outcome: 'merged' };
      if (pr.state === 'CLOSED') return { outcome: 'closed' };
      const seen = pr.head === round.head ? classify(pr.checks) : 'pending';
      const names = pr.checks.map((c) => c.name).sort().join('\n');
      if (seen === 'fail') {
        const failing = pr.checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => ({ name: c.name, url: c.link ?? null }));
        return { outcome: 'fail', failing, checks: pr.checks.length };
      }
      if (seen === 'pass' && names === lastSeen) return { outcome: 'pass', failing: [], checks: pr.checks.length };
      if (seen === 'none' && now() - round.started_at >= NO_CHECKS_GRACE_MS) return { outcome: 'pass', failing: [], checks: 0 };
      lastSeen = seen === 'pass' ? names : null;
    }
    if (now() - round.started_at >= timeoutMs) return { outcome: 'timeout' };
    try {
      await wait(POLL_SECONDS[Math.min(poll, POLL_SECONDS.length - 1)] * 1000, signal);
    } catch {
      return { outcome: 'aborted' };
    }
  }
}

/** @returns {import('../core/trail.js').TrailInput} the CI result of one round */
export function ciEntry(round, checks) {
  const at = round.head.slice(0, 7);
  const names = round.failing.map((c) => c.name).join(', ');
  return {
    kind: 'gate',
    summary: round.ci === 'pass'
      ? `pass ci round ${round.n}: ${checks ? `${checks} checks passed` : 'no checks reported'} at ${at}`
      : `fail ci round ${round.n}: ${names} failed at ${at}`,
    evidence: { gate: 'ci', pass: round.ci === 'pass', round: round.n, head: round.head, failing: names || null },
  };
}

const fence = (text) => ['```', text.replace(/```/g, "'''"), '```'].join('\n');

/**
 * The instruction of a fix round: the original task, what failed and where,
 * what the previous round accepted, and the trail so far. The harness starts
 * cold, so this is all it knows.
 *
 * @param {object} task the coding task
 * @param {{ n: number, state: Babysit, failing: Array<FailedCheck & { log: string|null }>,
 *   trail: import('../core/trail.js').TrailEntry[] }} round
 */
export function fixInstruction(task, { n, state, failing, trail }) {
  const last = state.rounds.at(-1);
  const issue = task.issue != null ? ` (issue #${task.issue})` : '';
  const history = trail.filter((e) => e.kind !== 'step').slice(-25).map((e) => `- ${e.kind}: ${e.summary}`);
  return [
    `Fix round ${n} of ${state.max_rounds} for ${task.pr_url}. The PR's CI failed on ${last.head.slice(0, 7)}, the head of \`${state.branch}\`. This clone starts at that head.`,
    'Make the failing checks pass. Fix only what makes them fail and keep the original change. Commit on top of the current branch.',
    '',
    `Original task${issue}: ${task.instruction}`,
    '',
    '## Failing checks',
    ...failing.flatMap((c) => [
      '',
      `### ${c.name}${c.url ? ` (${c.url})` : ''}`,
      c.log ? fence(c.log) : 'No log available.',
    ]),
    '',
    '## Decision trail so far',
    ...history,
  ].join('\n');
}
