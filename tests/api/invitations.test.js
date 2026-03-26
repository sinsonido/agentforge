/**
 * @file tests/api/invitations.test.js
 * @description Unit tests for InvitationStore.
 *
 * Uses in-memory SQLite to test invitation creation, retrieval,
 * acceptance, revocation and filtering by status.
 *
 * GitHub issue #101: Invitation system.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { InvitationStore } from '../../src/auth/invitations.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create an in-memory SQLite DB with the invitations schema.
 * Includes minimal users and teams tables to satisfy FK constraints.
 */
function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE invitations (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
      token TEXT NOT NULL UNIQUE,
      invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending'
    );
  `);

  // Seed a user to act as inviter
  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, role) VALUES ('u1', 'admin', 'admin@example.com', 'hash', 'admin')`
  ).run();

  return db;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InvitationStore', () => {
  let db;
  let store;

  before(() => {
    db = makeDb();
    store = new InvitationStore(db);
  });

  after(() => {
    db.close();
  });

  // Reset between tests by clearing invitations table
  beforeEach(() => {
    db.prepare('DELETE FROM invitations').run();
  });

  // ── createInvitation ───────────────────────────────────────────────────────

  describe('createInvitation()', () => {
    it('creates an invitation with default role and 168h expiry', () => {
      const inv = store.createInvitation({ email: 'alice@example.com', invitedBy: 'u1' });
      assert.ok(inv.id, 'has id');
      assert.equal(inv.email, 'alice@example.com');
      assert.equal(inv.role, 'viewer');
      assert.equal(inv.teamId, null);
      assert.equal(inv.status, 'pending');
      assert.ok(inv.token.length >= 64, 'token is 64+ hex chars');
      assert.ok(inv.expiresAt > inv.createdAt, 'expiresAt is after createdAt');
      // Default 168 h (7 days)
      const diffHours = (inv.expiresAt - inv.createdAt) / 3600;
      assert.ok(diffHours >= 167 && diffHours <= 169, `expiry is ~168h, got ${diffHours}`);
    });

    it('creates an invitation with custom role and expiry', () => {
      const inv = store.createInvitation({
        email: 'bob@example.com',
        role: 'admin',
        invitedBy: 'u1',
        expiresInHours: 24,
      });
      assert.equal(inv.role, 'admin');
      const diffHours = (inv.expiresAt - inv.createdAt) / 3600;
      assert.ok(diffHours >= 23 && diffHours <= 25, `expiry is ~24h, got ${diffHours}`);
    });

    it('throws when email is missing', () => {
      assert.throws(
        () => store.createInvitation({ invitedBy: 'u1' }),
        /email is required/i
      );
    });

    it('allows creating invitation without invitedBy (nullable)', () => {
      // invitedBy is now nullable — no error expected
      const inv = store.createInvitation({ email: 'noinviter@example.com' });
      assert.equal(inv.email, 'noinviter@example.com');
      assert.equal(inv.invitedBy, null);
    });
  });

  // ── getByToken ─────────────────────────────────────────────────────────────

  describe('getByToken()', () => {
    it('returns a valid pending invitation by token', () => {
      const created = store.createInvitation({ email: 'c@example.com', invitedBy: 'u1' });
      const found = store.getByToken(created.token);
      assert.ok(found, 'found the invitation');
      assert.equal(found.id, created.id);
      assert.equal(found.email, 'c@example.com');
    });

    it('returns null for an unknown token', () => {
      const result = store.getByToken('nonexistent-token');
      assert.equal(result, null);
    });

    it('still returns the row for an expired invitation (status check is caller responsibility)', () => {
      // Insert a past-expired invitation directly
      const created = store.createInvitation({ email: 'd@example.com', invitedBy: 'u1', expiresInHours: 1 });
      // Manually set expires_at to the past
      db.prepare(`UPDATE invitations SET expires_at = 1 WHERE id = ?`).run(created.id);
      // expireStale should mark it expired
      store.expireStale();
      const found = store.getByToken(created.token);
      assert.ok(found, 'row still found');
      assert.equal(found.status, 'expired');
    });
  });

  // ── getById ────────────────────────────────────────────────────────────────

  describe('getById()', () => {
    it('returns invitation by id', () => {
      const inv = store.createInvitation({ email: 'e@example.com', invitedBy: 'u1' });
      const found = store.getById(inv.id);
      assert.ok(found);
      assert.equal(found.id, inv.id);
    });

    it('returns null for unknown id', () => {
      assert.equal(store.getById('no-such-id'), null);
    });
  });

  // ── listInvitations ────────────────────────────────────────────────────────

  describe('listInvitations()', () => {
    it('lists all invitations when no filter given', () => {
      store.createInvitation({ email: 'a@x.com', invitedBy: 'u1' });
      store.createInvitation({ email: 'b@x.com', invitedBy: 'u1' });
      const all = store.listInvitations();
      assert.equal(all.length, 2);
    });

    it('filters by status', () => {
      const inv = store.createInvitation({ email: 'f@x.com', invitedBy: 'u1' });
      store.revokeInvitation(inv.id);
      store.createInvitation({ email: 'g@x.com', invitedBy: 'u1' });

      const pending = store.listInvitations({ status: 'pending' });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].email, 'g@x.com');

      const revoked = store.listInvitations({ status: 'revoked' });
      assert.equal(revoked.length, 1);
      assert.equal(revoked[0].email, 'f@x.com');
    });
  });

  // ── acceptInvitation ───────────────────────────────────────────────────────

  describe('acceptInvitation()', () => {
    it('marks invitation as accepted and sets used_at', () => {
      const inv = store.createInvitation({ email: 'h@x.com', invitedBy: 'u1' });
      const accepted = store.acceptInvitation(inv.token);
      assert.ok(accepted, 'returned accepted invitation');
      assert.equal(accepted.status, 'accepted');
      assert.ok(accepted.usedAt !== null, 'usedAt is set');
    });

    it('returns null when token does not exist', () => {
      const result = store.acceptInvitation('bogus-token');
      assert.equal(result, null);
    });

    it('returns null when trying to accept an already-accepted invitation', () => {
      const inv = store.createInvitation({ email: 'i@x.com', invitedBy: 'u1' });
      store.acceptInvitation(inv.token);
      // Second acceptance should fail
      const second = store.acceptInvitation(inv.token);
      assert.equal(second, null);
    });
  });

  // ── revokeInvitation ───────────────────────────────────────────────────────

  describe('revokeInvitation()', () => {
    it('revokes a pending invitation and returns true', () => {
      const inv = store.createInvitation({ email: 'j@x.com', invitedBy: 'u1' });
      const result = store.revokeInvitation(inv.id);
      assert.equal(result, true);
      const found = store.getById(inv.id);
      assert.equal(found.status, 'revoked');
    });

    it('returns false for an unknown id', () => {
      const result = store.revokeInvitation('does-not-exist');
      assert.equal(result, false);
    });

    it('returns false when trying to revoke an already-accepted invitation', () => {
      const inv = store.createInvitation({ email: 'k@x.com', invitedBy: 'u1' });
      store.acceptInvitation(inv.token);
      const result = store.revokeInvitation(inv.id);
      assert.equal(result, false);
    });
  });

  // ── expireStale ────────────────────────────────────────────────────────────

  describe('expireStale()', () => {
    it('marks past-expiry pending invitations as expired', () => {
      const inv = store.createInvitation({ email: 'l@x.com', invitedBy: 'u1', expiresInHours: 1 });
      // Backdate expires_at
      db.prepare('UPDATE invitations SET expires_at = 1 WHERE id = ?').run(inv.id);
      const count = store.expireStale();
      assert.equal(count, 1);
      assert.equal(store.getById(inv.id).status, 'expired');
    });

    it('does not expire invitations that have not yet passed their expiry', () => {
      store.createInvitation({ email: 'm@x.com', invitedBy: 'u1', expiresInHours: 24 });
      const count = store.expireStale();
      assert.equal(count, 0);
    });
  });
});
