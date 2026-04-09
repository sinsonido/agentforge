import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import eventBus from '../../src/core/event-bus.js';

// ─── Mock helpers ────────────────────────────────────────────────────────────

function makeRouter(models = {}, resolveOverride = null) {
  return {
    models,
    resolve: resolveOverride || ((_task, _ctx) => ({ action: 'execute', provider: 'mock', model: 'mock-model' })),
  };
}

function makeProviderRegistry(response) {
  const defaultResponse = { content: 'ok', tokens_in: 10, tokens_out: 20, tool_calls: [], finish_reason: 'stop' };
  return {
    execute: async (_providerId, _params) => response || defaultResponse,
  };
}

function makeOrchestrator(overrides = {}) {
  const taskQueue = overrides.taskQueue || new TaskQueue();
  const quotaManager = overrides.quotaManager || new QuotaManager();
  const router = overrides.router || makeRouter();
  const providerRegistry = overrides.providerRegistry || makeProviderRegistry();
  const config = overrides.config || {};
  const agents = overrides.agents || {};

  return new Orchestrator({ taskQueue, router, quotaManager, providerRegistry, agents, config });
}

// ─── Shared state ─────────────────────────────────────────────────────────────

let orchestrator;

afterEach(() => {
  if (orchestrator) {
    orchestrator.stop();
    orchestrator = null;
  }
  // Clear the singleton event bus log and all non-internal listeners
  eventBus.clearRecent();
  eventBus.removeAllListeners();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Orchestrator', () => {
  describe('constructor', () => {
    it('initializes with _running=false', () => {
      orchestrator = makeOrchestrator();
      assert.equal(orchestrator._running, false);
    });

    it('initializes project budget when config.project present', () => {
      orchestrator = makeOrchestrator({
        config: { project: { name: 'test-proj', budget: 50 } },
      });
      const pct = orchestrator.costTracker.getBudgetRemainingPct('test-proj');
      assert.equal(pct, 1.0);
    });

    it('uses default project name when config.project.name is absent', () => {
      orchestrator = makeOrchestrator({
        config: { project: { budget: 100 } },
      });
      const pct = orchestrator.costTracker.getBudgetRemainingPct('default');
      assert.equal(pct, 1.0);
    });
  });

  describe('start() / stop()', () => {
    it('start() sets _running=true and creates interval', () => {
      orchestrator = makeOrchestrator();
      orchestrator.start(10000); // long interval so tick never fires
      assert.equal(orchestrator._running, true);
      assert.ok(orchestrator._loopInterval !== null);
    });

    it('stop() sets _running=false and clears interval', () => {
      orchestrator = makeOrchestrator();
      orchestrator.start(10000);
      orchestrator.stop();
      assert.equal(orchestrator._running, false);
      assert.equal(orchestrator._loopInterval, null);
    });

    it('stop() is idempotent — no error if called twice', () => {
      orchestrator = makeOrchestrator();
      orchestrator.start(10000);
      assert.doesNotThrow(() => {
        orchestrator.stop();
        orchestrator.stop();
      });
      assert.equal(orchestrator._running, false);
    });
  });

  describe('_tick()', () => {
    it('returns early when not running', async () => {
      const taskQueue = new TaskQueue();
      taskQueue.add({ title: 'a task' });
      orchestrator = makeOrchestrator({ taskQueue });
      // _running is false by default
      await orchestrator._tick();
      // Task should remain queued — tick did nothing
      assert.equal(taskQueue.getByStatus('queued').length, 1);
    });

    it('returns early when no tasks in queue', async () => {
      orchestrator = makeOrchestrator();
      orchestrator._running = true;
      // No tasks — should resolve without error
      await assert.doesNotReject(() => orchestrator._tick());
    });

    it('sets waiting_quota when router returns action=wait', async () => {
      const taskQueue = new TaskQueue();
      const task = taskQueue.add({ title: 'quota test' });
      const router = makeRouter({}, () => ({ action: 'wait', provider: 'mock', model: 'mock-model' }));
      orchestrator = makeOrchestrator({ taskQueue, router });
      orchestrator._running = true;

      await orchestrator._tick();

      assert.equal(taskQueue.get(task.id).status, 'waiting_quota');
    });

    it('executes task and marks as completed on success', async () => {
      const taskQueue = new TaskQueue();
      const task = taskQueue.add({ title: 'success task' });
      const providerRegistry = makeProviderRegistry({ content: 'result text', tokens_in: 10, tokens_out: 20, tool_calls: [], finish_reason: 'stop' });
      orchestrator = makeOrchestrator({ taskQueue, providerRegistry });
      orchestrator._running = true;

      await orchestrator._tick();

      assert.equal(taskQueue.get(task.id).status, 'completed');
    });

    it('records cost after successful execution', async () => {
      const taskQueue = new TaskQueue();
      taskQueue.add({ title: 'cost task', agent_id: 'agent-1', project_id: 'proj-1' });
      const models = { 'mock-model': { provider: 'mock', cost_in: 1, cost_out: 2 } };
      const router = makeRouter(models);
      const providerRegistry = makeProviderRegistry({ content: 'done', tokens_in: 100, tokens_out: 200, tool_calls: [], finish_reason: 'stop' });
      const config = { project: { name: 'proj-1', budget: 999 } };
      orchestrator = makeOrchestrator({ taskQueue, router, providerRegistry, config });
      orchestrator._running = true;

      await orchestrator._tick();

      // cost = (100 * 1 / 1_000_000) + (200 * 2 / 1_000_000) = 0.0001 + 0.0004 = 0.0005
      const expectedCost = (100 * 1 / 1_000_000) + (200 * 2 / 1_000_000);
      const spent = orchestrator.costTracker.getBudgetStatus('proj-1').spent;
      assert.ok(Math.abs(spent - expectedCost) < 1e-10, `Expected spent ~${expectedCost}, got ${spent}`);
    });

    it('emits task.completed event on success', async () => {
      const taskQueue = new TaskQueue();
      const task = taskQueue.add({ title: 'emit task' });
      orchestrator = makeOrchestrator({ taskQueue });
      orchestrator._running = true;

      let completedEvent = null;
      eventBus.once('task.completed', (data) => { completedEvent = data; });

      await orchestrator._tick();

      assert.ok(completedEvent !== null, 'task.completed should be emitted');
      assert.equal(completedEvent.task.id, task.id);
    });

    it('marks task as failed and emits task.failed on provider error', async () => {
      const taskQueue = new TaskQueue();
      const task = taskQueue.add({ title: 'fail task' });
      const providerRegistry = {
        execute: async () => { throw new Error('provider boom'); },
      };
      orchestrator = makeOrchestrator({ taskQueue, providerRegistry });
      orchestrator._running = true;

      let failedEvent = null;
      eventBus.once('task.failed', (data) => { failedEvent = data; });

      await orchestrator._tick();

      assert.equal(taskQueue.get(task.id).status, 'failed');
      assert.ok(failedEvent !== null, 'task.failed should be emitted');
      assert.equal(failedEvent.error, 'provider boom');
    });
  });

  describe('_calculateCost()', () => {
    it('returns 0 when model not found', () => {
      orchestrator = makeOrchestrator();
      const cost = orchestrator._calculateCost('nonexistent-model', 1000, 2000);
      assert.equal(cost, 0);
    });

    it('calculates cost correctly from token counts', () => {
      const models = {
        'priced-model': { provider: 'mock', cost_in: 3, cost_out: 15 },
      };
      orchestrator = makeOrchestrator({ router: makeRouter(models) });
      // cost = (500 * 3 / 1_000_000) + (100 * 15 / 1_000_000)
      const expected = (500 * 3 / 1_000_000) + (100 * 15 / 1_000_000);
      const actual = orchestrator._calculateCost('priced-model', 500, 100);
      assert.ok(Math.abs(actual - expected) < 1e-10);
    });

    it('returns 0 for model with no cost fields', () => {
      const models = { 'free-model': { provider: 'mock' } };
      orchestrator = makeOrchestrator({ router: makeRouter(models) });
      assert.equal(orchestrator._calculateCost('free-model', 1000, 1000), 0);
    });
  });

  describe('event handlers', () => {
    it('quota.exhausted moves executing tasks to waiting_quota', () => {
      const taskQueue = new TaskQueue();
      const task = taskQueue.add({ title: 'exec task' });
      taskQueue.updateStatus(task.id, 'executing', { model_used: 'mock-model' });
      const models = { 'mock-model': { provider: 'mock-provider' } };
      orchestrator = makeOrchestrator({ taskQueue, router: makeRouter(models) });

      eventBus.emit('quota.exhausted', { provider: 'mock-provider' });

      assert.equal(taskQueue.get(task.id).status, 'waiting_quota');
    });

    it('quota.exhausted does not affect tasks on a different provider', () => {
      const taskQueue = new TaskQueue();
      const task = taskQueue.add({ title: 'other provider task' });
      taskQueue.updateStatus(task.id, 'executing', { model_used: 'other-model' });
      const models = { 'other-model': { provider: 'other-provider' } };
      orchestrator = makeOrchestrator({ taskQueue, router: makeRouter(models) });

      eventBus.emit('quota.exhausted', { provider: 'mock-provider' });

      assert.equal(taskQueue.get(task.id).status, 'executing');
    });

    it('quota.reset moves waiting_quota tasks back to queued', () => {
      const taskQueue = new TaskQueue();
      const task = taskQueue.add({ title: 'waiting task' });
      taskQueue.updateStatus(task.id, 'waiting_quota');
      orchestrator = makeOrchestrator({ taskQueue });

      let resumedEvent = null;
      eventBus.once('agent.resumed', (data) => { resumedEvent = data; });

      eventBus.emit('quota.reset', { provider: 'mock' });

      assert.equal(taskQueue.get(task.id).status, 'queued');
      assert.ok(resumedEvent !== null, 'agent.resumed should be emitted');
    });

    it('budget.exceeded pauses queued tasks for matching project', () => {
      const taskQueue = new TaskQueue();
      const task = taskQueue.add({ title: 'proj task', project_id: 'proj-x' });
      orchestrator = makeOrchestrator({ taskQueue });

      eventBus.emit('budget.exceeded', { projectId: 'proj-x' });

      assert.equal(taskQueue.get(task.id).status, 'paused_budget');
    });

    it('budget.exceeded pauses tasks with no project_id for matching project', () => {
      const taskQueue = new TaskQueue();
      const task = taskQueue.add({ title: 'no-project task' });
      // task.project_id is null — matches any projectId
      orchestrator = makeOrchestrator({ taskQueue });

      eventBus.emit('budget.exceeded', { projectId: 'some-proj' });

      assert.equal(taskQueue.get(task.id).status, 'paused_budget');
    });

    it('budget.exceeded does not affect queued tasks for a different project', () => {
      const taskQueue = new TaskQueue();
      const task = taskQueue.add({ title: 'other proj task', project_id: 'proj-b' });
      orchestrator = makeOrchestrator({ taskQueue });

      eventBus.emit('budget.exceeded', { projectId: 'proj-a' });

      assert.equal(taskQueue.get(task.id).status, 'queued');
    });
  });
});
