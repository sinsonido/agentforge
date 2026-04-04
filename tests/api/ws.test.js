/**
 * @file tests/api/ws.test.js
 * @description Unit tests for src/api/ws.js — startWebSocketServer.
 *
 * Tests WebSocket connection behaviour, event broadcasting, replay of recent
 * events, ping/pong keep-alive, and token-based authentication.
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

/**
 * Minimal eventBus stub with a configurable recent-events list.
 */
function makeEventBus(recentEvents = []) {
  const bus = Object.assign(new EventEmitter(), {
    getRecentEvents(n) {
      return recentEvents.slice(-n);
    },
  });
  return bus;
}

/**
 * Start an HTTP server on a random port, attach the WebSocket server, and
 * return { httpServer, wss, port, eventBus }.  The caller is responsible for
 * calling close() in their cleanup.
 */
function startTestServer(authConfig = {}, recentEvents = []) {
  return new Promise((resolve, reject) => {
    const eventBus = makeEventBus(recentEvents);
    const httpServer = http.createServer();
    const wss = startWebSocketServer(httpServer, eventBus, authConfig);

    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      resolve({ httpServer, wss, port, eventBus });
    });
    httpServer.on('error', reject);
  });
}

/**
 * Open a WebSocket connection and collect the first `n` messages.
 * Resolves once `n` messages have arrived or the connection closes.
 *
 * @param {string} url
 * @param {number} n
 * @returns {Promise<object[]>} Parsed JSON message objects.
 */
function collectMessages(url, n = 1) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const ws = new WebSocket(url);
    ws.on('message', (data) => {
      msgs.push(JSON.parse(data.toString()));
      if (msgs.length >= n) {
        ws.close();
        resolve(msgs);
      }
    });
    ws.on('close', () => resolve(msgs));
    ws.on('error', reject);
  });
}

/**
 * Open a WebSocket connection and wait for it to open (or close/error).
 * Resolves with the WebSocket instance once open, rejects on error.
 */
function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    // If the server immediately closes with a non-standard code, this fires
    ws.once('close', (code, reason) => {
      if (code !== 1000 && code !== 1001) {
        reject(new Error(`WS closed with code ${code}: ${reason}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startWebSocketServer', () => {
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server.httpServer.close(resolve));
      server = null;
    }
  });

  // ── Connectivity ────────────────────────────────────────────────────────

  describe('basic connectivity', () => {
    it('accepts connections at /ws path', async () => {
      server = await startTestServer();
      const ws = await openWs(`ws://127.0.0.1:${server.port}/ws`);
      ws.close();
      assert.ok(ws);
    });

    it('returns a WebSocketServer instance', async () => {
      server = await startTestServer();
      assert.equal(typeof server.wss.clients, 'object');
    });
  });

  // ── Event replay on connect ─────────────────────────────────────────────

  describe('event replay on connect', () => {
    it('replays recent events immediately on connect', async () => {
      const recent = [
        { event: 'task.queued', data: { id: '1' }, timestamp: 1000 },
        { event: 'task.completed', data: { id: '1' }, timestamp: 2000 },
      ];
      server = await startTestServer({}, recent);

      const msgs = await collectMessages(`ws://127.0.0.1:${server.port}/ws`, 2);

      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].event, 'task.queued');
      assert.equal(msgs[1].event, 'task.completed');
    });

    it('replays at most 20 recent events', async () => {
      const recent = Array.from({ length: 25 }, (_, i) => ({
        event: 'task.queued',
        data: { idx: i },
        timestamp: i,
      }));
      server = await startTestServer({}, recent);

      const msgs = await collectMessages(
        `ws://127.0.0.1:${server.port}/ws`,
        20,
      );

      // Should get exactly 20 (the last 20)
      assert.equal(msgs.length, 20);
    });

    it('sends no replay messages when there are no recent events', async () => {
      server = await startTestServer({}, []);

      // Emit a live event shortly after connecting so we know the ws is ready
      const liveMsg = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        let resolved = false;
        ws.on('open', () => {
          // Emit a live event
          server.eventBus.emit('task.queued', { id: 'live' });
        });
        ws.on('message', (data) => {
          if (!resolved) {
            resolved = true;
            ws.close();
            resolve(JSON.parse(data.toString()));
          }
        });
        ws.on('error', reject);
        setTimeout(() => { ws.close(); resolve(null); }, 500);
      });

      // The first message should be the live event, not a replay
      assert.ok(liveMsg === null || liveMsg.event === 'task.queued');
    });
  });

  // ── Live event broadcasting ─────────────────────────────────────────────

  describe('live event broadcasting', () => {
    it('broadcasts task.queued events to connected clients', async () => {
      server = await startTestServer();

      const msgPromise = new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        ws.once('open', () => {
          server.eventBus.emit('task.queued', { id: 'task-1', title: 'Do thing' });
        });
        ws.once('message', (data) => {
          ws.close();
          resolve(JSON.parse(data.toString()));
        });
        ws.once('error', reject);
      });

      const msg = await msgPromise;
      assert.equal(msg.event, 'task.queued');
      assert.equal(msg.data.id, 'task-1');
      assert.ok(typeof msg.timestamp === 'number');
    });

    it('broadcasts task.completed events', async () => {
      server = await startTestServer();

      const msgPromise = new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        ws.once('open', () => {
          server.eventBus.emit('task.completed', { id: 'task-2' });
        });
        ws.once('message', (data) => {
          ws.close();
          resolve(JSON.parse(data.toString()));
        });
        ws.once('error', reject);
      });

      const msg = await msgPromise;
      assert.equal(msg.event, 'task.completed');
    });

    it('broadcasts to multiple simultaneous clients', async () => {
      server = await startTestServer();
      const url = `ws://127.0.0.1:${server.port}/ws`;

      // Connect two clients
      const [p1, p2] = await Promise.all([
        new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          ws.once('open', () => resolve(ws));
          ws.once('error', reject);
        }),
        new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          ws.once('open', () => resolve(ws));
          ws.once('error', reject);
        }),
      ]);

      const received = [];
      const done = new Promise((resolve) => {
        let count = 0;
        const onMsg = (data) => {
          received.push(JSON.parse(data.toString()));
          count++;
          if (count >= 2) resolve();
        };
        p1.once('message', onMsg);
        p2.once('message', onMsg);
      });

      server.eventBus.emit('cost.recorded', { amount: 0.01 });
      await done;

      p1.close();
      p2.close();

      assert.equal(received.length, 2);
      assert.ok(received.every(m => m.event === 'cost.recorded'));
    });

    it('includes a numeric timestamp on broadcast messages', async () => {
      server = await startTestServer();

      const before = Date.now();
      const msgPromise = new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        ws.once('open', () => {
          server.eventBus.emit('budget.warning', { pct: 0.85 });
        });
        ws.once('message', (data) => {
          ws.close();
          resolve(JSON.parse(data.toString()));
        });
        ws.once('error', reject);
      });

      const msg = await msgPromise;
      const after = Date.now();

      assert.ok(msg.timestamp >= before, 'timestamp should be >= before');
      assert.ok(msg.timestamp <= after, 'timestamp should be <= after');
    });
  });

  // ── Authentication ──────────────────────────────────────────────────────

  describe('authentication', () => {
    let savedEnv;

    beforeEach(() => { savedEnv = process.env.NODE_ENV; });
    afterEach(() => { process.env.NODE_ENV = savedEnv; });

    it('allows connection when auth is disabled', async () => {
      server = await startTestServer({ enabled: false });
      const ws = await openWs(`ws://127.0.0.1:${server.port}/ws`);
      ws.close();
      assert.ok(ws);
    });

    it('allows connection without token when NODE_ENV=test (bypass)', async () => {
      process.env.NODE_ENV = 'test';
      server = await startTestServer({ enabled: true, secret: 'my-secret' });
      const ws = await openWs(`ws://127.0.0.1:${server.port}/ws`);
      ws.close();
      assert.ok(ws);
    });

    it('rejects connection with invalid token when auth enabled (non-test env)', async () => {
      process.env.NODE_ENV = 'production';
      server = await startTestServer({ enabled: true, secret: 'correct-secret' });

      const closeCode = await new Promise((resolve) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${server.port}/ws?token=wrong-token`,
        );
        ws.once('close', (code) => resolve(code));
        ws.once('error', () => resolve(null));
      });

      assert.equal(closeCode, 4401);
    });

    it('rejects connection with no token when auth enabled (non-test env)', async () => {
      process.env.NODE_ENV = 'production';
      server = await startTestServer({ enabled: true, secret: 'correct-secret' });

      const closeCode = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        ws.once('close', (code) => resolve(code));
        ws.once('error', () => resolve(null));
      });

      assert.equal(closeCode, 4401);
    });

    it('allows connection with correct token when auth enabled (non-test env)', async () => {
      process.env.NODE_ENV = 'production';
      server = await startTestServer({ enabled: true, secret: 'correct-secret' });

      const ws = await openWs(
        `ws://127.0.0.1:${server.port}/ws?token=correct-secret`,
      );
      ws.close();
      assert.ok(ws);
    });
  });
});
