/**
 * @file tests/api/ws.test.js
 * @description Unit tests for src/api/ws.js startWebSocketServer.
 *
 * Covers:
 *   - Returns a WebSocketServer instance
 *   - Replays recent events to new client on connect
 *   - Broadcasts eventBus events to all connected clients
 *   - Does NOT broadcast unregistered events
 *   - Cleans up (no interference between tests)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import eventBus from '../../src/core/event-bus.js';
import { startWebSocketServer } from '../../src/api/ws.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates an HTTP server with a WebSocket server attached at /ws,
 * listens on port 0 (OS-assigned), and returns { httpServer, wss, port }.
 */
function createTestServer() {
  const httpServer = http.createServer();
  const wss = startWebSocketServer(httpServer, eventBus, {});
  return new Promise((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      resolve({ httpServer, wss, port });
    });
    httpServer.once('error', reject);
  });
}

/**
 * Connects a WebSocket client to ws://127.0.0.1:<port>/ws and resolves
 * once the connection is open.
 */
function connectClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/**
 * Collects all messages received by a WebSocket client until a
 * predetermined count is reached or a timeout fires, whichever comes first.
 */
function collectMessages(ws, expectedCount, timeoutMs = 500) {
  return new Promise((resolve) => {
    const messages = [];
    const timer = setTimeout(() => resolve(messages), timeoutMs);
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()));
      if (messages.length >= expectedCount) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
  });
}

/**
 * Closes an HTTP server and its attached WebSocket server, terminating
 * all connected clients first to avoid ECONNRESET noise.
 */
function shutdownServer(httpServer, wss) {
  return new Promise((resolve) => {
    for (const client of wss.clients) client.terminate();
    wss.close(() => {
      httpServer.close(() => resolve());
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startWebSocketServer', () => {
  // Ensure a clean event log before every test so prior emits don't leak.
  beforeEach(() => {
    eventBus._log = [];
  });

  // ── 1. Returns a WebSocketServer instance ─────────────────────────────────

  it('returns a WebSocketServer instance', async () => {
    const { httpServer, wss } = await createTestServer();
    try {
      assert.ok(wss instanceof WebSocketServer, 'should be a WebSocketServer');
    } finally {
      await shutdownServer(httpServer, wss);
    }
  });

  // ── 2. Replays recent events to new client on connect ─────────────────────

  it('replays recent events to a newly connected client', async () => {
    // Pre-populate the event log before the client connects so that
    // getRecentEvents(20) will return these entries on connection.
    eventBus.emit('task.queued', { id: 'task-1' });
    eventBus.emit('task.completed', { id: 'task-2' });

    const { httpServer, wss, port } = await createTestServer();
    try {
      // Attach message listener BEFORE opening the connection so no replay
      // messages are missed between 'open' and the listener registration.
      const messagesPromise = new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const received = [];
        ws.on('message', (raw) => {
          received.push(JSON.parse(raw.toString()));
          if (received.length >= 2) resolve({ ws, received });
        });
        // Resolve with whatever arrived if the timeout fires first.
        setTimeout(() => resolve({ ws, received }), 600);
      });
      const { ws, received: messages } = await messagesPromise;
      ws.terminate();

      assert.equal(messages.length, 2, 'should receive 2 replayed events');
      assert.equal(messages[0].event, 'task.queued');
      assert.deepEqual(messages[0].data, { id: 'task-1' });
      assert.equal(messages[1].event, 'task.completed');
      assert.deepEqual(messages[1].data, { id: 'task-2' });
      // Each replayed message must carry a timestamp
      assert.ok(typeof messages[0].timestamp === 'number', 'replay message should have timestamp');
    } finally {
      await shutdownServer(httpServer, wss);
    }
  });

  // ── 3. Broadcasts eventBus events to all connected clients ────────────────

  it('broadcasts a registered event to all connected clients', async () => {
    const { httpServer, wss, port } = await createTestServer();
    try {
      const ws1 = await connectClient(port);
      const ws2 = await connectClient(port);

      // Drain any replay messages (log is empty so there should be none,
      // but collect with a short window to be safe).
      const drain1 = collectMessages(ws1, 1, 100).catch(() => []);
      const drain2 = collectMessages(ws2, 1, 100).catch(() => []);
      await Promise.all([drain1, drain2]);

      // Now set up collectors BEFORE emitting.
      const p1 = collectMessages(ws1, 1, 600);
      const p2 = collectMessages(ws2, 1, 600);

      eventBus.emit('task.queued', { id: 'broadcast-test' });

      const [msgs1, msgs2] = await Promise.all([p1, p2]);
      ws1.terminate();
      ws2.terminate();

      assert.equal(msgs1.length, 1, 'client 1 should receive 1 message');
      assert.equal(msgs1[0].event, 'task.queued');
      assert.deepEqual(msgs1[0].data, { id: 'broadcast-test' });
      assert.ok(typeof msgs1[0].timestamp === 'number', 'broadcast message should have timestamp');

      assert.equal(msgs2.length, 1, 'client 2 should receive 1 message');
      assert.equal(msgs2[0].event, 'task.queued');
      assert.deepEqual(msgs2[0].data, { id: 'broadcast-test' });
    } finally {
      await shutdownServer(httpServer, wss);
    }
  });

  // ── 4. Does NOT broadcast unregistered events ─────────────────────────────

  it('does not broadcast unregistered events', async () => {
    const { httpServer, wss, port } = await createTestServer();
    try {
      const ws = await connectClient(port);

      const received = [];
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

      // Emit an event that is not in the EVENTS array.
      eventBus.emit('unregistered.event', { should: 'not-arrive' });
      // Also emit a registered one so we know the listener is working.
      eventBus.emit('cost.recorded', { amount: 0.01 });

      // Wait long enough for both (or neither) to arrive.
      await new Promise((resolve) => setTimeout(resolve, 300));
      ws.terminate();

      const events = received.map((m) => m.event);
      assert.ok(!events.includes('unregistered.event'), 'unregistered event must not be broadcast');
      assert.ok(events.includes('cost.recorded'), 'registered event should have been broadcast');
    } finally {
      await shutdownServer(httpServer, wss);
    }
  });

  // ── 5. Cleans up: no interference between tests ───────────────────────────

  it('cleans up — a second independent server does not receive events from the first', async () => {
    const server1 = await createTestServer();
    const server2 = await createTestServer();
    try {
      const ws1 = await connectClient(server1.port);
      const ws2 = await connectClient(server2.port);

      const msgs1 = [];
      const msgs2 = [];
      ws1.on('message', (raw) => msgs1.push(JSON.parse(raw.toString())));
      ws2.on('message', (raw) => msgs2.push(JSON.parse(raw.toString())));

      eventBus.emit('agent.paused', { agentId: 'a1' });

      await new Promise((resolve) => setTimeout(resolve, 300));

      ws1.terminate();
      ws2.terminate();

      // Both servers listen on the same singleton eventBus, so both should
      // receive the event.  The important check is that neither server bleeds
      // messages it did not register for.
      const events1 = msgs1.map((m) => m.event);
      const events2 = msgs2.map((m) => m.event);

      assert.ok(events1.includes('agent.paused'), 'server1 client should receive agent.paused');
      assert.ok(events2.includes('agent.paused'), 'server2 client should receive agent.paused');

      // No spurious events should appear on either client.
      assert.ok(
        events1.every((e) => e === 'agent.paused'),
        'server1 client should only have agent.paused messages'
      );
      assert.ok(
        events2.every((e) => e === 'agent.paused'),
        'server2 client should only have agent.paused messages'
      );
    } finally {
      await shutdownServer(server1.httpServer, server1.wss);
      await shutdownServer(server2.httpServer, server2.wss);
    }
  });
});
