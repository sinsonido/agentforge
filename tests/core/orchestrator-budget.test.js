import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import { CostTracker } from '../../src/core/cost-tracker.js';
import { Budget, parseBudget } from '../../src/core/budget.js';
import { AgentForgeDB } from '../../src/persistence/db.js';
import eventBus from '../../src/core/event-bus.js';

const HOUR = 3_600_000;
const CODING = { kind: 'coding', title: 'Fix', repo: 'acme/app', base: 'master', instruction: 'Fix it', playbook: 'bug-fix' };
const round = (ci) => ({ branch: 'agentforge/x', dir: null, max_rounds: 2, verdict: null, rounds: [{ n: 0, head: 'abc1234', ci, failing: [], started_at: 1, finished_at: null }] });

let dir;
let running = [];
let dbs = [];
let clock;

before(() => { dir = mkdtempSync(join(tmpdir(), 'af-budget-orch-')); });
after(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  for (const o of running) o.stop({ graceMs: 0 });
  for (const db of dbs) db.close();
  running = [];
  dbs = [];
  for (const evt of ['quota.exhausted', 'quota.reset', 'budget.exceeded', 'budget.warning', 'task.step_changed']) eventBus.removeAllListeners(evt);
});

/**
 * An orchestrator on a real database whose coding runs are held until the test
 * finishes them, each with what the leg spent and where it left the task.
 */
function boot(file, budget, now = () => clock) {
  const db = new AgentForgeDB(join(dir, file));
  dbs.push(db);
  const taskQueue = new TaskQueue({ store: db });
  const costTracker = new CostTracker({}, { store: db });
  const runs = [];
  const coding = {
    concurrency: 1,
    run(task) {
      taskQueue.updateStatus(task.id, task.status === 'ci-watch' ? 'ci-watch' : 'executing');
      return new Promise((resolve) => {
        runs.push({ task, finish: (status, extra = {}) => { taskQueue.updateStatus(task.id, status, extra); resolve(); } });
      });
    },
  };
  const orchestrator = new Orchestrator({
    taskQueue, router: { models: {}, resolve: () => ({ action: 'wait' }) }, quotaManager: new QuotaManager(),
    providerRegistry: null, agents: {}, config: {}, coding,
    costTracker, budget: new Budget(parseBudget(budget).value, costTracker, now),
  });
  return { db, taskQueue, costTracker, orchestrator, runs };
}

function start(orchestrator) {
  running.push(orchestrator);
  orchestrator.start(5);
}

async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 40));
const trailOf = (queue, id) => queue.trail(id).map((e) => e.summary);

describe('Orchestrator budget gate', () => {
  it('records each build leg in the ledger and parks the task before a fix round it cannot afford', async () => {
    clock = 10 * 24 * HOUR;
    const { taskQueue, costTracker, orchestrator, runs } = boot('fix.db', { task: { build: 1 }, min_run_usd: 0.25 });
    const task = taskQueue.add({ ...CODING, issue: 1 });
    const paused = new Promise((r) => eventBus.once('task.paused_budget', r));

    start(orchestrator);
    await waitFor(() => runs.length === 1);
    runs[0].finish('ci-watch', { cost: 0.8, tokens_in: 10, tokens_out: 2, babysit: round('fail') });
    const event = await paused;

    assert.equal(event.task.id, task.id);
    await settle();
    assert.equal(runs.length, 1, 'the fix round never started');
    assert.equal(taskQueue.get(task.id).status, 'paused_budget');
    assert.equal(taskQueue.get(task.id).result, 'paused: task build budget $0.80 of $1.00 spent');
    assert.ok(trailOf(taskQueue, task.id).includes('fail budget: task build spent $0.80 of $1.00, under $0.25 left for the next run'));
    assert.deepEqual(costTracker.spent({ taskId: task.id }), { build: 0.8, verify: 0, total: 0.8 });
    assert.partialDeepStrictEqual(costTracker.records().at(-1), { taskId: task.id, repo: 'acme/app', phase: 'build', cost: 0.8 });
  });

  it('pauses a green PR before verification it cannot afford, and lets spent build not block it', async () => {
    clock = 10 * 24 * HOUR;
    const { taskQueue, costTracker, orchestrator, runs } = boot('verify.db', { task: { build: 1, verify: 0.5 } });
    const broke = taskQueue.add({ ...CODING, issue: 1 });
    taskQueue.updateStatus(broke.id, 'ci-watch', { babysit: round('pass') });
    costTracker.recordCost({ cost: 0.4, taskId: broke.id, repo: 'acme/app', phase: 'verify', at: clock });
    const green = taskQueue.add({ ...CODING, issue: 2 });
    taskQueue.updateStatus(green.id, 'ci-watch', { babysit: round('pass') });
    costTracker.recordCost({ cost: 1, taskId: green.id, repo: 'acme/app', phase: 'build', at: clock });

    start(orchestrator);
    await waitFor(() => runs.length === 1);

    assert.equal(runs[0].task.id, green.id);
    assert.equal(taskQueue.get(broke.id).status, 'paused_budget');
    assert.ok(trailOf(taskQueue, broke.id).includes('fail budget: task verify spent $0.40 of $0.50, under $0.25 left for the next run'));
  });

  it('resumes a parked task once the repo window rolls on, after a restart', async () => {
    clock = 10 * 24 * HOUR;
    const budget = { repo: { build: 1, window: 'day' } };
    const first = boot('restart.db', budget);
    first.costTracker.recordCost({ cost: 0.9, taskId: 'earlier', repo: 'acme/app', at: clock });
    const task = first.taskQueue.add({ ...CODING, issue: 1 });

    start(first.orchestrator);
    await waitFor(() => first.taskQueue.get(task.id).status === 'paused_budget');
    await first.orchestrator.stop({ graceMs: 0 });
    assert.equal(first.runs.length, 0);
    first.db.close();
    dbs = dbs.filter((d) => d !== first.db);

    clock += 23 * HOUR;
    const still = boot('restart.db', budget);
    start(still.orchestrator);
    await settle();
    assert.equal(still.taskQueue.get(task.id).status, 'paused_budget', 'the ledger came back from the database');
    await still.orchestrator.stop({ graceMs: 0 });
    still.db.close();
    dbs = dbs.filter((d) => d !== still.db);

    clock += 2 * HOUR;
    const later = boot('restart.db', budget);
    start(later.orchestrator);
    await waitFor(() => later.runs.length === 1);
    assert.equal(later.runs[0].task.id, task.id);
    assert.ok(trailOf(later.taskQueue, task.id).includes('budget has room again: resuming at queued'));
  });

  it('a project budget.exceeded pauses text tasks and leaves coding tasks to the budget gate', () => {
    const { taskQueue } = boot('project.db', {});
    const code = taskQueue.add({ ...CODING, issue: 1 });
    const text = taskQueue.add({ title: 'plain' });

    eventBus.emit('budget.exceeded', { projectId: 'p', spent_pct: 0.99 });

    assert.equal(taskQueue.get(code.id).status, 'queued');
    assert.equal(taskQueue.get(text.id).status, 'paused_budget');
  });
});
