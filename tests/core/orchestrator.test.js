import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import eventBus from '../../src/core/event-bus.js';

const ORCHESTRATOR_EVENTS = ['quota.exhausted', 'quota.reset', 'budget.exceeded', 'budget.warning'];
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

    assert.deepEqual(costs, [{
      projectId: 'proj-1',
      agentId: 'agent-1',
      model: 'mock-model',
      tokensIn: 2_000_000,
      tokensOut: 1_000_000,
      cost: 21,
    }]);
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
