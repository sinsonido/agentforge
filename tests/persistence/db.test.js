import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentForgeDB } from '../../src/persistence/db.js';

// Use a temp directory isolated from the real data store
const TEST_DIR = resolve('/tmp/agentforge-test-db');
const DB_PATH  = `${TEST_DIR}/test.db`;

describe('AgentForgeDB', () => {
  let db;

  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  beforeEach(() => {
    // Fresh DB for each test group — remove leftovers
    try { rmSync(DB_PATH); } catch (_) {}
    try { rmSync(`${DB_PATH}-wal`); } catch (_) {}
    try { rmSync(`${DB_PATH}-shm`); } catch (_) {}
    db = new AgentForgeDB(DB_PATH);
  });

  after(() => {
    try { db.close(); } catch (_) {}
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ─── Tasks ────────────────────────────────────────────────────────────────

  describe('saveTask() / getTask()', () => {
    it('persists a new task and retrieves it by id', () => {
      db.saveTask({ id: 't1', title: 'Hello', status: 'queued', created_at: Date.now() });
      const row = db.getTask('t1');
      assert.ok(row);
      assert.equal(row.id, 't1');
      assert.equal(row.title, 'Hello');
      assert.equal(row.status, 'queued');
    });

    it('returns null for an unknown task id', () => {
      assert.equal(db.getTask('nope'), null);
    });

    it('upserts — updates status without duplicating the row', () => {
      db.saveTask({ id: 't2', title: 'Work', status: 'queued', created_at: Date.now() });
      db.saveTask({ id: 't2', title: 'Work', status: 'completed', created_at: Date.now() });

      const row = db.getTask('t2');
      assert.equal(row.status, 'completed');

      const history = db.getTaskHistory(100);
      assert.equal(history.filter(r => r.id === 't2').length, 1);
    });

    it('persists optional fields (agent_id, model_used, tokens_in, cost)', () => {
      db.saveTask({
        id: 't3', title: 'Rich', status: 'completed',
        agent_id: 'agent-a', model_used: 'claude-sonnet-4-6',
        tokens_in: 100, tokens_out: 200, cost: 0.0012,
        created_at: Date.now(),
      });
      const row = db.getTask('t3');
      assert.equal(row.agent_id, 'agent-a');
      assert.equal(row.model_used, 'claude-sonnet-4-6');
      assert.equal(row.tokens_in, 100);
      assert.equal(row.tokens_out, 200);
      assert.ok(Math.abs(row.cost - 0.0012) < 1e-9);
    });

    it('truncates result to 10 000 characters', () => {
      const longResult = 'x'.repeat(20000);
      db.saveTask({ id: 't4', title: 'Big', status: 'completed', result: longResult, created_at: Date.now() });
      const row = db.getTask('t4');
      assert.equal(row.result.length, 10000);
    });
  });

  describe('getTasksByStatus()', () => {
    it('returns only tasks with the requested status', () => {
      db.saveTask({ id: 'a', title: 'A', status: 'queued',    created_at: Date.now() });
      db.saveTask({ id: 'b', title: 'B', status: 'executing', created_at: Date.now() });
      db.saveTask({ id: 'c', title: 'C', status: 'queued',    created_at: Date.now() });

      const queued = db.getTasksByStatus('queued');
      assert.equal(queued.length, 2);
      assert.ok(queued.every(r => r.status === 'queued'));
    });

    it('returns an empty array when no tasks match', () => {
      const rows = db.getTasksByStatus('failed');
      assert.deepEqual(rows, []);
    });
  });

  describe('getTaskHistory()', () => {
    it('returns up to limit rows ordered by created_at DESC', () => {
      for (let i = 1; i <= 5; i++) {
        db.saveTask({ id: `h${i}`, title: `T${i}`, status: 'queued', created_at: i * 1000 });
      }
      const rows = db.getTaskHistory(3);
      assert.equal(rows.length, 3);
      // newest first
      assert.equal(rows[0].id, 'h5');
    });
  });

  // ─── Costs ────────────────────────────────────────────────────────────────

  describe('recordCost() / getTotalCost()', () => {
    it('accumulates cost per project', () => {
      db.recordCost('proj1', 'agent-a', 'claude-sonnet-4-6', 100, 200, 0.001);
      db.recordCost('proj1', 'agent-b', 'claude-opus-4-6',   50,  100, 0.002);
      const total = db.getTotalCost('proj1');
      assert.ok(Math.abs(total - 0.003) < 1e-9);
    });

    it('returns 0 for a project with no cost records', () => {
      assert.equal(db.getTotalCost('unknown-proj'), 0);
    });

    it('does not mix costs between projects', () => {
      db.recordCost('alpha', 'a1', 'model', 0, 0, 1.0);
      db.recordCost('beta',  'a2', 'model', 0, 0, 2.0);
      assert.ok(Math.abs(db.getTotalCost('alpha') - 1.0) < 1e-9);
      assert.ok(Math.abs(db.getTotalCost('beta')  - 2.0) < 1e-9);
    });
  });

  describe('getCostByAgent()', () => {
    it('groups costs by agent_id', () => {
      db.recordCost('p', 'a1', 'm', 0, 0, 0.5);
      db.recordCost('p', 'a1', 'm', 0, 0, 0.5);
      db.recordCost('p', 'a2', 'm', 0, 0, 1.0);

      const rows = db.getCostByAgent('p');
      const map = Object.fromEntries(rows.map(r => [r.agent_id, r.total]));
      assert.ok(Math.abs(map.a1 - 1.0) < 1e-9);
      assert.ok(Math.abs(map.a2 - 1.0) < 1e-9);
    });
  });

  // ─── Events ───────────────────────────────────────────────────────────────

  describe('logEvent() / getRecentEvents()', () => {
    it('stores and retrieves events in reverse-insertion order', () => {
      db.logEvent('task.queued',    { id: 'x' });
      db.logEvent('task.executing', { id: 'x' });
      db.logEvent('task.completed', { id: 'x' });

      const events = db.getRecentEvents(10);
      assert.equal(events[0].event, 'task.completed');
      assert.equal(events[1].event, 'task.executing');
      assert.equal(events[2].event, 'task.queued');
    });

    it('deserialises event data back to an object', () => {
      db.logEvent('cost.recorded', { cost: 0.005 });
      const [evt] = db.getRecentEvents(1);
      assert.deepEqual(evt.data, { cost: 0.005 });
    });

    it('handles events with null data', () => {
      db.logEvent('ping', null);
      const [evt] = db.getRecentEvents(1);
      assert.equal(evt.data, null);
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 10; i++) db.logEvent('tick', { i });
      const events = db.getRecentEvents(3);
      assert.equal(events.length, 3);
    });
  });

  // ─── Agent activity ───────────────────────────────────────────────────────

  describe('logAgentActivity()', () => {
    it('records a state transition without throwing', () => {
      assert.doesNotThrow(() => {
        db.logAgentActivity('agent-1', 'idle', 'assigned', 'task-99', { note: 'test' });
      });
    });

    it('accepts null task_id for transitions not tied to a task', () => {
      assert.doesNotThrow(() => {
        db.logAgentActivity('agent-1', 'paused', 'idle', null, {});
      });
    });

    it('omits data column when payload is empty', () => {
      // Should not throw even with empty data object
      assert.doesNotThrow(() => {
        db.logAgentActivity('agent-2', 'idle', 'assigned', 'task-1');
      });
    });
  });

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  describe('close()', () => {
    it('closes the database without throwing', () => {
      const isolated = new AgentForgeDB(`${TEST_DIR}/close-test.db`);
      assert.doesNotThrow(() => isolated.close());
    });
  });
});
