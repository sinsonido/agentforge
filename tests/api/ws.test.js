/**
 * @file tests/api/ws.test.js
 * @description Unit tests for src/api/ws.js WebSocket server.
 *
 * Covers: client connection, event replay on connect, auth token validation,
 * event broadcasting, and connection cleanup.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { startWebSocketServer } from '../../src/api/ws.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal eventBus stub with a fixed replay history.
 * Uses slice(-n) to mirror the real AgentForgeEventBus implementation,
 * which returns the LAST n entries.
 */
function makeEventBus(recentEvents = []) {
  const bus = new EventEmitter();
  bus.getRecentEvents = (n) => recentEvents.slice(-n);
  bus.clearRecent = () => {};
  return bus;
}

/**
 * Start a bare HTTP server, attach the WS server, and return both.
 * The HTTP server listens on port 0 (OS-assigned).
 */
async function makeServer(eventBus, authConfig = {}) {
  const httpServer = http.createServer();
  const wss = startWebSocketServer(httpServer, eventBus, authConfig);
  await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
  return { httpServer, wss };
}

/**
 * Open a WebSocket connection to the test server.
 * Resolves once the 'open' event fires.
 */
function connect(httpServer, query = '') {
  const { port } = httpServer.address();
  const url = `ws://127.0.0.1:${port}/ws${query}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/**
 * Collect the next `n` messages from a WebSocket into an array.
 */
function collectMessages(ws, n) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    ws.on('message', (raw) => {
      msgs.push(JSON.parse(raw.toString()));
      if (msgs.length >= n) resolve(msgs);
    });
    ws.once('error', reject);
    ws.once('close', () => resolve(msgs));
  });
}

/**
 * Wait for a WebSocket to close, with a timeout and error handler so the
 * test fails fast instead of hanging if the close never arrives.
 */
function waitForClose(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('close', onClose);
      ws.off('error', onError);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for WebSocket close`));
    }, timeoutMs);
    const onClose = (code) => {
      clearTimeout(timer);
      ws.off('error', onError);
      resolve(code);
    };
    const onError = (err) => {
      clearTimeout(timer);
      ws.off('close', onClose);
      reject(err);
    };
    ws.once('close', onClose);
    ws.once('error', onError);
  });
}

// ---------------------------------------------------------------------------
// Tests: connection and event replay
// ---------------------------------------------------------------------------

describe('WebSocket server — basic connection', () => {
  let httpServer, wss, eventBus;

  before(async () => {
    eventBus = makeEventBus();
    ({ httpServer, wss } = await makeServer(eventBus));
  });

  after(async () => {
    await new Promise(r => wss.close(r));
    await new Promise(r => httpServer.close(r));
  });

  it('accepts a WebSocket connection at /ws', async () => {
    const ws = await connect(httpServer);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  it('server tracks connected clients', async () => {
    // Wait for the server-side 'connection' event before checking clients
    const serverConnected = new Promise(r => wss.once('connection', r));
    const ws = await connect(httpServer);
    await serverConnected;
    assert.ok(wss.clients.size >= 1);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Tests: event replay on connect
// ---------------------------------------------------------------------------

describe('WebSocket server — event replay on connect', () => {
  let httpServer, wss, eventBus;
  const REPLAY_EVENTS = [
    { event: 'task.queued',    data: { id: 't1' }, timestamp: 1000 },
    { event: 'task.completed', data: { id: 't1' }, timestamp: 2000 },
  ];

  before(async () => {
    eventBus = makeEventBus(REPLAY_EVENTS);
    ({ httpServer, wss } = await makeServer(eventBus));
  });

  after(async () => {
    await new Promise(r => wss.close(r));
    await new Promise(r => httpServer.close(r));
  });

  it('replays the last N events immediately on connect', async () => {
    const ws = await connect(httpServer);
    const msgs = await collectMessages(ws, REPLAY_EVENTS.length);
    ws.close();

    assert.equal(msgs.length, REPLAY_EVENTS.length);
    assert.equal(msgs[0].event, 'task.queued');
    assert.equal(msgs[1].event, 'task.completed');
  });

  it('replayed messages include event, data, and timestamp fields', async () => {
    const ws = await connect(httpServer);
    const [first] = await collectMessages(ws, 1);
    ws.close();

    assert.ok('event' in first);
    assert.ok('data' in first);
    assert.ok('timestamp' in first);
  });
});

// ---------------------------------------------------------------------------
// Tests: event broadcasting
// ---------------------------------------------------------------------------

describe('WebSocket server — event broadcasting', () => {
  let httpServer, wss, eventBus;

  before(async () => {
    eventBus = makeEventBus();
    ({ httpServer, wss } = await makeServer(eventBus));
  });

  after(async () => {
    await new Promise(r => wss.close(r));
    await new Promise(r => httpServer.close(r));
  });

  it('broadcasts task.queued to connected clients', async () => {
    const ws = await connect(httpServer);
    const incoming = new Promise(resolve => {
      ws.once('message', raw => resolve(JSON.parse(raw.toString())));
    });

    eventBus.emit('task.queued', { id: 'broadcast-test' });
    const msg = await incoming;
    ws.close();

    assert.equal(msg.event, 'task.queued');
    assert.equal(msg.data.id, 'broadcast-test');
    assert.ok(typeof msg.timestamp === 'number');
  });

  it('broadcasts cost.recorded to all connected clients', async () => {
    const ws1 = await connect(httpServer);
    const ws2 = await connect(httpServer);

    const p1 = new Promise(r => ws1.once('message', raw => r(JSON.parse(raw.toString()))));
    const p2 = new Promise(r => ws2.once('message', raw => r(JSON.parse(raw.toString()))));

    eventBus.emit('cost.recorded', { cost: 0.01 });
    const [m1, m2] = await Promise.all([p1, p2]);
    ws1.close();
    ws2.close();

    assert.equal(m1.event, 'cost.recorded');
    assert.equal(m2.event, 'cost.recorded');
  });
});

// ---------------------------------------------------------------------------
// Tests: auth (enabled)
// ---------------------------------------------------------------------------

describe('WebSocket server — token auth (auth enabled, non-test env)', () => {
  let httpServer, wss, eventBus;
  const SECRET = 'ws-test-secret';
  let savedNodeEnv;

  before(async () => {
    savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // disable test-bypass
    eventBus = makeEventBus();
    ({ httpServer, wss } = await makeServer(eventBus, { enabled: true, secret: SECRET }));
  });

  after(async () => {
    process.env.NODE_ENV = savedNodeEnv;
    await new Promise(r => wss.close(r));
    await new Promise(r => httpServer.close(r));
  });

  it('accepts connection with correct token', async () => {
    const ws = await connect(httpServer, `?token=${SECRET}`);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  it('closes connection with code 4401 when token is wrong', async () => {
    const { port } = httpServer.address();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`);
    const code = await waitForClose(ws);
    assert.equal(code, 4401);
  });

  it('closes connection with code 4401 when token is missing', async () => {
    const { port } = httpServer.address();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const code = await waitForClose(ws);
    assert.equal(code, 4401);
  });
});
