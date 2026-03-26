import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { AgentForgeDB } from '../../src/persistence/db.js';
import { createAuditMiddleware, sanitizePayload } from '../../src/auth/audit.js';

const DB_PATH = `/tmp/test-audit-${Date.now()}.db`;

describe('audit log', () => {
  let db;

  before(() => {
    db = new AgentForgeDB(DB_PATH);
  });

  after(() => {
    db.close();
    try {
      unlinkSync(DB_PATH);
    } catch { /* ignore */ }
  });

  // ─── DB: logAudit / getAuditLog ─────────────────────────────────────────

  it('logAudit inserts a row and getAuditLog returns it', () => {
    db.logAudit({
      userId: 'user1',
      username: 'alice',
      action: 'task.created',
      resource: 'task:abc',
      payload: '{"title":"test"}',
      ip: '127.0.0.1',
    });

    const { rows } = db.getAuditLog({ limit: 10, offset: 0 });
    assert.ok(rows.length >= 1, 'should have at least one row');

    const row = rows.find(r => r.username === 'alice' && r.action === 'task.created');
    assert.ok(row, 'inserted row should be retrievable');
    assert.equal(row.user_id, 'user1');
    assert.equal(row.resource, 'task:abc');
    assert.equal(row.ip, '127.0.0.1');
    assert.ok(typeof row.created_at === 'number', 'created_at should be a number');
  });

  it('getAuditLog filters by userId', () => {
    db.logAudit({ userId: 'user-filter-test', username: 'bob', action: 'orchestrator.started' });
    db.logAudit({ userId: 'other-user', username: 'carol', action: 'orchestrator.stopped' });

    const { rows } = db.getAuditLog({ limit: 100, offset: 0, userId: 'user-filter-test' });
    assert.ok(rows.every(r => r.user_id === 'user-filter-test'), 'all rows should match the userId filter');
    assert.ok(rows.some(r => r.username === 'bob'), 'bob should appear in filtered results');
  });

  it('getAuditLog filters by action', () => {
    db.logAudit({ userId: 'u1', username: 'dave', action: 'review.approved', resource: 'pr:42' });
    db.logAudit({ userId: 'u2', username: 'eve', action: 'review.rejected', resource: 'pr:43' });

    const { rows } = db.getAuditLog({ limit: 100, offset: 0, action: 'review.approved' });
    assert.ok(rows.every(r => r.action === 'review.approved'), 'all rows should match the action filter');
    assert.ok(rows.some(r => r.resource === 'pr:42'), 'pr:42 should appear');
  });

  it('getAuditLog returns hasMore=true when more rows exist beyond the page', () => {
    // Insert 3 entries with a unique action to isolate this test
    for (let i = 0; i < 3; i++) {
      db.logAudit({ userId: 'page-test', username: 'pager', action: 'user.login' });
    }
    // Fetch with limit=2 — should report hasMore
    const { rows, hasMore } = db.getAuditLog({ limit: 2, offset: 0, userId: 'page-test' });
    assert.equal(rows.length, 2, 'should return exactly limit rows');
    assert.equal(hasMore, true, 'hasMore should be true when more rows exist');
  });

  it('getAuditLog returns hasMore=false on the last page', () => {
    const { rows, hasMore } = db.getAuditLog({ limit: 100, offset: 0, userId: 'page-test' });
    assert.ok(rows.length <= 100);
    assert.equal(hasMore, false, 'hasMore should be false when all rows fit in the page');
  });

  // ─── sanitizePayload ─────────────────────────────────────────────────────

  it('sanitizePayload removes password field', () => {
    const result = sanitizePayload({ username: 'alice', password: 'secret123' });
    assert.equal(result.username, 'alice');
    assert.ok(!('password' in result), 'password should be stripped');
  });

  it('sanitizePayload removes token field', () => {
    const result = sanitizePayload({ model: 'claude-3', token: 'tok-xyz' });
    assert.equal(result.model, 'claude-3');
    assert.ok(!('token' in result), 'token should be stripped');
  });

  it('sanitizePayload removes secret field', () => {
    const result = sanitizePayload({ name: 'test', secret: 'shh' });
    assert.ok(!('secret' in result), 'secret should be stripped');
  });

  it('sanitizePayload removes currentPassword and newPassword', () => {
    const result = sanitizePayload({ currentPassword: 'old', newPassword: 'new', userId: 'u1' });
    assert.ok(!('currentPassword' in result), 'currentPassword should be stripped');
    assert.ok(!('newPassword' in result), 'newPassword should be stripped');
    assert.equal(result.userId, 'u1');
  });

  it('sanitizePayload leaves non-sensitive fields intact', () => {
    const input = { title: 'My task', type: 'code', priority: 'high' };
    const result = sanitizePayload(input);
    assert.deepEqual(result, input);
  });

  it('sanitizePayload handles null/non-object gracefully', () => {
    assert.equal(sanitizePayload(null), null);
    assert.equal(sanitizePayload(undefined), undefined);
  });

  // ─── createAuditMiddleware — no-op when db is null ───────────────────────

  it('createAuditMiddleware returns no-op middleware when db is null', (_, done) => {
    const audit = createAuditMiddleware(null);
    const middleware = audit('task.created');

    let nextCalled = false;
    const fakeReq = {};
    const fakeRes = {};
    const fakeNext = () => { nextCalled = true; };

    middleware(fakeReq, fakeRes, fakeNext);
    assert.ok(nextCalled, 'next() should be called');
    done();
  });

  it('createAuditMiddleware no-op does not throw or interact with res', (_, done) => {
    const audit = createAuditMiddleware(null);
    const mw = audit('orchestrator.started', r => `test:${r.id}`);

    const fakeReq = { id: 99 };
    const fakeRes = { on: () => { throw new Error('should not be called'); } };
    const fakeNext = () => done();

    // Should not call res.on or throw
    mw(fakeReq, fakeRes, fakeNext);
  });
});
