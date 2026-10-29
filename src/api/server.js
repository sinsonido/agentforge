/**
 * @file src/api/server.js
 * @description Express REST API server for the AgentForge dashboard.
 *
 * Exposes system state (tasks, agents, quotas, costs, events) via JSON endpoints
 * and integrates the WebSocket server for real-time event streaming.
 *
 * GitHub issue #33
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { startWebSocketServer } from './ws.js';
import { createAuthMiddleware } from '../auth/auth.js';
import { parseTaskInput } from '../core/task-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST_DIR = path.resolve(__dirname, '../../ui/dist');
const UI_MISSING_MESSAGE =
  'Dashboard not built: ui/dist/index.html is missing. Run `npm run ui:install` once, then `npm run ui:build`. The API and WebSocket keep working.';
const UI_MISSING_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>AgentForge: dashboard not built</title>
<h1>Dashboard not built</h1>
<p><code>ui/dist/index.html</code> is missing. Run <code>npm run ui:install</code> once, then <code>npm run ui:build</code>, and reload this page.</p>
<p>The API and WebSocket keep working.</p>
`;

// ---------------------------------------------------------------------------
// CORS middleware — allow any localhost origin for dev dashboard
// ---------------------------------------------------------------------------

/**
 * Add CORS headers permitting localhost on any port.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin || '';
  if (!origin || /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

function agentView({ id, name, role, model }) {
  return { id, name, role, model };
}

/**
 * Build and return an Express Router wired to the forge instance.
 *
 * @param {Object} forge - The object returned by createAgentForge().
 * @param {import('../core/task-queue.js').TaskQueue} forge.taskQueue
 * @param {import('../core/quota-tracker.js').QuotaManager} forge.quotaManager
 * @param {import('../core/event-bus.js').default} forge.eventBus
 * @param {Object} forge.orchestrator
 * @param {Object<string, Object>} forge.agents - Agent configs from buildFromConfig(), keyed by id.
 * @param {Object} [forge.costTracker] - May not exist yet; handled gracefully.
 * @returns {import('express').Router}
 */
function buildRouter(forge) {
  const router = express.Router();

  // ── GET /api/status ──────────────────────────────────────────────────────
  /**
   * System overview: task stats, quota states, running agent count.
   */
  router.get('/status', (req, res) => {
    try {
      const taskStats = forge.taskQueue.stats();
      const quotas = forge.quotaManager.getAllStatuses();
      const agents = Object.fromEntries(Object.entries(forge.agents ?? {}).map(([id, a]) => [id, agentView(a)]));

      res.json({
        ok: true,
        orchestrator: {
          running: forge.orchestrator?._running ?? false,
        },
        tasks: taskStats,
        quotas,
        agents,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/tasks ───────────────────────────────────────────────────────
  /**
   * List tasks. Merges live queue with DB history.
   * Optional query param: ?status=queued|executing|completed|failed
   */
  router.get('/tasks', (req, res) => {
    try {
      const { status } = req.query;
      const liveTasks = status
        ? forge.taskQueue.getByStatus(status)
        : forge.taskQueue.getAll();

      // Merge DB history (completed/failed not in live queue)
      if (forge.db) {
        const liveIds = new Set(liveTasks.map(t => t.id));
        const dbHistory = status
          ? forge.db.getTasksByStatus(status)
          : forge.db.getTaskHistory(500);
        const dbOnly = dbHistory.filter(t => !liveIds.has(t.id));
        const merged = [...liveTasks, ...dbOnly];
        return res.json({ ok: true, count: merged.length, tasks: merged });
      }

      res.json({ ok: true, count: liveTasks.length, tasks: liveTasks });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/tasks ──────────────────────────────────────────────────────
  /**
   * Add a new task. A text task needs `title`; a coding task (`kind: "coding"`)
   * needs `repo`, `base`, `instruction` and `playbook`. Posting a coding task whose
   * (repo, issue, playbook) matches a live one returns that task with 200.
   */
  router.post('/tasks', (req, res) => {
    try {
      const parsed = parseTaskInput(req.body);
      if (!parsed.ok) {
        return res.status(400).json({ ok: false, error: parsed.error });
      }
      const { task, created } = forge.taskQueue.admit(parsed.value);
      res.status(created ? 201 : 200).json({ ok: true, created, task });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/tasks/:id ───────────────────────────────────────────────────
  /**
   * Get a single task by ID.
   */
  router.get('/tasks/:id', (req, res) => {
    try {
      const task = forge.taskQueue.get(req.params.id) ?? forge.db?.findTask(req.params.id);
      if (!task) {
        return res.status(404).json({ ok: false, error: `Task '${req.params.id}' not found` });
      }
      res.json({ ok: true, task });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/tasks/:id/trail ─────────────────────────────────────────────
  /**
   * The task's decision trail in order: status transitions, playbook steps,
   * evidence-gate checks, agent decisions and evidence links.
   */
  router.get('/tasks/:id/trail', (req, res) => {
    try {
      const { id } = req.params;
      if (!forge.taskQueue.get(id) && !forge.db?.getTask(id)) {
        return res.status(404).json({ ok: false, error: `Task '${id}' not found` });
      }
      res.json({ ok: true, trail: forge.db?.getTrail(id) ?? [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/tasks/:id/events ────────────────────────────────────────────
  /**
   * Replay a task's agent transcript: stored events with seq > `after` (default 0),
   * oldest first, one page at a time. `more` says another page follows; ask again
   * with `after` set to the last seq received. Live events arrive over the
   * WebSocket as `task.agent_event` with the same seq.
   */
  router.get('/tasks/:id/events', (req, res) => {
    try {
      const { id } = req.params;
      const after = req.query.after === undefined ? 0 : Number(req.query.after);
      if (!Number.isInteger(after) || after < 0) {
        return res.status(400).json({ ok: false, error: 'after must be a non-negative integer' });
      }
      if (!forge.taskQueue.get(id) && !forge.db?.getTask(id)) {
        return res.status(404).json({ ok: false, error: `Task '${id}' not found` });
      }
      const page = forge.db ? forge.db.taskEventsAfter(id, after) : { events: [], more: false };
      res.json({ ok: true, ...page });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/tasks/:id/status ───────────────────────────────────────────
  /**
   * Update the status of a task (used by the Kanban board drag-and-drop).
   * Body: { status }
   */
  router.post('/tasks/:id/status', (req, res) => {
    try {
      const { status } = req.body ?? {};
      const validStatuses = ['queued', 'executing', 'completed', 'failed'];
      if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({ ok: false, error: `status must be one of: ${validStatuses.join(', ')}` });
      }
      const task = forge.taskQueue.get(req.params.id);
      if (!task) {
        return res.status(404).json({ ok: false, error: `Task '${req.params.id}' not found` });
      }
      forge.taskQueue.updateStatus(req.params.id, status);
      forge.eventBus.emit('task.status_changed', { taskId: req.params.id, status, changedAt: Date.now() });
      res.json({ ok: true, taskId: req.params.id, status });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/tasks/:id/cancel ───────────────────────────────────────────
  /**
   * Cancel a coding task. A queued one ends `cancelled` now and never starts (200).
   * A running one is aborted and settles `cancelled` once its container stops (202);
   * the coding runner emits `task.failed` then. Any other task cannot be cancelled (409).
   */
  router.post('/tasks/:id/cancel', (req, res) => {
    try {
      const { id } = req.params;
      const task = forge.taskQueue.get(id);
      if (!task) {
        return res.status(404).json({ ok: false, error: `Task '${id}' not found` });
      }
      if (task.kind === 'coding' && task.status === 'queued') {
        forge.taskQueue.updateStatus(id, 'cancelled', { result: 'cancelled (api)' });
        forge.eventBus.emit('task.failed', { task, status: 'cancelled', error: task.result });
        return res.json({ ok: true, task });
      }
      if (task.kind === 'coding' && forge.orchestrator?.cancelTask(id)) {
        return res.status(202).json({ ok: true, task });
      }
      res.status(409).json({ ok: false, error: `Task '${id}' is not a queued or running coding task (status: ${task.status})` });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/tasks/:id/approve, /reject ─────────────────────────────────
  /**
   * The operator's decision on a coding task in `needs-approval`. Body: { reason? }.
   * Approve runs the parked host action and answers when it has run (200); if the
   * action fails the task waits again and the answer is 502. Reject ends the task (200).
   * 404 for an unknown task, 409 when nothing waits for approval, 503 without a coding loop.
   */
  const decideApproval = (decision) => async (req, res) => {
    try {
      const { id } = req.params;
      const reason = req.body?.reason ?? null;
      if (reason != null && (typeof reason !== 'string' || reason.length > 500)) {
        return res.status(400).json({ ok: false, error: '`reason` must be a string of at most 500 characters' });
      }
      if (!forge.taskQueue.get(id)) {
        return res.status(404).json({ ok: false, error: `Task '${id}' not found` });
      }
      const pending = forge.orchestrator?.decideApproval?.(id, { decision, by: 'operator', reason: reason?.trim() || null });
      if (!pending) {
        return res.status(503).json({ ok: false, error: 'No coding loop is configured' });
      }
      const out = await pending;
      const task = forge.taskQueue.get(id);
      if (!out.ok) return res.status(out.conflict ? 409 : 502).json({ ok: false, error: out.error, task });
      res.json({ ok: true, status: out.status, task });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
  router.post('/tasks/:id/approve', decideApproval('approved'));
  router.post('/tasks/:id/reject', decideApproval('rejected'));

  // ── GET /api/agents ──────────────────────────────────────────────────────
  /**
   * List the configured agents.
   */
  router.get('/agents', (req, res) => {
    try {
      const agents = Object.values(forge.agents ?? {}).map(agentView);
      res.json({ ok: true, count: agents.length, agents });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/agents/:id ─────────────────────────────────────────────────
  /**
   * Update an agent's model or system prompt. The router and the context
   * builder read the same agent object, so the next task uses the change.
   * Body: { model?, systemPrompt? }
   */
  router.post('/agents/:id', (req, res) => {
    try {
      const agentId = req.params.id;
      const { model, systemPrompt } = req.body ?? {};
      const agent = forge.agents?.[agentId];
      if (!agent) {
        return res.status(404).json({ ok: false, error: `Agent '${agentId}' not found` });
      }
      if (model) agent.model = model;
      if (systemPrompt) agent.system_prompt = systemPrompt;
      forge.eventBus.emit('agent.config_updated', { agentId, model, updatedAt: Date.now() });
      res.json({ ok: true, agentId, model, systemPrompt });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/providers/test ──────────────────────────────────────────────
  /**
   * Test connectivity for a named provider.
   * Body: { provider }
   */
  router.post('/providers/test', async (req, res) => {
    try {
      const { provider } = req.body ?? {};
      if (!provider) {
        return res.status(400).json({ ok: false, error: '`provider` is required' });
      }
      const registry = forge.providerRegistry;
      if (!registry) {
        return res.status(503).json({ ok: false, error: 'Provider registry not available' });
      }
      const p = registry.get?.(provider);
      if (!p) {
        return res.status(404).json({ ok: false, error: `Provider '${provider}' not registered` });
      }
      // Run a minimal test call if the provider supports it
      if (typeof p.test === 'function') {
        await p.test();
      }
      res.json({ ok: true, provider, status: 'reachable' });
    } catch (err) {
      res.status(200).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/quotas ──────────────────────────────────────────────────────
  /**
   * All provider quota statuses (usage windows, state).
   */
  router.get('/quotas', (req, res) => {
    try {
      const quotas = forge.quotaManager.getAllStatuses();
      res.json({ ok: true, quotas });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/costs ───────────────────────────────────────────────────────
  /**
   * Cost stats with normalized shape for UI consumption.
   * Returns: { totalCostUSD, byAgent, byModel, transactions, budgets }
   */
  router.get('/costs', (req, res) => {
    try {
      const costTracker = forge.costTracker ?? forge.orchestrator?.costTracker;
      const db = forge.db;

      if (!costTracker && !db) {
        return res.json({ ok: true, available: false, costs: null });
      }

      // Base shape from in-memory cost tracker
      const rawStats = costTracker?.getAllStats?.() ?? {};

      // Enrich with DB data when available
      let byAgent = {};
      let transactions = [];
      if (db) {
        const projectId = forge.config?.project?.name || 'default';
        const agentRows = db.getCostByAgent(projectId);
        for (const row of agentRows) {
          byAgent[row.agent_id] = row.total;
        }
        transactions = db.getRecentEvents(200)
          .filter(e => e.event === 'cost.recorded')
          .map(e => e.data);
      }

      // Aggregate from rawStats if DB not available
      if (!db && rawStats.byAgent) {
        byAgent = rawStats.byAgent;
      }

      const totalCostUSD = Object.values(byAgent).reduce((s, v) => s + v, 0)
        || rawStats.totalCost
        || 0;

      const costs = {
        totalCostUSD,
        byAgent,
        byModel: rawStats.byModel ?? {},
        transactions,
        budgets: rawStats.budgets ?? rawStats.projects ?? {},
      };

      res.json({ ok: true, available: true, costs });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/events ──────────────────────────────────────────────────────
  /**
   * Recent events. Prefers DB when available.
   * Optional query param: ?limit=50  (default 50, max 1000)
   */
  router.get('/events', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 1000);
      if (forge.db) {
        const events = forge.db.getRecentEvents(limit);
        return res.json({ ok: true, count: events.length, events });
      }
      const events = forge.eventBus.getRecentEvents(limit);
      res.json({ ok: true, count: events.length, events });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/control/start ──────────────────────────────────────────────
  /**
   * Start the orchestrator.
   */
  router.post('/control/start', (req, res) => {
    try {
      if (!forge.orchestrator) {
        return res.status(503).json({ ok: false, error: 'Orchestrator not available' });
      }
      if (forge.orchestrator._running) {
        return res.status(409).json({ ok: false, error: 'Orchestrator is already running' });
      }
      forge.orchestrator.start();
      res.json({ ok: true, message: 'Orchestrator started' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/control/stop ───────────────────────────────────────────────
  /**
   * Stop the orchestrator.
   */
  router.post('/control/stop', (req, res) => {
    try {
      if (!forge.orchestrator) {
        return res.status(503).json({ ok: false, error: 'Orchestrator not available' });
      }
      if (!forge.orchestrator._running) {
        return res.status(409).json({ ok: false, error: 'Orchestrator is not running' });
      }
      forge.orchestrator.stop();
      res.json({ ok: true, message: 'Orchestrator stopped' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/test/reset (test mode only) ───────────────────────────────
  /**
   * Clear in-memory task queue and stop the orchestrator.
   * Only mounted when NODE_ENV === 'test'. Used by the E2E fixture to
   * reset server-side state between tests without restarting the server.
   */
  if (isTestEnv) {
    router.post('/test/reset', (req, res) => {
      try {
        // Clear the in-memory task queue
        forge.taskQueue.clear();
        // Stop orchestrator so it doesn't pick up stale tasks
        if (forge.orchestrator?._running) {
          forge.orchestrator.stop();
        }
        // Clear event bus replay log so WS replays don't leak events across tests
        forge.eventBus?.clearRecent?.();
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });
  }

  return router;
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

// In test mode (NODE_ENV=test) skip rate limiting entirely so the E2E suite
// can make hundreds of requests without hitting a 429.
const isTestEnv = process.env.NODE_ENV === 'test';
const skipInTest = () => isTestEnv;

/** General read limiter: 200 req / 1 min per IP (bypassed in test) */
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  skip: skipInTest,
  standardHeaders: true,
  legacyHeaders: false,
});

/** Strict mutation limiter: 30 req / 1 min per IP on POST /api/* (bypassed in test) */
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  skip: skipInTest,
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the AgentForge HTTP (REST + WebSocket) server.
 *
 * Creates an Express application, mounts the API routes under `/api`,
 * serves the React build from `ui/dist/`, attaches the WebSocket server
 * to the same HTTP server, then starts listening. Without a build, page
 * requests get a 503 that tells the operator to run `npm run ui:build`.
 *
 * @param {Object} forge  - The forge instance returned by createAgentForge().
 * @param {number} [port=3000] - Port to listen on.
 * @param {string} [host='127.0.0.1'] - Address to bind to.
 * @param {string} [uiDir] - Directory holding the built dashboard.
 * @returns {http.Server} The underlying Node.js HTTP server.
 *
 * @example
 * import { createAgentForge } from '../index.js';
 * import { startServer } from './api/server.js';
 *
 * const forge = await createAgentForge();
 * const server = startServer(forge, 3000);
 */
export function startServer(forge, port = 3000, host = '127.0.0.1', uiDir = UI_DIST_DIR) {
  const app = express();
  const uiIndex = path.join(uiDir, 'index.html');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
  }));

  // Body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // CORS — must be before routes
  app.use(corsMiddleware);

  // Auth — must be before rate limiters and router
  app.use('/api', createAuthMiddleware(forge.config?.server?.auth ?? {}));

  // Rate limiting — scoped to API routes only (not static files)
  app.use('/api', generalLimiter);
  app.post('/api/*splat', mutationLimiter);

  // API routes
  app.use('/api', buildRouter(forge));

  app.use(express.static(uiDir));
  app.get('/{*splat}', generalLimiter, (req, res) => {
    if (fs.existsSync(uiIndex)) return res.sendFile(uiIndex);
    res.status(503).type('html').send(UI_MISSING_PAGE);
  });
  if (!fs.existsSync(uiIndex)) {
    console.warn('[agentforge:api] %s', UI_MISSING_MESSAGE);
  }

  // Create the HTTP server and attach the WebSocket server
  const httpServer = http.createServer(app);
  startWebSocketServer(httpServer, forge.eventBus, forge.config?.server?.auth ?? {});

  if (!forge.config?.server?.auth?.enabled) {
    console.warn('[agentforge:api] WARNING: API auth is disabled — set server.auth.secret in agentforge.yml for production use');
  }

  httpServer.listen(port, host, () => {
    console.log('[agentforge:api] REST API listening on http://%s:%d', host, port);
    console.log('[agentforge:api] WebSocket endpoint: ws://%s:%d/ws', host, port);
  });

  return httpServer;
}
