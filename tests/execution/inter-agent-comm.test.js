import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InterAgentComm } from '../../src/execution/inter-agent-comm.js';
import eventBus from '../../src/core/event-bus.js';

describe('InterAgentComm', () => {
  let comm;
  let mockTaskQueue;
  let mockOrchestrator;
  let taskIdCounter;

  beforeEach(() => {
    taskIdCounter = 0;
    mockTaskQueue = {
      add(opts) {
        return { id: `task-${++taskIdCounter}`, ...opts };
      },
    };
    mockOrchestrator = {};
    comm = new InterAgentComm({ taskQueue: mockTaskQueue, orchestrator: mockOrchestrator });
  });

  describe('constructor', () => {
    it('initialises with empty pending map', () => {
      assert.equal(comm.pendingCount(), 0);
    });

    it('stores taskQueue and orchestrator references', () => {
      assert.equal(comm.taskQueue, mockTaskQueue);
      assert.equal(comm.orchestrator, mockOrchestrator);
    });
  });

  describe('ask()', () => {
    it('creates a task with correct defaults', async () => {
      const originalSetTimeout = global.setTimeout;
      // Stub setTimeout so InterAgentComm.ask() does not create a long-lived timer.
      global.setTimeout = (fn, delay, ...args) => {
        // Do not schedule a real timer; just return a dummy handle.
        return { _fakeTimeout: true, delay, fn, args };
      };

      try {
        const created = [];
        comm.taskQueue = {
          add(opts) {
            const t = { id: `task-${++taskIdCounter}`, ...opts };
            created.push(t);
            return t;
          },
        };

        const promise = comm.ask('agent-a', 'agent-b', 'What is the answer?');

        assert.equal(created.length, 1);
        assert.equal(created[0].title, 'What is the answer?');
        assert.equal(created[0].type, 'implement');
        assert.equal(created[0].priority, 'high');
        assert.equal(created[0].agent_id, 'agent-b');

        // Resolve to avoid hanging
        eventBus.emit('task.completed', { task: created[0] });
        await promise;
      } finally {
        // Restore the original setTimeout after the test completes.
        global.setTimeout = originalSetTimeout;
      }
    });

    it('resolves with task result when task.completed fires', async () => {
      const originalSetTimeout = global.setTimeout;
      // Stub setTimeout so InterAgentComm.ask() does not create a long-lived timer.
      global.setTimeout = (fn, delay, ...args) => {
        // Do not schedule a real timer; just return a dummy handle.
        return { _fakeTimeout: true, delay, fn, args };
      };

      try {
        const promise = comm.ask('agent-a', 'agent-b', 'Do something');
        const taskId = `task-${taskIdCounter}`;

        setImmediate(() => {
          eventBus.emit('task.completed', { task: { id: taskId, result: 'done result' } });
        });

        const result = await promise;
        assert.equal(result, 'done result');
      } finally {
        // Restore the original setTimeout after the test completes.
        global.setTimeout = originalSetTimeout;
      }
    });

    it('resolves with empty string when task result is undefined', async () => {
      const promise = comm.ask('agent-a', 'agent-b', 'Do something');
      const taskId = `task-${taskIdCounter}`;

      setImmediate(() => {
        eventBus.emit('task.completed', { task: { id: taskId } });
      });

      const result = await promise;
      assert.equal(result, '');
    });

    it('rejects when task.failed fires', async () => {
      const promise = comm.ask('agent-a', 'agent-b', 'Do something');
      const taskId = `task-${taskIdCounter}`;

      setImmediate(() => {
        eventBus.emit('task.failed', { task: { id: taskId }, error: 'something went wrong' });
      });

      await assert.rejects(promise, /something went wrong/);
    });

    it('ignores events for other task IDs', async () => {
      const promise = comm.ask('agent-a', 'agent-b', 'Do something');
      const taskId = `task-${taskIdCounter}`;

      setImmediate(() => {
        // Emit for a different task first — should be ignored
        eventBus.emit('task.completed', { task: { id: 'other-task', result: 'wrong' } });
        // Then emit for the correct task
        eventBus.emit('task.completed', { task: { id: taskId, result: 'correct' } });
      });

      const result = await promise;
      assert.equal(result, 'correct');
    });

    it('forwards optional opts to the task', async () => {
      const created = [];
      comm.taskQueue = {
        add(opts) {
          const t = { id: `task-${++taskIdCounter}`, ...opts };
          created.push(t);
          return t;
        },
      };

      const ctx = { extra: 'data' };
      const promise = comm.ask('agent-a', 'agent-b', 'Q', {
        type: 'review',
        priority: 'low',
        project_id: 'proj-1',
        context: ctx,
      });

      assert.equal(created[0].type, 'review');
      assert.equal(created[0].priority, 'low');
      assert.equal(created[0].project_id, 'proj-1');
      assert.deepEqual(created[0].context, ctx);

      eventBus.emit('task.completed', { task: created[0] });
      await promise;
    });

    it('removes pending entry after resolution', async () => {
      const promise = comm.ask('agent-a', 'agent-b', 'Q');
      const taskId = `task-${taskIdCounter}`;

      assert.equal(comm.pendingCount(), 1);

      setImmediate(() => {
        eventBus.emit('task.completed', { task: { id: taskId, result: 'ok' } });
      });

      await promise;
      assert.equal(comm.pendingCount(), 0);
    });

    it('removes pending entry after rejection', async () => {
      const promise = comm.ask('agent-a', 'agent-b', 'Q');
      const taskId = `task-${taskIdCounter}`;

      assert.equal(comm.pendingCount(), 1);

      setImmediate(() => {
        eventBus.emit('task.failed', { task: { id: taskId }, error: 'boom' });
      });

      await promise.catch(() => {});
      assert.equal(comm.pendingCount(), 0);
    });
  });

  describe('getToolDefinition()', () => {
    it('returns a valid tool definition object', () => {
      const def = comm.getToolDefinition();
      assert.equal(def.name, 'ask_agent');
      assert.equal(typeof def.description, 'string');
      assert.ok(def.description.length > 0);
    });

    it('has required input_schema with agent_id and question', () => {
      const { input_schema } = comm.getToolDefinition();
      assert.equal(input_schema.type, 'object');
      assert.ok('agent_id' in input_schema.properties);
      assert.ok('question' in input_schema.properties);
      assert.deepEqual(input_schema.required, ['agent_id', 'question']);
    });

    it('includes priority as optional enum property', () => {
      const { input_schema } = comm.getToolDefinition();
      const priority = input_schema.properties.priority;
      assert.equal(priority.type, 'string');
      assert.deepEqual(priority.enum, ['high', 'medium', 'low']);
    });
  });

  describe('pendingCount()', () => {
    it('tracks multiple concurrent requests', async () => {
      const p1 = comm.ask('a', 'b', 'Q1');
      const p2 = comm.ask('a', 'c', 'Q2');
      assert.equal(comm.pendingCount(), 2);

      eventBus.emit('task.completed', { task: { id: 'task-1', result: '' } });
      eventBus.emit('task.completed', { task: { id: 'task-2', result: '' } });

      await Promise.all([p1, p2]);
      assert.equal(comm.pendingCount(), 0);
    });
  });
});
