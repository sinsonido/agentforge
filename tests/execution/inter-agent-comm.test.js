/**
 * @file tests/execution/inter-agent-comm.test.js
 * @description Unit tests for src/execution/inter-agent-comm.js
 *
 * Covers:
 *  - ask() creates a subtask in the queue with correct fields
 *  - ask() resolves with task.result when task.completed fires
 *  - ask() rejects with the error message when task.failed fires
 *  - pendingCount() tracks in-flight requests accurately
 *  - getToolDefinition() returns the expected Anthropic tool schema
 *  - Only the matching task ID triggers resolve / reject (no crosstalk)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InterAgentComm } from '../../src/execution/inter-agent-comm.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import eventBus from '../../src/core/event-bus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal orchestrator stub — InterAgentComm only reads it, never calls it. */
const stubOrchestrator = { _running: false };

/** Build a fresh InterAgentComm with a real TaskQueue. */
function makeComm() {
  const taskQueue = new TaskQueue();
  const comm = new InterAgentComm({ taskQueue, orchestrator: stubOrchestrator });
  return { comm, taskQueue };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InterAgentComm — ask()', () => {
  let comm, taskQueue;

  beforeEach(() => {
    ({ comm, taskQueue } = makeComm());
    // Remove all task listeners set up by previous tests
    eventBus.removeAllListeners('task.completed');
    eventBus.removeAllListeners('task.failed');
  });

  it('adds a task to the queue with the supplied fields', async () => {
    const promise = comm.ask('agent-a', 'agent-b', 'What is 2+2?', {
      type: 'research',
      priority: 'medium',
      project_id: 'proj-1',
    });

    const tasks = taskQueue.getAll();
    assert.equal(tasks.length, 1);

    const task = tasks[0];
    assert.equal(task.title, 'What is 2+2?');
    assert.equal(task.type, 'research');
    assert.equal(task.priority, 'medium');
    assert.equal(task.agent_id, 'agent-b');
    assert.equal(task.project_id, 'proj-1');

    // Resolve the promise so the test doesn't leak
    eventBus.emit('task.completed', { task: { id: task.id, result: 'four' } });
    await promise;
  });

  it('uses default type=implement and priority=high when omitted', async () => {
    const promise = comm.ask('a', 'b', 'do something');
    const [task] = taskQueue.getAll();

    assert.equal(task.type, 'implement');
    assert.equal(task.priority, 'high');

    eventBus.emit('task.completed', { task: { id: task.id, result: '' } });
    await promise;
  });

  it('resolves with task.result on task.completed', async () => {
    const promise = comm.ask('a', 'b', 'answer me');
    const [task] = taskQueue.getAll();

    eventBus.emit('task.completed', { task: { id: task.id, result: 'The answer is 42' } });

    const result = await promise;
    assert.equal(result, 'The answer is 42');
  });

  it('resolves with empty string when task.result is undefined', async () => {
    const promise = comm.ask('a', 'b', 'no result');
    const [task] = taskQueue.getAll();

    eventBus.emit('task.completed', { task: { id: task.id } });

    const result = await promise;
    assert.equal(result, '');
  });

  it('rejects with the error message on task.failed', async () => {
    const promise = comm.ask('a', 'b', 'fail me');
    const [task] = taskQueue.getAll();

    eventBus.emit('task.failed', { task: { id: task.id }, error: 'provider timeout' });

    await assert.rejects(promise, /provider timeout/);
  });

  it('ignores task.completed events for other task IDs', async () => {
    const promise = comm.ask('a', 'b', 'mine');
    const [task] = taskQueue.getAll();

    // Fire completed for a different task — should not resolve `promise`
    eventBus.emit('task.completed', { task: { id: 'other-id', result: 'not mine' } });

    // Now complete the real task
    eventBus.emit('task.completed', { task: { id: task.id, result: 'correct' } });

    const result = await promise;
    assert.equal(result, 'correct');
  });

  it('ignores task.failed events for other task IDs', async () => {
    const promise = comm.ask('a', 'b', 'mine');
    const [task] = taskQueue.getAll();

    eventBus.emit('task.failed', { task: { id: 'unrelated' }, error: 'nope' });
    eventBus.emit('task.completed', { task: { id: task.id, result: 'ok' } });

    const result = await promise;
    assert.equal(result, 'ok');
  });
});

describe('InterAgentComm — pendingCount()', () => {
  beforeEach(() => {
    eventBus.removeAllListeners('task.completed');
    eventBus.removeAllListeners('task.failed');
  });

  it('is 0 initially', () => {
    const { comm } = makeComm();
    assert.equal(comm.pendingCount(), 0);
  });

  it('increments while ask() is in-flight', async () => {
    const { comm, taskQueue } = makeComm();

    const p = comm.ask('a', 'b', 'q');
    assert.equal(comm.pendingCount(), 1);

    const [task] = taskQueue.getAll();
    eventBus.emit('task.completed', { task: { id: task.id, result: '' } });
    await p;

    assert.equal(comm.pendingCount(), 0);
  });

  it('decrements after task.failed', async () => {
    const { comm, taskQueue } = makeComm();

    const p = comm.ask('a', 'b', 'q');
    assert.equal(comm.pendingCount(), 1);

    const [task] = taskQueue.getAll();
    eventBus.emit('task.failed', { task: { id: task.id }, error: 'boom' });

    await assert.rejects(p, /boom/);
    assert.equal(comm.pendingCount(), 0);
  });

  it('tracks multiple concurrent requests', async () => {
    const { comm, taskQueue } = makeComm();

    const p1 = comm.ask('a', 'b', 'q1');
    const p2 = comm.ask('a', 'c', 'q2');
    assert.equal(comm.pendingCount(), 2);

    const tasks = taskQueue.getAll();
    eventBus.emit('task.completed', { task: { id: tasks[0].id, result: 'r1' } });
    assert.equal(comm.pendingCount(), 1);

    eventBus.emit('task.completed', { task: { id: tasks[1].id, result: 'r2' } });
    await Promise.all([p1, p2]);
    assert.equal(comm.pendingCount(), 0);
  });
});

describe('InterAgentComm — getToolDefinition()', () => {
  it('returns an object with name=ask_agent', () => {
    const { comm } = makeComm();
    const def = comm.getToolDefinition();
    assert.equal(def.name, 'ask_agent');
  });

  it('has a description string', () => {
    const { comm } = makeComm();
    const def = comm.getToolDefinition();
    assert.ok(typeof def.description === 'string' && def.description.length > 0);
  });

  it('input_schema requires agent_id and question', () => {
    const { comm } = makeComm();
    const { input_schema } = comm.getToolDefinition();
    assert.ok(input_schema.required.includes('agent_id'));
    assert.ok(input_schema.required.includes('question'));
  });

  it('input_schema defines agent_id, question, and priority properties', () => {
    const { comm } = makeComm();
    const { properties } = comm.getToolDefinition().input_schema;
    assert.ok('agent_id' in properties);
    assert.ok('question' in properties);
    assert.ok('priority' in properties);
  });

  it('priority enum includes high, medium, low', () => {
    const { comm } = makeComm();
    const { priority } = comm.getToolDefinition().input_schema.properties;
    assert.ok(priority.enum.includes('high'));
    assert.ok(priority.enum.includes('medium'));
    assert.ok(priority.enum.includes('low'));
  });
});
