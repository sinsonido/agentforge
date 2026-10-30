import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostRunner } from './host-runner.js';

/**
 * poteto-mode's Shipping playbook on the host: green is not safe. Before the
 * merge is offered, a fresh harness run that did not write the change verifies
 * the PR at its exact head SHA, read-only, lane by lane. The merge refuses unless
 * a passing verdict exists for the PR's current head.
 *
 * The state lives on the task as `verification` and survives a restart:
 *
 *   head      the PR head AgentForge last pushed or read from GitHub
 *   verdicts  one per verified SHA, oldest first
 *
 * A verdict covers one SHA. Only the verdict whose `sha` equals `head` counts, so
 * a new head (a fix round, a push from outside) invalidates the old verdict by
 * moving `head`; nothing has to remember to clear it.
 *
 * @typedef {{ name: string, pass: boolean, evidence: string }} LaneResult
 * @typedef {{ sha: string, lanes: LaneResult[], pass: boolean, error: string|null, cost_usd: number, at: number }} Verdict
 * @typedef {{ head: string|null, verdicts: Verdict[] }} Verification
 * @typedef {Record<string, { pass: boolean, evidence: string }>} Report what the verifier wrote, by lane
 */

/** The file the verifier writes its per-lane report to, at the clone root. Never committed. */
export const REPORT_FILE = 'agentforge-verdict.json';

/**
 * What each lane asks the verifier, and how the host judges it. `tests` is
 * judged from the test runs the host saw in the stream, not from the report.
 */
export const LANES = Object.freeze({
  tests: {
    ask: (task) => `run exactly \`${task.test_command}\` as its own command and say whether it passes.`,
    judge(run, report, task) {
      const seen = run.observedTestRuns.filter((r) => r.command === task.test_command).at(-1);
      if (!seen) return { pass: false, evidence: `\`${task.test_command}\` was never run` };
      const counts = seen.counts?.pass != null ? `: ${seen.counts.pass} passed, ${seen.counts.fail ?? 0} failed` : '';
      const note = report?.evidence ? `. Verifier: ${report.evidence}` : '';
      return { pass: seen.passed, evidence: `\`${task.test_command}\` ${seen.passed ? 'passed' : 'failed'}${counts}${note}` };
    },
  },
  review: {
    ask: () => `read the diff against the base and the task. Pass only if it does what the task asks, changes nothing unrelated, and has no bug you can point to. Cite file and line for a failure.`,
    judge(run, report) {
      if (!report) return { pass: false, evidence: 'the verifier reported nothing for this lane' };
      return { pass: report.pass === true, evidence: report.evidence || 'no evidence given' };
    },
  },
});

export const VERIFY_DEFAULTS = Object.freeze({ lanes: Object.freeze(['tests', 'review']), budget_usd: 1, model: null });

/**
 * Parse the `verify:` block. Missing keys take their default.
 * @returns {{ ok: true, value: { lanes: string[], budget_usd: number, model: string|null } } | { ok: false, error: string }}
 */
export function parseVerify(raw) {
  if (raw == null) return { ok: true, value: { ...VERIFY_DEFAULTS, lanes: [...VERIFY_DEFAULTS.lanes] } };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'verify must be a mapping' };
  const value = { ...VERIFY_DEFAULTS, ...raw };
  const errors = [];
  const unknown = Object.keys(raw).filter((k) => !(k in VERIFY_DEFAULTS));
  if (unknown.length) errors.push(`unknown keys: ${unknown.join(', ')}`);
  const lanes = value.lanes;
  if (!Array.isArray(lanes) || !lanes.length) errors.push(`lanes must list at least one of: ${Object.keys(LANES).join(', ')}`);
  else {
    const bad = lanes.filter((l) => !(l in LANES));
    if (bad.length) errors.push(`unknown lanes: ${bad.join(', ')}; lanes are: ${Object.keys(LANES).join(', ')}`);
    if (new Set(lanes).size !== lanes.length) errors.push('lanes must not repeat');
  }
  if (!(typeof value.budget_usd === 'number' && value.budget_usd > 0)) errors.push('budget_usd must be a positive number');
  if (value.model != null && (typeof value.model !== 'string' || !value.model.trim())) errors.push('model must be a model name');
  if (errors.length) return { ok: false, error: errors.join('; ') };
  return { ok: true, value: { lanes: [...lanes], budget_usd: value.budget_usd, model: value.model ?? null } };
}

/**
 * Read a PR's state and head with gh on the host.
 * @returns {{ pr(url: string): Promise<{ state: string, head: string }> }}
 */
export function ghPrHead({ run = hostRunner } = {}) {
  return {
    async pr(url) {
      const view = JSON.parse(await run('gh', ['pr', 'view', url, '--json', 'state,headRefOid']));
      return { state: view.state, head: view.headRefOid };
    },
  };
}

/** @returns {Promise<Report|null>} the verifier's report, or null when it wrote none or wrote garbage */
export async function readReport(dir) {
  let raw;
  try {
    raw = JSON.parse(await readFile(join(dir, REPORT_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(raw?.lanes)) return null;
  return Object.fromEntries(raw.lanes
    .filter((l) => typeof l?.name === 'string')
    .map((l) => [l.name, { pass: l.pass === true, evidence: typeof l.evidence === 'string' ? l.evidence : '' }]));
}

const short = (sha) => String(sha ?? '').slice(0, 7);

/** Why a verifier run cannot count, or null. A verifier only reads: any commit or tracked change voids it. */
function voided(run, sha) {
  if (run.outcome !== 'stopped') return run.error ?? `verifier ${run.outcome}`;
  const n = run.commits.length;
  if (n) return `the verifier made ${n} commit${n === 1 ? '' : 's'}, so the run does not count`;
  if (run.head !== sha) return `the verifier moved HEAD to ${short(run.head)}, so the run does not count`;
  if (run.uncommitted) return 'the verifier changed tracked files, so the run does not count';
  return null;
}

/**
 * Judge one verifier run at `sha`, lane by lane.
 * @param {{ outcome: string, error: string|null, commits: object[], head: string, uncommitted: boolean,
 *   observedTestRuns: object[], costUsd: number|null }} run
 * @param {{ sha: string, lanes: string[], task: object, report: Report|null }} ctx
 * @returns {Verdict}
 */
export function judge(run, { sha, lanes, task, report }, now = Date.now()) {
  const results = lanes.map((name) => ({ name, ...LANES[name].judge(run, report?.[name] ?? null, task) }));
  const error = voided(run, sha);
  return { sha, lanes: results, pass: !error && results.every((l) => l.pass), error, cost_usd: run.costUsd ?? 0, at: now };
}

/** @returns {Verdict|null} the verdict recorded for `sha` */
export const verdictAt = (verification, sha) => verification?.verdicts.find((v) => v.sha === sha) ?? null;

/** @returns {Verdict|null} the verdict that covers the current head, if any */
export const currentVerdict = (verification) => (verification?.head ? verdictAt(verification, verification.head) : null);

/** @returns {Verification} `verification` with its head moved to `head` */
export const withHead = (verification, head) => ({ head, verdicts: verification?.verdicts ?? [] });

/** @returns {Verification} `verification` with `verdict` recorded for its SHA, replacing an older one */
export const withVerdict = (verification, verdict) => ({
  head: verification?.head ?? verdict.sha,
  verdicts: [...(verification?.verdicts ?? []).filter((v) => v.sha !== verdict.sha), verdict],
});

/** @returns {import('../core/trail.js').TrailInput[]} one gate entry per lane, and one for a void run */
export function verdictEntries(verdict) {
  const at = short(verdict.sha);
  const lanes = verdict.lanes.map(({ name, pass, evidence }) => ({
    kind: 'gate',
    summary: `${pass ? 'pass' : 'fail'} verify ${name} at ${at}: ${evidence}`,
    evidence: { gate: 'verify', lane: name, pass, sha: verdict.sha },
  }));
  const run = verdict.error ? [{
    kind: 'gate',
    summary: `fail verify run at ${at}: ${verdict.error}`,
    evidence: { gate: 'verify', lane: null, pass: false, sha: verdict.sha },
  }] : [];
  return [...run, ...lanes];
}

/** @returns {import('../core/trail.js').TrailInput} a verdict that stopped covering the PR head */
export function staleEntry(verdict, head) {
  return {
    kind: 'gate',
    summary: `stale verify at ${short(verdict.sha)}: the PR head is now ${short(head)}`,
    evidence: { gate: 'verify', stale: true, pass: false, sha: verdict.sha, head },
  };
}
