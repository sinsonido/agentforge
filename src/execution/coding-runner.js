import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import defaultEventBus from '../core/event-bus.js';
import { verdict } from '../core/playbook.js';

/**
 * The life of one coding task after the orchestrator picks it:
 *
 *   queued → executing → pr-opened   the evidence gate passed and the PR exists
 *                      → failed      harness error, gate failure, or publish error
 *                      → cancelled   aborted or timed out; never published
 *
 * Each row is the final queue write and the event that announces it.
 */
const FINAL = Object.freeze({
  'pr-opened': 'task.completed',
  failed: 'task.failed',
  cancelled: 'task.failed',
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
 * Drive one queued coding task to a terminal status. Marks it `executing`
 * before the first await, so a caller that does not await still owns it.
 *
 * @param {object} task the queue's live task object
 * @param {{
 *   queue: { updateStatus(id: string, status: string, extra?: object): object },
 *   execute: (task: object, opts: { signal?: AbortSignal }) => Promise<object>,
 *   publish: (opts: { task: object, clone: { dir: string }, verdict: object, queue: object }) => Promise<string>,
 *   signal?: AbortSignal,
 *   eventBus?: import('node:events').EventEmitter,
 * }} deps
 * @returns {Promise<'pr-opened'|'failed'|'cancelled'>}
 */
export async function runCodingTask(task, { queue, execute, publish, signal, eventBus = defaultEventBus }) {
  queue.updateStatus(task.id, 'executing');
  eventBus.emit('task.executing', { task });
  const [status, extra] = await settle(task, { queue, execute, publish, signal });
  queue.updateStatus(task.id, status, extra);
  eventBus.emit(FINAL[status], { task, status, error: status === 'pr-opened' ? undefined : extra.result });
  return status;
}

async function settle(task, { queue, execute, publish, signal }) {
  let run;
  try {
    run = await execute(task, { signal });
  } catch (err) {
    return ['failed', { result: err.message }];
  }
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

  const gate = verdict({ ...run, cancelled: false });
  if (!gate.pass) return ['failed', { ...spend, result: `evidence gate: ${gate.reasons.join('; ')}` }];

  try {
    const url = await publish({ task, clone: { dir: run.dir }, verdict: gate, queue });
    return ['pr-opened', { ...spend, pr_url: url, result: url }];
  } catch (err) {
    return ['failed', { ...spend, result: `publish: ${err.message}` }];
  }
}
