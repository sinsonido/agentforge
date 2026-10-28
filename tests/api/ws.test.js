/**
 * Replay messages are sent on the server 'connection' event, before the client
 * sees 'open', so message listeners are attached before awaiting open.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { startWebSocketServer } from '../../src/api/ws.js';

function makeEventBus(recentEvents = []) {
  const emitter = new EventEmitter();
  emitter.getRecentEvents = (n) => recentEvents.slice(-n);
  return emitter;
}

async function startServer(t, { auth = {}, recentEvents = [] } = {}) {
  const eventBus = makeEventBus(recentEvents);
  const httpServer = http.createServer();
  const wss = startWebSocketServer(httpServer, eventBus, auth);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  });
  return { url: `ws://127.0.0.1:${httpServer.address().port}/ws`, eventBus };
}

function openSocket(t, url) {
  const ws = new WebSocket(url);
  t.after(() => ws.terminate());
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, opened };
}

function nextMessages(ws, n) {
  return new Promise((resolve) => {
    const msgs = [];
    const handler = (raw) => {
      msgs.push(JSON.parse(raw.toString()));
      if (msgs.length === n) {
        ws.off('message', handler);
        resolve(msgs);
      }
    };
    ws.on('message', handler);
  });
}

function closeCode(ws) {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

function withNodeEnv(t, value) {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  t.after(() => {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  });
}

describe('WebSocket /ws', () => {
  it('replays the last 20 recent events, oldest first, on connect', async (t) => {
    const recentEvents = Array.from({ length: 25 }, (_, i) => ({
      event: 'task.queued',
      data: { task: { id: `t${i}` } },
      timestamp: 1000 + i,
    }));
    const { url } = await startServer(t, { recentEvents });

    const { ws, opened } = openSocket(t, url);
    const replay = nextMessages(ws, 20);
    await opened;
    const msgs = await replay;

    assert.deepEqual(msgs[0], { event: 'task.queued', data: { task: { id: 't5' } }, timestamp: 1005 });
    assert.equal(msgs[19].data.task.id, 't24');
  });

  it('broadcasts bus events to every connected client with a timestamp', async (t) => {
    const { url, eventBus } = await startServer(t);
    const a = openSocket(t, url);
    const b = openSocket(t, url);
    const fromA = nextMessages(a.ws, 1);
    const fromB = nextMessages(b.ws, 1);
    await Promise.all([a.opened, b.opened]);

    const before = Date.now();
    eventBus.emit('task.queued', { task: { id: 'abc', title: 'Build' } });
    const [[msgA], [msgB]] = await Promise.all([fromA, fromB]);

    assert.equal(msgA.event, 'task.queued');
    assert.deepEqual(msgA.data, { task: { id: 'abc', title: 'Build' } });
    assert.ok(msgA.timestamp >= before && msgA.timestamp <= Date.now());
    assert.deepEqual(msgB.data, msgA.data);
  });

  it('forwards the events the dashboard consumes', async (t) => {
    const { url, eventBus } = await startServer(t);
    const { ws, opened } = openSocket(t, url);
    const sent = [
      ['task.executing', { task: { id: 't1' } }],
      ['task.completed', { task: { id: 't1' }, cost: 0.01 }],
      ['task.failed', { task: { id: 't2' }, error: 'boom' }],
      ['cost.recorded', { projectId: 'p', agentId: 'dev', model: 'm', tokensIn: 10, tokensOut: 20, cost: 0.01 }],
      ['quota.exhausted', { provider: 'anthropic' }],
      ['budget.warning', { projectId: 'p', spent_pct: 0.85 }],
      ['agent.paused', { agent: 'dev', reason: 'quota_exhausted' }],
      ['review.approved', { prNumber: 7 }],
    ];
    const received = nextMessages(ws, sent.length);
    await opened;

    for (const [event, data] of sent) eventBus.emit(event, data);

    assert.deepEqual((await received).map((m) => [m.event, m.data]), sent);
  });

  it('does not forward events outside its list', async (t) => {
    const { url, eventBus } = await startServer(t);
    const { ws, opened } = openSocket(t, url);
    const received = nextMessages(ws, 1);
    await opened;

    eventBus.emit('internal.debug', { secret: true });
    eventBus.emit('task.completed', { task: { id: 't1' } });

    const [msg] = await received;
    assert.equal(msg.event, 'task.completed');
  });

  it('keeps broadcasting to remaining clients after one disconnects', async (t) => {
    const { url, eventBus } = await startServer(t);
    const a = openSocket(t, url);
    const b = openSocket(t, url);
    await Promise.all([a.opened, b.opened]);
    const aClosed = closeCode(a.ws);
    a.ws.terminate();
    await aClosed;

    const fromB = nextMessages(b.ws, 1);
    eventBus.emit('task.failed', { task: { id: 't9' }, error: 'x' });
    const [msg] = await fromB;
    assert.equal(msg.data.task.id, 't9');
  });

  describe('with auth enabled outside NODE_ENV=test', () => {
    const auth = { enabled: true, secret: 'my-secret' };

    it('closes with 4401 when the token is missing', async (t) => {
      withNodeEnv(t, 'production');
      const { url } = await startServer(t, { auth });
      assert.equal(await closeCode(new WebSocket(url)), 4401);
    });

    it('closes with 4401 when the token is wrong', async (t) => {
      withNodeEnv(t, 'production');
      const { url } = await startServer(t, { auth });
      assert.equal(await closeCode(new WebSocket(`${url}?token=wrong`)), 4401);
    });

    it('accepts the correct token and streams events', async (t) => {
      withNodeEnv(t, 'production');
      const { url, eventBus } = await startServer(t, { auth });
      const { ws, opened } = openSocket(t, `${url}?token=my-secret`);
      const received = nextMessages(ws, 1);
      await opened;
      eventBus.emit('quota.reset', { provider: 'anthropic' });
      assert.equal((await received)[0].event, 'quota.reset');
    });
  });
});
