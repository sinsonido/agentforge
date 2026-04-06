/**
 * @file tests/execution/inter-agent-comm.test.js
 * @description Unit tests for src/execution/inter-agent-comm.js
 *
 * Covers: ask() task creation, resolution on task.completed, rejection on
 * task.failed, pending count tracking, and getToolDefinition().
 *
 * NOTE: inter-agent-comm.js imports the eventBus singleton directly, so we
 * emit events on the same singleton to drive the tests.
 *
 * Every test that calls ask() ensures the returned promise is fully resolved
 * or rejected before the test ends, preventing the 5-minute internal setTimeout
 * from keeping the Node test runner alive after the suite completes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../../src/core/task-queue.js';
import eventBus from '../../src/core/event-bus.js';
import { InterAgentComm } from '../../src/execution/inter-agent-comm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComm() {
  const taskQueue = new TaskQueue();
  const orchestrator = {};
  const comm = new InterAgentComm({ taskQueue, orchestrator });
  return { comm, taskQueue };
}

/**
 * Resolve a pending ask() by emitting task.completed for the last task in the queue.
 * Returns the resolved promise so the test can await full cleanup.
 */
function resolveLastTask(taskQueue, result = 'done') {
  const tasks = taskQueue.getAll();
  const task = tasks[tasks.length - 1];
  eventBus.emit('task.completed', { task: { ...task, result } });
}

/**
 * Reject a pending ask() by emitting task.failed for the last task in the queue.
 */
function failLastTask(taskQueue, error = 'test cleanup') {
  const tasks = taskQueue.getAll();
  const task = tasks[tasks.length - 1];
  eventBus.emit('task.failed', { task, error });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InterAgentComm — getToolDefinition()', () => {
  it('returns a valid ask_agent tool definition', () => {
    const { comm } = makeComm();
    const def = comm.getToolDefinition();
    assert.equal(def.name, 'ask_agent');
    assert.ok(typeof def.description === 'string');
    assert.equal(def.input_schema.type, 'object');
    assert.ok(Array.isArray(def.input_schema.required));
    assert.ok(def.input_schema.required.includes('agent_id'));
    assert.ok(def.input_schema.required.includes('question'));
  });
});

describe('InterAgentComm — pendingCount()', () => {
  it('starts at 0', () => {
    const { comm } = makeComm();
    assert.equal(comm.pendingCount(), 0);
  });

  it('increments to 1 when ask() is called, then returns to 0 after resolution', async () => {
    const { comm, taskQueue } = makeComm();
    const p = comm.ask('agent-a', 'agent-b', 'do something');
    p.catch(() => {});
    assert.equal(comm.pendingCount(), 1);
    // Resolve to clean up the internal timer and listener
    resolveLastTask(taskQueue);
    await p;
    assert.equal(comm.pendingCount(), 0);
  });
});

describe('InterAgentComm — ask() task creation', () => {
  it('adds a task to the queue with correct fields', async () => {
    const { comm, taskQueue } = makeComm();
    const p = comm.ask('agent-a', 'agent-b', 'Write unit tests', {
      type: 'test',
      priority: 'high',
      project_id: 'proj-1',
    });

    const tasks = taskQueue.getAll();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Write unit tests');
    assert.equal(tasks[0].type, 'test');
    assert.equal(tasks[0].priority, 'high');
    assert.equal(tasks[0].agent_id, 'agent-b');
    assert.equal(tasks[0].project_id, 'proj-1');

    resolveLastTask(taskQueue);
    await p;
  });

  it('uses default type=implement and priority=high when omitted', async () => {
    const { comm, taskQueue } = makeComm();
    const p = comm.ask('agent-a', 'agent-b', 'Do the thing');
    const tasks = taskQueue.getAll();
    assert.equal(tasks[0].type, 'implement');
    assert.equal(tasks[0].priority, 'high');
    resolveLastTask(taskQueue);
    await p;
  });
});

describe('InterAgentComm — ask() resolution', () => {
  it('resolves with task.result when task.completed is emitted', async () => {
    const { comm, taskQueue } = makeComm();
    const promise = comm.ask('agent-a', 'agent-b', 'Summarise');
    const tasks = taskQueue.getAll();
    const task = tasks[tasks.length - 1];

    setImmediate(() => {
      eventBus.emit('task.completed', { task: { ...task, result: 'Summary done' } });
    });

    const result = await promise;
    assert.equal(result, 'Summary done');
  });

  it('resolves with empty string when result is null', async () => {
    const { comm, taskQueue } = makeComm();
    const promise = comm.ask('agent-a', 'agent-b', 'Null result task');
    const tasks = taskQueue.getAll();
    const task = tasks[tasks.length - 1];

    setImmediate(() => {
      eventBus.emit('task.completed', { task: { ...task, result: null } });
    });

    const result = await promise;
    assert.equal(result, '');
  });

  it('rejects with the error message when task.failed is emitted', async () => {
    const { comm, taskQueue } = makeComm();
    const promise = comm.ask('agent-a', 'agent-b', 'Failing task');
    const tasks = taskQueue.getAll();
    const task = tasks[tasks.length - 1];

    setImmediate(() => {
      eventBus.emit('task.failed', { task, error: 'Provider unreachable' });
    });

    await assert.rejects(promise, /Provider unreachable/);
  });

  it('decrements pendingCount after resolution', async () => {
    const { comm, taskQueue } = makeComm();
    const promise = comm.ask('agent-a', 'agent-b', 'Decrement check');
    const tasks = taskQueue.getAll();
    const task = tasks[tasks.length - 1];

    assert.equal(comm.pendingCount(), 1);

    setImmediate(() => {
      eventBus.emit('task.completed', { task: { ...task, result: 'done' } });
    });

    await promise;
    assert.equal(comm.pendingCount(), 0);
  });

  it('ignores task.completed events for unrelated task IDs', async () => {
    const { comm, taskQueue } = makeComm();
    const promise = comm.ask('agent-a', 'agent-b', 'Watch only my task');
    const tasks = taskQueue.getAll();
    const myTask = tasks[tasks.length - 1];

    setImmediate(() => {
      // Unrelated task first, then ours
      eventBus.emit('task.completed', { task: { id: 'unrelated-id', result: 'nope' } });
      setTimeout(() => {
        eventBus.emit('task.completed', { task: { ...myTask, result: 'mine' } });
      }, 10);
    });

    const result = await promise;
    assert.equal(result, 'mine');
  });
});
