import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import defaultEventBus from '../core/event-bus.js';
import {
  ACTIONS, DEFAULT_POLICY, FIRST_ACTION, decide, operatorEntry, pendingApproval, policyEntry,
} from '../core/autonomy.js';
import { verdict } from '../core/playbook.js';
import { TERMINAL_STATUSES } from '../core/task-model.js';
import { createStreamTrail, gateEntries, prEntry, readDecisionLogs, verdictEvidence } from '../core/trail.js';
import { ciEntry, fixInstruction, startRound, watchCi, withLastRound } from './babysit.js';
import { branchFor } from './names.js';

/**
 * The life of one coding task after the orchestrator picks it:
 *
 *   queued → executing → pr-opened        the PR exists; merge was denied or rejected
 *                      → completed        the PR is merged
 *                      → needs-approval   a host action waits for the operator
 *                      → ci-watch         the PR is open; its CI is watched next (with a babysitter)
 *                      → failed           harness error, gate failure, denied publish, or action error
 *                      → cancelled        aborted or timed out; never published
 *   ci-watch → (green) the merge, as above
 *            → fixing                     red with fix rounds left: a fresh harness run
 *            → failed                     red over the round cap, PR closed, or CI timed out
 *            → completed                  the PR was merged outside AgentForge
 *            → ci-watch                   the host shuts down; the next process resumes the watch
 *   fixing → ci-watch                     push-fix pushed the fix, or the host shut down
 *                                         and the round runs again
 *          → needs-approval|failed|cancelled  as for executing
 *   needs-approval → executing            approved: the parked action runs
 *                  → pr-opened|failed|cancelled  rejected: where the action before it left the task
 *
 * After the evidence gate passes, every host action (publish, push-fix, merge)
 * goes through the autonomy gate, `proceed`. Each call of runCodingTask is one
 * leg that ends in one of the statuses above; the orchestrator runs the next
 * leg of a task left in `ci-watch`. Each row is the queue write and the event
 * that announces it.
 *
 * Along the way it writes the task's decision trail: steps and skipped steps
 * from the agent stream, the agent's own decision log from the clone, each
 * gate check, each autonomy decision, and the commits, test run and PR it accepted.
 */
const FINAL = Object.freeze({
  'pr-opened': 'task.completed',
  completed: 'task.completed',
  'needs-approval': 'task.needs_approval',
  'ci-watch': 'task.ci_watch',
  failed: 'task.failed',
  cancelled: 'task.failed',
});

/**
 * How AgentForge performs each host action in ACTIONS. Each returns the task
 * fields it set, its trail evidence, and the payload of the next action.
 */
const HOST_ACTIONS = Object.freeze({
  async publish(task, { dir, verdict }, { publish, queue }) {
    const url = await publish({ task, clone: { dir }, verdict, queue, trail: queue.trail(task.id) });
    return { extra: { pr_url: url, result: url }, trail: [prEntry(url)], next: { pr_url: url }, head: verdict.commits.at(-1).sha };
  },
  async 'push-fix'(task, { dir, verdict, branch, round }, { pushFix }) {
    const sha = await pushFix({ task, clone: { dir }, verdict, branch });
    const n = verdict.commits.length;
    const summary = `fix round ${round} pushed ${n} commit${n === 1 ? '' : 's'} to ${branch} at ${sha.slice(0, 7)}`;
    const entry = { kind: 'evidence', summary, evidence: { branch, sha, round } };
    return { extra: { result: summary }, trail: [entry], next: { pr_url: task.pr_url }, head: sha };
  },
  async merge(task, { pr_url }, { merge }) {
    await merge({ task, url: pr_url });
    const entry = { kind: 'evidence', summary: `merged ${pr_url}`, evidence: { url: pr_url, merged: true } };
    return { extra: { result: `merged ${pr_url}` }, trail: [entry], next: null };
  },
});

/** The abort reason of a host shutdown: a CI watch or fix round resumes on the next boot. */
export const SHUTDOWN = 'shutdown';

const expandHome = (p) => (typeof p === 'string' && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/**
 * Turn the `executor:` config block into coding-executor options. Paths are
 * absolute because the executor hands them to the Docker daemon as bind mounts.
 * @returns {{ concurrency: number, options: object }}
 */
export function executorConfig(cfg) {
  const missing = ['state_dir', 'pstack_dir'].filter((k) => !cfg?.[k]);
  if (missing.length) throw new Error(`Invalid executor configuration: ${missing.join(', ')} required`);
  const options = {
    image: cfg.image,
    stateDir: resolve(expandHome(cfg.state_dir)),
    pstackDir: resolve(expandHome(cfg.pstack_dir)),
    claudeBin: cfg.claude_bin && resolve(expandHome(cfg.claude_bin)),
    credentialsFile: cfg.credentials_file && resolve(expandHome(cfg.credentials_file)),
    oauthToken: cfg.oauth_token || undefined,
    model: cfg.model,
    effort: cfg.effort,
    budgetUsd: cfg.budget_usd,
    timeoutMs: cfg.timeout_minutes && cfg.timeout_minutes * 60_000,
    dockerBin: cfg.docker_bin,
    gitAuthor: cfg.git_author,
  };
  return {
    concurrency: cfg.concurrency ?? 1,
    options: Object.fromEntries(Object.entries(options).filter(([, v]) => v != null && v !== '')),
  };
}

/**
 * @typedef {{
 *   queue: { updateStatus(id: string, status: string, extra?: object): object,
 *            appendTrail(id: string, entry: object): object|null, trail(id: string): object[] },
 *   publish: (opts: { task: object, clone: { dir: string }, verdict: object, queue: object, trail: object[] }) => Promise<string>,
 *   merge: (opts: { task: object, url: string }) => Promise<void>,
 *   pushFix?: (opts: { task: object, clone: { dir: string }, verdict: object, branch: string }) => Promise<string>,
 *   execute?: (task: object, opts: { signal?: AbortSignal }) => Promise<object>,
 *   babysit?: Babysitter,
 *   signal?: AbortSignal,
 *   policy?: import('../core/autonomy.js').Policy,
 *   eventBus?: import('node:events').EventEmitter,
 * }} HostDeps
 *
 * What the runner needs to babysit a PR. Without it, merge follows publish
 * directly and no CI is watched.
 * @typedef {{ ci: import('./babysit.js').CiReader, maxRounds: number, timeoutMs: number,
 *   wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>, now?: () => number }} Babysitter
 */

/**
 * Drive one coding task through its next leg: a queued task until it ends, parks
 * in `needs-approval` or waits in `ci-watch`; a task in `ci-watch` until CI
 * decides and the fix round or merge after it ends. Marks a queued task
 * `executing` before the first await, so a caller that does not await still owns it.
 *
 * @param {object} task the queue's live task object
 * @param {HostDeps & {
 *   execute: (task: object, opts: { signal?: AbortSignal }) => Promise<object>,
 *   signal?: AbortSignal,
 * }} deps
 * @returns {Promise<'pr-opened'|'completed'|'needs-approval'|'ci-watch'|'failed'|'cancelled'>}
 */
export async function runCodingTask(task, deps) {
  const { queue, eventBus = defaultEventBus } = deps;
  if (task.status === 'ci-watch') {
    const [status, extra] = await babysitLeg(task, deps);
    return finish(task, status, extra, deps);
  }
  queue.updateStatus(task.id, 'executing');
  eventBus.emit('task.executing', { task });
  const [status, extra] = await settle(task, deps);
  return finish(task, status, extra, deps);
}

/**
 * Apply the operator's decision to a task in `needs-approval`.
 * Approve runs the parked action, then the rest under the policy. If the
 * approved action throws, the task waits again with the error, so another
 * approve retries it. Reject ends the task where the action before it left it.
 *
 * @param {object} task the queue's live task object
 * @param {{ decision: 'approved'|'rejected', by: string, reason?: string|null }} choice
 * @param {HostDeps} deps
 * @returns {Promise<{ ok: true, status: string } | { ok: false, conflict: boolean, error: string }>}
 */
export async function decideApproval(task, { decision, by, reason = null }, deps) {
  const { queue, eventBus = defaultEventBus } = deps;
  const pending = task.status === 'needs-approval' ? task.approval : null;
  if (!pending || pending.decision) {
    return { ok: false, conflict: true, error: `Task '${task.id}' has no pending approval (status: ${task.status})` };
  }
  const approval = decide(pending, decision, { by, reason });
  queue.appendTrail(task.id, operatorEntry(approval));

  if (decision === 'rejected') {
    const status = ACTIONS[approval.action].stopsAt ?? 'cancelled';
    const result = `${approval.action} rejected${reason ? `: ${reason}` : ''}`;
    return { ok: true, status: finish(task, status, { approval, result }, deps) };
  }

  queue.updateStatus(task.id, 'executing', { approval });
  eventBus.emit('task.executing', { task });
  try {
    const [status, extra] = await proceed(task, approval.action, approval.payload, deps, {}, true);
    return { ok: true, status: finish(task, status, extra, deps) };
  } catch (err) {
    const again = { ...pending, error: err.message };
    finish(task, 'needs-approval', { approval: again, result: `${approval.action} failed: ${err.message}` }, deps);
    return { ok: false, conflict: false, error: `${approval.action}: ${err.message}` };
  }
}

function finish(task, status, extra, { queue, eventBus = defaultEventBus }) {
  const babysit = extra.babysit ?? task.babysit;
  if (babysit && !babysit.verdict && TERMINAL_STATUSES.includes(status)) {
    extra = { ...extra, babysit: { ...babysit, verdict: babysit.rounds.at(-1).ci === 'fail' ? 'red' : 'stopped' } };
  }
  queue.updateStatus(task.id, status, extra);
  const bad = status === 'failed' || status === 'cancelled';
  eventBus.emit(FINAL[status], { task, status, error: bad ? extra.result : undefined });
  return status;
}

/**
 * Run the harness, judge it with the evidence gate, and hand a passing run to
 * the autonomy gate. Without `fix` it is the task's first run and publish follows.
 * With `fix` it is a fix round: the harness gets `fix.task`, push-fix follows, and
 * a shutdown sends the task back to `ci-watch` to run the round again.
 * @param {{ task: object, payload: { branch: string, round: number } } | null} fix
 */
async function settle(task, deps, fix = null) {
  const { queue, execute, signal, eventBus = defaultEventBus } = deps;
  const record = (entries) => entries.forEach((e) => queue.appendTrail(task.id, e));
  const label = fix ? `fix round ${fix.payload.round}: ` : '';
  let run;
  try {
    run = await followStream(task, eventBus, record, () => execute(fix?.task ?? task, { signal }));
  } catch (err) {
    if (fix && signal?.reason === SHUTDOWN) return ['ci-watch', {}];
    return ['failed', { result: `${label}${err.message}` }];
  }
  if (run.dir) record(await readDecisionLogs(run.dir));
  const usage = run.usage ?? {};
  const spend = {
    cost: (task.cost ?? 0) + (run.costUsd ?? 0),
    tokens_in: (task.tokens_in ?? 0) + (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    tokens_out: (task.tokens_out ?? 0) + (usage.output_tokens ?? 0),
    step: run.step ?? task.step ?? null,
  };
  Object.assign(task, spend);

  if (fix && signal?.reason === SHUTDOWN) return ['ci-watch', spend];
  if (run.outcome === 'cancelled') return ['cancelled', { ...spend, result: `${label}cancelled (${run.cancelReason})` }];
  if (signal?.aborted) return ['cancelled', { ...spend, result: `${label}cancelled (signal)` }];
  if (run.outcome !== 'stopped') return ['failed', { ...spend, result: `${label}${run.error}` }];

  const gate = verdict({ ...run, testCommand: task.test_command, cancelled: false });
  record(gateEntries(gate));
  if (!gate.pass) return ['failed', { ...spend, result: `${label}evidence gate: ${gate.reasons.join('; ')}` }];
  record(verdictEvidence(gate));

  if (fix) return proceed(task, 'push-fix', { ...fix.payload, dir: run.dir, verdict: gate }, deps, spend);
  return proceed(task, FIRST_ACTION, { dir: run.dir, verdict: gate }, deps, spend);
}

/**
 * One leg of a task in `ci-watch`. A pending round is watched until its CI
 * decides. Green hands the PR to the action after the one that pushed it (merge).
 * Red runs a fix round while the cap allows. Each step reads the stored babysit
 * state, so a leg cut short by a restart converges when the next one runs.
 * @returns {Promise<[string, object]>}
 */
async function babysitLeg(task, deps) {
  const { queue, signal, babysit: sitter } = deps;
  if (!sitter) return ['failed', { result: 'ci-watch: this host has no CI watcher configured' }];
  let state = task.babysit;
  let round = state.rounds.at(-1);

  if (round.ci === 'pending') {
    const seen = await watchCi({ url: task.pr_url, round }, { ...sitter, signal });
    switch (seen.outcome) {
      case 'aborted':
        return signal?.reason === SHUTDOWN
          ? ['ci-watch', { babysit: state }]
          : ['cancelled', { babysit: state, result: 'cancelled (signal)' }];
      case 'merged':
        return ['completed', { babysit: { ...state, verdict: 'merged' }, result: `merged outside AgentForge: ${task.pr_url}` }];
      case 'closed':
        return ['failed', { babysit: { ...state, verdict: 'closed' }, result: `PR closed outside AgentForge: ${task.pr_url}` }];
      case 'timeout': {
        const minutes = Math.round(sitter.timeoutMs / 60_000);
        return ['failed', { babysit: { ...state, verdict: 'timeout' }, result: `CI on ${round.head.slice(0, 7)} did not finish in ${minutes} min` }];
      }
    }
    round = { ...round, ci: seen.outcome, failing: seen.failing, finished_at: (sitter.now ?? Date.now)() };
    state = withLastRound(state, round);
    queue.appendTrail(task.id, ciEntry(round, seen.checks));
    queue.updateStatus(task.id, 'ci-watch', { babysit: state });
  }

  if (round.ci === 'pass') {
    const after = ACTIONS[round.n === 0 ? FIRST_ACTION : 'push-fix'].next;
    return proceed(task, after, { pr_url: task.pr_url }, deps, { babysit: { ...state, verdict: 'green' } });
  }
  if (round.n >= state.max_rounds) {
    const names = round.failing.map((c) => c.name).join(', ');
    return ['failed', { babysit: state, result: `CI still failing after ${round.n} of ${state.max_rounds} fix rounds: ${names}` }];
  }
  return fixRound(task, state, round, deps);
}

/**
 * A fix round: a fresh harness run with consolidated scope on a fresh clone of
 * the PR branch (poteto-mode: fresh subagents by default), then the evidence gate
 * and push-fix through `settle`.
 */
async function fixRound(task, state, round, deps) {
  const { queue, eventBus = defaultEventBus, babysit: { ci } } = deps;
  const n = round.n + 1;
  const failing = await Promise.all(round.failing.map(async (c) => ({ ...c, log: await ci.logTail(task.repo, c.url) })));
  queue.appendTrail(task.id, {
    kind: 'decision',
    summary: `fix round ${n} of ${state.max_rounds}: fresh run on ${state.branch} for ${failing.map((c) => c.name).join(', ')}`,
    evidence: { source: 'babysit', round: n, branch: state.branch, head: round.head },
  });
  queue.updateStatus(task.id, 'fixing', { result: `fix round ${n} of ${state.max_rounds}` });
  eventBus.emit('task.fixing', { task, round: n });
  // The previous run's clone would be resumed as is; the round starts from the PR head.
  if (state.dir) await rm(state.dir, { recursive: true, force: true });
  const instruction = fixInstruction(task, { n, state, failing, trail: queue.trail(task.id) });
  return settle(task, deps, { task: { ...task, base: state.branch, instruction }, payload: { branch: state.branch, round: n } });
}

/**
 * The autonomy gate. Every host action runs through here, along the chain in
 * ACTIONS from `action`: an allowed action runs, the first that needs approval
 * parks the task with a pending approval, a denied one stops the chain.
 * `approved` lets the first action run without asking the policy; if it throws,
 * the error reaches the caller, which parks the task again.
 * @returns {Promise<[string, object]>} the status the task ends in and its fields
 */
async function proceed(task, action, payload, deps, fields, approved = false) {
  const { queue, policy = DEFAULT_POLICY } = deps;
  const extra = { ...fields };
  for (let name = action; name; name = ACTIONS[name].next) {
    const spec = ACTIONS[name];
    const rule = approved ? 'allow' : policy[name];
    if (!approved) queue.appendTrail(task.id, policyEntry(name, rule));
    if (rule === 'deny') return [spec.stopsAt ?? 'failed', { ...extra, result: `${name} denied by policy` }];
    if (rule === 'approve') {
      const approval = pendingApproval(task, name, payload);
      return ['needs-approval', { ...extra, approval, result: `awaiting approval: ${approval.summary}` }];
    }
    let done;
    try {
      done = await HOST_ACTIONS[name](task, payload, deps);
    } catch (err) {
      if (approved) throw err;
      return ['failed', { ...extra, result: `${name}: ${err.message}` }];
    }
    approved = false;
    done.trail.forEach((e) => queue.appendTrail(task.id, e));
    Object.assign(extra, done.extra);
    if (spec.watched && deps.babysit) {
      const { maxRounds, now = Date.now } = deps.babysit;
      const n = name === FIRST_ACTION ? 0 : payload.round;
      return ['ci-watch', { ...extra, babysit: startRound(task.babysit, { n, head: done.head, dir: payload.dir, branch: branchFor(task), maxRounds }, now()) }];
    }
    payload = done.next;
  }
  return ['completed', extra];
}

/** Record step changes and agent decisions for `task` while `fn` runs. */
async function followStream(task, eventBus, record, fn) {
  const stream = createStreamTrail();
  const onAgent = ({ taskId, event }) => taskId === task.id && record(stream.push(event));
  const onStep = ({ taskId, step }) => taskId === task.id && step != null && record([stream.step(step)]);
  eventBus.on('task.agent_event', onAgent);
  eventBus.on('task.step_changed', onStep);
  try {
    return await fn();
  } finally {
    eventBus.off('task.agent_event', onAgent);
    eventBus.off('task.step_changed', onStep);
  }
}
