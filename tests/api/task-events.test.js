import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { TaskQueue } from '../../src/core/task-queue.js';
import { AgentForgeDB, TASK_EVENTS_PAGE } from '../../src/persistence/db.js';
import { startServer } from '../../src/api/server.js';

async function serve(t) {
  const dir = mkdtempSync(join(tmpdir(), 'af-events-api-'));
  const db = new AgentForgeDB(join(dir, 'data.db'));
  const eventBus = Object.assign(new EventEmitter(), { getRecentEvents: () => [], clearRecent: () => {} });
  const forge = { taskQueue: new TaskQueue({ store: db }), eventBus, db, agents: {}, config: {}, orchestrator: null };
  const server = startServer(forge, 0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { port } = server.address();
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  };
  return { forge, get, wsUrl: `ws://127.0.0.1:${port}/ws` };
}

const announce = (forge, taskId, event) => forge.eventBus.emit('task.agent_event', { taskId, ...forge.db.appendTaskEvent(taskId, event) });

describe('GET /api/tasks/:id/events', () => {
  it('replays the stored transcript after a seq', async (t) => {
    const { forge, get } = await serve(t);
    const task = forge.taskQueue.add({ title: 'run' });
    announce(forge, task.id, { type: 'text', text: 'looking' });
    announce(forge, task.id, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } });
    announce(forge, task.id, { type: 'result', subtype: 'success' });

    const all = await get(`/api/tasks/${task.id}/events`);
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.events.map((e) => [e.seq, e.event.type]), [[1, 'text'], [2, 'tool_use'], [3, 'result']]);
    assert.equal(all.body.more, false);

    const tail = await get(`/api/tasks/${task.id}/events?after=2`);
    assert.deepEqual(tail.body.events.map((e) => e.seq), [3]);
  });

  it('pages a long transcript', async (t) => {
    const { forge, get } = await serve(t);
    const task = forge.taskQueue.add({ title: 'long' });
    for (let i = 0; i <= TASK_EVENTS_PAGE; i++) forge.db.appendTaskEvent(task.id, { type: 'text', text: String(i) });

    const first = await get(`/api/tasks/${task.id}/events`);
    assert.equal(first.body.more, true);
    const next = await get(`/api/tasks/${task.id}/events?after=${first.body.events.at(-1).seq}`);
    assert.deepEqual(next.body, { ok: true, events: [next.body.events[0]], more: false });
    assert.equal(next.body.events[0].seq, TASK_EVENTS_PAGE + 1);
  });

  it('answers 404 for an unknown task and 400 for a bad cursor', async (t) => {
    const { forge, get } = await serve(t);
    const task = forge.taskQueue.add({ title: 'x' });
    assert.equal((await get('/api/tasks/nope/events')).status, 404);
    assert.equal((await get(`/api/tasks/${task.id}/events?after=-1`)).status, 400);
    assert.equal((await get(`/api/tasks/${task.id}/events?after=abc`)).status, 400);
  });

  it('serves a task and its transcript from the database once the queue has forgotten it', async (t) => {
    const { forge, get } = await serve(t);
    forge.db.saveTask({ id: 'old', kind: 'coding', title: 'done', status: 'pr-opened', repo: 'o/r', base: 'master',
      instruction: 'go', issue: 1, playbook: 'feature', pr_url: 'https://github.com/o/r/pull/9' });
    forge.db.appendTaskEvent('old', { type: 'result', subtype: 'success' });

    const task = await get('/api/tasks/old');
    assert.equal(task.status, 200);
    assert.equal(task.body.task.pr_url, 'https://github.com/o/r/pull/9');
    assert.deepEqual(task.body.task.depends_on, []);
    assert.deepEqual((await get('/api/tasks/old/events')).body.events.map((e) => e.seq), [1]);
  });
});

describe('WebSocket task.agent_event', () => {
  it('broadcasts each agent event with the seq a replay returns', async (t) => {
    const { forge, get, wsUrl } = await serve(t);
    const task = forge.taskQueue.add({ title: 'live' });
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise((resolve) => ws.once('close', resolve));
    const received = new Promise((resolve) => ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'task.agent_event') resolve(msg.data);
    }));

    announce(forge, task.id, { type: 'text', text: 'hi' });

    const data = await received;
    const [stored] = (await get(`/api/tasks/${task.id}/events`)).body.events;
    assert.deepEqual(data, { taskId: task.id, ...stored });
    ws.terminate();
    await closed;
  });
});
