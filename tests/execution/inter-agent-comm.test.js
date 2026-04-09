import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { InterAgentComm } from '../../src/execution/inter-agent-comm.js';
import eventBus from '../../src/core/event-bus.js';

function makeQueue() {
  let counter = 0;
  return {
    add: (task) => ({ id: `task-${++counter}`, ...task }),
  };
}

describe('InterAgentComm', () => {
  let comm;
  let queue;

  beforeEach(() => {
    // Mock setTimeout so the 5-minute timer in ask() does not block the process.
    mock.timers.enable(['setTimeout']);
    queue = makeQueue();
    comm = new InterAgentComm({ taskQueue: queue, orchestrator: {} });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  describe('constructor', () => {
    it('starts with no pending requests', () => {
      assert.equal(comm.pendingCount(), 0);
    });
  });

  describe('getToolDefinition()', () => {
    it('returns the ask_agent tool name', () => {
      const def = comm.getToolDefinition();
      assert.equal(def.name, 'ask_agent');
    });

    it('has agent_id and question as required fields', () => {
      const def = comm.getToolDefinition();
      assert.ok(def.input_schema.required.includes('agent_id'));
      assert.ok(def.input_schema.required.includes('question'));
    });

    it('includes priority enum with high/medium/low', () => {
      const def = comm.getToolDefinition();
      const priority = def.input_schema.properties.priority;
      assert.deepEqual(priority.enum, ['high', 'medium', 'low']);
    });
  });

  describe('pendingCount()', () => {
    it('increments while a task is in-flight, then decrements on completion', async () => {
      const promise = comm.ask('agent-a', 'agent-b', 'hello?');
      assert.equal(comm.pendingCount(), 1);
      eventBus.emit('task.completed', { task: { id: 'task-1', result: 'ok' } });
      await promise;
      assert.equal(comm.pendingCount(), 0);
    });

    it('decrements when the task.failed event fires', async () => {
      const promise = comm.ask('agent-a', 'agent-b', 'hello?').catch(() => {});
      eventBus.emit('task.failed', { task: { id: 'task-1' }, error: 'boom' });
      await promise;
      assert.equal(comm.pendingCount(), 0);
    });
  });

  describe('ask()', () => {
    it('adds a task to the queue with the question as title', async () => {
      const added = [];
      queue.add = (t) => { added.push(t); return { id: 'spy-task', ...t }; };
      const p = comm.ask('src', 'tgt', 'What is the answer?');
      assert.equal(added[0].title, 'What is the answer?');
      eventBus.emit('task.completed', { task: { id: 'spy-task', result: 'done' } });
      await p;
    });

    it('assigns the target agent as agent_id on the new task', async () => {
      const added = [];
      queue.add = (t) => { added.push(t); return { id: 'spy-task', ...t }; };
      const p = comm.ask('src', 'target-agent', 'Do this');
      assert.equal(added[0].agent_id, 'target-agent');
      eventBus.emit('task.completed', { task: { id: 'spy-task', result: 'done' } });
      await p;
    });

    it('defaults task type to implement and priority to high', async () => {
      const added = [];
      queue.add = (t) => { added.push(t); return { id: 'spy-task', ...t }; };
      const p = comm.ask('src', 'tgt', 'Do this');
      assert.equal(added[0].type, 'implement');
      assert.equal(added[0].priority, 'high');
      eventBus.emit('task.completed', { task: { id: 'spy-task', result: 'done' } });
      await p;
    });

    it('accepts custom type and priority', async () => {
      const added = [];
      queue.add = (t) => { added.push(t); return { id: 'spy-task', ...t }; };
      const p = comm.ask('src', 'tgt', 'Review this', { type: 'review', priority: 'low' });
      assert.equal(added[0].type, 'review');
      assert.equal(added[0].priority, 'low');
      eventBus.emit('task.completed', { task: { id: 'spy-task', result: 'done' } });
      await p;
    });

    it('resolves with task.result when task.completed fires', async () => {
      const promise = comm.ask('src', 'tgt', 'Question?');
      eventBus.emit('task.completed', { task: { id: 'task-1', result: 'The answer is 42' } });
      assert.equal(await promise, 'The answer is 42');
    });

    it('resolves with empty string when task.result is absent', async () => {
      const promise = comm.ask('src', 'tgt', 'Question?');
      eventBus.emit('task.completed', { task: { id: 'task-1' } });
      assert.equal(await promise, '');
    });

    it('rejects with the error message when task.failed fires', async () => {
      const promise = comm.ask('src', 'tgt', 'Question?');
      eventBus.emit('task.failed', { task: { id: 'task-1' }, error: 'something went wrong' });
      await assert.rejects(() => promise, /something went wrong/);
    });

    it('ignores task.completed events for other task IDs', async () => {
      let resolved = false;
      const promise = comm.ask('src', 'tgt', 'Question?').then((v) => { resolved = true; return v; });

      eventBus.emit('task.completed', { task: { id: 'task-999', result: 'irrelevant' } });
      await Promise.resolve();
      assert.equal(resolved, false);

      eventBus.emit('task.completed', { task: { id: 'task-1', result: 'answer' } });
      await promise;
      assert.equal(resolved, true);
    });

    it('rejects with timeout error when the timer fires', async () => {
      const promise = comm.ask('src', 'tgt', 'Question?');
      // Advance mocked timers past the 5-minute timeout
      mock.timers.tick(5 * 60 * 1000 + 1);
      await assert.rejects(() => promise, /ask_agent timeout/);
    });

    it('forwards project_id and context opts to the new task', async () => {
      const added = [];
      queue.add = (t) => { added.push(t); return { id: 'spy-task', ...t }; };
      const p = comm.ask('src', 'tgt', 'Qs', { project_id: 'proj-1', context: { key: 'val' } });
      assert.equal(added[0].project_id, 'proj-1');
      assert.deepEqual(added[0].context, { key: 'val' });
      eventBus.emit('task.completed', { task: { id: 'spy-task', result: 'done' } });
      await p;
    });
  });
});
