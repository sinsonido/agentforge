/**
 * @file tests/execution/inter-agent-comm.test.js
 * @description Unit tests for src/execution/inter-agent-comm.js
 *
 * Covers:
 *  - getToolDefinition() returns correct Anthropic tool schema
 *  - pendingCount() starts at 0
 *  - ask() creates a task via taskQueue.add() with correct fields
 *  - ask() resolves with task.result when task.completed fires
 *  - ask() resolves with '' when result is undefined
 *  - ask() rejects when task.failed fires
 *  - ask() ignores events for unrelated task IDs
 *  - pendingCount() increments while pending, returns to 0 after resolve/reject
 *
 * Note: ask() sets a 5-minute liveness timeout.  We wrap globalThis.setTimeout
 * to automatically unref() long timers so they don't block process exit.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import eventBus from '../../src/core/event-bus.js';
import { InterAgentComm } from '../../src/execution/inter-agent-comm.js';

// ---------------------------------------------------------------------------
// Suppress long timers so the test process can exit cleanly.
// ask() schedules a 5-minute timeout; we let it run but unref() it so it
// does not prevent the event loop from draining after tests complete.
// ---------------------------------------------------------------------------
const _origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function patchedSetTimeout(fn, delay, ...args) {
  const timer = _origSetTimeout.call(this, fn, delay, ...args);
  if (delay >= 60_000 && timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _taskIdCounter = 0;

/** Minimal TaskQueue stub. */
function makeTaskQueue() {
  const added = [];
  return {
    added,
    add(spec) {
      const task = { ...spec, id: `task-${++_taskIdCounter}` };
      added.push(task);
      return task;
    },
  };
}

const fakeOrchestrator = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InterAgentComm', () => {
  let taskQueue, comm;

  beforeEach(() => {
    eventBus._log = [];
    taskQueue = makeTaskQueue();
    comm = new InterAgentComm({ taskQueue, orchestrator: fakeOrchestrator });
  });

  afterEach(() => {
    eventBus.removeAllListeners('task.completed');
    eventBus.removeAllListeners('task.failed');
  });

  // ── getToolDefinition() ───────────────────────────────────────────────────

  it('getToolDefinition() returns name "ask_agent"', () => {
    const def = comm.getToolDefinition();
    assert.equal(def.name, 'ask_agent');
  });

  it('getToolDefinition() schema requires agent_id and question', () => {
    const { input_schema } = comm.getToolDefinition();
    assert.ok(input_schema.properties, 'properties missing');
    assert.deepEqual(input_schema.required, ['agent_id', 'question']);
  });

  it('getToolDefinition() includes priority enum with high/medium/low', () => {
    const { input_schema } = comm.getToolDefinition();
    assert.deepEqual(input_schema.properties.priority.enum, ['high', 'medium', 'low']);
  });

  // ── pendingCount() ────────────────────────────────────────────────────────

  it('pendingCount() is 0 before any asks', () => {
    assert.equal(comm.pendingCount(), 0);
  });

  // ── ask() — task creation ─────────────────────────────────────────────────

  it('ask() calls taskQueue.add() with title, type, priority, agent_id, project_id', async () => {
    process.nextTick(() => {
      const task = taskQueue.added[0];
      if (task) eventBus.emit('task.completed', { task: { ...task, result: 'ok' } });
    });

    await comm.ask('agent-a', 'agent-b', 'What is X?', {
      type: 'review',
      priority: 'low',
      project_id: 'proj-1',
    });

    const added = taskQueue.added[0];
    assert.equal(added.title, 'What is X?');
    assert.equal(added.type, 'review');
    assert.equal(added.priority, 'low');
    assert.equal(added.agent_id, 'agent-b');
    assert.equal(added.project_id, 'proj-1');
  });

  it('ask() defaults type to "implement" and priority to "high"', async () => {
    process.nextTick(() => {
      const task = taskQueue.added[0];
      if (task) eventBus.emit('task.completed', { task: { ...task, result: '' } });
    });

    await comm.ask('from', 'to', 'Do thing');

    const added = taskQueue.added[0];
    assert.equal(added.type, 'implement');
    assert.equal(added.priority, 'high');
  });

  // ── ask() — resolution paths ──────────────────────────────────────────────

  it('ask() resolves with task.result on task.completed', async () => {
    process.nextTick(() => {
      const task = taskQueue.added[0];
      eventBus.emit('task.completed', { task: { ...task, result: 'the answer' } });
    });

    const result = await comm.ask('a', 'b', 'Q?');
    assert.equal(result, 'the answer');
  });

  it('ask() resolves with "" when task.result is undefined', async () => {
    process.nextTick(() => {
      const task = taskQueue.added[0];
      eventBus.emit('task.completed', { task: { ...task } });
    });

    const result = await comm.ask('a', 'b', 'No result');
    assert.equal(result, '');
  });

  it('ask() rejects with Error containing the error message on task.failed', async () => {
    process.nextTick(() => {
      const task = taskQueue.added[0];
      eventBus.emit('task.failed', { task, error: 'Provider unavailable' });
    });

    await assert.rejects(
      () => comm.ask('a', 'b', 'Failing task'),
      /Provider unavailable/,
    );
  });

  // ── ask() — event isolation ───────────────────────────────────────────────

  it('ask() ignores task.completed for a different task ID', async () => {
    let resolved = false;
    const p = comm.ask('a', 'b', 'Isolated?').then(() => { resolved = true; });

    // Emit for an unrelated task
    eventBus.emit('task.completed', { task: { id: 'unrelated-id-xyz', result: 'noise' } });

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resolved, false, 'should not have resolved');

    // Resolve with the correct task
    const task = taskQueue.added[0];
    eventBus.emit('task.completed', { task: { ...task, result: 'real' } });
    await p;
    assert.equal(resolved, true);
  });

  it('ask() ignores task.failed for a different task ID', async () => {
    let rejected = false;
    const p = comm.ask('a', 'b', 'Safe?').catch(() => { rejected = true; });

    eventBus.emit('task.failed', { task: { id: 'other-id-xyz' }, error: 'noise' });

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(rejected, false, 'should not have rejected');

    const task = taskQueue.added[0];
    eventBus.emit('task.completed', { task: { ...task, result: '' } });
    await p;
  });

  // ── ask() — pending count lifecycle ──────────────────────────────────────

  it('pendingCount() is 1 while ask() is in flight', () => {
    // Don't resolve yet
    const p = comm.ask('a', 'b', 'pending check').catch(() => {});
    assert.equal(comm.pendingCount(), 1);

    // Resolve to unblock
    const task = taskQueue.added[0];
    eventBus.emit('task.completed', { task: { ...task, result: '' } });
    return p;
  });

  it('pendingCount() returns to 0 after task.completed', async () => {
    process.nextTick(() => {
      const task = taskQueue.added[0];
      eventBus.emit('task.completed', { task: { ...task, result: 'done' } });
    });

    await comm.ask('a', 'b', 'cleanup on complete');
    assert.equal(comm.pendingCount(), 0);
  });

  it('pendingCount() returns to 0 after task.failed', async () => {
    process.nextTick(() => {
      const task = taskQueue.added[0];
      eventBus.emit('task.failed', { task, error: 'oops' });
    });

    await comm.ask('a', 'b', 'cleanup on fail').catch(() => {});
    assert.equal(comm.pendingCount(), 0);
  });
});
