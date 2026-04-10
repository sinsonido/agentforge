/**
 * @file tests/api/ws.test.js
 * @description Unit tests for src/api/ws.js — WebSocket server.
 *
 * Strategy: spin up a real http.Server + WebSocketServer on an OS-assigned
 * port (0), connect with the 'ws' client, and assert behaviour.
 *
 * Important: replay messages are sent immediately on the server 'connection'
 * event, which fires *before* the client 'open' event.  To avoid missing
 * these messages we register 'message' listeners before 'open' resolves.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { startWebSocketServer } from '../../src/api/ws.js';

// ---------------------------------------------------------------------------
// Minimal eventBus stub
// ---------------------------------------------------------------------------

function makeEventBus(recentEvents = []) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  emitter.getRecentEvents = () => recentEvents;
  return emitter;
}

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

async function startServer(authConfig = {}, recentEvents = []) {
  const eventBus = makeEventBus(recentEvents);
  const httpServer = http.createServer();
  const wss = startWebSocketServer(httpServer, eventBus, authConfig);

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  async function close() {
    // Terminate all open WS clients so httpServer.close() can resolve
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return { httpServer, wss, port, url: `ws://127.0.0.1:${port}/ws`, eventBus, close };
}

// ---------------------------------------------------------------------------
// WebSocket client helpers
// ---------------------------------------------------------------------------

/**
 * Open a WebSocket and return { ws, openPromise }.
 * Message listeners registered *before* awaiting openPromise will catch
 * messages sent during the connection handshake (replay).
 */
function openSocket(url, query = '') {
  const fullUrl = query ? `${url}?${query}` : url;
  const ws = new WebSocket(fullUrl);
  const openPromise = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, openPromise };
}

/** Collect exactly n messages from a socket, returning a promise. */
function collectMessages(ws, n) {
  if (n === 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    const msgs = [];
    const handler = (raw) => {
      msgs.push(JSON.parse(raw.toString()));
      if (msgs.length >= n) {
        ws.off('message', handler);
        resolve(msgs);
      }
    };
    ws.on('message', handler);
  });
}

/** Wait for a socket to close, resolving { code, reason }. */
function waitClose(ws) {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startWebSocketServer', () => {
  // ── Returns a WebSocketServer ────────────────────────────────────────────

  it('returns a WebSocketServer with a clients Set', async () => {
    const s = await startServer();
    assert.ok(s.wss, 'wss defined');
    assert.ok(s.wss.clients instanceof Set);
    await s.close();
  });

  // ── Basic connectivity ───────────────────────────────────────────────────

  it('accepts connections on the /ws path', async () => {
    const s = await startServer();
    const { ws, openPromise } = openSocket(s.url);
    await openPromise;
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
    await s.close();
  });

  // ── Replay ───────────────────────────────────────────────────────────────

  it('replays the last N recent events immediately on connect', async () => {
    const recent = [
      { event: 'task.queued', data: { id: '1' }, timestamp: 1000 },
      { event: 'task.completed', data: { id: '2' }, timestamp: 2000 },
    ];
    const s = await startServer({}, recent);

    // Register message listener BEFORE waiting for open
    const { ws, openPromise } = openSocket(s.url);
    const msgsPromise = collectMessages(ws, 2);
    await openPromise;

    const msgs = await msgsPromise;

    assert.equal(msgs[0].event, 'task.queued');
    assert.deepEqual(msgs[0].data, { id: '1' });
    assert.equal(msgs[1].event, 'task.completed');
    assert.deepEqual(msgs[1].data, { id: '2' });

    ws.terminate();
    await s.close();
  });

  it('sends no replay messages when recent events list is empty', async () => {
    const s = await startServer({}, []);
    const { ws, openPromise } = openSocket(s.url);
    // Collect up to 1 message within 100ms — should receive none
    let received = false;
    ws.once('message', () => { received = true; });
    await openPromise;
    await new Promise(r => setTimeout(r, 80));
    assert.equal(received, false, 'no messages expected');
    ws.terminate();
    await s.close();
  });

  // ── Event broadcast ──────────────────────────────────────────────────────

  it('broadcasts task.queued events to all connected clients', async () => {
    const s = await startServer();
    const { ws: ws1, openPromise: op1 } = openSocket(s.url);
    const { ws: ws2, openPromise: op2 } = openSocket(s.url);

    // Set up listeners before waiting for open
    const p1 = collectMessages(ws1, 1);
    const p2 = collectMessages(ws2, 1);
    await Promise.all([op1, op2]);

    s.eventBus.emit('task.queued', { id: 'abc' });

    const [[m1], [m2]] = await Promise.all([p1, p2]);
    assert.equal(m1.event, 'task.queued');
    assert.equal(m1.data.id, 'abc');
    assert.equal(m2.event, 'task.queued');

    ws1.terminate(); ws2.terminate();
    await s.close();
  });

  it('broadcasts task.completed events', async () => {
    const s = await startServer();
    const { ws, openPromise } = openSocket(s.url);
    const p = collectMessages(ws, 1);
    await openPromise;

    s.eventBus.emit('task.completed', { id: 'xyz', result: 'done' });
    const [msg] = await p;

    assert.equal(msg.event, 'task.completed');
    assert.equal(msg.data.id, 'xyz');

    ws.terminate();
    await s.close();
  });

  it('broadcasts task.failed events', async () => {
    const s = await startServer();
    const { ws, openPromise } = openSocket(s.url);
    const p = collectMessages(ws, 1);
    await openPromise;

    s.eventBus.emit('task.failed', { id: 'f1', error: 'boom' });
    const [msg] = await p;

    assert.equal(msg.event, 'task.failed');
    assert.equal(msg.data.error, 'boom');

    ws.terminate();
    await s.close();
  });

  it('broadcasts cost.recorded events', async () => {
    const s = await startServer();
    const { ws, openPromise } = openSocket(s.url);
    const p = collectMessages(ws, 1);
    await openPromise;

    s.eventBus.emit('cost.recorded', { cost: 0.05 });
    const [msg] = await p;

    assert.equal(msg.event, 'cost.recorded');
    assert.equal(msg.data.cost, 0.05);

    ws.terminate();
    await s.close();
  });

  it('broadcasts quota.exhausted events', async () => {
    const s = await startServer();
    const { ws, openPromise } = openSocket(s.url);
    const p = collectMessages(ws, 1);
    await openPromise;

    s.eventBus.emit('quota.exhausted', { provider: 'anthropic' });
    const [msg] = await p;

    assert.equal(msg.event, 'quota.exhausted');
    assert.equal(msg.data.provider, 'anthropic');

    ws.terminate();
    await s.close();
  });

  it('includes a numeric timestamp in every broadcast message', async () => {
    const s = await startServer();
    const { ws, openPromise } = openSocket(s.url);
    const p = collectMessages(ws, 1);
    await openPromise;

    const before = Date.now();
    s.eventBus.emit('budget.warning', { projectId: 'p1' });
    const [msg] = await p;
    const after = Date.now();

    assert.equal(typeof msg.timestamp, 'number');
    assert.ok(msg.timestamp >= before && msg.timestamp <= after, 'timestamp should be recent');

    ws.terminate();
    await s.close();
  });

  // ── Auth disabled ────────────────────────────────────────────────────────

  it('allows connections without token when auth is disabled', async () => {
    const s = await startServer({ enabled: false });
    const { ws, openPromise } = openSocket(s.url);
    await openPromise;
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.terminate();
    await s.close();
  });

  // ── Auth enabled (NODE_ENV=production) ───────────────────────────────────

  it('rejects connections with code 4401 when token is missing (auth enabled)', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const s = await startServer({ enabled: true, secret: 'my-secret' });
    try {
      const ws = new WebSocket(s.url);
      const { code } = await waitClose(ws);
      assert.equal(code, 4401);
    } finally {
      process.env.NODE_ENV = saved;
      await s.close();
    }
  });

  it('rejects connections with code 4401 when wrong token is supplied (auth enabled)', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const s = await startServer({ enabled: true, secret: 'my-secret' });
    try {
      const ws = new WebSocket(`${s.url}?token=wrong`);
      const { code } = await waitClose(ws);
      assert.equal(code, 4401);
    } finally {
      process.env.NODE_ENV = saved;
      await s.close();
    }
  });

  it('allows connection when correct token is supplied (auth enabled)', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const s = await startServer({ enabled: true, secret: 'my-secret' });
    try {
      const { ws, openPromise } = openSocket(s.url, 'token=my-secret');
      await openPromise;
      assert.equal(ws.readyState, WebSocket.OPEN);
      ws.terminate();
    } finally {
      process.env.NODE_ENV = saved;
      await s.close();
    }
  });

  // ── Connection tracking ──────────────────────────────────────────────────

  it('tracks connected clients in wss.clients', async () => {
    const s = await startServer();
    const { ws: ws1, openPromise: op1 } = openSocket(s.url);
    const { ws: ws2, openPromise: op2 } = openSocket(s.url);
    await Promise.all([op1, op2]);

    assert.equal(s.wss.clients.size, 2);

    ws1.terminate(); ws2.terminate();
    await s.close();
  });

  it('removes disconnected clients from wss.clients', async () => {
    const s = await startServer();
    const { ws, openPromise } = openSocket(s.url);
    await openPromise;

    assert.equal(s.wss.clients.size, 1);
    ws.terminate();

    // Wait briefly for the server to process the close
    await new Promise(r => setTimeout(r, 50));
    assert.equal(s.wss.clients.size, 0);

    await s.close();
  });
});
