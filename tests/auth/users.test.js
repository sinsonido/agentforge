import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AgentForgeDB } from '../../src/persistence/db.js';
import { UserStore } from '../../src/auth/users.js';

const DB_PATH = `/tmp/test-users-${Date.now()}.db`;
let db;
let store;

before(() => {
  db = new AgentForgeDB(DB_PATH);
  store = new UserStore(db);
});

after(() => {
  db.close();
});

beforeEach(() => {
  // Clear users table between tests
  db.db.exec('DELETE FROM users');
});

describe('UserStore', () => {
  it('creates a user and returns it without passwordHash', async () => {
    const user = await store.create({
      username: 'alice',
      password: 'securepass1',
      role: 'admin',
    });
    assert.equal(user.username, 'alice');
    assert.equal(user.role, 'admin');
    assert.equal(user.is_active, 1);
    assert.ok(!('password_hash' in user), 'should not expose password_hash');
    assert.ok(user.id, 'should have an id');
  });

  it('authenticate returns user on correct credentials', async () => {
    await store.create({ username: 'bob', password: 'hunter2', role: 'viewer' });
    const user = await store.authenticate('bob', 'hunter2');
    assert.ok(user, 'should return user');
    assert.equal(user.username, 'bob');
    assert.ok(!('password_hash' in user));
  });

  it('authenticate returns null on wrong password', async () => {
    await store.create({ username: 'carol', password: 'rightpass', role: 'viewer' });
    const user = await store.authenticate('carol', 'wrongpass');
    assert.equal(user, null);
  });

  it('authenticate returns null for non-existent user', async () => {
    const user = await store.authenticate('nobody', 'pass');
    assert.equal(user, null);
  });

  it('authenticate returns null for inactive user', async () => {
    const created = await store.create({ username: 'dave', password: 'pass1234', role: 'viewer' });
    store.deactivate(created.id);
    const user = await store.authenticate('dave', 'pass1234');
    assert.equal(user, null);
  });

  it('findById returns user without password_hash', async () => {
    const created = await store.create({ username: 'eve', password: 'passw0rd', role: 'operator' });
    const found = store.findById(created.id);
    assert.ok(found, 'should find user');
    assert.equal(found.username, 'eve');
    assert.ok(!('password_hash' in found));
  });

  it('findById returns null for unknown id', () => {
    const found = store.findById('nonexistent-id');
    assert.equal(found, null);
  });

  it('list returns all users', async () => {
    await store.create({ username: 'user1', password: 'pass1234', role: 'viewer' });
    await store.create({ username: 'user2', password: 'pass1234', role: 'operator' });
    const users = store.list();
    assert.equal(users.length, 2);
    assert.ok(users.every(u => !('password_hash' in u)));
  });

  it('updateRole changes the user role', async () => {
    const created = await store.create({ username: 'frank', password: 'passw0rd', role: 'viewer' });
    store.updateRole(created.id, 'operator');
    const updated = store.findById(created.id);
    assert.equal(updated.role, 'operator');
  });

  it('deactivate sets is_active to 0', async () => {
    const created = await store.create({ username: 'grace', password: 'passw0rd', role: 'viewer' });
    store.deactivate(created.id);
    const found = store.findById(created.id);
    assert.equal(found.is_active, 0);
  });

  it('countAdmins returns correct count', async () => {
    assert.equal(store.countAdmins(), 0);
    await store.create({ username: 'admin1', password: 'pass1234', role: 'admin' });
    await store.create({ username: 'admin2', password: 'pass1234', role: 'admin' });
    await store.create({ username: 'viewer1', password: 'pass1234', role: 'viewer' });
    assert.equal(store.countAdmins(), 2);
  });

  it('create rejects duplicate usernames', async () => {
    await store.create({ username: 'unique', password: 'pass1234', role: 'viewer' });
    await assert.rejects(
      () => store.create({ username: 'unique', password: 'other', role: 'viewer' }),
      /UNIQUE|unique/i,
    );
  });
});
