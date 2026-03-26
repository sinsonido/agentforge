import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AgentForgeDB } from '../../src/persistence/db.js';
import { getJwtSecret, signToken, verifyToken, revokeToken } from '../../src/auth/session.js';

const DB_PATH = `/tmp/test-session-${Date.now()}.db`;
let db;

before(() => {
  db = new AgentForgeDB(DB_PATH);
});

after(() => {
  db.close();
});

describe('session helpers', () => {
  describe('getJwtSecret', () => {
    it('generates and persists a secret on first call', () => {
      const s1 = getJwtSecret(db);
      assert.equal(typeof s1, 'string');
      assert.ok(s1.length >= 32);
      // Should return the same secret on subsequent calls
      const s2 = getJwtSecret(db);
      assert.equal(s1, s2);
    });
  });

  describe('signToken / verifyToken', () => {
    it('signs and verifies a valid token', () => {
      const token = signToken(db, { userId: 'u1', username: 'alice', role: 'admin' });
      assert.equal(typeof token, 'string');

      const payload = verifyToken(db, token);
      assert.ok(payload, 'should return payload');
      assert.equal(payload.userId, 'u1');
      assert.equal(payload.username, 'alice');
      assert.equal(payload.role, 'admin');
      assert.ok(payload.jti, 'should have jti');
    });

    it('returns null for a tampered token', () => {
      const token = signToken(db, { userId: 'u2', username: 'bob', role: 'viewer' });
      const tampered = token.slice(0, -5) + 'XXXXX';
      const result = verifyToken(db, tampered);
      assert.equal(result, null);
    });

    it('returns null for an empty string', () => {
      assert.equal(verifyToken(db, ''), null);
    });

    it('returns null for a completely invalid token', () => {
      assert.equal(verifyToken(db, 'not.a.jwt'), null);
    });
  });

  describe('revokeToken', () => {
    it('marks a token as revoked so verifyToken returns null', () => {
      const token = signToken(db, { userId: 'u3', username: 'carol', role: 'operator' });
      const payload = verifyToken(db, token);
      assert.ok(payload, 'should be valid before revocation');

      revokeToken(db, payload.jti);

      const after = verifyToken(db, token);
      assert.equal(after, null, 'should be null after revocation');
    });

    it('isTokenRevoked returns true after revocation', () => {
      const token = signToken(db, { userId: 'u4', username: 'dave', role: 'viewer' });
      const payload = verifyToken(db, token);
      assert.equal(db.isTokenRevoked(payload.jti), false);

      revokeToken(db, payload.jti);
      assert.equal(db.isTokenRevoked(payload.jti), true);
    });
  });

  describe('cleanExpiredTokens', () => {
    it('removes entries with past expiry without affecting future ones', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 10;
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      db.revokeToken('expired-jti', pastExp);
      db.revokeToken('future-jti', futureExp);

      assert.equal(db.isTokenRevoked('expired-jti'), true);
      assert.equal(db.isTokenRevoked('future-jti'), true);

      db.cleanExpiredTokens();

      assert.equal(db.isTokenRevoked('expired-jti'), false);
      assert.equal(db.isTokenRevoked('future-jti'), true);
    });
  });
});
