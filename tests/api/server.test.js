/**
 * @file tests/api/server.test.js
 * @description Integration tests for src/api/server.js — endpoints not yet
 *   covered by tests/api.test.js (tasks CRUD, quotas, costs, events,
 *   orchestrator control, CORS, and review endpoints).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import { startServer } from '../../src/api/server.js';

// ---------------------------------------------------------------------------
// Minimal forge factory
// ---------------------------------------------------------------------------

function makeForge(overrides = {}) {
  const taskQueue    = new TaskQueue();
  const quotaManager = new QuotaManager();
  const eventBus     = Object.assign(new EventEmitter(), {
    getRecentEvents: (n) => [
      { event: 'task.queued', data: { id: 'e1' }, ts: Date.now() },
    ].slice(0, n),
  });

  const orchestrator = {
    _running: false,
    start() { this._running = true; },
    stop()  { this._running = false; },
  };

  const costTracker = {
    getAllStats: () => ({
      totalCost: 0.42,
      byModel: { 'claude-opus-4-6': 0.42 },
      budgets: {},
    }),
  };

  return {
    taskQueue,
    quotaManager,
    eventBus,
    orchestrator,
    costTracker,
    agentPool: null,
    providerRegistry: null,
    db: null,
    config: { project: { name: 'test-project' } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function req(server, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }));
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
    forge  = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });
  after(async () => new Promise(r => server.close(r)));

  it('returns ok:true with orchestrator and task stats', async () => {
    const { status, body } = await req(server, 'GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.orchestrator.running, 'boolean');
    assert.ok(body.tasks);
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks  &  POST /api/tasks
// ---------------------------------------------------------------------------

describe('GET /api/tasks and POST /api/tasks', () => {
  let server, forge;

  before(async () => {
    forge  = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });
  after(async () => new Promise(r => server.close(r)));

  it('GET /api/tasks returns empty list initially', async () => {
    const { status, body } = await req(server, 'GET', '/api/tasks');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.tasks));
    assert.equal(body.count, 0);
  });

  it('POST /api/tasks creates a task and returns 201', async () => {
    const { status, body } = await req(server, 'POST', '/api/tasks', {
      title: 'Implement feature Y',
      type: 'implement',
      priority: 'high',
    });
    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.task.title, 'Implement feature Y');
    assert.ok(body.task.id);
  });

  it('POST /api/tasks returns 400 when title is missing', async () => {
    const { status, body } = await req(server, 'POST', '/api/tasks', { type: 'implement' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('title'));
  });

  it('GET /api/tasks?status=queued filters by status', async () => {
    // Add a task first
    await req(server, 'POST', '/api/tasks', { title: 'Filtered task', type: 'test' });
    const { status, body } = await req(server, 'GET', '/api/tasks?status=queued');
    assert.equal(status, 200);
    assert.ok(body.tasks.every(t => t.status === 'queued'));
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks/:id
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id', () => {
  let server, forge, taskId;

  before(async () => {
    forge  = makeForge();
    const t = forge.taskQueue.add({ title: 'Known task' });
    taskId = t.id;
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });
  after(async () => new Promise(r => server.close(r)));

  it('returns the task when found', async () => {
    const { status, body } = await req(server, 'GET', `/api/tasks/${taskId}`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.task.id, taskId);
    assert.equal(body.task.title, 'Known task');
  });

  it('returns 404 for unknown task id', async () => {
    const { status, body } = await req(server, 'GET', '/api/tasks/nonexistent-id');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/quotas
// ---------------------------------------------------------------------------

describe('GET /api/quotas', () => {
  let server, forge;

  before(async () => {
    forge  = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });
  after(async () => new Promise(r => server.close(r)));

  it('returns quota statuses', async () => {
    const { status, body } = await req(server, 'GET', '/api/quotas');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.quotas !== undefined);
  });
});

// ---------------------------------------------------------------------------
// GET /api/costs
// ---------------------------------------------------------------------------

describe('GET /api/costs', () => {
  let server, forge;

  before(async () => {
    forge  = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });
  after(async () => new Promise(r => server.close(r)));

  it('returns cost data from costTracker', async () => {
    const { status, body } = await req(server, 'GET', '/api/costs');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.available, true);
    assert.ok(body.costs.byModel);
  });

  it('returns available:false when no costTracker and no db', async () => {
    const noTrackerForge = makeForge({ costTracker: null, db: null });
    const s = startServer(noTrackerForge, 0);
    await new Promise(r => s.once('listening', r));
    const { body } = await req(s, 'GET', '/api/costs');
    assert.equal(body.available, false);
    await new Promise(r => s.close(r));
  });
});

// ---------------------------------------------------------------------------
// GET /api/events
// ---------------------------------------------------------------------------

describe('GET /api/events', () => {
  let server, forge;

  before(async () => {
    forge  = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });
  after(async () => new Promise(r => server.close(r)));

  it('returns events from eventBus when db is absent', async () => {
    const { status, body } = await req(server, 'GET', '/api/events');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.events));
    assert.equal(body.count, body.events.length);
  });

  it('respects ?limit query param', async () => {
    const { body } = await req(server, 'GET', '/api/events?limit=1');
    assert.ok(body.events.length <= 1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/control/start  &  /api/control/stop
// ---------------------------------------------------------------------------

describe('POST /api/control/start and /api/control/stop', () => {
  let server, forge;

  before(async () => {
    forge  = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });
  after(async () => new Promise(r => server.close(r)));

  it('starts the orchestrator', async () => {
    const { status, body } = await req(server, 'POST', '/api/control/start');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(forge.orchestrator._running, true);
  });

  it('returns 409 when orchestrator is already running', async () => {
    // Already started from previous test
    const { status, body } = await req(server, 'POST', '/api/control/start');
    assert.equal(status, 409);
    assert.equal(body.ok, false);
  });

  it('stops the orchestrator', async () => {
    const { status, body } = await req(server, 'POST', '/api/control/stop');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(forge.orchestrator._running, false);
  });

  it('returns 409 when orchestrator is already stopped', async () => {
    const { status, body } = await req(server, 'POST', '/api/control/stop');
    assert.equal(status, 409);
    assert.equal(body.ok, false);
  });

  it('returns 503 when orchestrator is null', async () => {
    const noOrchForge = makeForge({ orchestrator: null });
    const s = startServer(noOrchForge, 0);
    await new Promise(r => s.once('listening', r));
    const { status } = await req(s, 'POST', '/api/control/start');
    assert.equal(status, 503);
    await new Promise(r => s.close(r));
  });
});

// ---------------------------------------------------------------------------
// POST /api/review/:prNumber/approve  &  reject
// ---------------------------------------------------------------------------

describe('POST /api/review/:prNumber/approve and reject', () => {
  let server, forge;

  before(async () => {
    forge  = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });
  after(async () => new Promise(r => server.close(r)));

  it('approves a valid PR number and emits review.approved', async () => {
    const events = [];
    forge.eventBus.on('review.approved', e => events.push(e));

    const { status, body } = await req(server, 'POST', '/api/review/42/approve');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 42);
    assert.equal(body.action, 'approved');
    assert.equal(events.length, 1);
    assert.equal(events[0].prNumber, 42);
  });

  it('rejects with 400 for invalid PR number', async () => {
    const { status, body } = await req(server, 'POST', '/api/review/0/approve');
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('rejects a PR with reason and emits review.rejected', async () => {
    const events = [];
    forge.eventBus.on('review.rejected', e => events.push(e));

    const { status, body } = await req(server, 'POST', '/api/review/7/reject', {
      reason: 'Missing tests',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 7);
    assert.equal(body.reason, 'Missing tests');
    assert.equal(events[0].reason, 'Missing tests');
  });

  it('returns 400 when reason is missing on reject', async () => {
    const { status, body } = await req(server, 'POST', '/api/review/5/reject', {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('reason'));
  });
});

// ---------------------------------------------------------------------------
// CORS middleware
// ---------------------------------------------------------------------------

describe('CORS middleware', () => {
  let server, forge;

  before(async () => {
    forge  = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });
  after(async () => new Promise(r => server.close(r)));

  it('sets CORS headers for localhost origin', async () => {
    const { headers } = await req(server, 'GET', '/api/status', undefined, {
      Origin: 'http://localhost:5173',
    });
    assert.equal(headers['access-control-allow-origin'], 'http://localhost:5173');
  });

  it('does not set CORS headers for non-localhost origin', async () => {
    const { headers } = await req(server, 'GET', '/api/status', undefined, {
      Origin: 'https://evil.com',
    });
    assert.equal(headers['access-control-allow-origin'], undefined);
  });
});
