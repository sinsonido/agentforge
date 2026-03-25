import eventBus from './event-bus.js';

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const VALID_STATUSES = ['queued', 'assigned', 'executing', 'completed', 'failed', 'waiting_quota', 'paused_budget'];

/**
 * Priority task queue.
 * Tasks are ordered by: priority (desc) → created_at (asc).
 * Only tasks with status 'queued' are eligible for execution.
 */
export class TaskQueue {
  constructor() {
    this._tasks = new Map();
    this._counter = 0;
  }

  add(taskData) {
    const task = {
      id: taskData.id || `t${++this._counter}`,
      title: taskData.title,
      type: taskData.type || 'implement',
      priority: taskData.priority || 'medium',
      status: 'queued',
      agent_id: taskData.agent_id || null,
      project_id: taskData.project_id || null,
      context_tokens_estimate: taskData.context_tokens_estimate || 0,
      depends_on: taskData.depends_on || [],
      force_model: taskData.force_model || null,
      allow_tier_downgrade: taskData.allow_tier_downgrade ?? true,
      created_at: Date.now(),
      assigned_at: null,
      completed_at: null,
      result: null,
      cost: 0,
      tokens_in: 0,
      tokens_out: 0,
      model_used: null,
    };
    this._tasks.set(task.id, task);
    eventBus.emit('task.queued', task);
    return task;
  }

  /**
   * Get next executable task.
   * Must be 'queued' and all dependencies must be 'completed'.
   */
  next() {
    const eligible = Array.from(this._tasks.values())
      .filter(t => t.status === 'queued')
      .filter(t => this._dependenciesMet(t))
      .sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority] ?? 2;
        const pb = PRIORITY_ORDER[b.priority] ?? 2;
        if (pa !== pb) return pa - pb;
        return a.created_at - b.created_at;
      });

    return eligible[0] || null;
  }

  get(id) {
    return this._tasks.get(id) || null;
  }

  updateStatus(id, status, extra = {}) {
    const task = this._tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    if (!VALID_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    task.status = status;
    Object.assign(task, extra);
    if (status === 'assigned') task.assigned_at = Date.now();
    if (status === 'completed' || status === 'failed') task.completed_at = Date.now();
    return task;
  }

  getByStatus(status) {
    return Array.from(this._tasks.values()).filter(t => t.status === status);
  }

  getByAgent(agentId) {
    return Array.from(this._tasks.values()).filter(t => t.agent_id === agentId);
  }

  getAll() {
    return Array.from(this._tasks.values());
  }

  clear() {
    this._tasks.clear();
  }

  stats() {
    const all = this.getAll();
    return {
      total: all.length,
      queued: all.filter(t => t.status === 'queued').length,
      executing: all.filter(t => t.status === 'executing').length,
      completed: all.filter(t => t.status === 'completed').length,
      failed: all.filter(t => t.status === 'failed').length,
      waiting: all.filter(t => t.status === 'waiting_quota').length,
    };
  }

  _dependenciesMet(task) {
    if (!task.depends_on?.length) return true;
    return task.depends_on.every(depId => {
      const dep = this._tasks.get(depId);
      return dep && dep.status === 'completed';
    });
  }
}

export default TaskQueue;
