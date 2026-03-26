/**
 * @file tests/auth/session.test.js
 * @description Unit tests for src/auth/session.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createToken, verifyToken, generateStaticToken } from '../../src/auth/session.js';

// Helper: create a properly signed token with a custom payload.
// Uses the same known secret that session.js will pick up from the env.
const TEST_SECRET = process.env.AUTH_SECRET ?? 'agentforge-dev-secret-change-in-production';
function signedToken(payloadObj) {
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = createHmac('sha256', TEST_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const SAMPLE_USER = { id: 'abc-123', username: 'alice', role: 'operator' };

describe('createToken', () => {
  it('returns a three-part dot-separated string', () => {
    const token = createToken(SAMPLE_USER);
    assert.equal(typeof token, 'string');
    assert.equal(token.split('.').length, 3);
  });

  it('produces different tokens for different users', () => {
    const t1 = createToken({ id: '1', username: 'a', role: 'viewer' });
    const t2 = createToken({ id: '2', username: 'b', role: 'admin' });
    assert.notEqual(t1, t2);
  });
});

describe('verifyToken', () => {
  it('returns the payload for a valid token', () => {
    const token = createToken(SAMPLE_USER);
    const payload = verifyToken(token);
    assert.ok(payload, 'should return payload');
    assert.equal(payload.sub,      SAMPLE_USER.id);
    assert.equal(payload.username, SAMPLE_USER.username);
    assert.equal(payload.role,     SAMPLE_USER.role);
  });

  it('returns null for a tampered token', () => {
    const token = createToken(SAMPLE_USER);
    const parts = token.split('.');
    // Mutate the signature
    parts[2] = parts[2].slice(0, -4) + 'XXXX';
    assert.equal(verifyToken(parts.join('.')), null);
  });

  it('returns null for a tampered payload', () => {
    const token = createToken(SAMPLE_USER);
    const parts  = token.split('.');
    const newPay = Buffer.from(JSON.stringify({ sub: 'evil', username: 'evil', role: 'admin' })).toString('base64url');
    parts[1] = newPay;
    assert.equal(verifyToken(parts.join('.')), null);
  });

  it('returns null for a non-string', () => {
    assert.equal(verifyToken(null),      null);
    assert.equal(verifyToken(undefined), null);
    assert.equal(verifyToken(42),        null);
  });

  it('returns null for a token with wrong number of parts', () => {
    assert.equal(verifyToken('a.b'),     null);
    assert.equal(verifyToken('a.b.c.d'), null);
  });

  it('returns null for an expired token', () => {
    // Use a properly signed token with an exp well in the past.
    // This exercises the expiry check directly (not the signature check).
    const token = signedToken({
      sub: '1', username: 'x', role: 'viewer',
      iat: 1_000_000, exp: 1_000_001,   // well in the past
    });
    assert.equal(verifyToken(token), null, 'expired token should be rejected');
  });

  it('returns null for a token with missing exp', () => {
    const token = signedToken({ sub: '1', username: 'x', role: 'viewer', iat: Math.floor(Date.now() / 1000) });
    assert.equal(verifyToken(token), null, 'token without exp should be rejected');
  });

  it('returns null for a token with non-numeric exp', () => {
    const token = signedToken({ sub: '1', username: 'x', role: 'viewer', exp: 'never' });
    assert.equal(verifyToken(token), null, 'token with non-numeric exp should be rejected');
  });
});

describe('generateStaticToken', () => {
  it('returns a hex string of 64 characters (32 bytes)', () => {
    const t = generateStaticToken();
    assert.equal(typeof t, 'string');
    assert.equal(t.length, 64);
    assert.match(t, /^[0-9a-f]{64}$/);
  });

  it('generates unique tokens on each call', () => {
    assert.notEqual(generateStaticToken(), generateStaticToken());
  });
});
