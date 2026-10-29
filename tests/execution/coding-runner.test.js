import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runCodingTask, decideApproval, executorConfig } from '../../src/execution/coding-runner.js';
import { TaskQueue } from '../../src/core/task-queue.js';

const SHA = 'c'.repeat(40);
const PR = 'https://github.com/acme/app/pull/7';

function stoppedRun(over = {}) {
  return {
    outcome: 'stopped', cancelReason: null, error: null,
    costUsd: 0.42, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
    commits: [{ sha: SHA, subject: 'fix: parser' }], uncommitted: false,
    observedTestRuns: [{ seq: 9, command: 'npm test', passed: true }], lastEditSeq: 4,
    step: 6, dir: '/state/tasks/t1/repo',
    ...over,
  };
}

describe('runCodingTask', () => {
  let queue;
  let task;
  let bus;
  let published;
  let events;

  const publish = async (opts) => {
    published.push(opts);
    return PR;
  };

  function runWith(execute, extra = {}) {
    return runCodingTask(task, { queue, execute, publish, eventBus: bus, ...extra });
  }

  beforeEach(() => {
    queue = new TaskQueue();
    task = queue.admit({
      kind: 'coding', title: 'Fix the parser', repo: 'acme/app', base: 'master',
      instruction: 'Fix it', issue: 42, playbook: 'bug-fix', test_command: 'npm test',
    }).task;
    bus = new EventEmitter();
    published = [];
    events = [];
    for (const e of ['task.executing', 'task.completed', 'task.failed']) bus.on(e, (d) => events.push([e, d.status]));
  });

  it('marks the task executing before the first await', () => {
    const pending = runWith(() => new Promise(() => {}));
    assert.equal(queue.get(task.id).status, 'executing');
    assert.ok(pending instanceof Promise);
  });

  it('opens the PR when the gate passes and stores pr_url, step and spend', async () => {
    const status = await runWith(async () => stoppedRun(), { policy: { publish: 'allow', merge: 'deny' } });

    assert.equal(status, 'pr-opened');
    const stored = queue.get(task.id);
    assert.equal(stored.status, 'pr-opened');
    assert.equal(stored.pr_url, PR);
    assert.equal(stored.step, 6);
    assert.equal(stored.cost, 0.42);
    assert.equal(stored.tokens_in, 100);
    assert.equal(stored.tokens_out, 5);
    assert.ok(stored.completed_at);
    assert.equal(published.length, 1);
    assert.equal(published[0].clone.dir, '/state/tasks/t1/repo');
    assert.deepEqual(published[0].verdict.testRun, { command: 'npm test', sha: SHA, counts: null });
    assert.deepEqual(events, [['task.executing', undefined], ['task.completed', 'pr-opened']]);
  });

  it('fails with the gate reasons and does not publish', async () => {
    const status = await runWith(async () => stoppedRun({ commits: [], observedTestRuns: [] }));

    assert.equal(status, 'failed');
    assert.equal(queue.get(task.id).result, 'evidence gate: no commit ahead of base; `npm test` did not pass after the last edit');
    assert.equal(published.length, 0);
  });

  it('ends cancelled and never publishes a cancelled run, even with passing evidence', async () => {
    const status = await runWith(async () => stoppedRun({ outcome: 'cancelled', cancelReason: 'timeout' }));

    assert.equal(status, 'cancelled');
    assert.equal(queue.get(task.id).result, 'cancelled (timeout)');
    assert.equal(published.length, 0);
    assert.deepEqual(events.at(-1), ['task.failed', 'cancelled']);
  });

  it('ends cancelled when aborted after the harness stopped', async () => {
    const controller = new AbortController();
    const status = await runWith(async () => {
      controller.abort();
      return stoppedRun();
    }, { signal: controller.signal });

    assert.equal(status, 'cancelled');
    assert.equal(published.length, 0);
  });

  it('fails with the harness error', async () => {
    const status = await runWith(async () => stoppedRun({ outcome: 'error', error: 'harness result error_max_budget_usd' }));

    assert.equal(status, 'failed');
    assert.equal(queue.get(task.id).result, 'harness result error_max_budget_usd');
  });

  it('fails when the executor throws, for example on a clone error', async () => {
    const status = await runWith(async () => { throw new Error('git clone failed'); });

    assert.equal(status, 'failed');
    assert.equal(queue.get(task.id).result, 'git clone failed');
  });

  it('fails when publish throws', async () => {
    const status = await runCodingTask(task, {
      queue, eventBus: bus,
      execute: async () => stoppedRun(),
      publish: async () => { throw new Error('gh pr create failed: auth'); },
    });

    assert.equal(status, 'failed');
    assert.equal(queue.get(task.id).result, 'publish: gh pr create failed: auth');
  });
});

describe('executorConfig', () => {
  it('maps the executor block to absolute executor options and drops empty values', () => {
    const { concurrency, options } = executorConfig({
      state_dir: '/srv/state', pstack_dir: '~/pstack', claude_bin: '/opt/claude',
      oauth_token: '', budget_usd: 1.5, timeout_minutes: 10, model: 'sonnet',
    });

    assert.equal(concurrency, 1);
    assert.deepEqual(options, {
      stateDir: '/srv/state',
      pstackDir: join(homedir(), 'pstack'),
      claudeBin: '/opt/claude',
      model: 'sonnet',
      budgetUsd: 1.5,
      timeoutMs: 600_000,
    });
  });

  it('reads the concurrency limit', () => {
    assert.equal(executorConfig({ state_dir: '/s', pstack_dir: '/p', concurrency: 3 }).concurrency, 3);
  });

  it('refuses a block without state_dir or pstack_dir', () => {
    assert.throws(() => executorConfig({ image: 'node:24' }), /state_dir, pstack_dir required/);
  });
});
