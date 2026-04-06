/**
 * @file tests/execution/inter-agent-comm.test.js
 * @description Unit tests for src/execution/inter-agent-comm.js
 *
 * Covers: ask() task creation, resolution on task.completed, rejection on
 * task.failed, pending count tracking, and getToolDefinition().
 *
 * NOTE: inter-agent-comm.js imports the eventBus singleton directly, so we
 * emit events on the same singleton to drive the tests.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../../src/core/task-queue.js';
import eventBus from '../../src/core/event-bus.js';
import { InterAgentComm } from '../../src/execution/inter-agent-comm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComm() {
  const taskQueue = new TaskQueue();
  // Minimal orchestrator stub — not used by InterAgentComm directly
  const orchestrator = {};
  const comm = new InterAgentComm({ taskQueue, orchestrator });
  return { comm, taskQueue };
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

  it('increments when ask() is called', () => {
    const { comm } = makeComm();
    // Don't await — let it hang so we can check the count
    comm.ask('agent-a', 'agent-b', 'do something').catch(() => {});
    assert.equal(comm.pendingCount(), 1);
  });
});

describe('InterAgentComm — ask() task creation', () => {
  it('adds a task to the queue with correct fields', () => {
    const { comm, taskQueue } = makeComm();
    comm.ask('agent-a', 'agent-b', 'Write unit tests', {
      type: 'test',
      priority: 'high',
      project_id: 'proj-1',
    }).catch(() => {});

    const tasks = taskQueue.getAll();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Write unit tests');
    assert.equal(tasks[0].type, 'test');
    assert.equal(tasks[0].priority, 'high');
    assert.equal(tasks[0].agent_id, 'agent-b');
    assert.equal(tasks[0].project_id, 'proj-1');
  });

  it('uses default type=implement and priority=high when omitted', () => {
    const { comm, taskQueue } = makeComm();
    comm.ask('agent-a', 'agent-b', 'Do the thing').catch(() => {});
    const tasks = taskQueue.getAll();
    assert.equal(tasks[0].type, 'implement');
    assert.equal(tasks[0].priority, 'high');
  });
});

describe('InterAgentComm — ask() resolution', () => {
  beforeEach(() => {
    // Remove all listeners between tests to avoid cross-test pollution
    eventBus.removeAllListeners('task.completed');
    eventBus.removeAllListeners('task.failed');
  });

  it('resolves with task.result when task.completed is emitted', async () => {
    const { comm, taskQueue } = makeComm();
    const promise = comm.ask('agent-a', 'agent-b', 'Summarise');
    const tasks = taskQueue.getAll();
    const task = tasks[tasks.length - 1];

    // Simulate the orchestrator completing the task
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

    // Emit completed for a different task first, then for ours
    setImmediate(() => {
      eventBus.emit('task.completed', { task: { id: 'unrelated-id', result: 'nope' } });
      setTimeout(() => {
        eventBus.emit('task.completed', { task: { ...myTask, result: 'mine' } });
      }, 10);
    });

    const result = await promise;
    assert.equal(result, 'mine');
  });
});
