/**
 * @file tests/api/auth.test.js
 * @description Unit tests for src/auth/auth.js createAuthMiddleware.
 *
 * GitHub issue #93
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthMiddleware } from '../../src/auth/auth.js';

// ---------------------------------------------------------------------------
// Helpers — minimal req/res/next stubs
// ---------------------------------------------------------------------------

function makeReq({ method = 'GET', path = '/tasks', authorization } = {}) {
  return {
    method,
    path,
    headers: authorization ? { authorization } : {},
  };
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
// Tests
// ---------------------------------------------------------------------------

describe('createAuthMiddleware', () => {
  const SECRET = 'test-secret-abc123';

  // Save and restore NODE_ENV around tests that mutate it
  let savedNodeEnv;
  beforeEach(() => { savedNodeEnv = process.env.NODE_ENV; });
  afterEach(() => { process.env.NODE_ENV = savedNodeEnv; });

  // ── auth disabled ────────────────────────────────────────────────────────

  it('calls next() immediately when enabled=false', () => {
    const mw = createAuthMiddleware({ enabled: false, secret: SECRET });
    const req = makeReq({ authorization: undefined });
    const res = makeRes();
    const next = makeNext();

    process.env.NODE_ENV = 'production'; // ensure not in test bypass
    mw(req, res, next);

    assert.ok(next.wasCalled(), 'next should be called');
    assert.equal(res._status, null, 'should not set status');
  });

  it('calls next() when authConfig is empty object (enabled falsy)', () => {
    const mw = createAuthMiddleware({});
    const next = makeNext();
    process.env.NODE_ENV = 'production';
    mw(makeReq(), makeRes(), next);
    assert.ok(next.wasCalled());
  });

  // ── NODE_ENV=test bypass ─────────────────────────────────────────────────

  it('calls next() in test environment regardless of enabled=true', () => {
    process.env.NODE_ENV = 'test';
    const mw = createAuthMiddleware({ enabled: true, secret: SECRET });
    const next = makeNext();
    // No Authorization header — should still pass
    mw(makeReq(), makeRes(), next);
    assert.ok(next.wasCalled());
  });

  it('calls next() in test environment with wrong token', () => {
    process.env.NODE_ENV = 'test';
    const mw = createAuthMiddleware({ enabled: true, secret: SECRET });
    const next = makeNext();
    mw(makeReq({ authorization: 'Bearer wrong-token' }), makeRes(), next);
    assert.ok(next.wasCalled());
  });

  // ── auth enabled, correct token ──────────────────────────────────────────

  it('calls next() when enabled=true and correct Bearer token is provided', () => {
    process.env.NODE_ENV = 'production';
    const mw = createAuthMiddleware({ enabled: true, secret: SECRET });
    const next = makeNext();
    mw(makeReq({ authorization: `Bearer ${SECRET}` }), makeRes(), next);
    assert.ok(next.wasCalled());
  });

  // ── auth enabled, wrong token ────────────────────────────────────────────

  it('returns 401 when enabled=true and wrong token is provided', () => {
    process.env.NODE_ENV = 'production';
    const mw = createAuthMiddleware({ enabled: true, secret: SECRET });
    const res = makeRes();
    const next = makeNext();
    mw(makeReq({ authorization: 'Bearer wrong-token' }), res, next);
    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { ok: false, error: 'Unauthorized' });
    assert.ok(!next.wasCalled());
  });

  // ── auth enabled, no Authorization header ────────────────────────────────

  it('returns 401 when enabled=true and no Authorization header', () => {
    process.env.NODE_ENV = 'production';
    const mw = createAuthMiddleware({ enabled: true, secret: SECRET });
    const res = makeRes();
    const next = makeNext();
    mw(makeReq(), res, next);
    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { ok: false, error: 'Unauthorized' });
    assert.ok(!next.wasCalled());
  });

  it('returns 401 when Authorization header has wrong scheme', () => {
    process.env.NODE_ENV = 'production';
    const mw = createAuthMiddleware({ enabled: true, secret: SECRET });
    const res = makeRes();
    const next = makeNext();
    mw(makeReq({ authorization: `Basic ${SECRET}` }), res, next);
    assert.equal(res._status, 401);
    assert.ok(!next.wasCalled());
  });

  // ── health-check exemption ───────────────────────────────────────────────

  it('passes GET /api/status through even when enabled=true and no token', () => {
    process.env.NODE_ENV = 'production';
    // The middleware is mounted at /api, so req.path is /status (not /api/status)
    const mw = createAuthMiddleware({ enabled: true, secret: SECRET });
    const next = makeNext();
    const req = makeReq({ method: 'GET', path: '/status' });
    mw(req, makeRes(), next);
    assert.ok(next.wasCalled());
  });

  it('does NOT exempt POST /api/status from auth', () => {
    process.env.NODE_ENV = 'production';
    const mw = createAuthMiddleware({ enabled: true, secret: SECRET });
    const res = makeRes();
    const next = makeNext();
    const req = makeReq({ method: 'POST', path: '/status' });
    mw(req, res, next);
    assert.equal(res._status, 401);
    assert.ok(!next.wasCalled());
  });
});
