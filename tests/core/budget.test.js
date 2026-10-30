import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Budget, BUDGET_DEFAULTS, parseBudget, phasesAhead, resumeStatus } from '../../src/core/budget.js';
import { CostTracker } from '../../src/core/cost-tracker.js';

const HOUR = 3_600_000;
const NOW = 100 * 24 * HOUR;
const task = (over = {}) => ({ id: 't1', kind: 'coding', repo: 'acme/app', budget: null, babysit: null, ...over });
const round = (ci) => ({ babysit: { rounds: [{ n: 0, head: 'abc', ci, failing: [] }] } });

function ledger(records = []) {
  const costs = new CostTracker();
  for (const r of records) costs.recordCost({ repo: 'acme/app', taskId: 't1', phase: 'build', at: NOW, ...r });
  return costs;
}

const policy = (over = {}) => {
  const parsed = parseBudget(over);
  assert.ok(parsed.ok, parsed.error);
  return parsed.value;
};

describe('parseBudget', () => {
  it('has no limits by default', () => {
    assert.deepEqual(parseBudget(undefined), { ok: true, value: structuredClone(BUDGET_DEFAULTS) });
    assert.deepEqual(policy({ task: { build: 5 } }).repo, { window: 'day', build: null, verify: null });
  });

  it('rejects bad limits, windows and unknown keys', () => {
    const out = parseBudget({ task: { build: -1, cost: 1 }, repo: { window: 'hour' }, min_run_usd: 'x', extra: 1 });
    assert.equal(out.ok, false);
    for (const want of ['unknown key extra', 'unknown key task.cost', 'task.build must be a positive number', 'repo.window must be one of: day, week, month', 'min_run_usd']) {
      assert.ok(out.error.includes(want), `${want} in ${out.error}`);
    }
    assert.equal(parseBudget([]).ok, false);
    assert.equal(parseBudget({ repo: 3 }).ok, false);
  });
});

describe('phasesAhead', () => {
  it('names what the next leg can spend: build before a PR, then by the last CI round', () => {
    assert.deepEqual(phasesAhead(task()), ['build']);
    assert.deepEqual(phasesAhead(task(round('pending'))), ['build', 'verify']);
    assert.deepEqual(phasesAhead(task(round('fail'))), ['build']);
    assert.deepEqual(phasesAhead(task(round('pass'))), ['verify']);
  });

  it('resumes a parked task where it was: CI watch once it has a PR', () => {
    assert.equal(resumeStatus(task()), 'queued');
    assert.equal(resumeStatus(task(round('fail'))), 'ci-watch');
  });
});

describe('Budget', () => {
  it('lets a task run while every limit of its phase has min_run_usd left', () => {
    const budget = new Budget(policy({ task: { build: 1 }, min_run_usd: 0.25 }), ledger([{ cost: 0.7 }]), () => NOW);
    assert.equal(budget.check(task()), null);
    assert.ok(Math.abs(budget.runCap(task(), 'build') - 0.3) < 1e-9);
  });

  it('blocks the next build once under min_run_usd is left, naming the limit', () => {
    const budget = new Budget(policy({ task: { build: 1 }, min_run_usd: 0.25 }), ledger([{ cost: 0.8 }]), () => NOW);
    assert.partialDeepStrictEqual(budget.check(task()), { scope: 'task', phase: 'build', limit: 1, spent: 0.8 });
  });

  it("uses the task's own budget over the configured task build limit", () => {
    const budget = new Budget(policy({ task: { build: 10 } }), ledger([{ cost: 1.9 }]), () => NOW);
    assert.equal(budget.check(task({ budget: 2 }))?.limit, 2);
    assert.equal(budget.check(task()), null);
  });

  it('budgets verification apart from build', () => {
    const budget = new Budget(policy({ task: { build: 1, verify: 0.5 } }), ledger([{ cost: 0.9 }, { cost: 0.1, phase: 'verify' }]), () => NOW);
    assert.equal(budget.check(task(round('pass'))), null, 'a green PR only verifies; spent build does not block it');
    assert.equal(budget.check(task(round('fail')))?.phase, 'build');
    assert.equal(budget.check(task(round('pending')))?.phase, 'build');
    assert.ok(Math.abs(budget.runCap(task(), 'verify') - 0.4) < 1e-9);
  });

  it('sums a repository over its rolling window and across its tasks', () => {
    const costs = ledger([
      { cost: 3, taskId: 'old', at: NOW - 25 * HOUR },
      { cost: 0.5, taskId: 'other', at: NOW - 23 * HOUR },
      { cost: 0.4, taskId: 't1', at: NOW - HOUR },
      { cost: 9, taskId: 'x', repo: 'acme/elsewhere', at: NOW },
    ]);
    const budget = new Budget(policy({ repo: { build: 1 }, min_run_usd: 0.25 }), costs, () => NOW);
    assert.ok(Math.abs(budget.runCap(task(), 'build') - 0.1) < 1e-9, 'yesterday and other repos do not count');
    assert.partialDeepStrictEqual(budget.check(task()), { scope: 'repo', phase: 'build', limit: 1 });

    const week = new Budget(policy({ repo: { build: 5, window: 'week' } }), costs, () => NOW);
    assert.ok(Math.abs(week.runCap(task(), 'build') - 1.1) < 1e-9);
  });

  it('caps one run at the tightest limit and leaves it to the executor default without limits', () => {
    const costs = ledger([{ cost: 1, taskId: 'other' }]);
    const budget = new Budget(policy({ task: { build: 2 }, repo: { build: 1.5 } }), costs, () => NOW);
    assert.equal(budget.capRun(task(), 'build').budget, 0.5);
    assert.equal(budget.capRun(task(), 'verify').budget, undefined);
    assert.equal(new Budget(policy(), costs, () => NOW).capRun(task({ budget: null }), 'build').budget, undefined);
  });

  it('reports spend per phase with each limit, for the task and its repo window', () => {
    const budget = new Budget(policy({ task: { build: 2 }, repo: { verify: 3 } }), ledger([{ cost: 0.5 }, { cost: 0.25, phase: 'verify' }]), () => NOW);
    const report = budget.report(task());
    assert.equal(report.build.spent, 0.5);
    assert.deepEqual(report.build.limits.map((l) => [l.scope, l.limit, l.remaining]), [['task', 2, 1.5]]);
    assert.equal(report.verify.spent, 0.25);
    assert.deepEqual(report.verify.limits.map((l) => [l.scope, l.limit]), [['repo', 3]]);
    assert.deepEqual(budget.repoReport('acme/app'), {
      window: 'day', since: NOW - 24 * HOUR, build: { spent: 0.5, limit: null }, verify: { spent: 0.25, limit: 3 },
    });
  });
});
