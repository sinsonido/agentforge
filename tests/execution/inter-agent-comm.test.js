/**
 * @file tests/execution/inter-agent-comm.test.js
 * @description Unit tests for src/execution/inter-agent-comm.js — InterAgentComm.
 *
 * The implementation schedules a 5-minute setTimeout inside ask() to handle
 * timeouts. We use mock.timers to intercept it so tests exit immediately.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { InterAgentComm } from '../../src/execution/inter-agent-comm.js';
import eventBus from '../../src/core/event-bus.js';
import { TaskQueue } from '../../src/core/task-queue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComm(queue) {
  return new InterAgentComm({ taskQueue: queue, orchestrator: {} });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InterAgentComm', () => {
  let queue;
  let comm;

  beforeEach(() => {
    queue = new TaskQueue();
    comm  = makeComm(queue);
    eventBus.removeAllListeners('task.completed');
    eventBus.removeAllListeners('task.failed');
    // Intercept setTimeout so the 5-min timer never holds the process open
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    eventBus.removeAllListeners('task.completed');
    eventBus.removeAllListeners('task.failed');
    mock.timers.reset();
  });

  // ── pendingCount() ─────────────────────────────────────────────────────────

  it('starts with zero pending requests', () => {
    assert.equal(comm.pendingCount(), 0);
  });

  // ── getToolDefinition() ────────────────────────────────────────────────────

  it('returns a valid tool definition object', () => {
    const def = comm.getToolDefinition();
    assert.equal(def.name, 'ask_agent');
    assert.equal(typeof def.description, 'string');
    assert.ok(def.input_schema?.properties?.agent_id);
    assert.ok(def.input_schema?.properties?.question);
    assert.deepEqual(def.input_schema.required, ['agent_id', 'question']);
  });

  it('tool definition includes priority enum with high/medium/low', () => {
    const { input_schema } = comm.getToolDefinition();
    assert.deepEqual(input_schema.properties.priority.enum, ['high', 'medium', 'low']);
  });

  // ── ask() — happy path ──────────────────────────────────────────────────────

  it('ask() creates a task in the queue with correct fields', async () => {
    // Use setImmediate (not mocked) to emit the completion event
    setImmediate(() => {
      const [t] = queue.getAll();
      assert.equal(t.agent_id, 'tester');
      assert.equal(t.title, 'Write tests for feature X');
      assert.equal(t.priority, 'high');
      eventBus.emit('task.completed', { task: { ...t, result: 'Tests written.' } });
    });

    const result = await comm.ask('developer', 'tester', 'Write tests for feature X');
    assert.equal(result, 'Tests written.');
  });

  it('ask() resolves with empty string when result is undefined', async () => {
    setImmediate(() => {
      const [t] = queue.getAll();
      eventBus.emit('task.completed', { task: { ...t } }); // no result field
    });

    const result = await comm.ask('developer', 'tester', 'question');
    assert.equal(result, '');
  });

  it('ask() removes task from pending map on completion', async () => {
    setImmediate(() => {
      const [t] = queue.getAll();
      eventBus.emit('task.completed', { task: { ...t, result: 'done' } });
    });

    await comm.ask('a', 'b', 'q');
    assert.equal(comm.pendingCount(), 0);
  });

  it('ask() uses opts.type, opts.priority, and opts.project_id', async () => {
    setImmediate(() => {
      const [t] = queue.getAll();
      assert.equal(t.type, 'review');
      assert.equal(t.priority, 'low');
      assert.equal(t.project_id, 'proj-99');
      eventBus.emit('task.completed', { task: { ...t, result: 'ok' } });
    });

    await comm.ask('a', 'b', 'q', { type: 'review', priority: 'low', project_id: 'proj-99' });
  });

  // ── ask() — failure path ────────────────────────────────────────────────────

  it('ask() rejects when task.failed is emitted for that task', async () => {
    setImmediate(() => {
      const [t] = queue.getAll();
      eventBus.emit('task.failed', { task: t, error: 'provider quota exceeded' });
    });

    await assert.rejects(
      () => comm.ask('a', 'b', 'q'),
      /provider quota exceeded/
    );
    assert.equal(comm.pendingCount(), 0);
  });

  // ── ask() — timeout path ────────────────────────────────────────────────────

  it('ask() rejects after timeout when task never completes', async () => {
    // Kick off ask() (task is created but never completed)
    const askPromise = comm.ask('a', 'b', 'never-completes');
    assert.equal(comm.pendingCount(), 1);

    // Fast-forward the mocked 5-minute timer
    mock.timers.tick(5 * 60 * 1000);

    await assert.rejects(askPromise, /ask_agent timeout/);
    assert.equal(comm.pendingCount(), 0);
  });

  // ── event isolation ─────────────────────────────────────────────────────────

  it('ask() ignores task.completed events for different task IDs', async () => {
    const askPromise = comm.ask('a', 'b', 'real question');

    setImmediate(() => {
      const [t] = queue.getAll();
      // Wrong ID first — should be ignored
      eventBus.emit('task.completed', { task: { id: 'unrelated-id', result: 'not mine' } });
      // Correct ID — should resolve
      eventBus.emit('task.completed', { task: { ...t, result: 'my result' } });
    });

    const result = await askPromise;
    assert.equal(result, 'my result');
  });
});
