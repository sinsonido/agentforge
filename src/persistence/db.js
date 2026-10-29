import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CODING_FIELDS, TERMINAL_STATUSES } from '../core/task-model.js';
import { boundEntry } from '../core/trail.js';

// Schema upgrades, applied in order. PRAGMA user_version counts how many have run,
// so an existing DB file gets only the ones it is missing.
const MIGRATIONS = [
  `ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium';
   ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE tasks ADD COLUMN force_model TEXT;
   ALTER TABLE tasks ADD COLUMN allow_tier_downgrade INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE tasks ADD COLUMN context_tokens_estimate INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
   ALTER TABLE tasks ADD COLUMN repo TEXT;
   ALTER TABLE tasks ADD COLUMN base TEXT;
   ALTER TABLE tasks ADD COLUMN instruction TEXT;
   ALTER TABLE tasks ADD COLUMN issue INTEGER;
   ALTER TABLE tasks ADD COLUMN playbook TEXT;
   ALTER TABLE tasks ADD COLUMN step TEXT;
   ALTER TABLE tasks ADD COLUMN budget REAL;
   CREATE UNIQUE INDEX idx_tasks_coding_admission ON tasks(repo, issue, playbook)
     WHERE kind = 'coding' AND issue IS NOT NULL AND status NOT IN ('completed', 'failed');`,
  `ALTER TABLE tasks ADD COLUMN pr_url TEXT;
   DROP INDEX idx_tasks_coding_admission;
   CREATE UNIQUE INDEX idx_tasks_coding_admission ON tasks(repo, issue, playbook)
     WHERE kind = 'coding' AND issue IS NOT NULL AND status NOT IN ('completed', 'failed', 'pr-opened', 'cancelled');`,
  `ALTER TABLE tasks ADD COLUMN setup_command TEXT;
   ALTER TABLE tasks ADD COLUMN test_command TEXT;
   UPDATE tasks SET setup_command = 'npm ci', test_command = 'npm test' WHERE kind = 'coding';`,
  `CREATE TABLE task_events (
     task_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at INTEGER NOT NULL,
     event TEXT NOT NULL,
     PRIMARY KEY (task_id, seq)
   ) WITHOUT ROWID;`,
  `CREATE TABLE task_trail (
     task_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     summary TEXT NOT NULL,
     evidence TEXT,
     PRIMARY KEY (task_id, seq)
   );`,
  `ALTER TABLE tasks ADD COLUMN approval TEXT;`,
  `ALTER TABLE tasks ADD COLUMN babysit TEXT;`,
];

/** A task keeps its newest TASK_EVENTS_CAP agent events; older ones are pruned. */
export const TASK_EVENTS_CAP = 5000;
/** Any string inside a stored agent event is clipped to this many characters. */
export const EVENT_STRING_MAX = 4000;
/** Page size of taskEventsAfter(). */
export const TASK_EVENTS_PAGE = 500;

/** Copy of `value` with every string longer than `max` cut, saying how much was cut. */
export function clipStrings(value, max = EVENT_STRING_MAX) {
  if (typeof value === 'string') {
    return value.length > max ? `${value.slice(0, max)}… [clipped ${value.length - max} chars]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, max));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipStrings(v, max)]));
  }
  return value;
}

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

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_cost_project ON cost_records(project_id);
      CREATE INDEX IF NOT EXISTS idx_events_name ON events(event);
    `);

    this._migrate();

    // Prepared statements for performance
    this._stmts = {
      upsertTask: this.db.prepare(`
        INSERT INTO tasks (id, title, type, status, agent_id, project_id, model_used, tokens_in, tokens_out, cost, result, created_at, assigned_at, completed_at,
                           priority, depends_on, force_model, allow_tier_downgrade, context_tokens_estimate,
                           kind, repo, base, instruction, issue, playbook, step, budget, pr_url, setup_command, test_command, approval, babysit)
        VALUES (@id, @title, @type, @status, @agent_id, @project_id, @model_used, @tokens_in, @tokens_out, @cost, @result, @created_at, @assigned_at, @completed_at,
                @priority, @depends_on, @force_model, @allow_tier_downgrade, @context_tokens_estimate,
                @kind, @repo, @base, @instruction, @issue, @playbook, @step, @budget, @pr_url, @setup_command, @test_command, @approval, @babysit)
        ON CONFLICT(id) DO UPDATE SET
          status=excluded.status, step=excluded.step, pr_url=excluded.pr_url, approval=excluded.approval, babysit=excluded.babysit, model_used=excluded.model_used,
          tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out,
          cost=excluded.cost, result=excluded.result,
          assigned_at=excluded.assigned_at, completed_at=excluded.completed_at
      `),
      getTask: this.db.prepare('SELECT * FROM tasks WHERE id = ?'),
      getTasksByStatus: this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC'),
      getTaskHistory: this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?'),
      liveTasks: this.db.prepare(`
        SELECT * FROM tasks WHERE status NOT IN (${TERMINAL_STATUSES.map(s => `'${s}'`).join(', ')})
        ORDER BY created_at, rowid
      `),
      lastTaskSeq: this.db.prepare(`
        SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) AS seq FROM tasks
        WHERE id GLOB 't[0-9]*' AND NOT SUBSTR(id, 2) GLOB '*[^0-9]*'
      `),
      appendTrail: this.db.prepare(`
        INSERT INTO task_trail (task_id, seq, at, kind, summary, evidence)
        VALUES (@task_id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_trail WHERE task_id = @task_id), @at, @kind, @summary, @evidence)
        RETURNING seq, at, kind, summary, evidence
      `),
      getTrail: this.db.prepare('SELECT seq, at, kind, summary, evidence FROM task_trail WHERE task_id = ? ORDER BY seq'),
      insertCost: this.db.prepare(`
        INSERT INTO cost_records (project_id, agent_id, model, tokens_in, tokens_out, cost)
        VALUES (@project_id, @agent_id, @model, @tokens_in, @tokens_out, @cost)
      `),
      totalCost: this.db.prepare('SELECT COALESCE(SUM(cost), 0) as total FROM cost_records WHERE project_id = ?'),
      costByAgent: this.db.prepare('SELECT agent_id, COALESCE(SUM(cost), 0) as total FROM cost_records WHERE project_id = ? GROUP BY agent_id'),
      insertEvent: this.db.prepare('INSERT INTO events (event, data) VALUES (?, ?)'),
      recentEvents: this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
      appendTaskEvent: this.db.prepare(`
        INSERT INTO task_events (task_id, seq, at, event)
        SELECT @task_id, COALESCE(MAX(seq), 0) + 1, @at, @event FROM task_events WHERE task_id = @task_id
        RETURNING seq
      `),
      pruneTaskEvents: this.db.prepare('DELETE FROM task_events WHERE task_id = ? AND seq <= ?'),
      taskEventsAfter: this.db.prepare('SELECT seq, at, event FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
      insertActivity: this.db.prepare(`
        INSERT INTO agent_activity (agent_id, from_state, to_state, task_id, data)
        VALUES (@agent_id, @from_state, @to_state, @task_id, @data)
      `),
    };
  }

  _migrate() {
    const applied = this.db.pragma('user_version', { simple: true });
    MIGRATIONS.slice(applied).forEach((sql, i) => {
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.pragma(`user_version = ${applied + i + 1}`);
      })();
    });
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
      priority: task.priority || 'medium',
      depends_on: JSON.stringify(task.depends_on || []),
      force_model: task.force_model || null,
      allow_tier_downgrade: task.allow_tier_downgrade === false ? 0 : 1,
      context_tokens_estimate: task.context_tokens_estimate || 0,
      kind: task.kind || 'text',
      ...Object.fromEntries(CODING_FIELDS.map(f => [f, task[f] ?? null])),
      // better-sqlite3 binds a JS number as REAL, which the TEXT column would keep as '5.0'.
      step: task.step == null ? null : String(task.step),
      approval: task.approval ? JSON.stringify(task.approval) : null,
      babysit: task.babysit ? JSON.stringify(task.babysit) : null,
    });
  }

  /**
   * Load what a TaskQueue needs at boot: every non-terminal task, the tasks they
   * depend on, and the highest generated `t<n>` id so new ids never reuse an old one.
   */
  loadQueue() {
    const live = this._stmts.liveTasks.all().map(rowToTask);
    const loaded = new Set(live.map(t => t.id));
    const deps = [];
    for (const depId of live.flatMap(t => t.depends_on)) {
      if (loaded.has(depId)) continue;
      loaded.add(depId);
      const row = this.getTask(depId);
      if (row) deps.push(rowToTask(row));
    }
    return { tasks: [...live, ...deps], lastSeq: this._stmts.lastTaskSeq.get().seq };
  }

  /** Get a task by ID */
  getTask(id) {
    return this._stmts.getTask.get(id) || null;
  }

  /** A stored task in the shape the queue holds it, or null */
  findTask(id) {
    const row = this.getTask(id);
    return row ? rowToTask(row) : null;
  }

  /** Get tasks by status */
  getTasksByStatus(status) {
    return this._stmts.getTasksByStatus.all(status).map(rowToTask);
  }

  /** Get recent task history */
  getTaskHistory(limit = 100) {
    return this._stmts.getTaskHistory.all(limit).map(rowToTask);
  }

  // ─── Decision trail ──────────────────────────────────

  /**
   * Append one entry to a task's trail. `seq` counts from 1 per task.
   * @param {string} taskId
   * @param {import('../core/trail.js').TrailInput} entry
   * @returns {import('../core/trail.js').TrailEntry}
   */
  appendTrail(taskId, entry) {
    const { kind, summary, evidence } = boundEntry(entry);
    const row = this._stmts.appendTrail.get({
      task_id: taskId, at: Date.now(), kind, summary, evidence: evidence ? JSON.stringify(evidence) : null,
    });
    return rowToTrail(row);
  }

  /** @returns {import('../core/trail.js').TrailEntry[]} the task's trail in order */
  getTrail(taskId) {
    return this._stmts.getTrail.all(taskId).map(rowToTrail);
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

  // ─── Task events (agent transcript) ──────────────────

  /**
   * Append one agent event to a task's transcript under the next per-task `seq`,
   * clipping long strings and pruning past TASK_EVENTS_CAP.
   * @returns {{ seq: number, at: number, event: object }} the stored entry
   */
  appendTaskEvent(taskId, event, at = Date.now()) {
    const clipped = clipStrings(event);
    const { seq } = this._stmts.appendTaskEvent.get({ task_id: taskId, at, event: JSON.stringify(clipped) });
    if (seq > TASK_EVENTS_CAP) this._stmts.pruneTaskEvents.run(taskId, seq - TASK_EVENTS_CAP);
    return { seq, at, event: clipped };
  }

  /** Up to TASK_EVENTS_PAGE stored events of a task with seq > `after`, oldest first. */
  taskEventsAfter(taskId, after = 0) {
    const rows = this._stmts.taskEventsAfter.all(taskId, after, TASK_EVENTS_PAGE + 1);
    return {
      events: rows.slice(0, TASK_EVENTS_PAGE).map((r) => ({ seq: r.seq, at: r.at, event: JSON.parse(r.event) })),
      more: rows.length > TASK_EVENTS_PAGE,
    };
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

function rowToTrail(row) {
  return { ...row, evidence: row.evidence ? JSON.parse(row.evidence) : null };
}

function rowToTask(row) {
  const task = {
    ...row,
    depends_on: JSON.parse(row.depends_on),
    allow_tier_downgrade: row.allow_tier_downgrade === 1,
    approval: row.approval ? JSON.parse(row.approval) : null,
    babysit: row.babysit ? JSON.parse(row.babysit) : null,
  };
  if (task.kind !== 'coding') for (const f of CODING_FIELDS) delete task[f];
  return task;
}

export default AgentForgeDB;
