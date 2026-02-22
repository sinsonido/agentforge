import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLifecycle, AgentPool } from '../../src/core/agent-lifecycle.js';
import eventBus from '../../src/core/event-bus.js';

describe('AgentLifecycle', () => {
  let agent;

  beforeEach(() => {
    agent = new AgentLifecycle({ id: 'agent-1', name: 'TestAgent' });
  });

  describe('constructor', () => {
    it('initialises with idle state', () => {
      assert.equal(agent.state, 'idle');
    });

    it('uses id as name when name not provided', () => {
      const a = new AgentLifecycle({ id: 'my-agent' });
      assert.equal(a.name, 'my-agent');
    });

    it('starts with an empty history', () => {
      assert.deepEqual(agent.history, []);
    });
  });

  describe('valid transitions', () => {
    it('idle → assigned', () => {
      agent.transition('assigned');
      assert.equal(agent.state, 'assigned');
    });

    it('assigned → executing', () => {
      agent.transition('assigned');
      agent.transition('executing');
      assert.equal(agent.state, 'executing');
    });

    it('executing → reviewing', () => {
      agent.transition('assigned');
      agent.transition('executing');
      agent.transition('reviewing');
      assert.equal(agent.state, 'reviewing');
    });

    it('reviewing → completed', () => {
      agent.transition('assigned');
      agent.transition('executing');
      agent.transition('reviewing');
      agent.transition('completed');
      assert.equal(agent.state, 'completed');
    });

    it('executing → completed (direct)', () => {
      agent.transition('assigned');
      agent.transition('executing');
      agent.transition('completed');
      assert.equal(agent.state, 'completed');
    });

    it('executing → failed', () => {
      agent.transition('assigned');
      agent.transition('executing');
      agent.transition('failed');
      assert.equal(agent.state, 'failed');
    });

    it('completed → idle', () => {
      agent.transition('assigned');
      agent.transition('executing');
      agent.transition('completed');
      agent.transition('idle');
      assert.equal(agent.state, 'idle');
    });

    it('failed → idle', () => {
      agent.transition('assigned');
      agent.transition('failed');
      agent.transition('idle');
      assert.equal(agent.state, 'idle');
    });

    it('executing → paused', () => {
      agent.transition('assigned');
      agent.transition('executing');
      agent.transition('paused');
      assert.equal(agent.state, 'paused');
    });

    it('paused → idle', () => {
      agent.transition('assigned');
      agent.transition('executing');
      agent.transition('paused');
      agent.transition('idle');
      assert.equal(agent.state, 'idle');
    });
  });

  describe('invalid transitions', () => {
    it('throws when transitioning from idle to executing directly', () => {
      assert.throws(
        () => agent.transition('executing'),
        /invalid transition idle → executing/
      );
    });

    it('throws when transitioning from idle to completed', () => {
      assert.throws(
        () => agent.transition('completed'),
        /invalid transition/
      );
    });

    it('throws when transitioning from completed to assigned', () => {
      agent.transition('assigned');
      agent.transition('executing');
      agent.transition('completed');
      assert.throws(
        () => agent.transition('assigned'),
        /invalid transition/
      );
    });

    it('does not change state on invalid transition', () => {
      try {
        agent.transition('executing');
      } catch (_) { /* expected */ }
      assert.equal(agent.state, 'idle');
    });
  });

  describe('transition history', () => {
    it('records each transition in history', () => {
      agent.transition('assigned');
      agent.transition('executing');

      assert.equal(agent.history.length, 2);
      assert.equal(agent.history[0].from, 'idle');
      assert.equal(agent.history[0].to, 'assigned');
      assert.equal(agent.history[1].from, 'assigned');
      assert.equal(agent.history[1].to, 'executing');
    });

    it('records timestamp for each transition', () => {
      const before = Date.now();
      agent.transition('assigned');
      const after = Date.now();

      assert.ok(agent.history[0].timestamp >= before);
      assert.ok(agent.history[0].timestamp <= after);
    });
  });

  describe('events emitted on transitions', () => {
    it('emits agent.assigned when transitioning to assigned', () => {
      let emitted = null;
      eventBus.once('agent.assigned', (data) => { emitted = data; });

      agent.transition('assigned');

      assert.ok(emitted);
      assert.equal(emitted.agent, 'agent-1');
      assert.equal(emitted.name, 'TestAgent');
    });

    it('emits agent.executing when transitioning to executing', () => {
      let emitted = null;
      agent.transition('assigned');
      eventBus.once('agent.executing', (data) => { emitted = data; });
      agent.transition('executing');

      assert.ok(emitted);
      assert.equal(emitted.agent, 'agent-1');
    });

    it('emits agent.completed when transitioning to completed', () => {
      let emitted = null;
      agent.transition('assigned');
      agent.transition('executing');
      eventBus.once('agent.completed', (data) => { emitted = data; });
      agent.transition('completed');

      assert.ok(emitted);
      assert.equal(emitted.agent, 'agent-1');
    });

    it('emits agent.failed when transitioning to failed', () => {
      let emitted = null;
      agent.transition('assigned');
      eventBus.once('agent.failed', (data) => { emitted = data; });
      agent.transition('failed');

      assert.ok(emitted);
      assert.equal(emitted.agent, 'agent-1');
    });

    it('emits agent.paused when transitioning to paused', () => {
      let emitted = null;
      eventBus.once('agent.paused', (data) => { emitted = data; });
      agent.transition('paused');

      assert.ok(emitted);
      assert.equal(emitted.agent, 'agent-1');
    });
  });

  describe('convenience methods', () => {
    it('assign() sets currentTaskId and transitions to assigned', () => {
      agent.assign('task-42');
      assert.equal(agent.state, 'assigned');
      assert.equal(agent.currentTaskId, 'task-42');
    });

    it('startExecution() transitions to executing', () => {
      agent.assign('task-1');
      agent.startExecution();
      assert.equal(agent.state, 'executing');
    });

    it('startReview() transitions to reviewing', () => {
      agent.assign('task-1');
      agent.startExecution();
      agent.startReview();
      assert.equal(agent.state, 'reviewing');
    });

    it('complete() transitions to completed and clears currentTaskId', () => {
      agent.assign('task-1');
      agent.startExecution();
      agent.complete();
      assert.equal(agent.state, 'completed');
      assert.equal(agent.currentTaskId, null);
    });

    it('fail() transitions to failed and clears currentTaskId', () => {
      agent.assign('task-1');
      agent.fail('timeout');
      assert.equal(agent.state, 'failed');
      assert.equal(agent.currentTaskId, null);
    });

    it('pause() transitions to paused', () => {
      agent.pause('quota exhausted');
      assert.equal(agent.state, 'paused');
    });

    it('resume() transitions to idle from paused', () => {
      agent.pause('quota');
      agent.resume();
      assert.equal(agent.state, 'idle');
    });

    it('isAvailable() returns true only in idle state', () => {
      assert.equal(agent.isAvailable(), true);
      agent.assign('task-1');
      assert.equal(agent.isAvailable(), false);
    });
  });

  describe('getStatus()', () => {
    it('returns current status object', () => {
      agent.assign('task-99');
      const status = agent.getStatus();

      assert.equal(status.id, 'agent-1');
      assert.equal(status.name, 'TestAgent');
      assert.equal(status.state, 'assigned');
      assert.equal(status.currentTaskId, 'task-99');
      assert.equal(status.historyLength, 1);
    });
  });
});

describe('AgentPool', () => {
  let pool;

  beforeEach(() => {
    pool = new AgentPool();
  });

  describe('register()', () => {
    it('registers an agent and returns an AgentLifecycle', () => {
      const lifecycle = pool.register({ id: 'a1', name: 'Alpha' });

      assert.ok(lifecycle instanceof AgentLifecycle);
      assert.equal(lifecycle.id, 'a1');
    });

    it('agent is retrievable by id after registration', () => {
      pool.register({ id: 'a1', name: 'Alpha' });
      const agent = pool.get('a1');
      assert.ok(agent);
      assert.equal(agent.id, 'a1');
    });
  });

  describe('get()', () => {
    it('returns null for unknown agent id', () => {
      assert.equal(pool.get('nonexistent'), null);
    });
  });

  describe('getAvailable()', () => {
    it('returns only idle agents', () => {
      pool.register({ id: 'a1' });
      pool.register({ id: 'a2' });
      pool.register({ id: 'a3' });

      // Put a2 into assigned state
      pool.get('a2').assign('task-1');

      const available = pool.getAvailable();
      assert.equal(available.length, 2);
      const ids = available.map(a => a.id);
      assert.ok(ids.includes('a1'));
      assert.ok(ids.includes('a3'));
      assert.ok(!ids.includes('a2'));
    });

    it('returns empty array when all agents are busy', () => {
      pool.register({ id: 'a1' });
      pool.get('a1').assign('task-1');

      assert.deepEqual(pool.getAvailable(), []);
    });
  });

  describe('getExecuting()', () => {
    it('returns only agents in executing state', () => {
      pool.register({ id: 'a1' });
      pool.register({ id: 'a2' });

      pool.get('a1').assign('task-1');
      pool.get('a1').startExecution();
      pool.get('a2').assign('task-2');
      // a2 is assigned but not executing

      const executing = pool.getExecuting();
      assert.equal(executing.length, 1);
      assert.equal(executing[0].id, 'a1');
    });
  });

  describe('has()', () => {
    it('returns true for registered agents', () => {
      pool.register({ id: 'exists' });
      assert.equal(pool.has('exists'), true);
    });

    it('returns false for unregistered agents', () => {
      assert.equal(pool.has('missing'), false);
    });
  });

  describe('getAllStatuses()', () => {
    it('returns a status map keyed by agent id', () => {
      pool.register({ id: 'a1', name: 'One' });
      pool.register({ id: 'a2', name: 'Two' });

      const statuses = pool.getAllStatuses();
      assert.ok('a1' in statuses);
      assert.ok('a2' in statuses);
      assert.equal(statuses.a1.state, 'idle');
      assert.equal(statuses.a2.state, 'idle');
    });
  });
});
