/**
 * @file tests/api/server.test.js
 * @description Unit tests for src/api/server.js REST endpoints.
 *
 * Covers: GET /api/status, GET|POST /api/tasks, GET /api/tasks/:id,
 * GET /api/agents, GET /api/quotas, GET /api/costs, GET /api/events,
 * POST /api/control/start|stop, POST /api/review/:pr/approve|reject.
 *
 * Endpoints already covered by tests/api.test.js (not duplicated here):
 *   POST /api/tasks/:id/status, POST /api/agents/:id, POST /api/providers/test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import { startServer } from '../../src/api/server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeForge({ orchestratorRunning = false } = {}) {
  const taskQueue    = new TaskQueue();
  const quotaManager = new QuotaManager();
  const eventBus     = Object.assign(new EventEmitter(), {
    getRecentEvents: (n = 50) => Array.from({ length: 3 }, (_, i) => ({
      event: 'task.queued',
      data: { id: `t${i}` },
      timestamp: Date.now(),
    })).slice(0, n),
    clearRecent: () => {},
  });

  const agentPool = {
    getAllStatuses() {
      return { agent1: { agentId: 'agent1', status: 'idle', model: 'claude-opus-4-6' } };
    },
    updateAgentConfig(id, cfg) {
      return id === 'agent1' ? true : false;
    },
  };

  const orchestrator = {
    _running: orchestratorRunning,
    start() { this._running = true; },
    stop()  { this._running = false; },
  };

  const costTracker = {
    getAllStats: () => ({
      totalCost: 1.23,
      byAgent: { agent1: 0.75 },
      byModel: { 'claude-opus-4-6': 1.23 },
      budgets: {},
    }),
  };

  const providerRegistry = {
    get: () => null,
  };

  return { taskQueue, quotaManager, eventBus, agentPool, orchestrator,
    costTracker, providerRegistry, db: null, config: {} };
}

function apiReq(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

async function makeServer(opts) {
  const forge = makeForge(opts);
  const server = startServer(forge, 0);
  await new Promise(r => server.once('listening', r));
  return { server, forge };
}

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------

describe('GET /api/status', () => {
  let server, forge;
  before(async () => ({ server, forge } = await makeServer()));
  after(async () => new Promise(r => server.close(r)));

  it('returns ok:true with orchestrator, tasks, quotas, agents', async () => {
    const { status, body } = await apiReq(server, 'GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok('orchestrator' in body);
    assert.ok('tasks' in body);
    assert.ok('quotas' in body);
    assert.ok('agents' in body);
  });

  it('reflects orchestrator running state (false)', async () => {
    const { body } = await apiReq(server, 'GET', '/api/status');
    assert.equal(body.orchestrator.running, false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks
// ---------------------------------------------------------------------------

describe('GET /api/tasks', () => {
  let server, forge;
  before(async () => ({ server, forge } = await makeServer()));
  after(async () => new Promise(r => server.close(r)));

  it('returns empty list when no tasks', async () => {
    const { status, body } = await apiReq(server, 'GET', '/api/tasks');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.tasks));
    assert.equal(body.count, 0);
  });

  it('returns added tasks', async () => {
    forge.taskQueue.add({ title: 'Task A' });
    const { body } = await apiReq(server, 'GET', '/api/tasks');
    assert.equal(body.count, 1);
    assert.equal(body.tasks[0].title, 'Task A');
  });

  it('filters tasks by ?status=queued', async () => {
    const { body } = await apiReq(server, 'GET', '/api/tasks?status=queued');
    assert.equal(body.ok, true);
    assert.ok(body.tasks.every(t => t.status === 'queued'));
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks
// ---------------------------------------------------------------------------

describe('POST /api/tasks', () => {
  let server, forge;
  before(async () => ({ server, forge } = await makeServer()));
  after(async () => new Promise(r => server.close(r)));

  it('creates a task and returns 201', async () => {
    const { status, body } = await apiReq(server, 'POST', '/api/tasks', {
      title: 'New task',
      type: 'implement',
      priority: 'high',
    });
    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.task.title, 'New task');
    assert.equal(body.task.priority, 'high');
    assert.ok(body.task.id);
  });

  it('returns 400 when title is missing', async () => {
    const { status, body } = await apiReq(server, 'POST', '/api/tasks', { type: 'test' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /title/);
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks/:id
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id', () => {
  let server, forge, taskId;
  before(async () => {
    ({ server, forge } = await makeServer());
    const t = forge.taskQueue.add({ title: 'Find me' });
    taskId = t.id;
  });
  after(async () => new Promise(r => server.close(r)));

  it('returns the task when found', async () => {
    const { status, body } = await apiReq(server, 'GET', `/api/tasks/${taskId}`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.task.title, 'Find me');
  });

  it('returns 404 for unknown id', async () => {
    const { status, body } = await apiReq(server, 'GET', '/api/tasks/no-such-task');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents
// ---------------------------------------------------------------------------

describe('GET /api/agents', () => {
  let server;
  before(async () => ({ server } = await makeServer()));
  after(async () => new Promise(r => server.close(r)));

  it('returns agents list from agentPool', async () => {
    const { status, body } = await apiReq(server, 'GET', '/api/agents');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.agents));
    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0].agentId, 'agent1');
  });
});

// ---------------------------------------------------------------------------
// GET /api/quotas
// ---------------------------------------------------------------------------

describe('GET /api/quotas', () => {
  let server;
  before(async () => ({ server } = await makeServer()));
  after(async () => new Promise(r => server.close(r)));

  it('returns quota statuses', async () => {
    const { status, body } = await apiReq(server, 'GET', '/api/quotas');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.quotas === 'object');
  });
});

// ---------------------------------------------------------------------------
// GET /api/costs
// ---------------------------------------------------------------------------

describe('GET /api/costs', () => {
  let server;
  before(async () => ({ server } = await makeServer()));
  after(async () => new Promise(r => server.close(r)));

  it('returns cost data when costTracker is available', async () => {
    const { status, body } = await apiReq(server, 'GET', '/api/costs');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.available, true);
    assert.ok(typeof body.costs.totalCostUSD === 'number');
    assert.ok(typeof body.costs.byAgent === 'object');
    assert.ok(typeof body.costs.byModel === 'object');
  });

  it('returns available:false when no costTracker and no db', async () => {
    const forge2 = makeForge();
    forge2.costTracker = null;
    forge2.db = null;
    const s = startServer(forge2, 0);
    await new Promise(r => s.once('listening', r));
    const { body } = await apiReq(s, 'GET', '/api/costs');
    assert.equal(body.available, false);
    await new Promise(r => s.close(r));
  });
});

// ---------------------------------------------------------------------------
// GET /api/events
// ---------------------------------------------------------------------------

describe('GET /api/events', () => {
  let server;
  before(async () => ({ server } = await makeServer()));
  after(async () => new Promise(r => server.close(r)));

  it('returns recent events from eventBus', async () => {
    const { status, body } = await apiReq(server, 'GET', '/api/events');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.events));
    assert.ok(typeof body.count === 'number');
  });

  it('respects ?limit param', async () => {
    const { body } = await apiReq(server, 'GET', '/api/events?limit=1');
    assert.ok(body.events.length <= 1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/control/start
// ---------------------------------------------------------------------------

describe('POST /api/control/start', () => {
  let server, forge;
  before(async () => ({ server, forge } = await makeServer({ orchestratorRunning: false })));
  after(async () => new Promise(r => server.close(r)));

  it('starts the orchestrator', async () => {
    const { status, body } = await apiReq(server, 'POST', '/api/control/start');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(forge.orchestrator._running, true);
  });

  it('returns 409 when orchestrator already running', async () => {
    // Already running from previous test
    const { status, body } = await apiReq(server, 'POST', '/api/control/start');
    assert.equal(status, 409);
    assert.equal(body.ok, false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/control/stop
// ---------------------------------------------------------------------------

describe('POST /api/control/stop', () => {
  let server, forge;
  before(async () => ({ server, forge } = await makeServer({ orchestratorRunning: true })));
  after(async () => new Promise(r => server.close(r)));

  it('stops the orchestrator', async () => {
    const { status, body } = await apiReq(server, 'POST', '/api/control/stop');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(forge.orchestrator._running, false);
  });

  it('returns 409 when orchestrator not running', async () => {
    const { status, body } = await apiReq(server, 'POST', '/api/control/stop');
    assert.equal(status, 409);
    assert.equal(body.ok, false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/review/:prNumber/approve
// ---------------------------------------------------------------------------

describe('POST /api/review/:prNumber/approve', () => {
  let server, forge;
  before(async () => ({ server, forge } = await makeServer()));
  after(async () => new Promise(r => server.close(r)));

  it('emits review.approved and returns ok', async () => {
    let emitted = null;
    forge.eventBus.once('review.approved', (d) => { emitted = d; });
    const { status, body } = await apiReq(server, 'POST', '/api/review/42/approve');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 42);
    assert.equal(body.action, 'approved');
    assert.equal(emitted?.prNumber, 42);
  });

  it('returns 400 for invalid PR number', async () => {
    const { status, body } = await apiReq(server, 'POST', '/api/review/abc/approve');
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/review/:prNumber/reject
// ---------------------------------------------------------------------------

describe('POST /api/review/:prNumber/reject', () => {
  let server, forge;
  before(async () => ({ server, forge } = await makeServer()));
  after(async () => new Promise(r => server.close(r)));

  it('emits review.rejected with reason and returns ok', async () => {
    let emitted = null;
    forge.eventBus.once('review.rejected', (d) => { emitted = d; });
    const { status, body } = await apiReq(server, 'POST', '/api/review/7/reject', { reason: 'bad code' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 7);
    assert.equal(body.action, 'rejected');
    assert.equal(body.reason, 'bad code');
    assert.equal(emitted?.reason, 'bad code');
  });

  it('returns 400 when reason is missing', async () => {
    const { status, body } = await apiReq(server, 'POST', '/api/review/7/reject', {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /reason/);
  });

  it('returns 400 for invalid PR number', async () => {
    const { status, body } = await apiReq(server, 'POST', '/api/review/0/reject', { reason: 'x' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});
