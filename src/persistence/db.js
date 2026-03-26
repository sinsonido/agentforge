import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * AgentForgeDB — SQLite persistence layer using better-sqlite3.
 * Stores task history, cost records, and event logs.
 * Implements GitHub issue #43.
 */
export class AgentForgeDB {
  constructor(dbPath = '.agentforge/data.db') {
    const fullPath = resolve(process.cwd(), dbPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    this.db = new Database(fullPath);
    this._init();
  }

  _init() {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT,
        status TEXT,
        agent_id TEXT,
        project_id TEXT,
        model_used TEXT,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        result TEXT,
        created_at INTEGER,
        assigned_at INTEGER,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS cost_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT,
        agent_id TEXT,
        model TEXT,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        recorded_at INTEGER DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        data TEXT,
        timestamp INTEGER DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS agent_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        task_id TEXT,
        data TEXT,
        timestamp INTEGER DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE,
        password_hash TEXT NOT NULL DEFAULT '',
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'viewer',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_login INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
        token TEXT NOT NULL UNIQUE,
        invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        status TEXT NOT NULL DEFAULT 'pending'
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_cost_project ON cost_records(project_id);
      CREATE INDEX IF NOT EXISTS idx_events_name ON events(event);
      -- Note: idx_invitations_token is implicit from UNIQUE constraint on token
      CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);
    `);

    // Prepared statements for performance
    this._stmts = {
      upsertTask: this.db.prepare(`
        INSERT INTO tasks (id, title, type, status, agent_id, project_id, model_used, tokens_in, tokens_out, cost, result, created_at, assigned_at, completed_at)
        VALUES (@id, @title, @type, @status, @agent_id, @project_id, @model_used, @tokens_in, @tokens_out, @cost, @result, @created_at, @assigned_at, @completed_at)
        ON CONFLICT(id) DO UPDATE SET
          status=excluded.status, model_used=excluded.model_used,
          tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out,
          cost=excluded.cost, result=excluded.result,
          assigned_at=excluded.assigned_at, completed_at=excluded.completed_at
      `),
      getTask: this.db.prepare('SELECT * FROM tasks WHERE id = ?'),
      getTasksByStatus: this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC'),
      getTaskHistory: this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?'),
      insertCost: this.db.prepare(`
        INSERT INTO cost_records (project_id, agent_id, model, tokens_in, tokens_out, cost)
        VALUES (@project_id, @agent_id, @model, @tokens_in, @tokens_out, @cost)
      `),
      totalCost: this.db.prepare('SELECT COALESCE(SUM(cost), 0) as total FROM cost_records WHERE project_id = ?'),
      costByAgent: this.db.prepare('SELECT agent_id, COALESCE(SUM(cost), 0) as total FROM cost_records WHERE project_id = ? GROUP BY agent_id'),
      insertEvent: this.db.prepare('INSERT INTO events (event, data) VALUES (?, ?)'),
      recentEvents: this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
      insertActivity: this.db.prepare(`
        INSERT INTO agent_activity (agent_id, from_state, to_state, task_id, data)
        VALUES (@agent_id, @from_state, @to_state, @task_id, @data)
      `),
    };
  }

  // ─── Task operations ────────────────────────────────

  /** Save or update a task */
  saveTask(task) {
    this._stmts.upsertTask.run({
      id: task.id,
      title: task.title,
      type: task.type || null,
      status: task.status,
      agent_id: task.agent_id || null,
      project_id: task.project_id || null,
      model_used: task.model_used || null,
      tokens_in: task.tokens_in || 0,
      tokens_out: task.tokens_out || 0,
      cost: task.cost || 0,
      result: task.result ? String(task.result).slice(0, 10000) : null,
      created_at: task.created_at || Date.now(),
      assigned_at: task.assigned_at || null,
      completed_at: task.completed_at || null,
    });
  }

  /** Get a task by ID */
  getTask(id) {
    return this._stmts.getTask.get(id) || null;
  }

  /** Get tasks by status */
  getTasksByStatus(status) {
    return this._stmts.getTasksByStatus.all(status);
  }

  /** Get recent task history */
  getTaskHistory(limit = 100) {
    return this._stmts.getTaskHistory.all(limit);
  }

  // ─── Cost operations ─────────────────────────────────

  /** Record a cost entry */
  recordCost(projectId, agentId, model, tokensIn, tokensOut, cost) {
    this._stmts.insertCost.run({
      project_id: projectId,
      agent_id: agentId,
      model,
      tokens_in: tokensIn || 0,
      tokens_out: tokensOut || 0,
      cost: cost || 0,
    });
  }

  /** Get total spend for a project */
  getTotalCost(projectId) {
    return this._stmts.totalCost.get(projectId)?.total || 0;
  }

  /** Get cost breakdown by agent for a project */
  getCostByAgent(projectId) {
    return this._stmts.costByAgent.all(projectId);
  }

  // ─── Event log ───────────────────────────────────────

  /** Log an event */
  logEvent(event, data) {
    const serialized = data ? JSON.stringify(data) : null;
    this._stmts.insertEvent.run(event, serialized);
  }

  /** Get recent events */
  getRecentEvents(limit = 100) {
    return this._stmts.recentEvents.all(limit).map(e => ({
      ...e,
      data: e.data ? JSON.parse(e.data) : null,
    }));
  }

  // ─── Agent activity ──────────────────────────────────

  /** Log an agent state transition */
  logAgentActivity(agentId, fromState, toState, taskId, data = {}) {
    this._stmts.insertActivity.run({
      agent_id: agentId,
      from_state: fromState,
      to_state: toState,
      task_id: taskId || null,
      data: Object.keys(data).length ? JSON.stringify(data) : null,
    });
  }

  close() {
    this.db.close();
  }
}

export default AgentForgeDB;
