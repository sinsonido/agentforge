import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import eventBus from '../../src/core/event-bus.js';
import { SHUTDOWN } from '../../src/execution/coding-runner.js';

const ORCHESTRATOR_EVENTS = ['quota.exhausted', 'quota.reset', 'budget.exceeded', 'budget.warning', 'task.step_changed'];
const OK = { content: 'result text', tokens_in: 10, tokens_out: 20, tool_calls: [], finish_reason: 'stop' };

let running = [];

afterEach(() => {
  for (const o of running) o.stop();
  running = [];
  for (const evt of ORCHESTRATOR_EVENTS) eventBus.removeAllListeners(evt);
});

function makeOrchestrator({
  taskQueue = new TaskQueue(),
  models = {},
  resolve = () => ({ action: 'execute', provider: 'mock', model: 'mock-model' }),
  execute = async () => OK,
  agents = {},
  config = {},
  coding = null,
  intake = null,
} = {}) {
  const calls = [];
  const providerRegistry = {
    async execute(providerId, params) {
      calls.push({ providerId, params });
      return execute(providerId, params);
    },
  };
  const orchestrator = new Orchestrator({
    taskQueue,
    router: { models, resolve },
    quotaManager: new QuotaManager(),
    providerRegistry,
    agents,
    config,
    coding,
    intake,
  });
  return { orchestrator, taskQueue, calls };
}

function start(orchestrator) {
  running.push(orchestrator);
  orchestrator.start(5);
}

async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function captureNext(event) {
  return new Promise((resolve) => eventBus.once(event, resolve));
}

describe('Orchestrator execution loop', () => {
  it('runs a queued task through the routed provider and stores the result', async () => {
    const { orchestrator, taskQueue, calls } = makeOrchestrator({
      agents: { dev: { max_tokens_per_task: 1234 } },
    });
    const task = taskQueue.add({ title: 'write a function', agent_id: 'dev' });
    const completed = captureNext('task.completed');

    start(orchestrator);
    const event = await completed;

    const stored = taskQueue.get(task.id);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.result, 'result text');
    assert.equal(stored.model_used, 'mock-model');
    assert.equal(stored.tokens_in, 10);
    assert.equal(stored.tokens_out, 20);
    assert.equal(event.task.id, task.id);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].providerId, 'mock');
    assert.equal(calls[0].params.model, 'mock-model');
    assert.equal(calls[0].params.max_tokens, 1234);
    assert.ok(calls[0].params.messages.some((m) => m.content.includes('write a function')));
  });

  it('emits one cost.recorded priced per million tokens', async () => {
    const { orchestrator, taskQueue } = makeOrchestrator({
      models: { 'mock-model': { provider: 'mock', cost_in: 3, cost_out: 15 } },
      execute: async () => ({ ...OK, tokens_in: 2_000_000, tokens_out: 1_000_000 }),
      config: { project: { name: 'proj-1', budget: 1000 } },
    });
    const costs = [];
    const onCost = (d) => costs.push(d);
    eventBus.on('cost.recorded', onCost);
    const task = taskQueue.add({ title: 'priced', agent_id: 'agent-1', project_id: 'proj-1' });
    const completed = captureNext('task.completed');

    start(orchestrator);
    await completed;
    eventBus.off('cost.recorded', onCost);

    assert.equal(costs.length, 1);
    assert.partialDeepStrictEqual(costs[0], {
      projectId: 'proj-1',
      agentId: 'agent-1',
      model: 'mock-model',
      tokensIn: 2_000_000,
      tokensOut: 1_000_000,
      cost: 21,
      taskId: task.id,
      phase: 'build',
    });
    assert.equal(taskQueue.get(task.id).cost, 21);
  });

  it('records zero cost for a model with no pricing', async () => {
    const { orchestrator, taskQueue } = makeOrchestrator();
    const task = taskQueue.add({ title: 'free' });
    const completed = captureNext('task.completed');

    start(orchestrator);
    const event = await completed;

    assert.equal(event.cost, 0);
    assert.equal(taskQueue.get(task.id).cost, 0);
  });

  it('marks the task failed and emits task.failed when the provider throws', async () => {
    const { orchestrator, taskQueue } = makeOrchestrator({
      execute: async () => { throw new Error('provider boom'); },
    });
    const task = taskQueue.add({ title: 'fails' });
    const failed = captureNext('task.failed');

    start(orchestrator);
    const event = await failed;

    assert.equal(event.error, 'provider boom');
    assert.equal(taskQueue.get(task.id).status, 'failed');
    assert.equal(taskQueue.get(task.id).result, 'provider boom');
  });

  it('parks the task in waiting_quota without calling a provider when the router says wait', async () => {
    const { orchestrator, taskQueue, calls } = makeOrchestrator({
      resolve: () => ({ action: 'wait', reason: 'all providers exhausted' }),
    });
    const task = taskQueue.add({ title: 'blocked' });

    start(orchestrator);
    await waitFor(() => taskQueue.get(task.id).status === 'waiting_quota');

    assert.equal(calls.length, 0);
  });

  it('picks up no tasks after stop()', async () => {
    const { orchestrator, taskQueue, calls } = makeOrchestrator();
    start(orchestrator);
    orchestrator.stop();
    const task = taskQueue.add({ title: 'too late' });

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(taskQueue.get(task.id).status, 'queued');
    assert.equal(calls.length, 0);
  });
});

describe('Orchestrator event reactions', () => {
  it('quota.exhausted parks executing tasks on that provider only', () => {
    const { taskQueue } = makeOrchestrator({
      models: { 'a-model': { provider: 'a' }, 'b-model': { provider: 'b' } },
    });
    const onA = taskQueue.add({ title: 'on a', agent_id: 'dev' });
    const onB = taskQueue.add({ title: 'on b' });
    taskQueue.updateStatus(onA.id, 'executing', { model_used: 'a-model' });
    taskQueue.updateStatus(onB.id, 'executing', { model_used: 'b-model' });
    const paused = [];
    const onPaused = (d) => paused.push(d);
    eventBus.on('agent.paused', onPaused);

    eventBus.emit('quota.exhausted', { provider: 'a' });
    eventBus.off('agent.paused', onPaused);

    assert.equal(taskQueue.get(onA.id).status, 'waiting_quota');
    assert.equal(taskQueue.get(onB.id).status, 'executing');
    assert.deepEqual(paused, [{ agent: 'dev', reason: 'quota_exhausted' }]);
  });

  it('quota.reset re-queues waiting tasks and emits agent.resumed', () => {
    const { taskQueue } = makeOrchestrator();
    const task = taskQueue.add({ title: 'waiting', agent_id: 'dev' });
    taskQueue.updateStatus(task.id, 'waiting_quota');
    const resumed = captureNext('agent.resumed');

    eventBus.emit('quota.reset', { provider: 'mock' });

    assert.equal(taskQueue.get(task.id).status, 'queued');
    return resumed.then((d) => assert.deepEqual(d, { agent: 'dev' }));
  });

  it('budget.exceeded pauses queued tasks of that project and unscoped ones', () => {
    const { taskQueue } = makeOrchestrator();
    const mine = taskQueue.add({ title: 'mine', project_id: 'proj-a' });
    const unscoped = taskQueue.add({ title: 'unscoped' });
    const other = taskQueue.add({ title: 'other', project_id: 'proj-b' });

    eventBus.emit('budget.exceeded', { projectId: 'proj-a', spent_pct: 0.97 });

    assert.equal(taskQueue.get(mine.id).status, 'paused_budget');
    assert.equal(taskQueue.get(unscoped.id).status, 'paused_budget');
    assert.equal(taskQueue.get(other.id).status, 'queued');
  });
});

const CODING = { kind: 'coding', repo: 'acme/app', base: 'master', instruction: 'Fix it', playbook: 'bug-fix' };

function fakeCoding(concurrency = 1) {
  const runs = [];
  return {
    runs,
    coding: {
      concurrency,
      run(task, signal) {
        let finish;
        const done = new Promise((r) => { finish = r; });
        const queue = runs.queue;
        queue.updateStatus(task.id, 'executing');
        signal.addEventListener('abort', () => {
          queue.updateStatus(task.id, 'cancelled');
          finish();
        });
        runs.push({ task, signal, finish: (status = 'pr-opened', extra = {}) => { queue.updateStatus(task.id, status, extra); finish(); } });
        return done;
      },
    },
  };
}

describe('Orchestrator coding tasks', () => {
  function setup(concurrency = 1) {
    const fake = fakeCoding(concurrency);
    const made = makeOrchestrator({ coding: fake.coding });
    fake.runs.queue = made.taskQueue;
    return { ...made, runs: fake.runs };
  }

  it('routes coding tasks to the coding runner and text tasks to the provider', async () => {
    const { orchestrator, taskQueue, calls, runs } = setup();
    const code = taskQueue.add({ ...CODING, issue: 1 });
    const text = taskQueue.add({ title: 'plain', priority: 'low' });

    start(orchestrator);
    await waitFor(() => taskQueue.get(text.id).status === 'completed');

    assert.deepEqual(runs.map((r) => r.task.id), [code.id]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].params.messages.some((m) => m.content.includes('plain')));
  });

  it('runs at most `concurrency` coding tasks at a time', async () => {
    const { orchestrator, taskQueue, runs } = setup(1);
    const first = taskQueue.add({ ...CODING, issue: 1 });
    const second = taskQueue.add({ ...CODING, issue: 2 });

    start(orchestrator);
    await waitFor(() => runs.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(runs.length, 1);
    assert.equal(taskQueue.get(second.id).status, 'queued');

    runs[0].finish();
    await waitFor(() => runs.length === 2);
    assert.equal(taskQueue.get(first.id).status, 'pr-opened');
    assert.equal(runs[1].task.id, second.id);
  });

  it('records the spend of a finished coding task once', async () => {
    const { orchestrator, taskQueue, runs } = setup();
    taskQueue.add({ ...CODING, issue: 1 });
    const costs = [];
    const onCost = (d) => costs.push(d);
    eventBus.on('cost.recorded', onCost);

    start(orchestrator);
    await waitFor(() => runs.length === 1);
    runs[0].finish('pr-opened', { cost: 0.5, tokens_in: 100, tokens_out: 7 });
    await waitFor(() => costs.length === 1);
    eventBus.off('cost.recorded', onCost);

    assert.equal(costs.length, 1);
    assert.partialDeepStrictEqual(costs[0], {
      projectId: 'default', agentId: null, model: 'coding-executor', tokensIn: 100, tokensOut: 7, cost: 0.5,
      taskId: runs[0].task.id, repo: 'acme/app', phase: 'build',
    });
  });

  it('cancelTask aborts a running coding task', async () => {
    const { orchestrator, taskQueue, runs } = setup();
    const task = taskQueue.add({ ...CODING, issue: 1 });

    start(orchestrator);
    await waitFor(() => runs.length === 1);

    assert.equal(orchestrator.cancelTask(task.id), true);
    assert.equal(runs[0].signal.aborted, true);
    assert.equal(taskQueue.get(task.id).status, 'cancelled');
    assert.equal(orchestrator.cancelTask('nope'), false);
  });

  it('stop() cancels every running coding task and resolves once they settle', async () => {
    const { orchestrator, taskQueue, runs } = setup(2);
    const a = taskQueue.add({ ...CODING, issue: 1 });
    const b = taskQueue.add({ ...CODING, issue: 2 });

    start(orchestrator);
    await waitFor(() => runs.length === 2);
    await orchestrator.stop();

    assert.ok(runs.every((r) => r.signal.aborted));
    assert.equal(taskQueue.get(a.id).status, 'cancelled');
    assert.equal(taskQueue.get(b.id).status, 'cancelled');
    assert.equal(orchestrator.cancelTask(a.id), false);
  });

  it('stop() gives up waiting on a run that ignores the abort after graceMs', async () => {
    const { orchestrator, taskQueue } = makeOrchestrator({
      coding: { concurrency: 1, run: () => new Promise(() => {}) },
    });
    taskQueue.add({ ...CODING, issue: 1 });

    start(orchestrator);
    await waitFor(() => orchestrator._codingRuns.size === 1);
    const t0 = Date.now();
    await orchestrator.stop({ graceMs: 50 });
    assert.ok(Date.now() - t0 < 1000);
  });

  it('gives a task left in ci-watch its next leg before any queued task, and records only what each leg spent', async () => {
    const { orchestrator, taskQueue, runs } = setup(1);
    const watched = taskQueue.add({ ...CODING, issue: 1 });
    taskQueue.updateStatus(watched.id, 'ci-watch', { cost: 0.5, tokens_in: 100, tokens_out: 7 });
    const queued = taskQueue.add({ ...CODING, issue: 2 });
    const costs = [];
    const onCost = (d) => costs.push(d.cost);
    eventBus.on('cost.recorded', onCost);

    start(orchestrator);
    await waitFor(() => runs.length === 1);
    assert.equal(runs[0].task.id, watched.id);
    runs[0].finish('needs-approval', { cost: 0.75, tokens_in: 150, tokens_out: 9 });
    await waitFor(() => runs.length === 2);
    eventBus.off('cost.recorded', onCost);

    assert.equal(runs[1].task.id, queued.id);
    assert.deepEqual(costs, [0.25]);
  });

  it('stop() aborts with the shutdown reason, so a CI watch can stay for the next process', async () => {
    const { orchestrator, taskQueue, runs } = setup();
    taskQueue.add({ ...CODING, issue: 1 });

    start(orchestrator);
    await waitFor(() => runs.length === 1);
    await orchestrator.stop();
    assert.equal(runs[0].signal.reason, SHUTDOWN);
  });

  it('leaves coding tasks queued without a coding runner', async () => {
    const { orchestrator, taskQueue, calls } = makeOrchestrator();
    const task = taskQueue.add({ ...CODING, issue: 1 });

    start(orchestrator);
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(taskQueue.get(task.id).status, 'queued');
    assert.equal(calls.length, 0);
  });

  it('persists step changes through the queue', () => {
    const { taskQueue } = makeOrchestrator();
    const task = taskQueue.add({ ...CODING, issue: 1 });
    taskQueue.updateStatus(task.id, 'executing');

    eventBus.emit('task.step_changed', { taskId: task.id, step: 4 });

    assert.equal(taskQueue.get(task.id).step, 4);
    assert.equal(taskQueue.get(task.id).status, 'executing');
  });

  it('starts intake with the loop and stops it with the loop', () => {
    const log = [];
    const { orchestrator } = makeOrchestrator({ intake: { start: () => log.push('start'), stop: () => log.push('stop') } });

    start(orchestrator);
    orchestrator.stop();

    assert.deepEqual(log, ['start', 'stop']);
  });
});
