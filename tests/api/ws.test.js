/**
 * @file tests/api/ws.test.js
 * @description Unit tests for src/api/ws.js — WebSocket server.
 *
 * Covers:
 *  - Event broadcast to connected clients
 *  - Event replay of last N events on connect
 *  - Auth token validation (enabled vs disabled, NODE_ENV=test bypass)
 *  - wss.clients tracking (connect / disconnect)
 *  - All 18 listed event types are forwarded
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { startWebSocketServer } from '../../src/api/ws.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal eventBus stub with a controllable replay log. */
function makeEventBus(recentEvents = []) {
  const bus = new EventEmitter();
  bus.getRecentEvents = (n) => recentEvents.slice(-n);
  return bus;
}

/**
 * Create an HTTP server, attach a WS server, and start listening.
 */
async function makeServer(recentEvents = [], authConfig = {}) {
  const eventBus = makeEventBus(recentEvents);
  const httpServer = http.createServer();
  const wss = startWebSocketServer(httpServer, eventBus, authConfig);

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

  const { port } = httpServer.address();
  const url = `ws://127.0.0.1:${port}/ws`;

  const close = () => new Promise((resolve) => httpServer.close(resolve));

  return { httpServer, wss, eventBus, url, close };
}

/**
 * Connect a WebSocket and return a promise that resolves with:
 *  { ws, messages }
 * where messages[] accumulates every parsed JSON message received.
 *
 * The listener is registered *before* the 'open' event so that
 * replay messages sent immediately on connect are not missed.
 */
function connectWithMessages(url, token) {
  const wsUrl = token ? `${url}?token=${token}` : url;
  const ws = new WebSocket(wsUrl);
  const messages = [];

  ws.on('message', (raw) => messages.push(JSON.parse(raw)));

  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

/** Wait until messages.length >= n or timeout ms elapses. */
function waitForMessages(messages, n, timeout = 500) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (messages.length >= n) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(messages.slice(0, n));
      }
    }, 10);
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for ${n} messages; got ${messages.length}`));
    }, timeout);
  });
}

/** Wait for the WebSocket close event. */
function waitClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({});
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

// ---------------------------------------------------------------------------
// Tests — event broadcast
// ---------------------------------------------------------------------------

describe('startWebSocketServer — event broadcast', () => {
  let ctx;

  before(async () => { ctx = await makeServer(); });
  after(async () => { await ctx.close(); });

  it('broadcasts an event to a connected client', async () => {
    const { ws, messages } = await connectWithMessages(ctx.url);

    ctx.eventBus.emit('task.queued', { id: 'abc', title: 'Test' });

    const [msg] = await waitForMessages(messages, 1);
    assert.equal(msg.event, 'task.queued');
    assert.deepEqual(msg.data, { id: 'abc', title: 'Test' });
    assert.ok(typeof msg.timestamp === 'number');

    ws.close();
    await waitClose(ws);
  });

  it('broadcasts to multiple connected clients', async () => {
    const c1 = await connectWithMessages(ctx.url);
    const c2 = await connectWithMessages(ctx.url);

    ctx.eventBus.emit('task.completed', { id: 'xyz' });

    const [[m1], [m2]] = await Promise.all([
      waitForMessages(c1.messages, 1),
      waitForMessages(c2.messages, 1),
    ]);

    assert.equal(m1.event, 'task.completed');
    assert.equal(m2.event, 'task.completed');

    c1.ws.close();
    c2.ws.close();
    await Promise.all([waitClose(c1.ws), waitClose(c2.ws)]);
  });

  it('does not broadcast events not in the EVENTS list', async () => {
    const { ws, messages } = await connectWithMessages(ctx.url);

    ctx.eventBus.emit('not.in.events.list', { x: 1 });

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(messages.length, 0);

    ws.close();
    await waitClose(ws);
  });

  it('message payload includes event, data, and numeric timestamp', async () => {
    const { ws, messages } = await connectWithMessages(ctx.url);

    const payload = { taskId: 't1', cost: 0.002 };
    ctx.eventBus.emit('cost.recorded', payload);

    const [msg] = await waitForMessages(messages, 1);
    assert.ok('event' in msg, 'has event field');
    assert.ok('data' in msg, 'has data field');
    assert.ok('timestamp' in msg && typeof msg.timestamp === 'number', 'has numeric timestamp');
    assert.deepEqual(msg.data, payload);

    ws.close();
    await waitClose(ws);
  });
});

// ---------------------------------------------------------------------------
// Tests — event replay on connect
// ---------------------------------------------------------------------------

describe('startWebSocketServer — event replay on connect', () => {
  it('replays stored events immediately on connect', async () => {
    const stored = Array.from({ length: 3 }, (_, i) => ({
      event: 'task.queued',
      data: { id: `t${i}` },
      timestamp: Date.now() - (3 - i) * 1000,
    }));

    const ctx = await makeServer(stored);
    try {
      const { ws, messages } = await connectWithMessages(ctx.url);
      const replayed = await waitForMessages(messages, stored.length);

      assert.equal(replayed.length, stored.length);
      for (let i = 0; i < stored.length; i++) {
        assert.equal(replayed[i].event, stored[i].event);
        assert.deepEqual(replayed[i].data, stored[i].data);
      }

      ws.close();
      await waitClose(ws);
    } finally {
      await ctx.close();
    }
  });

  it('sends no replay messages when there are no recent events', async () => {
    const ctx = await makeServer([]);
    try {
      const { ws, messages } = await connectWithMessages(ctx.url);

      await new Promise((r) => setTimeout(r, 80));
      assert.equal(messages.length, 0);

      ws.close();
      await waitClose(ws);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — auth disabled
// ---------------------------------------------------------------------------

describe('startWebSocketServer — auth disabled', () => {
  it('accepts connections without a token when enabled=false', async () => {
    const ctx = await makeServer([], { enabled: false, secret: 'secret' });
    try {
      const { ws } = await connectWithMessages(ctx.url);
      assert.equal(ws.readyState, WebSocket.OPEN);
      ws.close();
      await waitClose(ws);
    } finally {
      await ctx.close();
    }
  });

  it('accepts connections when authConfig is empty object', async () => {
    const ctx = await makeServer([], {});
    try {
      const { ws } = await connectWithMessages(ctx.url);
      assert.equal(ws.readyState, WebSocket.OPEN);
      ws.close();
      await waitClose(ws);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — auth enabled, NODE_ENV=test bypass
// ---------------------------------------------------------------------------

describe('startWebSocketServer — auth (NODE_ENV=test bypass)', () => {
  let savedEnv;
  beforeEach(() => { savedEnv = process.env.NODE_ENV; });
  afterEach(() => { process.env.NODE_ENV = savedEnv; });

  it('allows connections without token in NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    const ctx = await makeServer([], { enabled: true, secret: 'supersecret' });
    try {
      const { ws } = await connectWithMessages(ctx.url);
      assert.equal(ws.readyState, WebSocket.OPEN);
      ws.close();
      await waitClose(ws);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — wss.clients tracking
// ---------------------------------------------------------------------------

describe('startWebSocketServer — clients set', () => {
  it('returns a WebSocketServer with a clients Set', async () => {
    const ctx = await makeServer();
    try {
      assert.ok(ctx.wss.clients instanceof Set);
    } finally {
      await ctx.close();
    }
  });

  it('clients grows on connect and shrinks on disconnect', async () => {
    const ctx = await makeServer();
    try {
      assert.equal(ctx.wss.clients.size, 0);

      const { ws } = await connectWithMessages(ctx.url);
      assert.equal(ctx.wss.clients.size, 1);

      ws.close();
      await waitClose(ws);
      // Allow the server-side close event to fire
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(ctx.wss.clients.size, 0);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — all listed event types are forwarded
// ---------------------------------------------------------------------------

describe('startWebSocketServer — all 18 event types broadcast', () => {
  const EVENTS = [
    'task.queued', 'task.assigned', 'task.executing',
    'task.completed', 'task.failed',
    'quota.throttled', 'quota.exhausted', 'quota.reset',
    'agent.paused', 'agent.resumed',
    'budget.warning', 'budget.exceeded',
    'git.committed', 'git.pr_created',
    'cost.recorded',
    'review.pending', 'review.approved', 'review.rejected',
  ];

  it('broadcasts every event in the EVENTS list', async () => {
    const ctx = await makeServer();
    try {
      const { ws, messages } = await connectWithMessages(ctx.url);

      for (const evt of EVENTS) {
        ctx.eventBus.emit(evt, { evt });
      }

      const received = await waitForMessages(messages, EVENTS.length);
      const receivedNames = received.map((m) => m.event);

      for (const evt of EVENTS) {
        assert.ok(receivedNames.includes(evt), `Expected event ${evt}`);
      }

      ws.close();
      await waitClose(ws);
    } finally {
      await ctx.close();
    }
  });
});
