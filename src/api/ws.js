/**
 * @file src/api/ws.js
 * @description WebSocket server for real-time AgentForge event streaming.
 *
 * Attaches to an existing http.Server so that REST and WebSocket traffic
 * share the same port.  On connect, the last 20 events are replayed to the
 * new client; afterwards all subsequent events are broadcast as they occur.
 *
 * GitHub issue #34
 */

import { WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// Event list — all events that are broadcast to connected clients
// ---------------------------------------------------------------------------

const EVENTS = [
  'task.queued',
  'task.assigned',
  'task.executing',
  'task.completed',
  'task.failed',
  'quota.throttled',
  'quota.exhausted',
  'quota.reset',
  'agent.paused',
  'agent.resumed',
  'budget.warning',
  'budget.exceeded',
  'git.committed',
  'git.pr_created',
  'cost.recorded',
  'review.pending',
  'review.approved',
  'review.rejected',
];

/** Interval (ms) between server-initiated pings to detect dead connections. */
const PING_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize and broadcast a message to every open WebSocket client.
 *
 * @param {WebSocketServer} wss
 * @param {Object} message - Will be serialized to JSON.
 */
function broadcast(wss, message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(payload);
    }
  }
}

/**
 * Send a single message to a specific client, ignoring send errors
 * (the client may have disconnected between the readyState check and send).
 *
 * @param {import('ws').WebSocket} ws
 * @param {Object} message
 */
function sendToClient(ws, message) {
  if (ws.readyState === 1 /* OPEN */) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Client disconnected mid-send — nothing to do
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create and attach a WebSocket server to an existing HTTP server.
 *
 * The WebSocket endpoint is mounted at `/ws` on the same port as the REST API.
 *
 * Behaviour per connection:
 *  - When `authConfig.enabled` is true (and `NODE_ENV !== 'test'`), the
 *    connecting client must supply the shared secret as a `?token=<secret>`
 *    query parameter.  Connections without a valid token are closed with code
 *    4401 and the message "Unauthorized".
 *  - Replays the last 20 events immediately on connect.
 *  - Forwards every listed event from the eventBus as it fires.
 *  - Sends a ping frame every 30 s; closes the connection if no pong is
 *    received before the next ping cycle.
 *  - Cleans up all timers on disconnect.
 *
 * @param {import('http').Server} httpServer - The Node.js HTTP server to attach to.
 * @param {import('../core/event-bus.js').default} eventBus - The AgentForge event bus singleton.
 * @param {{ enabled?: boolean, secret?: string }} [authConfig={}] - Auth config.
 * @returns {WebSocketServer} The created WebSocket server instance.
 *
 * @example
 * import http from 'node:http';
 * import express from 'express';
 * import eventBus from '../core/event-bus.js';
 * import { startWebSocketServer } from './ws.js';
 *
 * const app = express();
 * const httpServer = http.createServer(app);
 * startWebSocketServer(httpServer, eventBus, { enabled: false });
 * httpServer.listen(3000);
 */
export function startWebSocketServer(httpServer, eventBus, authConfig = {}) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // ── Per-connection logic ─────────────────────────────────────────────────
  wss.on('connection', (ws, req) => {
    // Token auth check for WebSocket connections
    if (authConfig.enabled && process.env.NODE_ENV !== 'test') {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token || token !== authConfig.secret) {
        ws.close(4401, 'Unauthorized');
        return;
      }
    }
    // Replay the last 20 events so the dashboard can hydrate immediately
    const recent = eventBus.getRecentEvents(20);
    for (const entry of recent) {
      sendToClient(ws, { event: entry.event, data: entry.data, timestamp: entry.timestamp });
    }

    // Liveness tracking — mark alive on each pong
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Ping timer — send a ping every PING_INTERVAL_MS; close if dead
    const pingTimer = setInterval(() => {
      if (!ws.isAlive) {
        // No pong received since last ping — terminate the stale connection
        clearInterval(pingTimer);
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      if (ws.readyState === 1 /* OPEN */) {
        ws.ping();
      }
    }, PING_INTERVAL_MS);

    // Clean up on disconnect
    ws.on('close', () => {
      clearInterval(pingTimer);
    });

    ws.on('error', () => {
      clearInterval(pingTimer);
    });
  });

  // ── Global event subscriptions — broadcast to all connected clients ───────
  for (const evt of EVENTS) {
    eventBus.on(evt, (data) => {
      broadcast(wss, { event: evt, data, timestamp: Date.now() });
    });
  }

  console.log('[agentforge:ws] WebSocket server attached at path /ws');

  return wss;
}
