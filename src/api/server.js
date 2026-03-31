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
import { UserStore } from '../auth/users.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signToken, verifyToken, revokeToken } from '../auth/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * Build auth routes for a given forge instance and return an Express Router.
 * Mounted at /api/auth.
 *
 * @param {Object} forge
 * @returns {import('express').Router}
 */
function buildAuthRouter(forge) {
  const router = express.Router();
  const db = forge.db;

  // ── POST /api/auth/setup ───────────────────────────────────────────────────
  /**
   * Create the first admin user. Only available when no users exist.
   * Body: { username, password, displayName? }
   */
  router.post('/setup', async (req, res) => {
    try {
      if (!db) return res.status(503).json({ ok: false, error: 'Database not available' });
      if (db.hasUsers()) {
        return res.status(409).json({ ok: false, error: 'Setup already complete. Users already exist.' });
      }
      const { username, password, displayName } = req.body ?? {};
      if (!username || !password) {
        return res.status(400).json({ ok: false, error: '`username` and `password` are required' });
      }
      const store = new UserStore(db);
      const user = await store.create({ username, password, displayName, role: 'admin' });
      return res.status(201).json({ ok: true, user });
    } catch (err) {
      if (err.message?.includes('UNIQUE')) {
        return res.status(409).json({ ok: false, error: 'Username already exists' });
      }
      if (err.message?.includes('at least')) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/auth/login ───────────────────────────────────────────────────
  /**
   * Authenticate with username + password and receive a JWT.
   * Body: { username, password }
   */
  router.post('/login', async (req, res) => {
    try {
      if (!db) return res.status(503).json({ ok: false, error: 'Database not available' });
      const { username, password } = req.body ?? {};
      if (!username || !password) {
        return res.status(400).json({ ok: false, error: '`username` and `password` are required' });
      }
      const store = new UserStore(db);
      const user = await store.authenticate(username, password);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Invalid credentials' });
      }
      const token = signToken(db, { userId: user.id, username: user.username, role: user.role });
      return res.json({
        ok: true,
        token,
        user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/auth/logout ──────────────────────────────────────────────────
  /**
   * Revoke the current JWT. Requires Authorization: Bearer <token>.
   */
  router.post('/logout', (req, res) => {
    try {
      if (!db) return res.status(503).json({ ok: false, error: 'Database not available' });
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      if (!token) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
      const payload = verifyToken(db, token);
      if (!payload) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
      revokeToken(db, payload.jti, payload.exp);
      return res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/auth/me ───────────────────────────────────────────────────────
  /**
   * Return the authenticated user's profile and permissions.
   * Requires Authorization: Bearer <token>.
   */
  router.get('/me', (req, res) => {
    try {
      if (!db) return res.status(503).json({ ok: false, error: 'Database not available' });
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });

      const payload = verifyToken(db, token);
      if (!payload) return res.status(401).json({ ok: false, error: 'Unauthorized' });

      const store = new UserStore(db);
      const user = store.findById(payload.userId);
      if (!user || !user.is_active) return res.status(401).json({ ok: false, error: 'Unauthorized' });

      const permissions = rolePermissions(user.role);
      return res.json({
        ok: true,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          role: user.role,
          permissions,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/auth/change-password ────────────────────────────────────────
  /**
   * Change the authenticated user's password.
   * Body: { currentPassword, newPassword }
   */
  router.post('/change-password', async (req, res) => {
    try {
      if (!db) return res.status(503).json({ ok: false, error: 'Database not available' });
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });

      const payload = verifyToken(db, token);
      if (!payload) return res.status(401).json({ ok: false, error: 'Unauthorized' });

      const { currentPassword, newPassword } = req.body ?? {};
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ ok: false, error: '`currentPassword` and `newPassword` are required' });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ ok: false, error: 'New password must be at least 8 characters' });
      }

      // Re-authenticate to verify current password
      const user = db.findUserById(payload.userId);
      if (!user || !user.is_active) return res.status(401).json({ ok: false, error: 'Unauthorized' });

      const ok = await verifyPassword(currentPassword, user.password_hash);
      if (!ok) {
        return res.status(400).json({ ok: false, error: 'Current password is incorrect' });
      }

      const newHash = await hashPassword(newPassword);
      db.updateUserPasswordHash(user.id, newHash);

      return res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

/**
 * Return a list of permission strings for a given role.
 * @param {string} role
 * @returns {string[]}
 */
function rolePermissions(role) {
  const base = ['tasks:read', 'agents:read', 'costs:read', 'events:read', 'quotas:read'];
  if (role === 'operator' || role === 'admin') {
    base.push('tasks:write', 'agents:write', 'control:write');
  }
  if (role === 'admin') {
    base.push('users:read', 'users:write', 'providers:write');
  }
  return base;
}

/**
 * Build and return an Express Router wired to the forge instance.
 *
 * @param {Object} forge - The object returned by createAgentForge().
 * @param {import('../core/task-queue.js').TaskQueue} forge.taskQueue
 * @param {import('../core/quota-tracker.js').QuotaManager} forge.quotaManager
 * @param {import('../core/event-bus.js').default} forge.eventBus
 * @param {Object} forge.orchestrator
 * @param {Object} [forge.agentPool]   - May not exist yet; handled gracefully.
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
      const agentStatuses = forge.agentPool?.getAllStatuses?.() ?? {};

      res.json({
        ok: true,
        orchestrator: {
          running: forge.orchestrator?._running ?? false,
        },
        tasks: taskStats,
        quotas,
        agents: agentStatuses,
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
   * Add a new task.
   * Body: { title, type, priority, agent_id }
   */
  router.post('/tasks', (req, res) => {
    try {
      const { title, type, priority, agent_id } = req.body ?? {};
      if (!title) {
        return res.status(400).json({ ok: false, error: '`title` is required' });
      }
      const task = forge.taskQueue.add({ title, type, priority, agent_id });
      res.status(201).json({ ok: true, task });
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
      const task = forge.taskQueue.get(req.params.id);
      if (!task) {
        return res.status(404).json({ ok: false, error: `Task '${req.params.id}' not found` });
      }
      res.json({ ok: true, task });
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

  // ── GET /api/agents ──────────────────────────────────────────────────────
  /**
   * List all agents and their lifecycle status.
   */
  router.get('/agents', (req, res) => {
    try {
      const statuses = forge.agentPool?.getAllStatuses?.() ?? {};
      const agents = Object.values(statuses);
      res.json({ ok: true, count: agents.length, agents });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/agents/:id ─────────────────────────────────────────────────
  /**
   * Update an agent's runtime config (model, systemPrompt).
   * Body: { model?, systemPrompt? }
   */
  router.post('/agents/:id', (req, res) => {
    try {
      const agentId = req.params.id;
      const { model, systemPrompt } = req.body ?? {};
      const pool = forge.agentPool;
      if (!pool) {
        return res.status(503).json({ ok: false, error: 'Agent pool not available' });
      }
      const updated = pool.updateAgentConfig?.(agentId, { model, systemPrompt });
      if (updated === false) {
        return res.status(404).json({ ok: false, error: `Agent '${agentId}' not found` });
      }
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

  // ── POST /api/review/:prNumber/approve ───────────────────────────────────
  /**
   * Approve a PR review.
   */
  router.post('/review/:prNumber/approve', (req, res) => {
    try {
      const prNumber = parseInt(req.params.prNumber, 10);
      if (!Number.isFinite(prNumber) || prNumber < 1) {
        return res.status(400).json({ ok: false, error: 'Invalid PR number' });
      }
      forge.eventBus.emit('review.approved', { prNumber, approvedAt: Date.now() });
      res.json({ ok: true, prNumber, action: 'approved' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/review/:prNumber/reject ────────────────────────────────────
  /**
   * Reject a PR review.
   * Body: { reason }
   */
  router.post('/review/:prNumber/reject', (req, res) => {
    try {
      const prNumber = parseInt(req.params.prNumber, 10);
      if (!Number.isFinite(prNumber) || prNumber < 1) {
        return res.status(400).json({ ok: false, error: 'Invalid PR number' });
      }
      const { reason } = req.body ?? {};
      if (!reason) {
        return res.status(400).json({ ok: false, error: '`reason` is required in the request body' });
      }
      forge.eventBus.emit('review.rejected', { prNumber, reason, rejectedAt: Date.now() });
      res.json({ ok: true, prNumber, action: 'rejected', reason });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

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
 * serves the static UI from `src/ui/` if it exists, attaches the
 * WebSocket server to the same HTTP server, then starts listening.
 *
 * @param {Object} forge  - The forge instance returned by createAgentForge().
 * @param {number} [port=3000] - Port to listen on.
 * @param {string} [host='127.0.0.1'] - Address to bind to.
 * @returns {http.Server} The underlying Node.js HTTP server.
 *
 * @example
 * import { createAgentForge } from '../index.js';
 * import { startServer } from './api/server.js';
 *
 * const forge = await createAgentForge();
 * const server = startServer(forge, 3000);
 */
export function startServer(forge, port = 3000, host = '127.0.0.1') {
  const app = express();

  // Security headers — allow inline styles/scripts needed by React/Vite build
  const isReactBuild = fs.existsSync(path.resolve(__dirname, '../../ui/dist'));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...(isReactBuild ? [] : ["'unsafe-inline'"])],
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

  // Rate limiting — scoped to API routes only (not static files)
  app.use('/api', generalLimiter);
  app.post('/api/*splat', mutationLimiter);

  // Auth middleware — only enforced when a static secret is configured or at
  // least one user account exists.  Before first-run setup (no users yet)
  // the server must be reachable without credentials so the admin can POST
  // /api/auth/setup.  The middleware itself also bypasses in NODE_ENV=test.
  const authConfig = forge.config?.auth ?? {};
  const hasUsers = !!(forge.db?.hasUsers?.());
  const dbForAuth = (authConfig.secret || hasUsers) ? (forge.db ?? null) : null;
  const authMiddleware = createAuthMiddleware(authConfig, dbForAuth);
  // Apply auth to all /api routes except /api/auth/* (login, setup)
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    authMiddleware(req, res, next);
  });

  // Auth routes — unauthenticated
  app.use('/api/auth', buildAuthRouter(forge));

  // API routes
  app.use('/api', buildRouter(forge));

  // Static UI — prefer React build (ui/dist/) over vanilla (src/ui/)
  const reactBuildDir = path.resolve(__dirname, '../../ui/dist');
  const vanillaUIDir  = path.resolve(__dirname, '../ui');
  const uiDir = fs.existsSync(reactBuildDir) ? reactBuildDir : vanillaUIDir;
  if (fs.existsSync(uiDir)) {
    app.use(express.static(uiDir));
    // SPA fallback: serve index.html for any non-API route
    app.get('/{*splat}', (req, res) => {
      res.sendFile(path.join(uiDir, 'index.html'));
    });
  }

  // Create the HTTP server and attach the WebSocket server
  const httpServer = http.createServer(app);
  startWebSocketServer(httpServer, forge.eventBus);

  httpServer.listen(port, host, () => {
    console.log('[agentforge:api] REST API listening on http://%s:%d', host, port);
    console.log('[agentforge:api] WebSocket endpoint: ws://%s:%d/ws', host, port);

    // First-run detection: prompt admin to create an account if none exist
    if (forge.db && !forge.db.hasUsers()) {
      console.log('[agentforge:setup] No admin account found.');
      console.log(`[agentforge:setup] Visit http://${host}:${port}/setup to create one.`);
    }

    // Periodically purge expired revoked-token entries (every 6 hours)
    if (forge.db) {
      setInterval(() => forge.db.cleanExpiredTokens(), 6 * 60 * 60 * 1000).unref();
    }
  });

  return httpServer;
}
