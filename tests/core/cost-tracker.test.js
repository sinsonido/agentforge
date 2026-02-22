import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CostTracker } from '../../src/core/cost-tracker.js';
import eventBus from '../../src/core/event-bus.js';

describe('CostTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  describe('initProject()', () => {
    it('registers a project with the given budget', () => {
      tracker.initProject('proj-1', 100);
      const status = tracker.getBudgetStatus('proj-1');

      assert.ok(status, 'should return a status for the project');
      assert.equal(status.budget, 100);
      assert.equal(status.spent, 0);
      assert.equal(status.remaining, 100);
    });

    it('sets remaining_pct to 1.0 for a fresh project', () => {
      tracker.initProject('proj-fresh', 50);
      const status = tracker.getBudgetStatus('proj-fresh');
      assert.equal(status.remaining_pct, 1);
    });

    it('can register multiple projects independently', () => {
      tracker.initProject('proj-a', 100);
      tracker.initProject('proj-b', 200);

      tracker.recordCost('proj-a', 'agent-1', 'model-x', 10);

      const a = tracker.getBudgetStatus('proj-a');
      const b = tracker.getBudgetStatus('proj-b');

      assert.equal(a.spent, 10);
      assert.equal(b.spent, 0);
    });
  });

  describe('recordCost()', () => {
    it('accumulates spend for a project', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost('proj-1', 'agent-1', 'model-a', 5);
      tracker.recordCost('proj-1', 'agent-1', 'model-a', 3);

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.spent, 8);
    });

    it('tracks costs per agent', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost('proj-1', 'agent-alpha', 'model-a', 4);
      tracker.recordCost('proj-1', 'agent-beta', 'model-a', 6);

      const byAgent = tracker.getCostByAgent();
      assert.equal(byAgent['agent-alpha'], 4);
      assert.equal(byAgent['agent-beta'], 6);
    });

    it('tracks costs per model', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost('proj-1', 'agent-1', 'claude-opus-4', 3);
      tracker.recordCost('proj-1', 'agent-1', 'claude-opus-4', 2);
      tracker.recordCost('proj-1', 'agent-1', 'gemini-2.5-pro', 1);

      const byModel = tracker.getCostByModel();
      assert.equal(byModel['claude-opus-4'], 5);
      assert.equal(byModel['gemini-2.5-pro'], 1);
    });

    it('ignores zero and negative costs', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost('proj-1', 'agent-1', 'model-a', 0);
      tracker.recordCost('proj-1', 'agent-1', 'model-a', -5);

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.spent, 0);
    });

    it('emits cost.recorded event', () => {
      tracker.initProject('proj-1', 100);
      let emitted = null;
      eventBus.once('cost.recorded', (data) => { emitted = data; });

      tracker.recordCost('proj-1', 'agent-1', 'model-a', 2.5);

      assert.ok(emitted);
      assert.equal(emitted.projectId, 'proj-1');
      assert.equal(emitted.agentId, 'agent-1');
      assert.equal(emitted.modelId, 'model-a');
      assert.equal(emitted.cost, 2.5);
    });

    it('works when project is not registered (no budget tracking)', () => {
      // Should not throw; agent and model costs still tracked
      assert.doesNotThrow(() => {
        tracker.recordCost('unregistered', 'agent-1', 'model-a', 1.0);
      });
      const byAgent = tracker.getCostByAgent();
      assert.equal(byAgent['agent-1'], 1.0);
    });
  });

  describe('getBudgetStatus()', () => {
    it('returns null for an unregistered project', () => {
      assert.equal(tracker.getBudgetStatus('does-not-exist'), null);
    });

    it('returns correct remaining and remaining_pct', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost('proj-1', 'agent-1', 'model-a', 25);

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.remaining, 75);
      assert.equal(status.remaining_pct, 0.75);
      assert.equal(status.spent_pct, 0.25);
    });

    it('clamps remaining to 0 (no negative remaining)', () => {
      tracker.initProject('proj-1', 10);
      tracker.recordCost('proj-1', 'agent-1', 'model-a', 5);
      tracker.recordCost('proj-1', 'agent-1', 'model-a', 5);
      tracker.recordCost('proj-1', 'agent-1', 'model-a', 5); // over budget

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.remaining, 0);
    });

    it('warning is false below 80% spend', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost('proj-1', 'agent-1', 'model-a', 50);

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.warning, false);
      assert.equal(status.exceeded, false);
    });

    it('warning is true at 80% spend (remaining_pct < 0.20)', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost('proj-1', 'agent-1', 'model-a', 85);

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.warning, true);
      assert.equal(status.exceeded, false);
    });

    it('exceeded is true at 95% spend (remaining_pct < 0.05)', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost('proj-1', 'agent-1', 'model-a', 96);

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.exceeded, true);
    });
  });

  describe('budget.warning event', () => {
    it('emits budget.warning when spend reaches 80%', () => {
      tracker.initProject('proj-warn', 100);
      let warnEvent = null;
      eventBus.once('budget.warning', (data) => { warnEvent = data; });

      tracker.recordCost('proj-warn', 'agent-1', 'model-a', 82);

      assert.ok(warnEvent, 'budget.warning should be emitted');
      assert.equal(warnEvent.projectId, 'proj-warn');
    });

    it('does not emit budget.warning below 80%', () => {
      tracker.initProject('proj-safe', 100);
      let warnEvent = null;
      eventBus.once('budget.warning', (data) => { warnEvent = data; });

      tracker.recordCost('proj-safe', 'agent-1', 'model-a', 50);

      assert.equal(warnEvent, null);
    });
  });

  describe('budget.exceeded event', () => {
    it('emits budget.exceeded when spend reaches 95%', () => {
      tracker.initProject('proj-exceed', 100);
      let exceedEvent = null;
      eventBus.once('budget.exceeded', (data) => { exceedEvent = data; });

      tracker.recordCost('proj-exceed', 'agent-1', 'model-a', 96);

      assert.ok(exceedEvent, 'budget.exceeded should be emitted');
      assert.equal(exceedEvent.projectId, 'proj-exceed');
    });

    it('does not emit budget.exceeded at 80%', () => {
      tracker.initProject('proj-warn-only', 100);
      let exceedEvent = null;
      eventBus.once('budget.exceeded', (data) => { exceedEvent = data; });

      tracker.recordCost('proj-warn-only', 'agent-1', 'model-a', 82);

      assert.equal(exceedEvent, null);
    });
  });

  describe('getAllStats()', () => {
    it('returns full breakdown including projects, byAgent, byModel and totalSpent', () => {
      tracker.initProject('proj-a', 100);
      tracker.initProject('proj-b', 200);

      tracker.recordCost('proj-a', 'agent-1', 'model-x', 10);
      tracker.recordCost('proj-b', 'agent-2', 'model-y', 20);

      const stats = tracker.getAllStats();

      assert.ok('projects' in stats);
      assert.ok('byAgent' in stats);
      assert.ok('byModel' in stats);
      assert.ok('totalSpent' in stats);

      assert.equal(stats.projects['proj-a'].spent, 10);
      assert.equal(stats.projects['proj-b'].spent, 20);
      assert.equal(stats.byAgent['agent-1'], 10);
      assert.equal(stats.byAgent['agent-2'], 20);
      assert.equal(stats.byModel['model-x'], 10);
      assert.equal(stats.byModel['model-y'], 20);
      assert.equal(stats.totalSpent, 30);
    });

    it('returns empty breakdown when nothing is tracked', () => {
      const stats = tracker.getAllStats();
      assert.deepEqual(stats.projects, {});
      assert.deepEqual(stats.byAgent, {});
      assert.deepEqual(stats.byModel, {});
      assert.equal(stats.totalSpent, 0);
    });
  });

  describe('getBudgetRemainingPct()', () => {
    it('returns 1.0 when project has no budget registered', () => {
      assert.equal(tracker.getBudgetRemainingPct('nonexistent'), 1.0);
    });

    it('returns correct percentage after spending', () => {
      tracker.initProject('proj-pct', 100);
      tracker.recordCost('proj-pct', 'agent-1', 'model-a', 40);
      assert.equal(tracker.getBudgetRemainingPct('proj-pct'), 0.6);
    });
  });
});
