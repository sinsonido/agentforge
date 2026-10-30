/**
 * REST endpoints of src/api/server.js not covered by tests/api.test.js
 * (which owns POST /api/tasks/:id/status, POST /api/agents/:id and
 * POST /api/providers/test).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import { CostTracker } from '../../src/core/cost-tracker.js';
import { Budget, parseBudget } from '../../src/core/budget.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import defaultEventBus from '../../src/core/event-bus.js';
import { decideApproval, runCodingTask } from '../../src/execution/coding-runner.js';
import { startServer } from '../../src/api/server.js';
import { AgentForgeDB } from '../../src/persistence/db.js';

const ORCHESTRATOR_EVENTS = ['quota.exhausted', 'quota.reset', 'budget.exceeded', 'budget.warning', 'task.step_changed'];

function makeForge(overrides = {}) {
  const recent = Array.from({ length: 3 }, (_, i) => ({
    event: 'task.queued',
    data: { task: { id: `t${i}` } },
    timestamp: 1000 + i,
  }));
  const eventBus = Object.assign(new EventEmitter(), {
    getRecentEvents: (n) => recent.slice(-n),
    clearRecent: () => {},
  });
  return {
    taskQueue: new TaskQueue(),
    quotaManager: new QuotaManager(),
    eventBus,
    agents: {
      dev: { id: 'dev', name: 'Dev', role: 'Backend', model: 'claude-sonnet-5-5', system_prompt: 'secret' },
    },
    orchestrator: {
      _running: false,
      start() { this._running = true; },
      stop() { this._running = false; },
    },
    costTracker: null,
    providerRegistry: null,
    db: null,
    config: {},
    ...overrides,
  };
}

async function serve(t, forge = makeForge()) {
  const server = startServer(forge, 0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  return { forge, call };
}

describe('GET /api/status', () => {
  it('reports task counts, quotas, agents and orchestrator state', async (t) => {
    const { forge, call } = await serve(t);
    forge.taskQueue.add({ title: 'a' });
    const done = forge.taskQueue.add({ title: 'b' });
    forge.taskQueue.updateStatus(done.id, 'completed');
    forge.quotaManager.addProvider('anthropic', { max_requests_per_minute: 50 });

    const { status, body } = await call('GET', '/api/status');

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.orchestrator.running, false);
    assert.equal(body.tasks.total, 2);
    assert.equal(body.tasks.queued, 1);
    assert.equal(body.tasks.completed, 1);
    assert.deepEqual(Object.keys(body.quotas), ['anthropic']);
    assert.deepEqual(body.agents, { dev: { id: 'dev', name: 'Dev', role: 'Backend', model: 'claude-sonnet-5-5' } });
  });
});

describe('/api/tasks', () => {
  it('lists every task, or only those matching ?status', async (t) => {
    const { forge, call } = await serve(t);
    forge.taskQueue.add({ title: 'queued one' });
    const done = forge.taskQueue.add({ title: 'done one' });
    forge.taskQueue.updateStatus(done.id, 'completed');

    const all = await call('GET', '/api/tasks');
    assert.equal(all.body.count, 2);
    assert.deepEqual(all.body.tasks.map((x) => x.title).sort(), ['done one', 'queued one']);

    const queued = await call('GET', '/api/tasks?status=queued');
    assert.equal(queued.body.count, 1);
    assert.equal(queued.body.tasks[0].title, 'queued one');
  });

  it('creates a queued task from the posted fields', async (t) => {
    const { forge, call } = await serve(t);
    const { status, body } = await call('POST', '/api/tasks', {
      body: { title: 'New task', type: 'review', priority: 'high', agent_id: 'dev' },
    });

    assert.equal(status, 201);
    assert.equal(body.task.status, 'queued');
    assert.equal(body.task.type, 'review');
    assert.equal(body.task.priority, 'high');
    assert.equal(body.task.agent_id, 'dev');
    assert.equal(forge.taskQueue.get(body.task.id).title, 'New task');
  });

  it('rejects a task without a title', async (t) => {
    const { forge, call } = await serve(t);
    const { status, body } = await call('POST', '/api/tasks', { body: { type: 'test' } });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(forge.taskQueue.getAll().length, 0);
  });

  const codingBody = {
    kind: 'coding', repo: 'sinsonido/agentforge', base: 'master',
    instruction: 'Add task model v2', issue: 195, playbook: 'feature', budget: 5,
  };

  it('creates a coding task and lists it with its coding fields', async (t) => {
    const { call } = await serve(t);
    const created = await call('POST', '/api/tasks', { body: codingBody });

    assert.equal(created.status, 201);
    assert.equal(created.body.created, true);
    assert.equal(created.body.task.kind, 'coding');
    assert.equal(created.body.task.title, 'Add task model v2');
    assert.equal(created.body.task.step, null);

    const listed = await call('GET', '/api/tasks');
    assert.equal(listed.body.tasks[0].playbook, 'feature');
    assert.equal(listed.body.tasks[0].issue, 195);
  });

  it('returns the live coding task for a duplicate repo, issue and playbook', async (t) => {
    const { forge, call } = await serve(t);
    const first = await call('POST', '/api/tasks', { body: codingBody });
    const again = await call('POST', '/api/tasks', { body: codingBody });

    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(again.body.task.id, first.body.task.id);
    assert.equal(forge.taskQueue.getAll().length, 1);
  });

  it('rejects a coding task missing its required fields with a readable message', async (t) => {
    const { forge, call } = await serve(t);
    const { status, body } = await call('POST', '/api/tasks', { body: { kind: 'coding', title: 'x', repo: 'o/r' } });

    assert.equal(status, 400);
    assert.deepEqual(body, { ok: false, error: 'a coding task requires `base`, `instruction`, `playbook`' });
    assert.equal(forge.taskQueue.getAll().length, 0);
  });

  it('rejects a coding task with an unknown playbook', async (t) => {
    const { call } = await serve(t);
    const { status, body } = await call('POST', '/api/tasks', { body: { ...codingBody, playbook: 'yolo' } });
    assert.equal(status, 400);
    assert.match(body.error, /`playbook` must be one of/);
  });

  it('returns one task by id, or 404', async (t) => {
    const { forge, call } = await serve(t);
    const task = forge.taskQueue.add({ title: 'Find me' });

    const found = await call('GET', `/api/tasks/${task.id}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.task.title, 'Find me');

    const missing = await call('GET', '/api/tasks/no-such-task');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.ok, false);
  });
});

describe('GET /api/tasks/:id/trail', () => {
  it('returns the task trail in order, and 404 for an unknown task', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-trail-api-'));
    const db = new AgentForgeDB(path.join(dir, 'data.db'));
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const { forge, call } = await serve(t, makeForge({ db, taskQueue: new TaskQueue({ store: db }) }));
    const task = forge.taskQueue.add({ title: 'trailed' });
    forge.taskQueue.updateStatus(task.id, 'failed', { result: 'boom' });

    const res = await call('GET', `/api/tasks/${task.id}/trail`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.trail.map((e) => [e.seq, e.kind, e.summary]), [
      [1, 'status', 'queued'],
      [2, 'status', 'queued → failed: boom'],
    ]);

    assert.equal((await call('GET', '/api/tasks/nope/trail')).status, 404);
  });
});

describe('POST /api/tasks/:id/cancel', () => {
  const coding = {
    kind: 'coding', title: 'Fix it', repo: 'o/r', base: 'master', instruction: 'Fix it', playbook: 'bug-fix',
  };

  afterEach(() => {
    for (const evt of ORCHESTRATOR_EVENTS) defaultEventBus.removeAllListeners(evt);
  });

  function codingForge() {
    const forge = makeForge();
    const started = [];
    const settled = [];
    const runs = [];
    const orchestrator = new Orchestrator({
      taskQueue: forge.taskQueue,
      router: { models: {}, resolve: () => ({ action: 'wait', reason: 'no text tasks here' }) },
      quotaManager: forge.quotaManager,
      providerRegistry: null,
      config: {},
      coding: {
        concurrency: 1,
        run: (task, signal) => {
          started.push(task.id);
          const run = runCodingTask(task, {
            queue: forge.taskQueue,
            eventBus: forge.eventBus,
            signal,
            execute: (_t, { signal: s }) => new Promise((resolve) => {
              s.addEventListener('abort', () => resolve({ outcome: 'cancelled', cancelReason: 'signal' }), { once: true });
            }),
            publish: async () => { throw new Error('a cancelled run must not publish'); },
          }).then((status) => settled.push(status));
          runs.push(run);
          return run;
        },
      },
    });
    forge.orchestrator = orchestrator;
    return { forge, orchestrator, started, settled, runs };
  }

  it('returns 404 for an unknown task', async (t) => {
    const { call } = await serve(t);
    const { status, body } = await call('POST', '/api/tasks/nope/cancel');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });

  it('cancels a queued coding task so it never starts', async (t) => {
    const { forge, orchestrator, started } = codingForge();
    const { call } = await serve(t, forge);
    const task = forge.taskQueue.add(coding);
    const failed = [];
    forge.eventBus.on('task.failed', (e) => failed.push(e));

    const { status, body } = await call('POST', `/api/tasks/${task.id}/cancel`);

    assert.equal(status, 200);
    assert.equal(body.task.status, 'cancelled');
    assert.equal(forge.taskQueue.get(task.id).status, 'cancelled');
    assert.deepEqual(failed.map((e) => [e.task.id, e.status]), [[task.id, 'cancelled']]);

    orchestrator._dispatchCoding();
    assert.deepEqual(started, []);
  });

  it('cancels a coding task paused on its budget so it never resumes', async (t) => {
    const { forge } = codingForge();
    const { call } = await serve(t, forge);
    const task = forge.taskQueue.add(coding);
    forge.taskQueue.updateStatus(task.id, 'paused_budget', { result: 'paused: task build budget $1.00 of $1.00 spent' });

    const { status, body } = await call('POST', `/api/tasks/${task.id}/cancel`);

    assert.equal(status, 200);
    assert.equal(body.task.status, 'cancelled');
  });

  it('aborts a running coding task with 202; it settles cancelled without publishing', async (t) => {
    const { forge, orchestrator, settled, runs } = codingForge();
    const { call } = await serve(t, forge);
    const task = forge.taskQueue.add(coding);
    orchestrator._dispatchCoding();
    assert.equal(forge.taskQueue.get(task.id).status, 'executing');

    const { status, body } = await call('POST', `/api/tasks/${task.id}/cancel`);

    assert.equal(status, 202);
    assert.equal(body.task.id, task.id);
    await Promise.all(runs);
    assert.deepEqual(settled, ['cancelled']);
    assert.equal(forge.taskQueue.get(task.id).status, 'cancelled');
    assert.equal(forge.taskQueue.get(task.id).pr_url, null);
  });

  it('returns 409 for a finished coding task and for a text task', async (t) => {
    const { forge } = codingForge();
    const { call } = await serve(t, forge);
    const done = forge.taskQueue.add(coding);
    forge.taskQueue.updateStatus(done.id, 'failed');
    const text = forge.taskQueue.add({ title: 'plain' });

    for (const id of [done.id, text.id]) {
      const { status, body } = await call('POST', `/api/tasks/${id}/cancel`);
      assert.equal(status, 409);
      assert.equal(body.ok, false);
    }
    assert.equal(forge.taskQueue.get(done.id).status, 'failed');
    assert.equal(forge.taskQueue.get(text.id).status, 'queued');
  });

  it('returns 409 for an executing coding task with no run to abort', async (t) => {
    const { forge } = codingForge();
    const { call } = await serve(t, forge);
    const task = forge.taskQueue.add(coding);
    forge.taskQueue.updateStatus(task.id, 'executing');

    const { status } = await call('POST', `/api/tasks/${task.id}/cancel`);
    assert.equal(status, 409);
    assert.equal(forge.taskQueue.get(task.id).status, 'executing');
  });
});

describe('POST /api/tasks/:id/approve and /reject', () => {
  const PR = 'https://github.com/o/r/pull/3';
  const coding = {
    kind: 'coding', title: 'Fix it', repo: 'o/r', base: 'master', instruction: 'Fix it', issue: 3, playbook: 'bug-fix', test_command: 'npm test',
  };

  async function parked(t, { mergeError = null } = {}) {
    const forge = makeForge();
    const merged = [];
    const host = {
      queue: forge.taskQueue,
      eventBus: forge.eventBus,
      publish: async () => PR,
      merge: async ({ url }) => {
        if (mergeError) throw new Error(mergeError);
        merged.push(url);
      },
    };
    forge.orchestrator = new Orchestrator({
      taskQueue: forge.taskQueue,
      router: { models: {}, resolve: () => ({ action: 'wait', reason: 'none' }) },
      quotaManager: forge.quotaManager,
      providerRegistry: null,
      config: {},
      coding: { concurrency: 1, run: () => {}, decide: (task, choice) => decideApproval(task, choice, host) },
    });
    const task = forge.taskQueue.add(coding);
    await runCodingTask(task, {
      ...host,
      execute: async () => ({
        outcome: 'stopped', commits: [{ sha: 'a'.repeat(40), subject: 'fix' }], uncommitted: false,
        observedTestRuns: [{ seq: 2, command: 'npm test', passed: true }], lastEditSeq: 1, dir: '/clone',
      }),
    });
    const { call } = await serve(t, forge);
    return { forge, call, task, merged };
  }

  afterEach(() => {
    for (const evt of ORCHESTRATOR_EVENTS) defaultEventBus.removeAllListeners(evt);
  });

  it('approves the pending merge: 200, merged, completed', async (t) => {
    const { forge, call, task, merged } = await parked(t);
    assert.equal(task.status, 'needs-approval');

    const { status, body } = await call('POST', `/api/tasks/${task.id}/approve`, { body: { reason: 'looks good' } });

    assert.equal(status, 200);
    assert.equal(body.status, 'completed');
    assert.equal(body.task.approval.decided_by, 'operator');
    assert.equal(body.task.approval.reason, 'looks good');
    assert.deepEqual(merged, [PR]);
    assert.equal(forge.taskQueue.get(task.id).status, 'completed');
  });

  it('rejects the pending merge: 200, pr-opened, not merged', async (t) => {
    const { call, task, merged } = await parked(t);
    const { status, body } = await call('POST', `/api/tasks/${task.id}/reject`, { body: { reason: 'wait for review' } });

    assert.equal(status, 200);
    assert.equal(body.status, 'pr-opened');
    assert.equal(body.task.result, 'merge rejected: wait for review');
    assert.deepEqual(merged, []);
  });

  it('answers 502 and keeps the task waiting when the approved merge fails', async (t) => {
    const { call, task } = await parked(t, { mergeError: 'checks pending' });
    const { status, body } = await call('POST', `/api/tasks/${task.id}/approve`);

    assert.equal(status, 502);
    assert.equal(body.error, 'merge: checks pending');
    assert.equal(body.task.status, 'needs-approval');
    assert.equal(body.task.approval.error, 'checks pending');
  });

  it('answers 409 once decided, 404 for an unknown task, 400 for a bad reason', async (t) => {
    const { call, task } = await parked(t);
    assert.equal((await call('POST', `/api/tasks/${task.id}/approve`, { body: { reason: 5 } })).status, 400);
    assert.equal((await call('POST', `/api/tasks/${task.id}/reject`)).status, 200);
    const again = await call('POST', `/api/tasks/${task.id}/approve`);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /no pending approval/);
    assert.equal((await call('POST', '/api/tasks/nope/approve')).status, 404);
  });

  it('answers 503 without a coding loop', async (t) => {
    const { forge, call } = await serve(t);
    const task = forge.taskQueue.add({ title: 'plain' });
    assert.equal((await call('POST', `/api/tasks/${task.id}/approve`)).status, 503);
  });
});

describe('GET /api/agents', () => {
  it('lists the configured agents without their prompts', async (t) => {
    const { call } = await serve(t);
    const { body } = await call('GET', '/api/agents');
    assert.equal(body.count, 1);
    assert.deepEqual(body.agents, [{ id: 'dev', name: 'Dev', role: 'Backend', model: 'claude-sonnet-5-5' }]);
  });
});

describe('GET /api/quotas', () => {
  it('reports usage per configured provider', async (t) => {
    const { forge, call } = await serve(t);
    forge.quotaManager.addProvider('anthropic', { max_requests_per_minute: 50 });
    forge.quotaManager.recordUsage('anthropic', 100);

    const { body } = await call('GET', '/api/quotas');

    assert.equal(body.quotas.anthropic.provider, 'anthropic');
    assert.equal(body.quotas.anthropic.requests.used, 1);
    assert.equal(body.quotas.anthropic.requests.max, 50);
  });
});

describe('GET /api/costs', () => {
  it('reports spend by agent, model and project budget from the cost tracker', async (t) => {
    const costTracker = new CostTracker({});
    costTracker.initProject('proj', 10);
    costTracker.recordCost({ projectId: 'proj', agentId: 'dev', model: 'claude-sonnet-5-5', cost: 0.5 });
    costTracker.recordCost({ projectId: 'proj', agentId: 'qa', model: 'codestral:22b', cost: 0.25 });
    const { call } = await serve(t, makeForge({ costTracker }));

    const { body } = await call('GET', '/api/costs');

    assert.equal(body.available, true);
    assert.equal(body.costs.totalCostUSD, 0.75);
    assert.deepEqual(body.costs.byAgent, { dev: 0.5, qa: 0.25 });
    assert.deepEqual(body.costs.byModel, { 'claude-sonnet-5-5': 0.5, 'codestral:22b': 0.25 });
    assert.equal(body.costs.budgets.proj.spent, 0.75);
    assert.equal(body.costs.budgets.proj.budget, 10);
  });

  it('counts spend with no agent in the total and splits it by phase and repo window (#244)', async (t) => {
    const costTracker = new CostTracker({});
    const budget = new Budget(parseBudget({ repo: { build: 5 } }).value, costTracker);
    costTracker.recordCost({ projectId: 'p', cost: 0.5, taskId: 't1', repo: 'acme/app' });
    costTracker.recordCost({ projectId: 'p', cost: 0.25, taskId: 't1', repo: 'acme/app', phase: 'verify' });
    const { call } = await serve(t, makeForge({ costTracker, orchestrator: { budget } }));

    const { body } = await call('GET', '/api/costs');

    assert.equal(body.costs.totalCostUSD, 0.75);
    assert.deepEqual(body.costs.byPhase, { build: 0.5, verify: 0.25 });
    assert.equal(body.costs.repos['acme/app'].window, 'day');
    assert.deepEqual(body.costs.repos['acme/app'].build, { spent: 0.5, limit: 5 });
    assert.deepEqual(body.costs.repos['acme/app'].verify, { spent: 0.25, limit: null });
    assert.deepEqual(body.costs.transactions.map((r) => [r.phase, r.cost]), [['build', 0.5], ['verify', 0.25]]);
  });

  it('reports costs unavailable without a cost tracker or db', async (t) => {
    const { call } = await serve(t, makeForge({ orchestrator: null }));
    const { body } = await call('GET', '/api/costs');
    assert.deepEqual(body, { ok: true, available: false, costs: null });
  });
});

describe('GET /api/tasks/:id/spend', () => {
  it("reports a task's build and verify spend with its limits", async (t) => {
    const costTracker = new CostTracker({});
    const budget = new Budget(parseBudget({ task: { build: 2, verify: 1 } }).value, costTracker);
    const forge = makeForge({ costTracker, orchestrator: { budget } });
    const task = forge.taskQueue.add({ kind: 'coding', title: 'x', repo: 'acme/app', base: 'master', instruction: 'go', playbook: 'feature' });
    costTracker.recordCost({ cost: 0.5, taskId: task.id, repo: 'acme/app' });
    const { call } = await serve(t, forge);

    const { status, body } = await call('GET', `/api/tasks/${task.id}/spend`);

    assert.equal(status, 200);
    assert.equal(body.spend.build.spent, 0.5);
    assert.partialDeepStrictEqual(body.spend.build.limits, [{ scope: 'task', limit: 2, remaining: 1.5 }]);
    assert.equal(body.spend.verify.spent, 0);
    assert.equal((await call('GET', '/api/tasks/nope/spend')).status, 404);
  });
});

describe('GET /api/events', () => {
  it('returns the most recent events, capped by ?limit', async (t) => {
    const { call } = await serve(t);

    const all = await call('GET', '/api/events');
    assert.equal(all.body.count, 3);

    const one = await call('GET', '/api/events?limit=1');
    assert.equal(one.body.count, 1);
    assert.deepEqual(one.body.events[0].data, { task: { id: 't2' } });
  });
});

describe('/api/control', () => {
  it('starts a stopped orchestrator and refuses to start it twice', async (t) => {
    const { forge, call } = await serve(t);

    const first = await call('POST', '/api/control/start');
    assert.equal(first.status, 200);
    assert.equal(forge.orchestrator._running, true);

    const second = await call('POST', '/api/control/start');
    assert.equal(second.status, 409);
  });

  it('stops a running orchestrator and refuses to stop it twice', async (t) => {
    const { forge, call } = await serve(t);
    forge.orchestrator._running = true;

    const first = await call('POST', '/api/control/stop');
    assert.equal(first.status, 200);
    assert.equal(forge.orchestrator._running, false);

    const second = await call('POST', '/api/control/stop');
    assert.equal(second.status, 409);
  });

  it('answers 503 when there is no orchestrator', async (t) => {
    const { call } = await serve(t, makeForge({ orchestrator: null }));
    assert.equal((await call('POST', '/api/control/start')).status, 503);
    assert.equal((await call('POST', '/api/control/stop')).status, 503);
  });
});

describe('CORS', () => {
  it('echoes a localhost origin', async (t) => {
    const { call } = await serve(t);
    const { headers } = await call('GET', '/api/status', { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  it('answers preflight with 204', async (t) => {
    const { call } = await serve(t);
    const { status } = await call('OPTIONS', '/api/tasks', {
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(status, 204);
  });

  it('sends no allow-origin header for other origins', async (t) => {
    const { call } = await serve(t);
    const { headers } = await call('GET', '/api/status', { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(headers.get('access-control-allow-origin'), null);
  });
});

describe('auth enabled outside NODE_ENV=test', () => {
  const SECRET = 'server-auth-test-secret';

  async function serveWithAuth(t) {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    t.after(() => {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    });
    return serve(t, makeForge({ config: { server: { auth: { enabled: true, secret: SECRET } } } }));
  }

  it('rejects requests without a token or with a wrong one', async (t) => {
    const { call } = await serveWithAuth(t);
    assert.equal((await call('GET', '/api/tasks')).status, 401);
    assert.equal((await call('GET', '/api/tasks', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  });

  it('accepts the correct bearer token', async (t) => {
    const { call } = await serveWithAuth(t);
    const { status } = await call('GET', '/api/tasks', { headers: { Authorization: `Bearer ${SECRET}` } });
    assert.equal(status, 200);
  });

  it('guards POST /api/tasks/:id/cancel like the other task mutations', async (t) => {
    const { forge, call } = await serveWithAuth(t);
    const task = forge.taskQueue.add({ title: 'x' });
    assert.equal((await call('POST', `/api/tasks/${task.id}/cancel`)).status, 401);
    const authed = await call('POST', `/api/tasks/${task.id}/cancel`, { headers: { Authorization: `Bearer ${SECRET}` } });
    assert.equal(authed.status, 409);
  });

  it('leaves GET /api/status open as a health check', async (t) => {
    const { call } = await serveWithAuth(t);
    assert.equal((await call('GET', '/api/status')).status, 200);
  });
});

describe('dashboard pages', () => {
  async function serveUi(t, uiDir) {
    const server = startServer(makeForge(), 0, '127.0.0.1', uiDir);
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
  }

  it('serves index.html for client-side routes when the build exists', async (t) => {
    const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ui-'));
    t.after(() => fs.rmSync(uiDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<div id="root"></div>');
    const base = await serveUi(t, uiDir);
    for (const page of ['/', '/kanban']) {
      const res = await fetch(base + page);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '<div id="root"></div>');
    }
  });

  it('answers 503 with the build command when the build is missing', async (t) => {
    const base = await serveUi(t, path.join(os.tmpdir(), 'af-ui-missing-' + process.pid));
    const res = await fetch(base + '/');
    assert.equal(res.status, 503);
    assert.match(await res.text(), /npm run ui:build/);
    assert.equal((await fetch(base + '/api/status')).status, 200);
  });
});
