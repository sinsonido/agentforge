/**
 * Spend limits for coding tasks, per task and per repository, with build and
 * verification budgeted apart.
 *
 * Every executor run is one tranche of spend, recorded in the cost ledger
 * (CostTracker) with its `phase`:
 *   build   the task's first run and its fix rounds
 *   verify  independent verification runs before merge
 *
 * The `budget:` block in agentforge.yml sets the limits. Each is optional:
 *   task.build, task.verify     USD one task may spend over its whole life.
 *                               A task's own `budget` overrides task.build.
 *   repo.build, repo.verify     USD all tasks of one repository may spend in
 *                               the rolling `repo.window` (day, week or month).
 *   min_run_usd                 a tranche starts only with at least this much
 *                               left under every limit of its phase.
 *
 * Before each leg that could spend, the orchestrator asks `check`. A blocked
 * task parks in `paused_budget` and resumes on its own once `check` passes
 * again: the repo window rolled on, or the operator raised a limit. Each run
 * is capped at `runCap`, which reaches the harness as `--max-budget-usd`.
 *
 * @typedef {'build'|'verify'} Phase
 * @typedef {'day'|'week'|'month'} Window
 * @typedef {{ build: number|null, verify: number|null }} PhaseLimits
 * @typedef {{ min_run_usd: number, task: PhaseLimits, repo: PhaseLimits & { window: Window } }} BudgetPolicy
 * @typedef {{ scope: 'task'|'repo', phase: Phase, limit: number, spent: number, remaining: number }} Limit
 * @typedef {{ spent(filter: { taskId?: string, repo?: string, since?: number }): Record<Phase, number> }} Ledger
 */

export const PHASES = Object.freeze(['build', 'verify']);

const DAY = 86_400_000;
export const WINDOWS = Object.freeze({ day: DAY, week: 7 * DAY, month: 30 * DAY });

/** @type {Readonly<BudgetPolicy>} */
export const BUDGET_DEFAULTS = Object.freeze({
  min_run_usd: 0.25,
  task: Object.freeze({ build: null, verify: null }),
  repo: Object.freeze({ window: 'day', build: null, verify: null }),
});

const isUsd = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Parse the `budget:` block. Missing keys take their default; a missing limit is no limit.
 * @param {unknown} raw
 * @returns {{ ok: true, value: BudgetPolicy } | { ok: false, error: string }}
 */
export function parseBudget(raw) {
  if (raw == null) return { ok: true, value: globalThis.structuredClone(BUDGET_DEFAULTS) };
  const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  if (!isMap(raw)) return { ok: false, error: 'budget must be a mapping' };
  const errors = [];
  const unknown = (obj, keys, where) => Object.keys(obj).filter((k) => !keys.includes(k)).forEach((k) => errors.push(`unknown key ${where}${k}`));
  unknown(raw, ['min_run_usd', 'task', 'repo'], '');

  const section = (name, extra) => {
    const given = raw[name] ?? {};
    if (!isMap(given)) {
      errors.push(`${name} must be a mapping`);
      return { ...BUDGET_DEFAULTS[name] };
    }
    unknown(given, [...PHASES, ...extra], `${name}.`);
    const value = { ...BUDGET_DEFAULTS[name], ...given };
    for (const p of PHASES) {
      if (value[p] != null && !isUsd(value[p])) errors.push(`${name}.${p} must be a positive number of USD`);
    }
    return value;
  };
  const value = { min_run_usd: raw.min_run_usd ?? BUDGET_DEFAULTS.min_run_usd, task: section('task', []), repo: section('repo', ['window']) };
  if (!(typeof value.min_run_usd === 'number' && value.min_run_usd >= 0)) errors.push('min_run_usd must be a number, 0 or more');
  if (!(value.repo.window in WINDOWS)) errors.push(`repo.window must be one of: ${Object.keys(WINDOWS).join(', ')}`);
  if (errors.length) return { ok: false, error: errors.join('; ') };
  return { ok: true, value };
}

/**
 * The phases the next leg of a coding task could spend in. A task with no PR yet
 * runs its build. With a PR, CI decides: a pending round may go red (a fix
 * round) or green (verification before merge), a red one runs a fix round, and
 * a green one only verifies, unless a verdict at that head is already recorded.
 * @returns {Phase[]}
 */
export function phasesAhead(task) {
  const round = task.babysit?.rounds?.at(-1);
  if (!round) return ['build'];
  if (round.ci === 'pass') return task.verification?.verdicts?.some((v) => v.sha === round.head) ? [] : ['verify'];
  if (round.ci === 'fail') return ['build'];
  return ['build', 'verify'];
}

const usd = (n) => `$${n.toFixed(2)}`;

export class Budget {
  /**
   * @param {BudgetPolicy} policy
   * @param {Ledger} ledger
   * @param {() => number} [now]
   */
  constructor(policy, ledger, now = Date.now) {
    this.policy = policy ?? BUDGET_DEFAULTS;
    this.ledger = ledger;
    this.now = now;
  }

  /** Start of the rolling repo window. */
  since() {
    return this.now() - WINDOWS[this.policy.repo.window];
  }

  /**
   * Every configured limit on `phase` for `task`, with what it has spent.
   * @returns {Limit[]}
   */
  limits(task, phase) {
    const taskLimit = phase === 'build' ? task.budget ?? this.policy.task.build : this.policy.task.verify;
    const rows = [];
    if (taskLimit != null) rows.push(['task', taskLimit, this.ledger.spent({ taskId: task.id })[phase]]);
    const repoLimit = this.policy.repo[phase];
    if (repoLimit != null && task.repo) rows.push(['repo', repoLimit, this.ledger.spent({ repo: task.repo, since: this.since() })[phase]]);
    return rows.map(([scope, limit, spent]) => ({ scope, phase, limit, spent, remaining: Math.max(0, limit - spent) }));
  }

  /**
   * The first limit that blocks `phases`, by default those the next leg of
   * `task` could reach, or null when it may run.
   * @param {Phase[]} [phases]
   * @returns {Limit|null}
   */
  check(task, phases = phasesAhead(task)) {
    for (const phase of phases) {
      const blocked = this.limits(task, phase).find((l) => l.remaining < Math.max(this.policy.min_run_usd, Number.EPSILON));
      if (blocked) return blocked;
    }
    return null;
  }

  /**
   * The most one run of `phase` may spend: what is left under its tightest
   * limit, or null when no limit applies.
   * @returns {number|null}
   */
  runCap(task, phase) {
    const left = this.limits(task, phase).map((l) => l.remaining);
    return left.length ? Math.min(...left) : null;
  }

  /**
   * `task` as one run of `phase` sees it: `budget`, which the executor passes as
   * `--max-budget-usd`, is what the run may spend, or unset for the executor's default.
   */
  capRun(task, phase) {
    return { ...task, budget: this.runCap(task, phase) ?? undefined };
  }

  /**
   * Spend and limits per phase for one task and its repository's window.
   */
  report(task) {
    const mine = this.ledger.spent({ taskId: task.id });
    return Object.fromEntries(PHASES.map((phase) => [phase, {
      spent: mine[phase],
      limits: this.limits(task, phase),
    }]));
  }

  /**
   * One repository's spend in the current window, per phase, with its limit.
   */
  repoReport(repo) {
    const spent = this.ledger.spent({ repo, since: this.since() });
    return {
      window: this.policy.repo.window,
      since: this.since(),
      ...Object.fromEntries(PHASES.map((p) => [p, { spent: spent[p], limit: this.policy.repo[p] }])),
    };
  }
}

/** @returns {import('./trail.js').TrailInput} why a task parked */
export function pauseEntry({ scope, phase, limit, spent }, minRun) {
  return {
    kind: 'gate',
    summary: `fail budget: ${scope} ${phase} spent ${usd(spent)} of ${usd(limit)}, under ${usd(minRun)} left for the next run`,
    evidence: { gate: 'budget', pass: false, scope, phase, limit, spent },
  };
}

/** @returns {import('./trail.js').TrailInput} why a parked task runs again */
export function resumeEntry(status) {
  return { kind: 'decision', summary: `budget has room again: resuming at ${status}`, evidence: { source: 'budget', status } };
}

/** The status a task parked in `paused_budget` goes back to: CI watch once it has a PR. */
export const resumeStatus = (task) => (task.babysit ? 'ci-watch' : 'queued');

/** Why a task is paused, for its `result`. */
export const pauseReason = ({ scope, phase, limit, spent }) =>
  `paused: ${scope} ${phase} budget ${usd(spent)} of ${usd(limit)} spent`;
