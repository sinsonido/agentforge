import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../src/core/task-queue.js';
import { QuotaManager } from '../src/core/quota-tracker.js';
import { Router } from '../src/routing/router.js';

describe('TaskQueue', () => {
  it('should add tasks and retrieve by priority', () => {
    const q = new TaskQueue();
    q.add({ title: 'Low task', priority: 'low' });
    q.add({ title: 'High task', priority: 'high' });
    q.add({ title: 'Medium task', priority: 'medium' });

    const next = q.next();
    assert.equal(next.title, 'High task');
  });

  it('should respect FIFO within same priority', () => {
    const q = new TaskQueue();
    q.add({ title: 'First', priority: 'high' });
    q.add({ title: 'Second', priority: 'high' });

    const next = q.next();
    assert.equal(next.title, 'First');
  });

  it('should wait for dependencies', () => {
    const q = new TaskQueue();
    const t1 = q.add({ title: 'Dependency', priority: 'high' });
    q.add({ title: 'Dependent', priority: 'high', depends_on: [t1.id] });

    // Dependent should not be returned (dep not completed)
    const next = q.next();
    assert.equal(next.title, 'Dependency');

    // Complete dependency
    q.updateStatus(t1.id, 'completed');

    // Now dependent is eligible (since t1 was taken out of 'queued')
    const next2 = q.next();
    assert.equal(next2.title, 'Dependent');
  });

  it('should track stats correctly', () => {
    const q = new TaskQueue();
    q.add({ title: 'A' });
    q.add({ title: 'B' });
    const t = q.add({ title: 'C' });
    q.updateStatus(t.id, 'completed');

    const stats = q.stats();
    assert.equal(stats.total, 3);
    assert.equal(stats.queued, 2);
    assert.equal(stats.completed, 1);
  });
});

describe('QuotaManager', () => {
  it('should allow execution when under quota', () => {
    const qm = new QuotaManager();
    qm.addProvider('test', { max_requests_per_minute: 100, max_tokens_per_minute: 100000 });

    assert.equal(qm.canExecute('test', 1000), true);
  });

  it('should block execution when quota exhausted', () => {
    const qm = new QuotaManager();
    qm.addProvider('test', { max_requests_per_minute: 2, max_tokens_per_minute: 1000 });

    // Use up quota
    qm.recordUsage('test', 500, 0);
    qm.recordUsage('test', 500, 0);

    // Should be exhausted (2/2 requests, 1000/1000 tokens)
    assert.equal(qm.canExecute('test', 100), false);
  });

  it('should return status with usage info', () => {
    const qm = new QuotaManager();
    qm.addProvider('test', { max_requests_per_minute: 100, max_tokens_per_minute: 100000 });
    qm.recordUsage('test', 5000, 1000);

    const status = qm.getStatus('test');
    assert.equal(status.provider, 'test');
    assert.equal(status.requests.used, 1);
    assert.equal(status.tokens.used, 5000);
  });

  it('should allow unknown providers (no limits)', () => {
    const qm = new QuotaManager();
    assert.equal(qm.canExecute('unknown', 999999), true);
  });
});

describe('Router', () => {
  const models = {
    'claude-opus-4': { provider: 'anthropic', tier: 1, cost_in: 15, cost_out: 75, context: 200000 },
    'claude-sonnet-4': { provider: 'anthropic', tier: 2, cost_in: 3, cost_out: 15, context: 200000 },
    'gemini-2.5-pro': { provider: 'google', tier: 1, cost_in: 1.25, cost_out: 10, context: 1000000 },
    'deepseek-v3': { provider: 'deepseek', tier: 3, cost_in: 0.27, cost_out: 1.1, context: 128000 },
    'codestral:22b': { provider: 'ollama', tier: 3, cost_in: 0, cost_out: 0, context: 32000 },
  };

  const rules = [
    { match: { context_tokens_gt: 200000 }, force: 'gemini-2.5-pro' },
    { match: { type: ['architecture', 'planning'] }, tier: 1, prefer: 'claude-opus-4' },
    { match: { type: ['implement'] }, tier: 2, prefer: 'claude-sonnet-4' },
    { match: { type: ['test', 'script'] }, tier: 3, prefer: 'codestral:22b' },
  ];

  function makeRouter() {
    const qm = new QuotaManager();
    // All providers have quota
    qm.addProvider('anthropic', { max_requests_per_minute: 100, max_tokens_per_minute: 400000 });
    qm.addProvider('google', { max_requests_per_minute: 60, max_tokens_per_minute: 400000 });
    qm.addProvider('deepseek', { max_requests_per_minute: 120, max_tokens_per_minute: 400000 });
    // Ollama has no quota
    return new Router({ rules, models, agents: {}, quotaManager: qm });
  }

  it('should route architecture tasks to T1', () => {
    const router = makeRouter();
    const result = router.resolve({ type: 'architecture', context_tokens_estimate: 0 });
    assert.equal(result.action, 'execute');
    assert.equal(result.model, 'claude-opus-4');
    assert.equal(result.tier, 1);
  });

  it('should route implement tasks to T2', () => {
    const router = makeRouter();
    const result = router.resolve({ type: 'implement', context_tokens_estimate: 0 });
    assert.equal(result.action, 'execute');
    assert.equal(result.model, 'claude-sonnet-4');
  });

  it('should route test tasks to T3 local', () => {
    const router = makeRouter();
    const result = router.resolve({ type: 'test', context_tokens_estimate: 0 });
    assert.equal(result.action, 'execute');
    assert.equal(result.model, 'codestral:22b');
    assert.equal(result.provider, 'ollama');
  });

  it('should force Gemini for large context', () => {
    const router = makeRouter();
    const result = router.resolve({ type: 'implement', context_tokens_estimate: 300000 });
    assert.equal(result.model, 'gemini-2.5-pro');
  });

  it('should respect force_model override', () => {
    const router = makeRouter();
    const result = router.resolve({ type: 'test', force_model: 'claude-opus-4', context_tokens_estimate: 0 });
    assert.equal(result.model, 'claude-opus-4');
  });
});
