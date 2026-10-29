import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../../src/core/task-queue.js';
import eventBus from '../../src/core/event-bus.js';

describe('TaskQueue', () => {
  let q;

  beforeEach(() => {
    q = new TaskQueue();
  });

  describe('add()', () => {
    it('creates a task with correct defaults', () => {
      const task = q.add({ title: 'My task' });

      assert.equal(task.title, 'My task');
      assert.equal(task.type, 'implement');
      assert.equal(task.priority, 'medium');
      assert.equal(task.status, 'queued');
      assert.equal(task.agent_id, null);
      assert.equal(task.project_id, null);
      assert.equal(task.context_tokens_estimate, 0);
      assert.deepEqual(task.depends_on, []);
      assert.equal(task.force_model, null);
      assert.equal(task.allow_tier_downgrade, true);
      assert.equal(task.cost, 0);
      assert.equal(task.tokens_in, 0);
      assert.equal(task.tokens_out, 0);
      assert.equal(task.model_used, null);
      assert.equal(task.result, null);
      assert.equal(task.assigned_at, null);
      assert.equal(task.completed_at, null);
      assert.ok(task.id, 'task should have an id');
      assert.ok(task.created_at, 'task should have a created_at timestamp');
    });

    it('respects provided values over defaults', () => {
      const task = q.add({
        title: 'Custom task',
        id: 'custom-id',
        type: 'architecture',
        priority: 'high',
        agent_id: 'agent-1',
        project_id: 'proj-1',
        context_tokens_estimate: 5000,
        depends_on: ['t1'],
        force_model: 'claude-opus-4',
        allow_tier_downgrade: false,
      });

      assert.equal(task.id, 'custom-id');
      assert.equal(task.type, 'architecture');
      assert.equal(task.priority, 'high');
      assert.equal(task.agent_id, 'agent-1');
      assert.equal(task.project_id, 'proj-1');
      assert.equal(task.context_tokens_estimate, 5000);
      assert.deepEqual(task.depends_on, ['t1']);
      assert.equal(task.force_model, 'claude-opus-4');
      assert.equal(task.allow_tier_downgrade, false);
    });

    it('emits task.queued event on add', () => {
      let emittedTask = null;
      const handler = ({ task: t }) => { emittedTask = t; };
      eventBus.once('task.queued', handler);

      const task = q.add({ title: 'Event test task' });

      assert.ok(emittedTask, 'should have emitted task.queued');
      assert.equal(emittedTask.id, task.id);
      assert.equal(emittedTask.title, 'Event test task');
    });

    it('auto-increments id when none provided', () => {
      const t1 = q.add({ title: 'First' });
      const t2 = q.add({ title: 'Second' });
      const t3 = q.add({ title: 'Third' });

      assert.ok(t1.id !== t2.id, 'ids should be unique');
      assert.ok(t2.id !== t3.id, 'ids should be unique');
    });
  });

  describe('next()', () => {
    it('returns the highest priority task first', () => {
      q.add({ title: 'Low task', priority: 'low' });
      q.add({ title: 'High task', priority: 'high' });
      q.add({ title: 'Medium task', priority: 'medium' });

      const next = q.next();
      assert.equal(next.title, 'High task');
    });

    it('returns critical priority before high', () => {
      q.add({ title: 'High task', priority: 'high' });
      q.add({ title: 'Critical task', priority: 'critical' });

      const next = q.next();
      assert.equal(next.title, 'Critical task');
    });

    it('respects FIFO ordering within the same priority', () => {
      q.add({ title: 'First high', priority: 'high' });
      q.add({ title: 'Second high', priority: 'high' });

      const next = q.next();
      assert.equal(next.title, 'First high');
    });

    it('does not return tasks whose dependencies are not completed', () => {
      const dep = q.add({ title: 'Dependency', priority: 'medium' });
      q.add({ title: 'Dependent', priority: 'high', depends_on: [dep.id] });

      // Dependent has higher priority but its dep is unmet
      const next = q.next();
      assert.equal(next.title, 'Dependency');
    });

    it('returns dependent task after its dependency is completed', () => {
      const dep = q.add({ title: 'Dependency', priority: 'medium' });
      q.add({ title: 'Dependent', priority: 'high', depends_on: [dep.id] });

      q.updateStatus(dep.id, 'completed');

      const next = q.next();
      assert.equal(next.title, 'Dependent');
    });

    it('returns null when no tasks are queued', () => {
      const next = q.next();
      assert.equal(next, null);
    });

    it('returns null when all tasks are non-queued status', () => {
      const t = q.add({ title: 'Done task' });
      q.updateStatus(t.id, 'completed');

      const next = q.next();
      assert.equal(next, null);
    });
  });

  describe('updateStatus()', () => {
    it('changes task status correctly', () => {
      const task = q.add({ title: 'Status test' });
      q.updateStatus(task.id, 'executing');
      assert.equal(q.get(task.id).status, 'executing');
    });

    it('sets assigned_at when transitioning to assigned', () => {
      const task = q.add({ title: 'Assign test' });
      const before = Date.now();
      q.updateStatus(task.id, 'assigned');
      const after = Date.now();
      const updated = q.get(task.id);
      assert.ok(updated.assigned_at >= before);
      assert.ok(updated.assigned_at <= after);
    });

    it('sets completed_at when transitioning to completed', () => {
      const task = q.add({ title: 'Complete test' });
      const before = Date.now();
      q.updateStatus(task.id, 'completed');
      const after = Date.now();
      const updated = q.get(task.id);
      assert.ok(updated.completed_at >= before);
      assert.ok(updated.completed_at <= after);
    });

    it('sets completed_at when transitioning to failed', () => {
      const task = q.add({ title: 'Fail test' });
      q.updateStatus(task.id, 'failed');
      const updated = q.get(task.id);
      assert.ok(updated.completed_at > 0);
    });

    it('merges extra properties into the task', () => {
      const task = q.add({ title: 'Extra test' });
      q.updateStatus(task.id, 'completed', { result: 'done', model_used: 'claude-opus-4', cost: 0.05 });
      const updated = q.get(task.id);
      assert.equal(updated.result, 'done');
      assert.equal(updated.model_used, 'claude-opus-4');
      assert.equal(updated.cost, 0.05);
    });

    it('throws on invalid status', () => {
      const task = q.add({ title: 'Throw test' });
      assert.throws(
        () => q.updateStatus(task.id, 'invalid_status'),
        /Invalid status: invalid_status/
      );
    });

    it('throws when task id is not found', () => {
      assert.throws(
        () => q.updateStatus('nonexistent-id', 'completed'),
        /Task nonexistent-id not found/
      );
    });

    it('accepts all valid statuses', () => {
      const validStatuses = ['queued', 'assigned', 'executing', 'completed', 'failed', 'waiting_quota', 'paused_budget', 'pr-opened', 'cancelled'];
      for (const status of validStatuses) {
        const task = q.add({ title: `Task for ${status}` });
        assert.doesNotThrow(() => q.updateStatus(task.id, status));
      }
    });
  });

  describe('getByStatus()', () => {
    it('filters tasks by status correctly', () => {
      const t1 = q.add({ title: 'Task 1' });
      const t2 = q.add({ title: 'Task 2' });
      q.add({ title: 'Task 3' });

      q.updateStatus(t1.id, 'executing');
      q.updateStatus(t2.id, 'completed');

      const queued = q.getByStatus('queued');
      const executing = q.getByStatus('executing');
      const completed = q.getByStatus('completed');

      assert.equal(queued.length, 1);
      assert.equal(queued[0].title, 'Task 3');
      assert.equal(executing.length, 1);
      assert.equal(executing[0].title, 'Task 1');
      assert.equal(completed.length, 1);
      assert.equal(completed[0].title, 'Task 2');
    });

    it('returns empty array when no tasks match', () => {
      q.add({ title: 'Queued task' });
      const failed = q.getByStatus('failed');
      assert.deepEqual(failed, []);
    });
  });

  describe('stats()', () => {
    it('returns correct counts for all status types', () => {
      const t1 = q.add({ title: 'A' });
      const t2 = q.add({ title: 'B' });
      const t3 = q.add({ title: 'C' });
      const t4 = q.add({ title: 'D' });
      const t5 = q.add({ title: 'E' });

      q.updateStatus(t1.id, 'executing');
      q.updateStatus(t2.id, 'completed');
      q.updateStatus(t3.id, 'failed');
      q.updateStatus(t4.id, 'waiting_quota');
      // t5 remains 'queued'

      const stats = q.stats();
      assert.equal(stats.total, 5);
      assert.equal(stats.queued, 1);
      assert.equal(stats.executing, 1);
      assert.equal(stats.completed, 1);
      assert.equal(stats.failed, 1);
      assert.equal(stats.waiting, 1);
    });

    it('returns zeros for empty queue', () => {
      const stats = q.stats();
      assert.equal(stats.total, 0);
      assert.equal(stats.queued, 0);
      assert.equal(stats.executing, 0);
      assert.equal(stats.completed, 0);
      assert.equal(stats.failed, 0);
      assert.equal(stats.waiting, 0);
    });
  });

  describe('_dependenciesMet()', () => {
    it('returns true when task has no dependencies', () => {
      const task = q.add({ title: 'No deps' });
      assert.equal(q._dependenciesMet(task), true);
    });

    it('returns false when a dependency is not completed', () => {
      const dep = q.add({ title: 'Dep' });
      const task = q.add({ title: 'Dependent', depends_on: [dep.id] });
      assert.equal(q._dependenciesMet(task), false);
    });

    it('returns true when all dependencies are completed', () => {
      const dep1 = q.add({ title: 'Dep 1' });
      const dep2 = q.add({ title: 'Dep 2' });
      q.updateStatus(dep1.id, 'completed');
      q.updateStatus(dep2.id, 'completed');
      const task = q.add({ title: 'Dependent', depends_on: [dep1.id, dep2.id] });
      assert.equal(q._dependenciesMet(task), true);
    });

    it('returns false when only some dependencies are completed', () => {
      const dep1 = q.add({ title: 'Dep 1' });
      const dep2 = q.add({ title: 'Dep 2' });
      q.updateStatus(dep1.id, 'completed');
      // dep2 remains queued
      const task = q.add({ title: 'Dependent', depends_on: [dep1.id, dep2.id] });
      assert.equal(q._dependenciesMet(task), false);
    });
  });

  describe('admit()', () => {
    const coding = (over = {}) => ({
      kind: 'coding', title: 'Fix it', repo: 'o/r', base: 'master', instruction: 'Fix it',
      issue: 12, playbook: 'bug-fix', budget: 3, ...over,
    });

    it('creates a text task by default with no coding fields', () => {
      const { task, created } = q.admit({ title: 'Plain' });
      assert.equal(created, true);
      assert.equal(task.kind, 'text');
      assert.equal('repo' in task, false);
    });

    it('creates a coding task with step null', () => {
      const { task } = q.admit(coding());
      assert.equal(task.kind, 'coding');
      assert.equal(task.playbook, 'bug-fix');
      assert.equal(task.issue, 12);
      assert.equal(task.step, null);
      assert.equal(task.budget, 3);
    });

    it('returns the live task for the same repo, issue and playbook, without emitting', () => {
      const first = q.admit(coding()).task;
      let emitted = 0;
      const onQueued = () => emitted++;
      eventBus.on('task.queued', onQueued);
      const again = q.admit(coding({ instruction: 'reworded' }));
      eventBus.off('task.queued', onQueued);

      assert.equal(again.created, false);
      assert.equal(again.task, first);
      assert.equal(emitted, 0);
      assert.equal(q.getAll().length, 1);
    });

    it('admits a new task once the previous one is terminal', () => {
      const first = q.admit(coding()).task;
      q.updateStatus(first.id, 'failed');
      const second = q.admit(coding());
      assert.equal(second.created, true);
      assert.notEqual(second.task.id, first.id);
    });

    it('keeps tasks apart when the playbook, issue or repo differs, or the issue is absent', () => {
      q.admit(coding());
      for (const over of [{ playbook: 'feature' }, { issue: 13 }, { repo: 'o/other' }, { issue: null }, { issue: null }]) {
        assert.equal(q.admit(coding(over)).created, true, JSON.stringify(over));
      }
    });
  });

  describe('with a store', () => {
    function memoryStore(rows = [], lastSeq = 0) {
      const saved = new Map(rows.map(r => [r.id, { ...r }]));
      const trails = new Map();
      return {
        saved,
        saveTask: (task) => saved.set(task.id, { ...task }),
        appendTrail: (id, entry) => {
          const list = trails.get(id) ?? [];
          const stored = { seq: list.length + 1, at: Date.now(), ...entry };
          trails.set(id, [...list, stored]);
          return stored;
        },
        getTrail: (id) => trails.get(id) ?? [],
        loadQueue: () => ({ tasks: [...saved.values()].map(r => ({ ...r })), lastSeq }),
      };
    }

    it('writes every add and status change through', () => {
      const store = memoryStore();
      const sq = new TaskQueue({ store });
      const task = sq.add({ title: 'Persist' });
      assert.equal(store.saved.get(task.id).status, 'queued');
      sq.updateStatus(task.id, 'waiting_quota');
      assert.equal(store.saved.get(task.id).status, 'waiting_quota');
    });

    it('applies the boot rule to restored tasks', () => {
      const row = (id, status) => ({ id, title: id, status, priority: 'medium', depends_on: [], created_at: 1 });
      const store = memoryStore([
        row('q', 'queued'), row('x', 'executing'), row('w', 'waiting_quota'),
        row('a', 'assigned'), row('p', 'paused_budget'),
      ], 9);

      const sq = new TaskQueue({ store });

      assert.deepEqual(
        Object.fromEntries([...store.saved.values()].map(t => [t.id, t.status])),
        { q: 'queued', x: 'failed', w: 'queued', a: 'queued', p: 'paused_budget' },
      );
      assert.equal(store.saved.get('x').result, 'interrupted');
      assert.equal(sq.add({ title: 'next' }).id, 't10');
      assert.deepEqual(sq.trail('x').map(e => e.summary), ['executing → failed: interrupted']);
    });

    it('records each status transition in the trail, with the reason for a bad end', () => {
      const sq = new TaskQueue({ store: memoryStore() });
      const task = sq.add({ title: 'Trail' });
      sq.updateStatus(task.id, 'executing');
      sq.updateStatus(task.id, 'executing', { step: 2 });
      sq.updateStatus(task.id, 'failed', { result: 'evidence gate: no commit ahead of base' });

      assert.deepEqual(sq.trail(task.id).map(e => [e.kind, e.summary]), [
        ['status', 'queued'],
        ['status', 'queued → executing'],
        ['status', 'executing → failed: evidence gate: no commit ahead of base'],
      ]);
    });

    it('keeps no trail without a store', () => {
      const task = q.add({ title: 'No store' });
      assert.equal(q.appendTrail(task.id, { kind: 'step', summary: 'step 1', evidence: null }), null);
      assert.deepEqual(q.trail(task.id), []);
    });
  });
});
