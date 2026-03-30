/**
 * @file tests/auth/rbac.test.js
 * @description Unit tests for src/auth/rbac.js
 *
 * Tests requirePermission middleware using mock req/res/next — no HTTP server needed.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requirePermission, getPermissions, ROLE_PERMISSIONS } from '../../src/auth/rbac.js';

// rbac.test.js tests real RBAC behavior — unset NODE_ENV so test-mode bypass doesn't hide results.
let _savedEnv;
before(() => { _savedEnv = process.env.NODE_ENV; delete process.env.NODE_ENV; });
after(() => { if (_savedEnv !== undefined) process.env.NODE_ENV = _savedEnv; });

// ---------------------------------------------------------------------------
// Helpers — build minimal mock req / res / next
// ---------------------------------------------------------------------------

function makeReq(user) {
  return { user };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
  };
  return res;
}

function makeNext() {
  let called = false;
  const fn = () => { called = true; };
  fn.wasCalled = () => called;
  return fn;
}

// ---------------------------------------------------------------------------
// ROLE_PERMISSIONS shape
// ---------------------------------------------------------------------------

describe('ROLE_PERMISSIONS', () => {
  it('defines admin, operator, and viewer roles', () => {
    assert.ok(Array.isArray(ROLE_PERMISSIONS.admin));
    assert.ok(Array.isArray(ROLE_PERMISSIONS.operator));
    assert.ok(Array.isArray(ROLE_PERMISSIONS.viewer));
  });

  it('admin has all permissions including users:write and audit:read', () => {
    assert.ok(ROLE_PERMISSIONS.admin.includes('users:write'));
    assert.ok(ROLE_PERMISSIONS.admin.includes('audit:read'));
    assert.ok(ROLE_PERMISSIONS.admin.includes('control:start'));
  });

  it('operator has control:start but not users:write or audit:read', () => {
    assert.ok(ROLE_PERMISSIONS.operator.includes('control:start'));
    assert.ok(!ROLE_PERMISSIONS.operator.includes('users:write'));
    assert.ok(!ROLE_PERMISSIONS.operator.includes('audit:read'));
  });

  it('viewer has only read permissions', () => {
    const writes = ROLE_PERMISSIONS.viewer.filter(p => p.endsWith(':write') || p.startsWith('control:') || p.startsWith('review:'));
    assert.equal(writes.length, 0, `viewer should have no write/control/review permissions, got: ${writes.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// getPermissions
// ---------------------------------------------------------------------------

describe('getPermissions', () => {
  it('returns permission array for known role', () => {
    const perms = getPermissions('viewer');
    assert.ok(Array.isArray(perms));
    assert.ok(perms.includes('tasks:read'));
  });

  it('returns empty array for unknown role', () => {
    assert.deepEqual(getPermissions('superuser'), []);
    assert.deepEqual(getPermissions(undefined), []);
    assert.deepEqual(getPermissions(''), []);
  });
});

// ---------------------------------------------------------------------------
// requirePermission — null/undefined user (auth disabled / static key / test mode)
// ---------------------------------------------------------------------------

describe('requirePermission — null user', () => {
  it('calls next() when req.user is null (auth disabled / no-restriction mode)', () => {
    const mw   = requirePermission('tasks:write');
    const req  = makeReq(null);
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.ok(next.wasCalled(), 'next() should be called for null user');
    assert.equal(res._status, null, 'no status should be set');
  });

  it('calls next() when req.user is undefined', () => {
    const mw   = requirePermission('users:write');
    const req  = makeReq(undefined);
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.ok(next.wasCalled(), 'next() should be called for undefined user');
    assert.equal(res._status, null);
  });
});

// ---------------------------------------------------------------------------
// requirePermission — admin role
// ---------------------------------------------------------------------------

describe('requirePermission — admin', () => {
  it('calls next() for any permission', () => {
    const permissions = ['tasks:write', 'agents:write', 'control:start', 'users:write', 'audit:read'];
    for (const perm of permissions) {
      const mw   = requirePermission(perm);
      const req  = makeReq({ id: '1', username: 'admin', role: 'admin' });
      const res  = makeRes();
      const next = makeNext();
      mw(req, res, next);
      assert.ok(next.wasCalled(), `admin should pass for permission '${perm}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// requirePermission — viewer role
// ---------------------------------------------------------------------------

describe('requirePermission — viewer', () => {
  it('calls next() for tasks:read', () => {
    const mw   = requirePermission('tasks:read');
    const req  = makeReq({ id: '2', username: 'viewer1', role: 'viewer' });
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.ok(next.wasCalled());
  });

  it('returns 403 for tasks:write', () => {
    const mw   = requirePermission('tasks:write');
    const req  = makeReq({ id: '2', username: 'viewer1', role: 'viewer' });
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.ok(!next.wasCalled(), 'next() should NOT be called');
    assert.equal(res._status, 403);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.error, 'Forbidden');
    assert.equal(res._body.required, 'tasks:write');
  });

  it('returns 403 for control:start', () => {
    const mw   = requirePermission('control:start');
    const req  = makeReq({ id: '2', username: 'viewer1', role: 'viewer' });
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.ok(!next.wasCalled());
    assert.equal(res._status, 403);
  });

  it('returns 403 for review:approve', () => {
    const mw   = requirePermission('review:approve');
    const req  = makeReq({ id: '2', username: 'viewer1', role: 'viewer' });
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.ok(!next.wasCalled());
    assert.equal(res._status, 403);
  });
});

// ---------------------------------------------------------------------------
// requirePermission — operator role
// ---------------------------------------------------------------------------

describe('requirePermission — operator', () => {
  it('calls next() for control:start', () => {
    const mw   = requirePermission('control:start');
    const req  = makeReq({ id: '3', username: 'op1', role: 'operator' });
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.ok(next.wasCalled());
  });

  it('calls next() for tasks:write', () => {
    const mw   = requirePermission('tasks:write');
    const req  = makeReq({ id: '3', username: 'op1', role: 'operator' });
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.ok(next.wasCalled());
  });

  it('returns 403 for users:write', () => {
    const mw   = requirePermission('users:write');
    const req  = makeReq({ id: '3', username: 'op1', role: 'operator' });
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.ok(!next.wasCalled());
    assert.equal(res._status, 403);
    assert.equal(res._body.required, 'users:write');
  });

  it('returns 403 for audit:read', () => {
    const mw   = requirePermission('audit:read');
    const req  = makeReq({ id: '3', username: 'op1', role: 'operator' });
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.ok(!next.wasCalled());
    assert.equal(res._status, 403);
  });
});

// ---------------------------------------------------------------------------
// requirePermission — unknown role
// ---------------------------------------------------------------------------

describe('requirePermission — unknown role', () => {
  it('returns 403 for an unknown role', () => {
    const mw   = requirePermission('tasks:read');
    const req  = makeReq({ id: '99', username: 'rogue', role: 'superadmin' });
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.ok(!next.wasCalled());
    assert.equal(res._status, 403);
    assert.equal(res._body.ok, false);
  });
});
