/**
 * @file tests/api/server.test.js
 * @description Unit tests for src/api/server.js — startServer() REST endpoints.
 *
 * Uses Node 24 built-in test runner + fetch.
 * NODE_ENV=test is expected so auth and rate-limiting are bypassed.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import eventBus from '../../src/core/event-bus.js';
import { startServer } from '../../src/api/server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrchestrator(running = false) {
  return {
    _running: running,
    start() { this._running = true; },
    stop()  { this._running = false; },
  };
}

function makeForge(overrides = {}) {
  const taskQueue    = new TaskQueue();
  const quotaManager = new QuotaManager();
  const orchestrator = makeOrchestrator();
  return {
    taskQueue,
    quotaManager,
    eventBus,
    orchestrator,
    agentPool:        null,
    costTracker:      null,
    db:               null,
    providerRegistry: null,
    config:           {},
    ...overrides,
  };
}

async function json(res) {
  return res.json();
}

// ---------------------------------------------------------------------------
// Shared server + forge — all suites reuse the same HTTP server instance.
// Each suite resets queue + eventBus in beforeEach to prevent cross-test
// contamination.
// ---------------------------------------------------------------------------

let server;
let port;
let forge;

// Helper: build a URL scoped to the shared server
function url(path) {
  return `http://127.0.0.1:${port}/api${path}`;
}

// Helper: POST with JSON body
async function post(path, body) {
  return fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Helper: GET
async function get(path) {
  return fetch(url(path));
}

// Global setup — start one server for the whole file
{
  forge  = makeForge();
  server = startServer(forge, 0);
  // Wait for the server to be assigned a port
  await new Promise(resolve => server.once('listening', resolve));
  port = server.address().port;
}

// Global teardown — close server after all tests
after(() => {
  server.close();
  forge.quotaManager.stopWatcher();
});

// Reset shared state before every test
beforeEach(() => {
  // Fresh queue (to avoid ordering / leftover task pollution)
  forge.taskQueue.clear();
  // Clear event log
  eventBus.clearRecent();
  // Make orchestrator non-running by default
  forge.orchestrator._running = false;
});

// ===========================================================================
// GET /api/status
// ===========================================================================

describe('GET /api/status', () => {
  it('returns ok with task stats and quotas', async () => {
    forge.taskQueue.add({ title: 'Test task' });
    const res = await get('/status');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.ok(typeof body.tasks === 'object', 'should include tasks stats');
    assert.ok(typeof body.quotas === 'object', 'should include quotas');
    assert.ok(typeof body.orchestrator === 'object', 'should include orchestrator');
    assert.equal(body.orchestrator.running, false);
  });

  it('returns 500 when taskQueue throws', async () => {
    const origStats = forge.taskQueue.stats;
    forge.taskQueue.stats = () => { throw new Error('stats boom'); };
    try {
      const res = await get('/status');
      assert.equal(res.status, 500);
      const body = await json(res);
      assert.equal(body.ok, false);
      assert.match(body.error, /stats boom/);
    } finally {
      forge.taskQueue.stats = origStats;
    }
  });
});

// ===========================================================================
// GET /api/tasks
// ===========================================================================

describe('GET /api/tasks', () => {
  it('returns empty list initially', async () => {
    const res = await get('/tasks');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.count, 0);
    assert.deepEqual(body.tasks, []);
  });

  it('returns all tasks when queue has items', async () => {
    forge.taskQueue.add({ title: 'Task A' });
    forge.taskQueue.add({ title: 'Task B' });
    const res = await get('/tasks');
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.count, 2);
    assert.equal(body.tasks.length, 2);
  });

  it('filters by ?status=queued', async () => {
    const t1 = forge.taskQueue.add({ title: 'Will be executing' });
    forge.taskQueue.add({ title: 'Stays queued' });
    forge.taskQueue.updateStatus(t1.id, 'executing');

    const res = await get('/tasks?status=queued');
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.count, 1);
    assert.equal(body.tasks[0].title, 'Stays queued');
  });
});

// ===========================================================================
// POST /api/tasks
// ===========================================================================

describe('POST /api/tasks', () => {
  it('creates a task and returns 201', async () => {
    const res = await post('/tasks', { title: 'New task', priority: 'high' });
    assert.equal(res.status, 201);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.ok(body.task, 'should return the created task');
    assert.equal(body.task.title, 'New task');
    assert.equal(body.task.priority, 'high');
    assert.equal(body.task.status, 'queued');
  });

  it('returns 400 when title is missing', async () => {
    const res = await post('/tasks', { priority: 'high' });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /title/i);
  });

  it('returns 400 when body is empty', async () => {
    const res = await post('/tasks', {});
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.ok, false);
  });
});

// ===========================================================================
// GET /api/tasks/:id
// ===========================================================================

describe('GET /api/tasks/:id', () => {
  it('returns task when found', async () => {
    const task = forge.taskQueue.add({ title: 'Findable task' });
    const res  = await get(`/tasks/${task.id}`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.task.id, task.id);
    assert.equal(body.task.title, 'Findable task');
  });

  it('returns 404 when not found', async () => {
    const res  = await get('/tasks/nonexistent-task-id');
    assert.equal(res.status, 404);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /not found/i);
  });
});

// ===========================================================================
// POST /api/tasks/:id/status
// ===========================================================================

describe('POST /api/tasks/:id/status', () => {
  it('updates task status', async () => {
    const task = forge.taskQueue.add({ title: 'Status update task' });
    const res  = await post(`/tasks/${task.id}/status`, { status: 'executing' });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.taskId, task.id);
    assert.equal(body.status, 'executing');
    // Verify the queue was actually updated
    assert.equal(forge.taskQueue.get(task.id).status, 'executing');
  });

  it('returns 400 on invalid status', async () => {
    const task = forge.taskQueue.add({ title: 'Bad status task' });
    const res  = await post(`/tasks/${task.id}/status`, { status: 'invalid_status' });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /status must be one of/i);
  });

  it('returns 400 when status field is missing', async () => {
    const task = forge.taskQueue.add({ title: 'No status task' });
    const res  = await post(`/tasks/${task.id}/status`, {});
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.ok, false);
  });

  it('returns 404 when task not found', async () => {
    const res  = await post('/tasks/ghost-task-id/status', { status: 'completed' });
    assert.equal(res.status, 404);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /not found/i);
  });
});

// ===========================================================================
// GET /api/quotas
// ===========================================================================

describe('GET /api/quotas', () => {
  it('returns quota statuses (empty object when no providers)', async () => {
    const res  = await get('/quotas');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.ok(typeof body.quotas === 'object', 'quotas should be an object');
  });

  it('includes provider quota when a provider is registered', async () => {
    forge.quotaManager.addProvider('test-provider', {
      max_requests_per_minute: 100,
    });
    try {
      const res  = await get('/quotas');
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.ok('test-provider' in body.quotas, 'should include test-provider');
      assert.equal(body.quotas['test-provider'].provider, 'test-provider');
    } finally {
      // Clean up
      forge.quotaManager.trackers.delete('test-provider');
    }
  });
});

// ===========================================================================
// GET /api/events
// ===========================================================================

describe('GET /api/events', () => {
  it('returns events from eventBus', async () => {
    eventBus.emit('test.event', { value: 1 });
    eventBus.emit('test.event', { value: 2 });
    const res  = await get('/events');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.ok(typeof body.count === 'number');
    assert.ok(Array.isArray(body.events));
    assert.ok(body.count >= 2);
  });

  it('respects ?limit= param', async () => {
    // Emit 10 events
    for (let i = 0; i < 10; i++) {
      eventBus.emit('test.limit', { i });
    }
    const res  = await get('/events?limit=3');
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.events.length, 3);
    assert.equal(body.count, 3);
  });

  it('defaults to 50 events when no limit provided', async () => {
    // Emit 60 events to exceed the 50-event default
    for (let i = 0; i < 60; i++) {
      eventBus.emit('test.default', { i });
    }
    const res  = await get('/events');
    const body = await json(res);
    assert.equal(body.ok, true);
    // The default cap is 50
    assert.ok(body.events.length <= 50);
  });
});

// ===========================================================================
// POST /api/control/start
// ===========================================================================

describe('POST /api/control/start', () => {
  it('starts the orchestrator', async () => {
    assert.equal(forge.orchestrator._running, false);
    const res  = await post('/control/start', {});
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(forge.orchestrator._running, true);
  });

  it('returns 409 if already running', async () => {
    forge.orchestrator._running = true;
    const res  = await post('/control/start', {});
    assert.equal(res.status, 409);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /already running/i);
  });

  it('returns 503 if orchestrator is absent', async () => {
    const origOrchestrator = forge.orchestrator;
    forge.orchestrator = null;
    try {
      const res  = await post('/control/start', {});
      assert.equal(res.status, 503);
      const body = await json(res);
      assert.equal(body.ok, false);
      assert.match(body.error, /not available/i);
    } finally {
      forge.orchestrator = origOrchestrator;
    }
  });
});

// ===========================================================================
// POST /api/control/stop
// ===========================================================================

describe('POST /api/control/stop', () => {
  it('stops the orchestrator', async () => {
    forge.orchestrator._running = true;
    const res  = await post('/control/stop', {});
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(forge.orchestrator._running, false);
  });

  it('returns 409 if already stopped', async () => {
    assert.equal(forge.orchestrator._running, false);
    const res  = await post('/control/stop', {});
    assert.equal(res.status, 409);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /not running/i);
  });
});

// ===========================================================================
// POST /api/review/:prNumber/approve
// ===========================================================================

describe('POST /api/review/:prNumber/approve', () => {
  it('emits review.approved event and returns ok', async () => {
    const events = [];
    const handler = (data) => events.push(data);
    eventBus.on('review.approved', handler);
    try {
      const res  = await post('/review/42/approve', {});
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.equal(body.prNumber, 42);
      assert.equal(events.length, 1);
      assert.equal(events[0].prNumber, 42);
    } finally {
      eventBus.off('review.approved', handler);
    }
  });

  it('returns 400 for invalid prNumber (zero)', async () => {
    const res  = await post('/review/0/approve', {});
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /invalid pr number/i);
  });

  it('returns 400 for non-numeric prNumber', async () => {
    const res  = await post('/review/abc/approve', {});
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.ok, false);
  });
});

// ===========================================================================
// POST /api/review/:prNumber/reject
// ===========================================================================

describe('POST /api/review/:prNumber/reject', () => {
  it('emits review.rejected event and returns ok', async () => {
    const events = [];
    const handler = (data) => events.push(data);
    eventBus.on('review.rejected', handler);
    try {
      const res  = await post('/review/7/reject', { reason: 'Tests failing' });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.equal(body.prNumber, 7);
      assert.equal(body.reason, 'Tests failing');
      assert.equal(events.length, 1);
      assert.equal(events[0].prNumber, 7);
      assert.equal(events[0].reason, 'Tests failing');
    } finally {
      eventBus.off('review.rejected', handler);
    }
  });

  it('returns 400 when reason is missing', async () => {
    const res  = await post('/review/7/reject', {});
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /reason/i);
  });

  it('returns 400 for invalid prNumber', async () => {
    const res  = await post('/review/-1/reject', { reason: 'No good' });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.ok, false);
  });
});

// ===========================================================================
// CORS middleware
// ===========================================================================

describe('CORS middleware', () => {
  it('allows localhost origin', async () => {
    const res = await fetch(url('/status'), {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(res.status, 200);
    const acao = res.headers.get('access-control-allow-origin');
    assert.equal(acao, 'http://localhost:5173');
  });

  it('responds 204 to OPTIONS preflight', async () => {
    const res = await fetch(url('/tasks'), {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    });
    assert.equal(res.status, 204);
  });

  it('does not set CORS header for non-localhost origin', async () => {
    const res = await fetch(url('/status'), {
      headers: { Origin: 'https://evil.example.com' },
    });
    // Request should still succeed (no blocking), but without CORS header
    assert.equal(res.status, 200);
    const acao = res.headers.get('access-control-allow-origin');
    assert.ok(!acao || acao !== 'https://evil.example.com',
      'should NOT echo back non-localhost origin');
  });
});

// ===========================================================================
// GET /api/costs  (no costTracker, no db)
// ===========================================================================

describe('GET /api/costs', () => {
  it('returns available=false when no costTracker and no db', async () => {
    const res  = await get('/costs');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.available, false);
    assert.equal(body.costs, null);
  });

  it('returns available=true and costs when costTracker is present', async () => {
    const costTracker = {
      getAllStats: () => ({
        totalCost: 0.05,
        byAgent: { 'agent-1': 0.05 },
        byModel: { 'claude-opus-4': 0.05 },
        budgets: {},
      }),
    };
    forge.costTracker = costTracker;
    try {
      const res  = await get('/costs');
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.equal(body.available, true);
      assert.ok(body.costs, 'costs should be present');
      assert.ok(typeof body.costs.totalCostUSD === 'number');
    } finally {
      forge.costTracker = null;
    }
  });
});

// ===========================================================================
// GET /api/agents
// ===========================================================================

describe('GET /api/agents', () => {
  it('returns empty list when agentPool is null', async () => {
    const res  = await get('/agents');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.count, 0);
    assert.deepEqual(body.agents, []);
  });

  it('returns agents from agentPool.getAllStatuses()', async () => {
    forge.agentPool = {
      getAllStatuses: () => ({
        'agent-1': { id: 'agent-1', state: 'idle' },
        'agent-2': { id: 'agent-2', state: 'executing' },
      }),
    };
    try {
      const res  = await get('/agents');
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.equal(body.count, 2);
      assert.equal(body.agents.length, 2);
    } finally {
      forge.agentPool = null;
    }
  });
});

// ===========================================================================
// POST /api/agents/:id
// ===========================================================================

describe('POST /api/agents/:id', () => {
  it('returns 503 when agentPool is null', async () => {
    const res  = await post('/agents/agent-1', { model: 'claude-opus-4' });
    assert.equal(res.status, 503);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /not available/i);
  });

  it('returns 404 when agent is not found', async () => {
    forge.agentPool = {
      updateAgentConfig: () => false,
    };
    try {
      const res  = await post('/agents/missing-agent', { model: 'gpt-4' });
      assert.equal(res.status, 404);
      const body = await json(res);
      assert.equal(body.ok, false);
      assert.match(body.error, /not found/i);
    } finally {
      forge.agentPool = null;
    }
  });

  it('updates agent config and returns ok', async () => {
    forge.agentPool = {
      updateAgentConfig: (_id, _cfg) => true,
    };
    try {
      const res  = await post('/agents/agent-1', { model: 'claude-haiku-3' });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.equal(body.agentId, 'agent-1');
      assert.equal(body.model, 'claude-haiku-3');
    } finally {
      forge.agentPool = null;
    }
  });
});

// ===========================================================================
// POST /api/providers/test
// ===========================================================================

describe('POST /api/providers/test', () => {
  it('returns 400 when provider field is missing', async () => {
    const res  = await post('/providers/test', {});
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /provider/i);
  });

  it('returns 503 when providerRegistry is null', async () => {
    const res  = await post('/providers/test', { provider: 'anthropic' });
    assert.equal(res.status, 503);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /not available/i);
  });

  it('returns 404 when provider is not registered', async () => {
    forge.providerRegistry = { get: () => null };
    try {
      const res  = await post('/providers/test', { provider: 'unknown-provider' });
      assert.equal(res.status, 404);
      const body = await json(res);
      assert.equal(body.ok, false);
      assert.match(body.error, /not registered/i);
    } finally {
      forge.providerRegistry = null;
    }
  });

  it('returns ok when provider is found and reachable', async () => {
    forge.providerRegistry = {
      get: (name) => name === 'anthropic' ? { test: async () => {} } : null,
    };
    try {
      const res  = await post('/providers/test', { provider: 'anthropic' });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.equal(body.provider, 'anthropic');
    } finally {
      forge.providerRegistry = null;
    }
  });
});
