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

  describe('loadQueue()', () => {
    it('returns live tasks with their completed dependencies and the last generated id', () => {
      db.saveTask({ id: 't7', title: 'Dep', status: 'completed', created_at: 1 });
      db.saveTask({ id: 't2', title: 'Old', status: 'failed', created_at: 2 });
      db.saveTask({ id: 'custom', title: 'Run', status: 'queued', priority: 'high', depends_on: ['t7'], allow_tier_downgrade: false, created_at: 3 });

      const { tasks, lastSeq } = db.loadQueue();

      assert.deepEqual(tasks.map(t => t.id), ['custom', 't7']);
      assert.equal(tasks[0].priority, 'high');
      assert.deepEqual(tasks[0].depends_on, ['t7']);
      assert.equal(tasks[0].allow_tier_downgrade, false);
      assert.equal(lastSeq, 7);
    });
  });

  describe('schema migration', () => {
    it('upgrades a DB file created before the queue columns existed, once', async () => {
      const { default: Database } = await import('better-sqlite3');
      const path = `${TEST_DIR}/legacy.db`;
      const legacy = new Database(path);
      legacy.exec(`CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT, status TEXT, agent_id TEXT, project_id TEXT,
        model_used TEXT, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost REAL DEFAULT 0,
        result TEXT, created_at INTEGER, assigned_at INTEGER, completed_at INTEGER)`);
      legacy.prepare("INSERT INTO tasks (id, title, status, created_at) VALUES ('t1', 'Legacy', 'queued', 1)").run();
      legacy.close();

      new AgentForgeDB(path).close();
      const upgraded = new AgentForgeDB(path);

      assert.equal(upgraded.db.pragma('user_version', { simple: true }), 3);
      const [task] = upgraded.loadQueue().tasks;
      assert.equal(task.title, 'Legacy');
      assert.equal(task.priority, 'medium');
      assert.deepEqual(task.depends_on, []);
      assert.equal(task.allow_tier_downgrade, true);
      upgraded.close();
    });

    it('upgrades a DB file at the #240 schema to coding tasks, keeping its rows as text tasks', async () => {
      const { default: Database } = await import('better-sqlite3');
      const path = `${TEST_DIR}/v1.db`;
      const v1 = new Database(path);
      v1.exec(`CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT, status TEXT, agent_id TEXT, project_id TEXT,
        model_used TEXT, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost REAL DEFAULT 0,
        result TEXT, created_at INTEGER, assigned_at INTEGER, completed_at INTEGER,
        priority TEXT NOT NULL DEFAULT 'medium', depends_on TEXT NOT NULL DEFAULT '[]', force_model TEXT,
        allow_tier_downgrade INTEGER NOT NULL DEFAULT 1, context_tokens_estimate INTEGER NOT NULL DEFAULT 0)`);
      v1.pragma('user_version = 1');
      v1.prepare("INSERT INTO tasks (id, title, status, priority, created_at) VALUES ('t3', 'Old', 'queued', 'high', 1)").run();
      v1.close();

      const upgraded = new AgentForgeDB(path);

      assert.equal(upgraded.db.pragma('user_version', { simple: true }), 3);
      const [task] = upgraded.loadQueue().tasks;
      assert.equal(task.kind, 'text');
      assert.equal(task.priority, 'high');
      assert.equal('repo' in task, false);
      upgraded.saveTask({ id: 't4', kind: 'coding', title: 'New', status: 'queued', repo: 'o/r', base: 'main', instruction: 'go', issue: 1, playbook: 'feature' });
      assert.equal(upgraded.getTask('t4').playbook, 'feature');
      upgraded.close();
    });
  });

  describe('coding tasks', () => {
    const coding = (id, over = {}) => ({
      id, kind: 'coding', title: 'Fix', status: 'queued', created_at: 1,
      repo: 'o/r', base: 'master', instruction: 'Fix it', issue: 9, playbook: 'bug-fix', step: null, budget: 4, ...over,
    });

    it('round-trips the coding fields and updates the step', () => {
      db.saveTask(coding('t1'));
      db.saveTask(coding('t1', { status: 'executing', step: '3. root-cause' }));
      const [task] = db.loadQueue().tasks;
      assert.equal(task.kind, 'coding');
      assert.equal(task.repo, 'o/r');
      assert.equal(task.issue, 9);
      assert.equal(task.budget, 4);
      assert.equal(task.step, '3. root-cause');
      assert.equal(db.getTaskHistory(1)[0].playbook, 'bug-fix');
    });

    it('refuses a second live row for the same repo, issue and playbook', () => {
      db.saveTask(coding('t1'));
      assert.throws(() => db.saveTask(coding('t2')), /UNIQUE constraint failed/);
      db.saveTask(coding('t1', { status: 'completed' }));
      assert.doesNotThrow(() => db.saveTask(coding('t2')));
      assert.doesNotThrow(() => db.saveTask(coding('t3', { issue: null })));
      assert.doesNotThrow(() => db.saveTask(coding('t4', { issue: null })));
    });

    for (const status of ['pr-opened', 'cancelled']) {
      it(`frees the issue for a new task once its task is ${status}`, () => {
        db.saveTask(coding('t1', { status: 'executing' }));
        db.saveTask(coding('t1', { status, pr_url: 'https://github.com/o/r/pull/1' }));
        assert.doesNotThrow(() => db.saveTask(coding('t2')));
        assert.equal(db.getTask('t1').pr_url, 'https://github.com/o/r/pull/1');
        assert.deepEqual(db.loadQueue().tasks.map(t => t.id), ['t2']);
      });
    }
  });

  describe('TaskQueue on a DB file', () => {
    it('restores a coding task after a restart and still refuses its duplicate', async () => {
      const { TaskQueue } = await import('../../src/core/task-queue.js');
      const input = { kind: 'coding', title: 'Model v2', repo: 'o/r', base: 'master', instruction: 'Do it', issue: 195, playbook: 'feature', budget: 5 };
      const before = new TaskQueue({ store: db }).add(input);
      db.close();

      db = new AgentForgeDB(DB_PATH);
      const queue = new TaskQueue({ store: db });

      assert.deepEqual(queue.get(before.id), before);
      const again = queue.admit(input);
      assert.equal(again.created, false);
      assert.equal(again.task.id, before.id);
      assert.equal(queue.add({ title: 'text' }).id, 't2');
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
