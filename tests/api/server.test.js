/**
 * @file tests/api/server.test.js
 * @description Unit tests for src/api/server.js — startServer() REST endpoints.
 *
 * Covers all routes:
 *   GET  /api/status
 *   GET  /api/tasks           (with optional ?status= filter)
 *   POST /api/tasks
 *   GET  /api/tasks/:id
 *   POST /api/tasks/:id/status
 *   GET  /api/agents
 *   POST /api/agents/:id
 *   POST /api/providers/test
 *   GET  /api/quotas
 *   GET  /api/costs
 *   GET  /api/events
 *   POST /api/control/start
 *   POST /api/control/stop
 *   POST /api/review/:prNumber/approve
 *   POST /api/review/:prNumber/reject
 *   CORS middleware
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import eventBus from '../../src/core/event-bus.js';
import { startServer } from '../../src/api/server.js';

// ---------------------------------------------------------------------------
// Forge factory
// ---------------------------------------------------------------------------

function makeForge(overrides = {}) {
  const taskQueue = new TaskQueue();
  const quotaManager = new QuotaManager();

  const orchestrator = {
    _running: false,
    start() { this._running = true; },
    stop()  { this._running = false; },
  };

  const agentPool = {
    _configs: {},
    getAllStatuses() {
      return { agent1: { agentId: 'agent1', status: 'idle', model: 'claude-opus-4-5' } };
    },
    updateAgentConfig(id, cfg) {
      if (id !== 'agent1') return false;
      Object.assign(this._configs[id] ?? (this._configs[id] = {}), cfg);
      return true;
    },
  };

  const providerRegistry = {
    _providers: {
      anthropic: { name: 'anthropic' },
      broken:    { name: 'broken', test: async () => { throw new Error('provider unreachable'); } },
    },
    get(id) { return this._providers[id] ?? null; },
  };

  return {
    taskQueue,
    quotaManager,
    eventBus,
    orchestrator,
    agentPool,
    costTracker: null,
    db: null,
    providerRegistry,
    config: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper — wraps global fetch
// ---------------------------------------------------------------------------

function apiUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

async function api(port, method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(apiUrl(port, path), opts);
  const json = await res.json();
  return { status: res.status, headers: res.headers, body: json };
}

async function options(port, path) {
  const res = await fetch(apiUrl(port, path), {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173' },
  });
  return { status: res.status, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

function listenAsync(server) {
  return new Promise(resolve => server.once('listening', resolve));
}

function closeAsync(server) {
  return new Promise(resolve => server.close(resolve));
}

// ===========================================================================
// One shared server for most suites (reset state in beforeEach via /test/reset)
// ===========================================================================

let sharedServer;
let sharedForge;
let port;

before(async () => {
  sharedForge = makeForge();
  sharedServer = startServer(sharedForge, 0);
  await listenAsync(sharedServer);
  port = sharedServer.address().port;
});

after(async () => {
  await closeAsync(sharedServer);
});

beforeEach(async () => {
  // Reset server-side state between tests
  await api(port, 'POST', '/api/test/reset');
  // Clear the event bus log to avoid cross-test contamination
  eventBus.clearRecent();
});

// ===========================================================================
// GET /api/status
// ===========================================================================

describe('GET /api/status', () => {
  it('returns ok with task stats, quotas, and orchestrator state', async () => {
    const { status, body } = await api(port, 'GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.orchestrator === 'object', 'should have orchestrator');
    assert.equal(body.orchestrator.running, false);
    assert.ok(typeof body.tasks === 'object', 'should have tasks stats');
    assert.ok('total' in body.tasks, 'tasks stats should have total');
    assert.ok(typeof body.quotas === 'object', 'should have quotas');
  });

  it('returns 500 when taskQueue.stats() throws', async () => {
    // Use a dedicated forge instance where taskQueue.stats throws
    const brokenForge = makeForge({
      taskQueue: {
        stats() { throw new Error('stats exploded'); },
        getAll() { return []; },
        getByStatus() { return []; },
        add() {},
        get() { return null; },
        updateStatus() {},
        clear() {},
      },
    });
    const srv = startServer(brokenForge, 0);
    await listenAsync(srv);
    const p = srv.address().port;
    try {
      const { status, body } = await api(p, 'GET', '/api/status');
      assert.equal(status, 500);
      assert.equal(body.ok, false);
      assert.ok(body.error.includes('stats exploded'));
    } finally {
      await closeAsync(srv);
    }
  });
});

// ===========================================================================
// GET /api/tasks
// ===========================================================================

describe('GET /api/tasks', () => {
  it('returns empty list initially', async () => {
    const { status, body } = await api(port, 'GET', '/api/tasks');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.count, 0);
    assert.deepEqual(body.tasks, []);
  });

  it('returns all tasks after adding some', async () => {
    sharedForge.taskQueue.add({ title: 'Task A' });
    sharedForge.taskQueue.add({ title: 'Task B' });
    const { status, body } = await api(port, 'GET', '/api/tasks');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.count, 2);
  });

  it('filters by ?status=queued', async () => {
    sharedForge.taskQueue.add({ title: 'Queued task' });
    const { status, body } = await api(port, 'GET', '/api/tasks?status=queued');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.count >= 1);
    assert.ok(body.tasks.every(t => t.status === 'queued'), 'all tasks should be queued');
  });

  it('returns empty list when filtering by a status with no matches', async () => {
    const { status, body } = await api(port, 'GET', '/api/tasks?status=failed');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.count, 0);
  });
});

// ===========================================================================
// POST /api/tasks
// ===========================================================================

describe('POST /api/tasks', () => {
  it('creates a task and returns 201 with task object', async () => {
    const { status, body } = await api(port, 'POST', '/api/tasks', { title: 'New task' });
    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.ok(body.task, 'should have task in response');
    assert.equal(body.task.title, 'New task');
    assert.equal(body.task.status, 'queued');
    assert.ok(body.task.id, 'task should have an id');
  });

  it('returns 400 when title is missing', async () => {
    const { status, body } = await api(port, 'POST', '/api/tasks', { type: 'implement' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('title'), 'error should mention title');
  });

  it('returns 400 when body is empty', async () => {
    const { status, body } = await api(port, 'POST', '/api/tasks', {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('respects optional fields (type, priority)', async () => {
    const { status, body } = await api(port, 'POST', '/api/tasks', {
      title: 'Priority task',
      type: 'review',
      priority: 'high',
    });
    assert.equal(status, 201);
    assert.equal(body.task.type, 'review');
    assert.equal(body.task.priority, 'high');
  });
});

// ===========================================================================
// GET /api/tasks/:id
// ===========================================================================

describe('GET /api/tasks/:id', () => {
  it('returns task when found', async () => {
    const task = sharedForge.taskQueue.add({ title: 'Findable task' });
    const { status, body } = await api(port, 'GET', `/api/tasks/${task.id}`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.task.id, task.id);
    assert.equal(body.task.title, 'Findable task');
  });

  it('returns 404 when task not found', async () => {
    const { status, body } = await api(port, 'GET', '/api/tasks/nonexistent-id');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('nonexistent-id') || body.error.toLowerCase().includes('not found'));
  });
});

// ===========================================================================
// POST /api/tasks/:id/status
// ===========================================================================

describe('POST /api/tasks/:id/status', () => {
  it('updates task status successfully', async () => {
    const task = sharedForge.taskQueue.add({ title: 'Status task' });
    const { status, body } = await api(port, 'POST', `/api/tasks/${task.id}/status`, { status: 'completed' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.taskId, task.id);
    assert.equal(body.status, 'completed');
    // Verify the in-memory task was actually updated
    assert.equal(sharedForge.taskQueue.get(task.id).status, 'completed');
  });

  it('returns 400 on invalid status', async () => {
    const task = sharedForge.taskQueue.add({ title: 'Status task 2' });
    const { status, body } = await api(port, 'POST', `/api/tasks/${task.id}/status`, { status: 'invalid-state' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('returns 400 when status field is missing', async () => {
    const task = sharedForge.taskQueue.add({ title: 'Status task 3' });
    const { status, body } = await api(port, 'POST', `/api/tasks/${task.id}/status`, {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('returns 404 when task not found', async () => {
    const { status, body } = await api(port, 'POST', '/api/tasks/ghost-id/status', { status: 'queued' });
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });
});

// ===========================================================================
// GET /api/agents
// ===========================================================================

describe('GET /api/agents', () => {
  it('returns agents list from agentPool', async () => {
    const { status, body } = await api(port, 'GET', '/api/agents');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.count === 'number');
    assert.ok(Array.isArray(body.agents));
    assert.equal(body.count, body.agents.length);
  });

  it('returns empty agents list when agentPool is null', async () => {
    const forge = makeForge({ agentPool: null });
    const srv = startServer(forge, 0);
    await listenAsync(srv);
    const p = srv.address().port;
    try {
      const { status, body } = await api(p, 'GET', '/api/agents');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.count, 0);
      assert.deepEqual(body.agents, []);
    } finally {
      await closeAsync(srv);
    }
  });
});

// ===========================================================================
// POST /api/agents/:id
// ===========================================================================

describe('POST /api/agents/:id', () => {
  it('updates agent config and returns ok', async () => {
    const { status, body } = await api(port, 'POST', '/api/agents/agent1', {
      model: 'claude-haiku-4-5',
      systemPrompt: 'Be concise.',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.agentId, 'agent1');
    assert.equal(body.model, 'claude-haiku-4-5');
  });

  it('returns 404 when agent does not exist', async () => {
    const { status, body } = await api(port, 'POST', '/api/agents/no-such-agent', { model: 'x' });
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });

  it('returns 503 when agentPool is absent', async () => {
    const forge = makeForge({ agentPool: null });
    const srv = startServer(forge, 0);
    await listenAsync(srv);
    const p = srv.address().port;
    try {
      const { status, body } = await api(p, 'POST', '/api/agents/agent1', { model: 'x' });
      assert.equal(status, 503);
      assert.equal(body.ok, false);
    } finally {
      await closeAsync(srv);
    }
  });
});

// ===========================================================================
// POST /api/providers/test
// ===========================================================================

describe('POST /api/providers/test', () => {
  it('returns ok for a registered provider without test() method', async () => {
    const { status, body } = await api(port, 'POST', '/api/providers/test', { provider: 'anthropic' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.provider, 'anthropic');
    assert.equal(body.status, 'reachable');
  });

  it('returns ok:false when provider test() throws', async () => {
    const { status, body } = await api(port, 'POST', '/api/providers/test', { provider: 'broken' });
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('unreachable'));
  });

  it('returns 400 when provider field is missing', async () => {
    const { status, body } = await api(port, 'POST', '/api/providers/test', {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('returns 404 for an unregistered provider', async () => {
    const { status, body } = await api(port, 'POST', '/api/providers/test', { provider: 'unknown' });
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });

  it('returns 503 when providerRegistry is absent', async () => {
    const forge = makeForge({ providerRegistry: null });
    const srv = startServer(forge, 0);
    await listenAsync(srv);
    const p = srv.address().port;
    try {
      const { status, body } = await api(p, 'POST', '/api/providers/test', { provider: 'anthropic' });
      assert.equal(status, 503);
      assert.equal(body.ok, false);
    } finally {
      await closeAsync(srv);
    }
  });
});

// ===========================================================================
// GET /api/quotas
// ===========================================================================

describe('GET /api/quotas', () => {
  it('returns quota statuses', async () => {
    const { status, body } = await api(port, 'GET', '/api/quotas');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.quotas === 'object', 'should have quotas object');
  });

  it('returns empty quotas when no providers registered', async () => {
    // A fresh QuotaManager has no trackers
    const { status, body } = await api(port, 'GET', '/api/quotas');
    assert.equal(status, 200);
    assert.deepEqual(body.quotas, {});
  });

  it('returns quota for registered providers', async () => {
    const forge = makeForge();
    forge.quotaManager.addProvider('anthropic', { max_requests_per_minute: 100 });
    const srv = startServer(forge, 0);
    await listenAsync(srv);
    const p = srv.address().port;
    try {
      const { status, body } = await api(p, 'GET', '/api/quotas');
      assert.equal(status, 200);
      assert.ok('anthropic' in body.quotas);
      assert.equal(body.quotas.anthropic.provider, 'anthropic');
    } finally {
      await closeAsync(srv);
    }
  });
});

// ===========================================================================
// GET /api/costs
// ===========================================================================

describe('GET /api/costs', () => {
  it('returns available:false when costTracker and db are both null', async () => {
    const { status, body } = await api(port, 'GET', '/api/costs');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.available, false);
    assert.equal(body.costs, null);
  });

  it('returns available:true with cost data when costTracker is present', async () => {
    const costTracker = {
      getAllStats() {
        return {
          totalCost: 0.05,
          byAgent: { agent1: 0.03, agent2: 0.02 },
          byModel: { 'claude-opus-4-5': 0.05 },
          budgets: {},
        };
      },
    };
    const forge = makeForge({ costTracker });
    const srv = startServer(forge, 0);
    await listenAsync(srv);
    const p = srv.address().port;
    try {
      const { status, body } = await api(p, 'GET', '/api/costs');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.available, true);
      assert.ok(body.costs, 'should have costs object');
      assert.ok(typeof body.costs.totalCostUSD === 'number');
      assert.ok(typeof body.costs.byAgent === 'object');
      assert.ok(typeof body.costs.byModel === 'object');
    } finally {
      await closeAsync(srv);
    }
  });
});

// ===========================================================================
// GET /api/events
// ===========================================================================

describe('GET /api/events', () => {
  it('returns events from eventBus', async () => {
    eventBus.emit('task.queued', { id: 't1', title: 'Test' });
    const { status, body } = await api(port, 'GET', '/api/events');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.count === 'number');
    assert.ok(Array.isArray(body.events));
    assert.ok(body.count >= 1);
    assert.ok(body.events.some(e => e.event === 'task.queued'));
  });

  it('returns empty events list when log is empty', async () => {
    // beforeEach cleared eventBus._log, so it starts empty
    const { status, body } = await api(port, 'GET', '/api/events');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.count, 0);
    assert.deepEqual(body.events, []);
  });

  it('respects ?limit= param', async () => {
    // Emit 10 events
    for (let i = 0; i < 10; i++) {
      eventBus.emit('test.event', { i });
    }
    const { status, body } = await api(port, 'GET', '/api/events?limit=3');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.events.length, 3);
    assert.equal(body.count, 3);
  });

  it('caps limit at 1000', async () => {
    // Just verify it doesn't explode when over-large limit is provided
    const { status, body } = await api(port, 'GET', '/api/events?limit=9999');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });
});

// ===========================================================================
// POST /api/control/start
// ===========================================================================

describe('POST /api/control/start', () => {
  it('starts the orchestrator', async () => {
    assert.equal(sharedForge.orchestrator._running, false, 'precondition: not running');
    const { status, body } = await api(port, 'POST', '/api/control/start');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(sharedForge.orchestrator._running, true);
  });

  it('returns 409 if already running', async () => {
    sharedForge.orchestrator._running = true;
    const { status, body } = await api(port, 'POST', '/api/control/start');
    assert.equal(status, 409);
    assert.equal(body.ok, false);
    assert.ok(body.error.toLowerCase().includes('already running'));
    // clean up
    sharedForge.orchestrator._running = false;
  });

  it('returns 503 if orchestrator is absent', async () => {
    const forge = makeForge({ orchestrator: null });
    const srv = startServer(forge, 0);
    await listenAsync(srv);
    const p = srv.address().port;
    try {
      const { status, body } = await api(p, 'POST', '/api/control/start');
      assert.equal(status, 503);
      assert.equal(body.ok, false);
    } finally {
      await closeAsync(srv);
    }
  });
});

// ===========================================================================
// POST /api/control/stop
// ===========================================================================

describe('POST /api/control/stop', () => {
  it('stops the orchestrator', async () => {
    sharedForge.orchestrator._running = true;
    const { status, body } = await api(port, 'POST', '/api/control/stop');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(sharedForge.orchestrator._running, false);
  });

  it('returns 409 if already stopped', async () => {
    sharedForge.orchestrator._running = false;
    const { status, body } = await api(port, 'POST', '/api/control/stop');
    assert.equal(status, 409);
    assert.equal(body.ok, false);
    assert.ok(body.error.toLowerCase().includes('not running'));
  });
});

// ===========================================================================
// POST /api/review/:prNumber/approve
// ===========================================================================

describe('POST /api/review/:prNumber/approve', () => {
  it('emits review.approved event and returns ok', async () => {
    const events = [];
    eventBus.once('review.approved', data => events.push(data));

    const { status, body } = await api(port, 'POST', '/api/review/42/approve');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 42);
    assert.ok(events.length === 1, 'should emit review.approved');
    assert.equal(events[0].prNumber, 42);
  });

  it('returns 400 for invalid prNumber (string)', async () => {
    const { status, body } = await api(port, 'POST', '/api/review/abc/approve');
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.toLowerCase().includes('invalid'));
  });

  it('returns 400 for prNumber = 0', async () => {
    const { status, body } = await api(port, 'POST', '/api/review/0/approve');
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

// ===========================================================================
// POST /api/review/:prNumber/reject
// ===========================================================================

describe('POST /api/review/:prNumber/reject', () => {
  it('emits review.rejected event and returns ok', async () => {
    const events = [];
    eventBus.once('review.rejected', data => events.push(data));

    const { status, body } = await api(port, 'POST', '/api/review/7/reject', { reason: 'Needs more tests' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 7);
    assert.equal(body.reason, 'Needs more tests');
    assert.ok(events.length === 1, 'should emit review.rejected');
    assert.equal(events[0].prNumber, 7);
    assert.equal(events[0].reason, 'Needs more tests');
  });

  it('returns 400 when reason is missing', async () => {
    const { status, body } = await api(port, 'POST', '/api/review/7/reject', {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('reason'));
  });

  it('returns 400 for invalid prNumber', async () => {
    const { status, body } = await api(port, 'POST', '/api/review/notanumber/reject', { reason: 'x' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

// ===========================================================================
// CORS middleware
// ===========================================================================

describe('CORS middleware', () => {
  it('allows localhost origin by setting ACAO header', async () => {
    const { headers } = await api(port, 'GET', '/api/status');
    const acao = headers.get('access-control-allow-origin');
    // Should be set to the request origin or *
    assert.ok(acao === 'http://localhost:5173' || acao === '*', `unexpected ACAO: ${acao}`);
  });

  it('responds 204 to OPTIONS preflight request', async () => {
    const { status } = await options(port, '/api/status');
    assert.equal(status, 204);
  });

  it('sets Access-Control-Allow-Methods header on preflight', async () => {
    const { headers } = await options(port, '/api/tasks');
    const acam = headers.get('access-control-allow-methods');
    assert.ok(acam && acam.includes('GET'), `expected GET in ACAM, got: ${acam}`);
    assert.ok(acam && acam.includes('POST'), `expected POST in ACAM, got: ${acam}`);
  });
});
