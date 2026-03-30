/**
 * @file tests/api/admin-rbac.test.js
 * @description RBAC enforcement tests for admin API endpoints.
 *
 * Uses startServer(..., { enforceRbac: true }) so requirePermission() enforces
 * auth on the test server without mutating process.env.NODE_ENV (which is
 * shared across concurrent worker threads and would race with admin.test.js).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import { UserStore } from '../../src/auth/users.js';
import { startServer } from '../../src/api/server.js';

// ---------------------------------------------------------------------------
// Helpers (same as admin.test.js)
// ---------------------------------------------------------------------------

function makeForge(userStore) {
  const taskQueue    = new TaskQueue();
  const quotaManager = new QuotaManager();
  const eventBus     = Object.assign(new EventEmitter(), {
    getRecentEvents: () => [],
  });
  const agentPool = {
    getAllStatuses() { return {}; },
    updateAgentConfig() { return false; },
  };
  const providerRegistry = {
    get() { return null; },
  };

  return {
    taskQueue,
    quotaManager,
    eventBus,
    agentPool,
    providerRegistry,
    orchestrator: { _running: false, start() {}, stop() {} },
    costTracker: null,
    userStore,
  };
}

function req(server, method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    };
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

function bearerToken(username, password) {
  return `Bearer ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// RBAC — 401 / 403 enforcement
// ---------------------------------------------------------------------------

describe('RBAC — admin-only access controls', () => {
  let server, userStore;

  before(async () => {
    userStore = new UserStore();
    // In production mode the admin is not auto-seeded — create it explicitly.
    userStore.create({ username: 'admin', role: 'admin', password: 'admin' });
    userStore.create({ username: 'viewer1', role: 'viewer', password: 'pw' });
    userStore.create({ username: 'op1', role: 'operator', password: 'pw' });

    server = startServer(makeForge(userStore), 0, '127.0.0.1', { enforceRbac: true });
    await new Promise(r => server.once('listening', r));
  });

  after(async () => new Promise(r => server.close(r)));

  it('returns 401 when no credentials are provided', async () => {
    const { status, body } = await req(server, 'GET', '/api/admin/users');
    assert.equal(status, 401);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Unauthorized');
  });

  it('returns 403 for a viewer attempting to list users', async () => {
    const { status, body } = await req(
      server, 'GET', '/api/admin/users', undefined,
      { Authorization: bearerToken('viewer1', 'pw') },
    );
    assert.equal(status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Forbidden');
  });

  it('returns 403 for an operator attempting to list users', async () => {
    const { status, body } = await req(
      server, 'GET', '/api/admin/users', undefined,
      { Authorization: bearerToken('op1', 'pw') },
    );
    assert.equal(status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Forbidden');
  });

  it('allows an admin to list users when authenticated', async () => {
    const { status, body } = await req(
      server, 'GET', '/api/admin/users', undefined,
      { Authorization: bearerToken('admin', 'admin') },
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.users));
  });

  it('returns 403 for a viewer attempting to create a user', async () => {
    const { status } = await req(
      server, 'POST', '/api/admin/users',
      { username: 'x', role: 'viewer', password: 'x' },
      { Authorization: bearerToken('viewer1', 'pw') },
    );
    assert.equal(status, 403);
  });
});
