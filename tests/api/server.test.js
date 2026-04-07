/**
 * @file tests/api/server.test.js
 * @description Tests for REST API endpoints in src/api/server.js not covered by api.test.js.
 *
 * Covers:
 *  GET  /api/status
 *  GET  /api/tasks            (list, filter by ?status)
 *  POST /api/tasks            (create)
 *  GET  /api/tasks/:id        (get one)
 *  GET  /api/agents
 *  GET  /api/quotas
 *  GET  /api/costs            (no costTracker/db → available:false)
 *  GET  /api/events
 *  POST /api/control/start
 *  POST /api/control/stop
 *  POST /api/review/:prNumber/approve
 *  POST /api/review/:prNumber/reject
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import { startServer } from '../../src/api/server.js';

// ---------------------------------------------------------------------------
// Minimal forge stub
// ---------------------------------------------------------------------------

function makeForge(overrides = {}) {
  const taskQueue = new TaskQueue();
  const quotaManager = new QuotaManager();
  const eventBus = Object.assign(new EventEmitter(), {
    getRecentEvents: (n) => [],
    clearRecent: () => {},
  });

  const agentPool = {
    _configs: { 'dev-agent': {} },
    getAllStatuses() {
      return {
        'dev-agent': { agentId: 'dev-agent', status: 'idle', model: 'claude-opus-4-6' },
      };
    },
    updateAgentConfig(id, cfg) {
      if (!(id in this._configs)) return false;
      Object.assign(this._configs[id], cfg);
      return true;
    },
  };

  const providerRegistry = {
    get: () => null,
  };

  const orchestrator = {
    _running: false,
    start() { this._running = true; },
    stop() { this._running = false; },
  };

  return {
    taskQueue,
    quotaManager,
    eventBus,
    agentPool,
    providerRegistry,
    orchestrator,
    costTracker: null,
    db: null,
    config: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function req(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------

describe('GET /api/status', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('returns ok:true', async () => {
    const { status, body } = await req(server, 'GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it('includes orchestrator.running=false', async () => {
    const { body } = await req(server, 'GET', '/api/status');
    assert.equal(body.orchestrator.running, false);
  });

  it('includes tasks stats', async () => {
    const { body } = await req(server, 'GET', '/api/status');
    assert.ok(typeof body.tasks === 'object');
  });

  it('includes quotas object', async () => {
    const { body } = await req(server, 'GET', '/api/status');
    assert.ok(typeof body.quotas === 'object');
  });

  it('includes agents object', async () => {
    const { body } = await req(server, 'GET', '/api/status');
    assert.ok(typeof body.agents === 'object');
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks
// ---------------------------------------------------------------------------

describe('GET /api/tasks', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    forge.taskQueue.add({ title: 'Task A', type: 'implement', priority: 'high' });
    forge.taskQueue.add({ title: 'Task B', type: 'test', priority: 'low' });
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('returns all tasks', async () => {
    const { status, body } = await req(server, 'GET', '/api/tasks');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.count, 2);
    assert.equal(body.tasks.length, 2);
  });

  it('filters by status via ?status=queued', async () => {
    const { status, body } = await req(server, 'GET', '/api/tasks?status=queued');
    assert.equal(status, 200);
    assert.ok(body.tasks.every((t) => t.status === 'queued'));
  });

  it('returns empty array for status with no matches', async () => {
    const { status, body } = await req(server, 'GET', '/api/tasks?status=executing');
    assert.equal(status, 200);
    assert.equal(body.tasks.length, 0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks
// ---------------------------------------------------------------------------

describe('POST /api/tasks', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('creates a task and returns 201', async () => {
    const { status, body } = await req(server, 'POST', '/api/tasks', {
      title: 'New task',
      type: 'implement',
      priority: 'high',
    });
    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.ok(body.task.id);
    assert.equal(body.task.title, 'New task');
  });

  it('returns 400 when title is missing', async () => {
    const { status, body } = await req(server, 'POST', '/api/tasks', { type: 'implement' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks/:id
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id', () => {
  let server, forge, taskId;

  before(async () => {
    forge = makeForge();
    const t = forge.taskQueue.add({ title: 'Findable task' });
    taskId = t.id;
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('returns the task by ID', async () => {
    const { status, body } = await req(server, 'GET', `/api/tasks/${taskId}`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.task.id, taskId);
    assert.equal(body.task.title, 'Findable task');
  });

  it('returns 404 for unknown task ID', async () => {
    const { status, body } = await req(server, 'GET', '/api/tasks/nonexistent');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents
// ---------------------------------------------------------------------------

describe('GET /api/agents', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('returns ok:true with agents array', async () => {
    const { status, body } = await req(server, 'GET', '/api/agents');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.agents));
  });

  it('returns the stub agent in the list', async () => {
    const { body } = await req(server, 'GET', '/api/agents');
    assert.equal(body.count, 1);
    assert.equal(body.agents[0].agentId, 'dev-agent');
  });
});

// ---------------------------------------------------------------------------
// GET /api/quotas
// ---------------------------------------------------------------------------

describe('GET /api/quotas', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('returns ok:true with quotas object', async () => {
    const { status, body } = await req(server, 'GET', '/api/quotas');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.quotas === 'object');
  });
});

// ---------------------------------------------------------------------------
// GET /api/costs
// ---------------------------------------------------------------------------

describe('GET /api/costs', () => {
  let server, forge;

  before(async () => {
    forge = makeForge(); // costTracker=null, db=null
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('returns available:false when no costTracker or db', async () => {
    const { status, body } = await req(server, 'GET', '/api/costs');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.available, false);
    assert.equal(body.costs, null);
  });
});

// ---------------------------------------------------------------------------
// GET /api/events
// ---------------------------------------------------------------------------

describe('GET /api/events', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('returns ok:true with events array', async () => {
    const { status, body } = await req(server, 'GET', '/api/events');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.events));
  });

  it('respects the ?limit query param', async () => {
    const { body } = await req(server, 'GET', '/api/events?limit=5');
    assert.equal(body.ok, true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/control/start and /stop
// ---------------------------------------------------------------------------

describe('POST /api/control/start', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('starts the orchestrator and returns ok:true', async () => {
    const { status, body } = await req(server, 'POST', '/api/control/start');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(forge.orchestrator._running, true);
  });

  it('returns 409 when orchestrator is already running', async () => {
    // orchestrator is already running from previous test
    const { status, body } = await req(server, 'POST', '/api/control/start');
    assert.equal(status, 409);
    assert.equal(body.ok, false);
  });
});

describe('POST /api/control/stop', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    forge.orchestrator._running = true; // pre-start
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('stops the orchestrator and returns ok:true', async () => {
    const { status, body } = await req(server, 'POST', '/api/control/stop');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(forge.orchestrator._running, false);
  });

  it('returns 409 when orchestrator is not running', async () => {
    const { status, body } = await req(server, 'POST', '/api/control/stop');
    assert.equal(status, 409);
    assert.equal(body.ok, false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/review/:prNumber/approve and /reject
// ---------------------------------------------------------------------------

describe('POST /api/review/:prNumber/approve', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('emits review.approved event and returns ok:true', async () => {
    let emitted = null;
    forge.eventBus.once('review.approved', (p) => { emitted = p; });

    const { status, body } = await req(server, 'POST', '/api/review/42/approve');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 42);
    assert.equal(body.action, 'approved');
    assert.ok(emitted !== null);
    assert.equal(emitted.prNumber, 42);
  });

  it('returns 400 for non-numeric PR number', async () => {
    const { status, body } = await req(server, 'POST', '/api/review/abc/approve');
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('returns 400 for PR number 0', async () => {
    const { status, body } = await req(server, 'POST', '/api/review/0/approve');
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

describe('POST /api/review/:prNumber/reject', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise((r) => server.once('listening', r));
  });
  after(async () => new Promise((r) => server.close(r)));

  it('emits review.rejected event and returns ok:true', async () => {
    let emitted = null;
    forge.eventBus.once('review.rejected', (p) => { emitted = p; });

    const { status, body } = await req(server, 'POST', '/api/review/7/reject', {
      reason: 'Tests are missing',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 7);
    assert.equal(body.action, 'rejected');
    assert.equal(body.reason, 'Tests are missing');
    assert.ok(emitted !== null);
    assert.equal(emitted.reason, 'Tests are missing');
  });

  it('returns 400 when reason is missing', async () => {
    const { status, body } = await req(server, 'POST', '/api/review/7/reject', {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('returns 400 for non-numeric PR number', async () => {
    const { status, body } = await req(server, 'POST', '/api/review/abc/reject', {
      reason: 'bad',
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});
