import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ParallelExecution } from '../../src/execution/parallel-execution.js';
import eventBus from '../../src/core/event-bus.js';

// Helper: create a manually-resolved promise and capture its resolver
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('ParallelExecution', () => {
  let pe;

  beforeEach(() => {
    pe = new ParallelExecution({ maxConcurrent: 3 });
  });

  describe('constructor', () => {
    it('sets maxConcurrent from options', () => {
      assert.equal(pe.maxConcurrent, 3);
    });

    it('defaults maxConcurrent to 4 when not provided', () => {
      const defaultPe = new ParallelExecution();
      assert.equal(defaultPe.maxConcurrent, 4);
    });

    it('starts with no running tasks', () => {
      assert.equal(pe._running.size, 0);
    });
  });

  describe('hasCapacity()', () => {
    it('returns true when no tasks are running', () => {
      assert.equal(pe.hasCapacity(), true);
    });

    it('returns true when running tasks are below maxConcurrent', async () => {
      const d1 = deferred();
      const d2 = deferred();

      // Don't await start() — we don't want to wait for the tasks to finish
      pe.start('t1', () => d1.promise);
      pe.start('t2', () => d2.promise);
      // Yield so the async start() bodies execute synchronously
      await Promise.resolve();

      assert.equal(pe.hasCapacity(), true); // 2 running, max 3

      d1.resolve(); d2.resolve();
      await pe.waitAll();
    });

    it('returns false when at maxConcurrent', async () => {
      const d1 = deferred(); const d2 = deferred(); const d3 = deferred();

      pe.start('t1', () => d1.promise);
      pe.start('t2', () => d2.promise);
      pe.start('t3', () => d3.promise);
      await Promise.resolve();

      assert.equal(pe.hasCapacity(), false); // 3/3

      d1.resolve(); d2.resolve(); d3.resolve();
      await pe.waitAll();
    });
  });

  describe('availableSlots()', () => {
    it('returns maxConcurrent when nothing is running', () => {
      assert.equal(pe.availableSlots(), 3);
    });

    it('decrements as tasks are started', async () => {
      const d1 = deferred(); const d2 = deferred();

      pe.start('t1', () => d1.promise);
      await Promise.resolve();
      assert.equal(pe.availableSlots(), 2);

      pe.start('t2', () => d2.promise);
      await Promise.resolve();
      assert.equal(pe.availableSlots(), 1);

      d1.resolve(); d2.resolve();
      await pe.waitAll();
    });

    it('returns 0 when at capacity', async () => {
      const d1 = deferred(); const d2 = deferred(); const d3 = deferred();

      pe.start('t1', () => d1.promise);
      pe.start('t2', () => d2.promise);
      pe.start('t3', () => d3.promise);
      await Promise.resolve();

      assert.equal(pe.availableSlots(), 0);

      d1.resolve(); d2.resolve(); d3.resolve();
      await pe.waitAll();
    });
  });

  describe('start()', () => {
    it('executes the provided function', async () => {
      let called = false;
      // await is fine here because the fn resolves immediately
      await pe.start('t1', async () => { called = true; });
      assert.equal(called, true);
    });

    it('removes the task from _running after completion', async () => {
      await pe.start('t1', () => Promise.resolve());
      await pe.waitAll();
      assert.equal(pe._running.size, 0);
    });

    it('removes the task from _running even when the function rejects', async () => {
      try {
        await pe.start('t1', () => Promise.reject(new Error('boom')));
      } catch {
        // expected
      }
      await pe.waitAll();
      assert.equal(pe._running.size, 0);
    });

    it('registers the task in _running during execution', async () => {
      const d = deferred();
      pe.start('t1', () => d.promise); // don't await
      await Promise.resolve();          // yield to let start() body run

      assert.equal(pe._running.size, 1);
      d.resolve();
      await pe.waitAll();
    });

    it('throws when at capacity', async () => {
      const d1 = deferred(); const d2 = deferred(); const d3 = deferred();

      pe.start('t1', () => d1.promise);
      pe.start('t2', () => d2.promise);
      pe.start('t3', () => d3.promise);
      await Promise.resolve();

      await assert.rejects(
        () => pe.start('t4', () => Promise.resolve()),
        /at capacity/
      );

      d1.resolve(); d2.resolve(); d3.resolve();
      await pe.waitAll();
    });

    it('emits parallel.task_started event on start', async () => {
      let startedEvent = null;
      eventBus.once('parallel.task_started', (data) => { startedEvent = data; });

      await pe.start('task-99', () => Promise.resolve());

      assert.ok(startedEvent, 'parallel.task_started should be emitted');
      assert.equal(startedEvent.taskId, 'task-99');
    });

    it('emits parallel.slot_freed event when task completes', async () => {
      let freedEvent = null;
      eventBus.once('parallel.slot_freed', (data) => { freedEvent = data; });

      await pe.start('task-99', () => Promise.resolve());
      await pe.waitAll();

      assert.ok(freedEvent, 'parallel.slot_freed should be emitted');
      assert.equal(freedEvent.taskId, 'task-99');
    });
  });

  describe('waitAll()', () => {
    it('resolves immediately when no tasks are running', async () => {
      await assert.doesNotReject(() => pe.waitAll());
    });

    it('resolves after all running tasks complete', async () => {
      const completionOrder = [];

      pe.start('t1', async () => {
        await new Promise(r => setTimeout(r, 10));
        completionOrder.push('t1');
      });
      pe.start('t2', async () => {
        await new Promise(r => setTimeout(r, 5));
        completionOrder.push('t2');
      });

      await pe.waitAll();

      assert.ok(completionOrder.includes('t1'));
      assert.ok(completionOrder.includes('t2'));
      assert.equal(pe._running.size, 0);
    });

    it('resolves even when a task rejects', async () => {
      const p = pe.start('t1', () => Promise.reject(new Error('task failed')));
      p.catch(() => {}); // prevent unhandledRejection
      await assert.doesNotReject(() => pe.waitAll());
    });
  });

  describe('getStats()', () => {
    it('returns correct stats when nothing is running', () => {
      const stats = pe.getStats();
      assert.equal(stats.running, 0);
      assert.equal(stats.capacity, 3);
      assert.equal(stats.available, 3);
      assert.deepEqual(stats.taskIds, []);
    });

    it('shows correct running count and task ids', async () => {
      const d1 = deferred(); const d2 = deferred();

      pe.start('task-a', () => d1.promise);
      pe.start('task-b', () => d2.promise);
      await Promise.resolve();

      const stats = pe.getStats();
      assert.equal(stats.running, 2);
      assert.equal(stats.available, 1);
      assert.ok(stats.taskIds.includes('task-a'));
      assert.ok(stats.taskIds.includes('task-b'));

      d1.resolve(); d2.resolve();
      await pe.waitAll();
    });

    it('shows zero running after waitAll completes', async () => {
      await pe.start('t1', () => Promise.resolve());
      await pe.waitAll();

      const stats = pe.getStats();
      assert.equal(stats.running, 0);
      assert.equal(stats.available, 3);
    });
  });
});
