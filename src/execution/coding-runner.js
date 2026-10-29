import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import defaultEventBus from '../core/event-bus.js';
import {
  ACTIONS, DEFAULT_POLICY, FIRST_ACTION, decide, operatorEntry, pendingApproval, policyEntry,
} from '../core/autonomy.js';
import { verdict } from '../core/playbook.js';
import { createStreamTrail, gateEntries, prEntry, readDecisionLogs, verdictEvidence } from '../core/trail.js';

/**
 * The life of one coding task after the orchestrator picks it:
 *
 *   queued → executing → pr-opened        the PR exists; merge was denied or rejected
 *                      → completed        the PR is merged
 *                      → needs-approval   a host action waits for the operator
 *                      → failed           harness error, gate failure, denied publish, or action error
 *                      → cancelled        aborted or timed out; never published
 *   needs-approval → executing            approved: the parked action runs
 *                  → pr-opened|cancelled  rejected: where the action before it left the task
 *
 * After the evidence gate passes, every host action (publish, then merge) goes
 * through the autonomy gate, `proceed`. Each row is the queue write and the
 * event that announces it.
 *
 * Along the way it writes the task's decision trail: steps and skipped steps
 * from the agent stream, the agent's own decision log from the clone, each
 * gate check, each autonomy decision, and the commits, test run and PR it accepted.
 */
const FINAL = Object.freeze({
  'pr-opened': 'task.completed',
  completed: 'task.completed',
  'needs-approval': 'task.needs_approval',
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
    return { extra: { pr_url: url, result: url }, trail: [prEntry(url)], next: { pr_url: url } };
  },
  async merge(task, { pr_url }, { merge }) {
    await merge({ task, url: pr_url });
    const entry = { kind: 'evidence', summary: `merged ${pr_url}`, evidence: { url: pr_url, merged: true } };
    return { extra: { result: `merged ${pr_url}` }, trail: [entry], next: null };
  },
});

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
 *   policy?: import('../core/autonomy.js').Policy,
 *   eventBus?: import('node:events').EventEmitter,
 * }} HostDeps
 */

/**
 * Drive one queued coding task until it ends or parks in `needs-approval`.
 * Marks it `executing` before the first await, so a caller that does not await
 * still owns it.
 *
 * @param {object} task the queue's live task object
 * @param {HostDeps & {
 *   execute: (task: object, opts: { signal?: AbortSignal }) => Promise<object>,
 *   signal?: AbortSignal,
 * }} deps
 * @returns {Promise<'pr-opened'|'completed'|'needs-approval'|'failed'|'cancelled'>}
 */
export async function runCodingTask(task, deps) {
  const { queue, eventBus = defaultEventBus } = deps;
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
  queue.updateStatus(task.id, status, extra);
  const bad = status === 'failed' || status === 'cancelled';
  eventBus.emit(FINAL[status], { task, status, error: bad ? extra.result : undefined });
  return status;
}

async function settle(task, deps) {
  const { queue, execute, signal, eventBus = defaultEventBus } = deps;
  const record = (entries) => entries.forEach((e) => queue.appendTrail(task.id, e));
  let run;
  try {
    run = await followStream(task, eventBus, record, () => execute(task, { signal }));
  } catch (err) {
    return ['failed', { result: err.message }];
  }
  if (run.dir) record(await readDecisionLogs(run.dir));
  const usage = run.usage ?? {};
  const spend = {
    cost: run.costUsd ?? 0,
    tokens_in: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    tokens_out: usage.output_tokens ?? 0,
    step: run.step ?? task.step ?? null,
  };
  Object.assign(task, spend);

  if (run.outcome === 'cancelled') return ['cancelled', { ...spend, result: `cancelled (${run.cancelReason})` }];
  if (signal?.aborted) return ['cancelled', { ...spend, result: 'cancelled (signal)' }];
  if (run.outcome !== 'stopped') return ['failed', { ...spend, result: run.error }];

  const gate = verdict({ ...run, testCommand: task.test_command, cancelled: false });
  record(gateEntries(gate));
  if (!gate.pass) return ['failed', { ...spend, result: `evidence gate: ${gate.reasons.join('; ')}` }];
  record(verdictEvidence(gate));

  return proceed(task, FIRST_ACTION, { dir: run.dir, verdict: gate }, deps, spend);
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
