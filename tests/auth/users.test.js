/**
 * @file tests/auth/users.test.js
 * @description Unit tests for src/auth/users.js (UserStore).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { UserStore } from '../../src/auth/users.js';

let store;

describe('UserStore', () => {
  beforeEach(() => {
    // Ensure test-mode seeding and low bcrypt rounds even when run directly.
    process.env.NODE_ENV = 'test';
    process.env.AGENTFORGE_ADMIN_PASSWORD = 'admin';
    store = new UserStore();
  });

  // ── Initial seed ──────────────────────────────────────────────────────────

  describe('initial seed', () => {
    it('seeds a default admin user', () => {
      const users = store.list();
      assert.equal(users.length, 1);
      assert.equal(users[0].username, 'admin');
      assert.equal(users[0].role, 'admin');
    });

    it('does not expose passwordHash in list()', () => {
      const [admin] = store.list();
      assert.equal(admin.passwordHash, undefined);
    });
  });

  // ── create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a new user and returns safe shape', async () => {
      const user = await store.create({ username: 'bob', password: 'secret', role: 'viewer' });
      assert.equal(user.username, 'bob');
      assert.equal(user.role, 'viewer');
      assert.ok(user.id);
      assert.equal(user.passwordHash, undefined);
    });

    it('defaults role to viewer when not specified', async () => {
      const user = await store.create({ username: 'carol', password: 'pw' });
      assert.equal(user.role, 'viewer');
    });

    it('throws on missing username or password', async () => {
      await assert.rejects(store.create({ password: 'pw' }),  /required/);
      await assert.rejects(store.create({ username: 'x' }),   /required/);
    });

    it('throws on duplicate username', async () => {
      await store.create({ username: 'dave', password: 'pw' });
      await assert.rejects(store.create({ username: 'dave', password: 'pw2' }), /already exists/);
    });

    it('throws on invalid role', async () => {
      await assert.rejects(store.create({ username: 'eve', password: 'pw', role: 'superadmin' }), /Invalid role/);
    });
  });

  // ── getById ───────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns user for known id', async () => {
      const created = await store.create({ username: 'frank', password: 'pw' });
      const found   = store.getById(created.id);
      assert.equal(found.username, 'frank');
    });

    it('returns null for unknown id', () => {
      assert.equal(store.getById('no-such-id'), null);
    });
  });

  // ── authenticate ─────────────────────────────────────────────────────────

  describe('authenticate', () => {
    it('returns user on correct credentials', async () => {
      const user = await store.authenticate('admin', 'admin');
      assert.ok(user);
      assert.equal(user.username, 'admin');
      assert.equal(user.passwordHash, undefined);
    });

    it('returns null for wrong password', async () => {
      assert.equal(await store.authenticate('admin', 'wrong'), null);
    });

    it('returns null for unknown username', async () => {
      assert.equal(await store.authenticate('ghost', 'pw'), null);
    });

    it('is case-sensitive for passwords', async () => {
      await store.create({ username: 'grace', password: 'Secret' });
      assert.equal(await store.authenticate('grace', 'secret'), null);
      assert.ok(await store.authenticate('grace', 'Secret'));
    });
  });

  // ── updateRole ────────────────────────────────────────────────────────────

  describe('updateRole', () => {
    it('updates the role of an existing user', async () => {
      const created = await store.create({ username: 'henry', password: 'pw', role: 'viewer' });
      const updated = store.updateRole(created.id, 'operator');
      assert.equal(updated.role, 'operator');
    });

    it('returns null for an unknown user id', () => {
      assert.equal(store.updateRole('no-such-id', 'operator'), null);
    });

    it('throws on invalid role', async () => {
      const { id } = await store.create({ username: 'iris', password: 'pw' });
      assert.throws(() => store.updateRole(id, 'god'), /Invalid role/);
    });
  });

  // ── list ──────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns all users without passwordHash', async () => {
      await store.create({ username: 'jack', password: 'pw' });
      const users = store.list();
      assert.equal(users.length, 2);
      for (const u of users) {
        assert.equal(u.passwordHash, undefined);
        assert.ok(u.id);
        assert.ok(u.username);
        assert.ok(u.role);
      }
    });
  });
});
