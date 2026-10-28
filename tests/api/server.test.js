/**
 * REST endpoints of src/api/server.js not covered by tests/api.test.js
 * (which owns POST /api/tasks/:id/status, POST /api/agents/:id and
 * POST /api/providers/test).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';
import { CostTracker } from '../../src/core/cost-tracker.js';
import { startServer } from '../../src/api/server.js';

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
    agentPool: {
      getAllStatuses: () => ({ dev: { agentId: 'dev', status: 'idle', model: 'claude-sonnet-5-5' } }),
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
    assert.equal(body.agents.dev.status, 'idle');
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

describe('GET /api/agents', () => {
  it('lists agent statuses from the pool', async (t) => {
    const { call } = await serve(t);
    const { body } = await call('GET', '/api/agents');
    assert.equal(body.count, 1);
    assert.deepEqual(body.agents, [{ agentId: 'dev', status: 'idle', model: 'claude-sonnet-5-5' }]);
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
    costTracker.recordCost('proj', 'dev', 'claude-sonnet-5-5', 0.5);
    costTracker.recordCost('proj', 'qa', 'codestral:22b', 0.25);
    const { call } = await serve(t, makeForge({ costTracker }));

    const { body } = await call('GET', '/api/costs');

    assert.equal(body.available, true);
    assert.equal(body.costs.totalCostUSD, 0.75);
    assert.deepEqual(body.costs.byAgent, { dev: 0.5, qa: 0.25 });
    assert.deepEqual(body.costs.byModel, { 'claude-sonnet-5-5': 0.5, 'codestral:22b': 0.25 });
    assert.equal(body.costs.budgets.proj.spent, 0.75);
    assert.equal(body.costs.budgets.proj.budget, 10);
  });

  it('reports costs unavailable without a cost tracker or db', async (t) => {
    const { call } = await serve(t, makeForge({ orchestrator: null }));
    const { body } = await call('GET', '/api/costs');
    assert.deepEqual(body, { ok: true, available: false, costs: null });
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

  it('leaves GET /api/status open as a health check', async (t) => {
    const { call } = await serveWithAuth(t);
    assert.equal((await call('GET', '/api/status')).status, 200);
  });
});
