import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CostTracker } from '../../src/core/cost-tracker.js';
import eventBus from '../../src/core/event-bus.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentForgeDB } from '../../src/persistence/db.js';

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

      tracker.recordCost({ projectId: 'proj-a', agentId: 'agent-1', model: 'model-x', cost: 10 });

      const a = tracker.getBudgetStatus('proj-a');
      const b = tracker.getBudgetStatus('proj-b');

      assert.equal(a.spent, 10);
      assert.equal(b.spent, 0);
    });
  });

  describe('recordCost()', () => {
    it('accumulates spend for a project', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'model-a', cost: 5 });
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'model-a', cost: 3 });

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.spent, 8);
    });

    it('tracks costs per agent', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-alpha', model: 'model-a', cost: 4 });
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-beta', model: 'model-a', cost: 6 });

      const byAgent = tracker.getCostByAgent();
      assert.equal(byAgent['agent-alpha'], 4);
      assert.equal(byAgent['agent-beta'], 6);
    });

    it('tracks costs per model', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'claude-opus-4', cost: 3 });
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'claude-opus-4', cost: 2 });
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'gemini-2.5-pro', cost: 1 });

      const byModel = tracker.getCostByModel();
      assert.equal(byModel['claude-opus-4'], 5);
      assert.equal(byModel['gemini-2.5-pro'], 1);
    });

    it('ignores zero and negative costs', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'model-a', cost: 0 });
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'model-a', cost: -5 });

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.spent, 0);
    });

    it('works when project is not registered (no budget tracking)', () => {
      // Should not throw; agent and model costs still tracked
      assert.doesNotThrow(() => {
        tracker.recordCost({ projectId: 'unregistered', agentId: 'agent-1', model: 'model-a', cost: 1.0 });
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
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'model-a', cost: 25 });

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.remaining, 75);
      assert.equal(status.remaining_pct, 0.75);
      assert.equal(status.spent_pct, 0.25);
    });

    it('clamps remaining to 0 (no negative remaining)', () => {
      tracker.initProject('proj-1', 10);
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'model-a', cost: 5 });
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'model-a', cost: 5 });
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'model-a', cost: 5 }); // over budget

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.remaining, 0);
    });

    it('warning is false below 80% spend', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'model-a', cost: 50 });

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.warning, false);
      assert.equal(status.exceeded, false);
    });

    it('warning is true at 80% spend (remaining_pct < 0.20)', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'model-a', cost: 85 });

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.warning, true);
      assert.equal(status.exceeded, false);
    });

    it('exceeded is true at 95% spend (remaining_pct < 0.05)', () => {
      tracker.initProject('proj-1', 100);
      tracker.recordCost({ projectId: 'proj-1', agentId: 'agent-1', model: 'model-a', cost: 96 });

      const status = tracker.getBudgetStatus('proj-1');
      assert.equal(status.exceeded, true);
    });
  });

  describe('budget.warning event', () => {
    it('emits budget.warning when spend reaches 80%', () => {
      tracker.initProject('proj-warn', 100);
      let warnEvent = null;
      eventBus.once('budget.warning', (data) => { warnEvent = data; });

      tracker.recordCost({ projectId: 'proj-warn', agentId: 'agent-1', model: 'model-a', cost: 82 });

      assert.ok(warnEvent, 'budget.warning should be emitted');
      assert.equal(warnEvent.projectId, 'proj-warn');
    });

    it('does not emit budget.warning below 80%', () => {
      tracker.initProject('proj-safe', 100);
      let warnEvent = null;
      eventBus.once('budget.warning', (data) => { warnEvent = data; });

      tracker.recordCost({ projectId: 'proj-safe', agentId: 'agent-1', model: 'model-a', cost: 50 });

      assert.equal(warnEvent, null);
    });
  });

  describe('budget.exceeded event', () => {
    it('emits budget.exceeded when spend reaches 95%', () => {
      tracker.initProject('proj-exceed', 100);
      let exceedEvent = null;
      eventBus.once('budget.exceeded', (data) => { exceedEvent = data; });

      tracker.recordCost({ projectId: 'proj-exceed', agentId: 'agent-1', model: 'model-a', cost: 96 });

      assert.ok(exceedEvent, 'budget.exceeded should be emitted');
      assert.equal(exceedEvent.projectId, 'proj-exceed');
    });

    it('does not emit budget.exceeded at 80%', () => {
      tracker.initProject('proj-warn-only', 100);
      let exceedEvent = null;
      eventBus.once('budget.exceeded', (data) => { exceedEvent = data; });

      tracker.recordCost({ projectId: 'proj-warn-only', agentId: 'agent-1', model: 'model-a', cost: 82 });

      assert.equal(exceedEvent, null);
    });
  });

  describe('getAllStats()', () => {
    it('returns full breakdown including projects, byAgent, byModel and totalSpent', () => {
      tracker.initProject('proj-a', 100);
      tracker.initProject('proj-b', 200);

      tracker.recordCost({ projectId: 'proj-a', agentId: 'agent-1', model: 'model-x', cost: 10 });
      tracker.recordCost({ projectId: 'proj-b', agentId: 'agent-2', model: 'model-y', cost: 20 });

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
      tracker.recordCost({ projectId: 'proj-pct', agentId: 'agent-1', model: 'model-a', cost: 40 });
      assert.equal(tracker.getBudgetRemainingPct('proj-pct'), 0.6);
    });
  });

  describe('the ledger', () => {
    it('counts spend with no agent or registered project in the total (#244)', () => {
      tracker.recordCost({ projectId: 'default', cost: 0.5, taskId: 't1', repo: 'acme/app' });
      const stats = tracker.getAllStats();
      assert.equal(stats.totalSpent, 0.5);
      assert.deepEqual(stats.byAgent, {});
    });

    it('splits spend by phase, build by default, and filters by task, repo and time', () => {
      tracker.recordCost({ cost: 1, taskId: 't1', repo: 'a/b', at: 10 });
      tracker.recordCost({ cost: 0.5, taskId: 't1', repo: 'a/b', phase: 'verify', at: 20 });
      tracker.recordCost({ cost: 2, taskId: 't2', repo: 'c/d', at: 30 });

      assert.deepEqual(tracker.spent({ taskId: 't1' }), { build: 1, verify: 0.5, total: 1.5 });
      assert.deepEqual(tracker.spent({ repo: 'a/b', since: 15 }), { build: 0, verify: 0.5, total: 0.5 });
      assert.deepEqual(tracker.getAllStats().byPhase, { build: 3, verify: 0.5 });
      assert.deepEqual(tracker.repos(), ['a/b', 'c/d']);
    });

    it('writes through to its store and reloads it on construction, so budgets survive a restart', () => {
      const dir = mkdtempSync(join(tmpdir(), 'af-ledger-'));
      try {
        const db = new AgentForgeDB(join(dir, 'data.db'));
        new CostTracker({}, { store: db }).recordCost({ projectId: 'p', cost: 0.75, taskId: 't1', repo: 'a/b', phase: 'verify', at: 7 });
        db.close();

        const reopened = new AgentForgeDB(join(dir, 'data.db'));
        const again = new CostTracker({}, { store: reopened });
        again.initProject('p', 10);
        assert.deepEqual(again.spent({ taskId: 't1' }), { build: 0, verify: 0.75, total: 0.75 });
        assert.equal(again.getBudgetStatus('p').spent, 0.75, 'a project budget counts spend from before the restart');

        reopened.db.exec('DELETE FROM cost_records');
        again.reload();
        assert.deepEqual(again.spent(), { build: 0, verify: 0, total: 0 });
        assert.equal(again.getBudgetStatus('p').spent, 0);
        reopened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
