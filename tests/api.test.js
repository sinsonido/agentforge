/**
 * @file tests/api.test.js
 * @description Tests for the three new REST endpoints added for the UI:
 *   POST /api/tasks/:id/status  — Kanban drag-and-drop
 *   POST /api/agents/:id        — agent config update
 *   POST /api/providers/test    — provider connection test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { TaskQueue } from '../src/core/task-queue.js';
import { QuotaManager } from '../src/core/quota-tracker.js';
import { startServer } from '../src/api/server.js';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal forge stub
// ─────────────────────────────────────────────────────────────────────────────

function makeForge() {
  const taskQueue    = new TaskQueue();
  const quotaManager = new QuotaManager();
  const eventBus     = Object.assign(new EventEmitter(), {
    getRecentEvents: () => [],
  });

  // Minimal agent pool stub
  const agentPool = {
    _configs: {},
    getAllStatuses() {
      return { dummy: { agentId: 'dummy', status: 'idle', model: 'claude-opus-4-6' } };
    },
    updateAgentConfig(id, cfg) {
      if (id !== 'dummy') return false;
      Object.assign(this._configs[id] ?? (this._configs[id] = {}), cfg);
      return true;
    },
  };

  // Minimal provider registry stub
  const providerRegistry = {
    _providers: {
      'anthropic': { name: 'anthropic' },
      'broken':    { name: 'broken', test: async () => { throw new Error('unreachable'); } },
    },
    get(id) { return this._providers[id] ?? null; },
  };

  return { taskQueue, quotaManager, eventBus, agentPool, providerRegistry,
    orchestrator: { _running: false, start() {}, stop() {} },
    costTracker: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

function req(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(data) });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/tasks/:id/status', () => {
  let server, forge, taskId;

  before(async () => {
    forge = makeForge();
    const t = forge.taskQueue.add({ title: 'Test task' });
    taskId = t.id;
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => new Promise(r => server.close(r)));

  it('moves a task to a valid status', async () => {
    const { status, body } = await req(server, 'POST', `/api/tasks/${taskId}/status`, { status: 'completed' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'completed');
    const updated = forge.taskQueue.get(taskId);
    assert.equal(updated.status, 'completed');
  });

  it('rejects an invalid status value', async () => {
    const { status, body } = await req(server, 'POST', `/api/tasks/${taskId}/status`, { status: 'bogus' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('returns 400 when status is missing', async () => {
    const { status, body } = await req(server, 'POST', `/api/tasks/${taskId}/status`, {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('returns 404 for an unknown task ID', async () => {
    const { status, body } = await req(server, 'POST', `/api/tasks/nonexistent/status`, { status: 'queued' });
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });
});

describe('POST /api/agents/:id', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => new Promise(r => server.close(r)));

  it('updates an existing agent config', async () => {
    const { status, body } = await req(server, 'POST', '/api/agents/dummy', {
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'You are helpful.',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.agentId, 'dummy');
    assert.equal(body.model, 'claude-haiku-4-5-20251001');
  });

  it('returns 404 when agent does not exist', async () => {
    const { status, body } = await req(server, 'POST', '/api/agents/noexist', { model: 'x' });
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });
});

describe('POST /api/providers/test', () => {
  let server, forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => new Promise(r => server.close(r)));

  it('succeeds for a registered provider without a test() method', async () => {
    const { status, body } = await req(server, 'POST', '/api/providers/test', { provider: 'anthropic' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'reachable');
  });

  it('returns ok:false when provider test() throws', async () => {
    const { status, body } = await req(server, 'POST', '/api/providers/test', { provider: 'broken' });
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('unreachable'));
  });

  it('returns 404 for an unregistered provider', async () => {
    const { status, body } = await req(server, 'POST', '/api/providers/test', { provider: 'unknown' });
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });

  it('returns 400 when provider field is missing', async () => {
    const { status, body } = await req(server, 'POST', '/api/providers/test', {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});
