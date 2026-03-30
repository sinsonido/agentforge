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
import { TeamStore, VALID_ROLES } from '../auth/teams.js';
import { requirePermission } from '../auth/rbac.js';

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
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
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

  // ── Teams routes /api/teams ───────────────────────────────────────────────
  {
    // Initialise the TeamStore once, backed by the raw better-sqlite3 handle.
    // forge.db is an AgentForgeDB instance; its .db property is the raw Database.
    const teamStore = forge.db ? new TeamStore(forge.db.db) : null;

    /**
     * Helper: return 503 when the DB / TeamStore is unavailable.
     */
    function requireTeamStore(res) {
      if (!teamStore) {
        res.status(503).json({ ok: false, error: 'Database not available' });
        return false;
      }
      return true;
    }

    // GET /api/teams — list all teams
    router.get('/teams', requirePermission('teams:read'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const teams = teamStore.listTeams();
        res.json({ ok: true, teams });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // POST /api/teams — create team (admin only)
    router.post('/teams', requirePermission('teams:manage'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const { name, description } = req.body ?? {};
        if (!name) {
          return res.status(400).json({ ok: false, error: '`name` is required' });
        }
        const team = teamStore.createTeam({ name, description });
        res.status(201).json({ ok: true, team });
      } catch (err) {
        if (err.message.includes('UNIQUE constraint')) {
          return res.status(409).json({ ok: false, error: 'Team name already exists' });
        }
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // GET /api/teams/:id — get team with members and projects
    router.get('/teams/:id', requirePermission('teams:read'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const team = teamStore.getTeam(req.params.id);
        if (!team) {
          return res.status(404).json({ ok: false, error: `Team '${req.params.id}' not found` });
        }
        const members = teamStore.listMembers(req.params.id);
        const projects = teamStore.listProjects(req.params.id);
        res.json({ ok: true, team: { ...team, members, projects } });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // PUT /api/teams/:id — update team (admin only)
    router.put('/teams/:id', requirePermission('teams:manage'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const { name, description } = req.body ?? {};
        const team = teamStore.updateTeam(req.params.id, { name, description });
        if (!team) {
          return res.status(404).json({ ok: false, error: `Team '${req.params.id}' not found` });
        }
        res.json({ ok: true, team });
      } catch (err) {
        if (err.message.includes('UNIQUE constraint')) {
          return res.status(409).json({ ok: false, error: 'Team name already exists' });
        }
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // DELETE /api/teams/:id — delete team (admin only)
    router.delete('/teams/:id', requirePermission('teams:manage'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const deleted = teamStore.deleteTeam(req.params.id);
        if (!deleted) {
          return res.status(404).json({ ok: false, error: `Team '${req.params.id}' not found` });
        }
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // GET /api/teams/:id/members — list members
    router.get('/teams/:id/members', requirePermission('teams:read'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const team = teamStore.getTeam(req.params.id);
        if (!team) {
          return res.status(404).json({ ok: false, error: `Team '${req.params.id}' not found` });
        }
        const members = teamStore.listMembers(req.params.id);
        res.json({ ok: true, members });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // POST /api/teams/:id/members — add member (admin only)
    router.post('/teams/:id/members', requirePermission('teams:manage'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const { userId, role = 'member' } = req.body ?? {};
        if (!userId) {
          return res.status(400).json({ ok: false, error: '`userId` is required' });
        }
        if (!VALID_ROLES.includes(role)) {
          return res.status(400).json({ ok: false, error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
        }
        const team = teamStore.getTeam(req.params.id);
        if (!team) {
          return res.status(404).json({ ok: false, error: `Team '${req.params.id}' not found` });
        }
        teamStore.addMember(req.params.id, userId, role);
        res.status(201).json({ ok: true });
      } catch (err) {
        if (err.message.includes('already a member')) {
          return res.status(400).json({ ok: false, error: err.message });
        }
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // DELETE /api/teams/:id/members/:uid — remove member (admin only)
    router.delete('/teams/:id/members/:uid', requirePermission('teams:manage'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const removed = teamStore.removeMember(req.params.id, req.params.uid);
        if (!removed) {
          return res.status(404).json({ ok: false, error: 'Member not found' });
        }
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // PUT /api/teams/:id/members/:uid — set role (admin only)
    router.put('/teams/:id/members/:uid', requirePermission('teams:manage'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const { role } = req.body ?? {};
        if (!role) {
          return res.status(400).json({ ok: false, error: '`role` is required' });
        }
        if (!VALID_ROLES.includes(role)) {
          return res.status(400).json({ ok: false, error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
        }
        const updated = teamStore.setMemberRole(req.params.id, req.params.uid, role);
        if (!updated) {
          return res.status(404).json({ ok: false, error: 'Member not found' });
        }
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // GET /api/teams/:id/projects — list projects
    router.get('/teams/:id/projects', requirePermission('teams:read'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const team = teamStore.getTeam(req.params.id);
        if (!team) {
          return res.status(404).json({ ok: false, error: `Team '${req.params.id}' not found` });
        }
        const projects = teamStore.listProjects(req.params.id);
        res.json({ ok: true, projects });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // POST /api/teams/:id/projects — add project (admin only)
    router.post('/teams/:id/projects', requirePermission('teams:manage'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const { projectId } = req.body ?? {};
        if (!projectId) {
          return res.status(400).json({ ok: false, error: '`projectId` is required' });
        }
        const team = teamStore.getTeam(req.params.id);
        if (!team) {
          return res.status(404).json({ ok: false, error: `Team '${req.params.id}' not found` });
        }
        teamStore.addProject(req.params.id, projectId);
        res.status(201).json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // DELETE /api/teams/:id/projects/:pid — remove project (admin only)
    router.delete('/teams/:id/projects/:pid', requirePermission('teams:manage'), (req, res) => {
      if (!requireTeamStore(res)) return;
      try {
        const removed = teamStore.removeProject(req.params.id, req.params.pid);
        if (!removed) {
          return res.status(404).json({ ok: false, error: 'Project association not found' });
        }
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
  app.put('/api/*splat', mutationLimiter);
  app.delete('/api/*splat', mutationLimiter);

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
  });

  return httpServer;
}
