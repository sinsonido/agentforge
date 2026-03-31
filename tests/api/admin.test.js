/**
 * @file tests/api/admin.test.js
 * @description Tests for admin user management API endpoints.
 *
 * GET    /api/admin/users
 * POST   /api/admin/users
 * PATCH  /api/admin/users/:id
 * POST   /api/admin/users/:id/reset-password
 * DELETE /api/admin/users/:id
 *
 * GitHub issue #98
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
// Helpers
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

/**
 * Make an HTTP request against a running test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Promise<{status: number, body: unknown}>}
 */
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

/**
 * Build an Authorization header value for use with the server's auth middleware.
 *
 * Encodes credentials as Base64("username:password") and wraps them in a
 * Bearer token, matching the format expected by buildAuthMiddleware().
 *
 * @param {string} username
 * @param {string} password
 * @returns {string} The Authorization header value, e.g. "Bearer <base64>".
 */
function bearerToken(username, password) {
  return `Bearer ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------

describe('GET /api/admin/users', () => {
  let server, userStore;

  before(async () => {
    userStore = new UserStore(); // fresh store with seeded admin
    server = startServer(makeForge(userStore), 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => new Promise(r => server.close(r)));

  it('returns list of users without password_hash', async () => {
    const { status, body } = await req(server, 'GET', '/api/admin/users');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.users));
    assert.ok(body.users.length >= 1);
    // Must not expose password_hash
    for (const u of body.users) {
      assert.equal(u.password_hash, undefined);
    }
  });

  it('includes the seeded admin user', async () => {
    const { body } = await req(server, 'GET', '/api/admin/users');
    const admin = body.users.find(u => u.username === 'admin');
    assert.ok(admin, 'admin user should exist');
    assert.equal(admin.role, 'admin');
    assert.equal(admin.isActive, true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users
// ---------------------------------------------------------------------------

describe('POST /api/admin/users', () => {
  let server, userStore;

  before(async () => {
    userStore = new UserStore();
    server = startServer(makeForge(userStore), 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => new Promise(r => server.close(r)));

  it('creates a new user and returns 201', async () => {
    const { status, body } = await req(server, 'POST', '/api/admin/users', {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'operator',
      password: 'secret123',
    });
    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.user.username, 'alice');
    assert.equal(body.user.role, 'operator');
    assert.equal(body.user.password_hash, undefined);
  });

  it('returns 409 for a duplicate username', async () => {
    // Create once
    await req(server, 'POST', '/api/admin/users', {
      username: 'bob',
      role: 'viewer',
      password: 'pass1',
    });
    // Try again with same username
    const { status, body } = await req(server, 'POST', '/api/admin/users', {
      username: 'bob',
      role: 'viewer',
      password: 'pass2',
    });
    assert.equal(status, 409);
    assert.equal(body.ok, false);
  });

  it('returns 400 when username is missing', async () => {
    const { status, body } = await req(server, 'POST', '/api/admin/users', {
      role: 'viewer',
      password: 'x',
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('returns 400 when password is missing', async () => {
    const { status, body } = await req(server, 'POST', '/api/admin/users', {
      username: 'carol',
      role: 'viewer',
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('returns 400 for an invalid role value', async () => {
    const { status, body } = await req(server, 'POST', '/api/admin/users', {
      username: 'dave',
      role: 'superuser',
      password: 'x',
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('role'));
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/users/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/admin/users/:id', () => {
  let server, userStore, operatorId;

  before(async () => {
    userStore = new UserStore();
    // Create an operator to manipulate in tests
    const op = userStore.create({ username: 'op1', role: 'operator', password: 'pw' });
    operatorId = op.id;

    server = startServer(makeForge(userStore), 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => new Promise(r => server.close(r)));

  it('updates the role of a user', async () => {
    const { status, body } = await req(server, 'PATCH', `/api/admin/users/${operatorId}`, {
      role: 'viewer',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.user.role, 'viewer');
  });

  it('deactivates a non-admin user', async () => {
    const { status, body } = await req(server, 'PATCH', `/api/admin/users/${operatorId}`, {
      isActive: false,
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.user.isActive, false);
  });

  it('returns 400 when attempting to deactivate the last active admin', async () => {
    // Look up the seeded admin by username rather than assuming a specific id
    const adminUser = userStore.findByUsername('admin');
    assert.ok(adminUser, 'seeded admin should exist');
    const { status, body } = await req(server, 'PATCH', `/api/admin/users/${adminUser.id}`, {
      isActive: false,
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('last active admin'));
  });

  it('returns 404 for unknown user id', async () => {
    const { status, body } = await req(server, 'PATCH', '/api/admin/users/9999', {
      role: 'viewer',
    });
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });

  it('returns 400 for an invalid role value', async () => {
    const { status, body } = await req(server, 'PATCH', `/api/admin/users/${operatorId}`, {
      role: 'god',
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('role'));
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/reset-password
// ---------------------------------------------------------------------------

describe('POST /api/admin/users/:id/reset-password', () => {
  let server, userStore, userId;

  before(async () => {
    userStore = new UserStore();
    const u = userStore.create({ username: 'eve', role: 'viewer', password: 'oldpass' });
    userId = u.id;

    server = startServer(makeForge(userStore), 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => new Promise(r => server.close(r)));

  it('resets the password and returns ok:true', async () => {
    const { status, body } = await req(server, 'POST', `/api/admin/users/${userId}/reset-password`, {
      password: 'newpassword',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it('returns 400 when password is missing', async () => {
    const { status, body } = await req(server, 'POST', `/api/admin/users/${userId}/reset-password`, {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('returns 404 for unknown user id', async () => {
    const { status, body } = await req(server, 'POST', '/api/admin/users/9999/reset-password', {
      password: 'x',
    });
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Self-deactivation guard — HTTP-level test via auth middleware
// ---------------------------------------------------------------------------

describe('PATCH /api/admin/users/:id — self-deactivation guard', () => {
  let server, userStore;

  before(async () => {
    userStore = new UserStore();
    // Create a second admin so "last admin" guard doesn't fire first
    userStore.create({ username: 'admin2', role: 'admin', password: 'pw' });

    server = startServer(makeForge(userStore), 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => new Promise(r => server.close(r)));

  it('userStore.countAdmins() reflects active admin count', () => {
    assert.equal(userStore.countAdmins(), 2);
  });

  it('returns 400 when an admin tries to deactivate their own account (HTTP, Bearer token)', async () => {
    // The auth middleware runs in all environments and populates req.user from
    // a valid Bearer token even when NODE_ENV=test.  The self-deactivation
    // guard in the route handler fires when req.user.userId === :id.
    const admin = userStore.findByUsername('admin');
    assert.ok(admin, 'seeded admin should exist');
    const authHeader = bearerToken('admin', 'admin');
    const { status, body } = await req(
      server, 'PATCH', `/api/admin/users/${admin.id}`,
      { isActive: false },
      { Authorization: authHeader },
    );
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('Cannot deactivate your own account'));
  });

  it('deactivating one admin still leaves another active admin', () => {
    const admin2 = userStore.findByUsername('admin2');
    userStore.update(admin2.id, { isActive: false });
    assert.equal(userStore.countAdmins(), 1);
  });
});

// RBAC enforcement tests (401/403) live in admin-rbac.test.js to avoid
// process.env.NODE_ENV race conditions with concurrent describe blocks.

// ---------------------------------------------------------------------------
// DELETE /api/admin/users/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/admin/users/:id', () => {
  let server, userStore, deletableId;

  before(async () => {
    userStore = new UserStore();
    const u = userStore.create({ username: 'todelete', role: 'viewer', password: 'pw' });
    deletableId = u.id;

    server = startServer(makeForge(userStore), 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => new Promise(r => server.close(r)));

  it('deletes an existing user and returns ok:true', async () => {
    const { status, body } = await req(server, 'DELETE', `/api/admin/users/${deletableId}`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    // User should no longer appear in list
    const list = await req(server, 'GET', '/api/admin/users');
    const found = list.body.users.find(u => u.id === deletableId);
    assert.equal(found, undefined);
  });

  it('returns 404 when deleting a non-existent user', async () => {
    const { status, body } = await req(server, 'DELETE', '/api/admin/users/9999');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });
});
