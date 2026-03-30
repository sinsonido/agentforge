/**
 * @file tests/auth/auth.test.js
 * @description Unit tests for src/auth/auth.js (authMiddleware).
 *
 * Exercises the middleware with mocked req/res/next — no HTTP server required.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createToken } from '../../src/auth/session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(headers = {}) {
  return { headers };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body  = body; return this; },
  };
  return res;
}

function makeNext() {
  let called = false;
  const fn = () => { called = true; };
  fn.wasCalled = () => called;
  return fn;
}

// authMiddleware is sensitive to process.env at module-load time, so we
// re-import it after adjusting the env where needed.
// Node's module cache is keyed on the resolved path; to get a fresh instance
// we alter the env then import with a cache-busting query string.

async function loadMiddleware() {
  // Force a fresh import by appending a unique query parameter.
  const { authMiddleware } = await import(`../../src/auth/auth.js?t=${Date.now()}`);
  return authMiddleware;
}

// ---------------------------------------------------------------------------
// Tests run in NODE_ENV=test (default), AUTH_ENABLED not set
// ---------------------------------------------------------------------------

describe('authMiddleware — test mode (auth disabled)', () => {
  let mw;

  before(async () => {
    delete process.env.AUTH_ENABLED;
    process.env.NODE_ENV = 'test';
    mw = await loadMiddleware();
  });

  it('sets req.user = null and calls next() with no Authorization header', () => {
    const req  = makeReq({});
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.equal(req.user, null);
    assert.ok(next.wasCalled());
  });

  it('sets req.user = null and calls next() even with a Bearer token', () => {
    const token = createToken({ id: '1', username: 'a', role: 'admin' });
    const req   = makeReq({ authorization: `Bearer ${token}` });
    const res   = makeRes();
    const next  = makeNext();
    mw(req, res, next);
    assert.equal(req.user, null);
    assert.ok(next.wasCalled());
  });
});

// ---------------------------------------------------------------------------
// Tests with AUTH_ENABLED=true and NODE_ENV=production-like
// ---------------------------------------------------------------------------

describe('authMiddleware — auth enabled', () => {
  let mw;

  before(async () => {
    process.env.AUTH_ENABLED = 'true';
    process.env.NODE_ENV     = 'production';
    mw = await loadMiddleware();
  });

  after(() => {
    delete process.env.AUTH_ENABLED;
    process.env.NODE_ENV = 'test';
  });

  it('returns 401 when no Authorization header is present', () => {
    const req  = makeReq({});
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.equal(res._status, 401);
    assert.ok(!next.wasCalled());
  });

  it('returns 401 when Authorization scheme is not Bearer', () => {
    const req  = makeReq({ authorization: 'Basic dXNlcjpwYXNz' });
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.equal(res._status, 401);
    assert.ok(!next.wasCalled());
  });

  it('returns 401 for an invalid JWT', () => {
    const req  = makeReq({ authorization: 'Bearer not.a.valid.jwt' });
    const res  = makeRes();
    const next = makeNext();
    mw(req, res, next);
    assert.equal(res._status, 401);
    assert.ok(!next.wasCalled());
  });

  it('sets req.user and calls next() for a valid JWT', () => {
    const user  = { id: 'u1', username: 'alice', role: 'operator' };
    const token = createToken(user);
    const req   = makeReq({ authorization: `Bearer ${token}` });
    const res   = makeRes();
    const next  = makeNext();
    mw(req, res, next);
    assert.ok(next.wasCalled());
    assert.equal(req.user.id,       user.id);
    assert.equal(req.user.username, user.username);
    assert.equal(req.user.role,     user.role);
  });

  it('sets req.user to admin sentinel and calls next() for a valid static API key', async () => {
    process.env.AGENTFORGE_API_KEY = 'my-static-key';
    const mwWithKey = await loadMiddleware();
    const req  = makeReq({ authorization: 'Bearer my-static-key' });
    const res  = makeRes();
    const next = makeNext();
    mwWithKey(req, res, next);
    assert.ok(req.user, 'req.user should be set');
    assert.equal(req.user.role, 'admin', 'static API key grants admin role');
    assert.ok(next.wasCalled());
    delete process.env.AGENTFORGE_API_KEY;
  });
});
