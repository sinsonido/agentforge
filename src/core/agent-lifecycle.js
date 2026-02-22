import eventBus from './event-bus.js';

/**
 * Valid agent states and allowed transitions.
 * idle → assigned → executing → reviewing → completed
 *                             ↘ failed
 * any → paused → idle
 */
const TRANSITIONS = {
  idle:      ['assigned', 'paused'],
  assigned:  ['executing', 'idle', 'failed'],
  executing: ['reviewing', 'completed', 'failed', 'paused'],
  reviewing: ['completed', 'failed', 'executing'],
  completed: ['idle'],
  failed:    ['idle'],
  paused:    ['idle'],
};

/**
 * AgentLifecycle — State machine for a single agent.
 * Implements GitHub issue #21.
 */
export class AgentLifecycle {
  constructor(agentConfig) {
    this.id = agentConfig.id;
    this.name = agentConfig.name || agentConfig.id;
    this.config = agentConfig;
    this.state = 'idle';
    this.currentTaskId = null;
    this.history = []; // { from, to, data, timestamp }
  }

  /**
   * Transition to a new state.
   * @param {string} newState
   * @param {Object} data - Extra context for the event
   */
  transition(newState, data = {}) {
    const allowed = TRANSITIONS[this.state];
    if (!allowed?.includes(newState)) {
      throw new Error(
        `AgentLifecycle(${this.id}): invalid transition ${this.state} → ${newState}`
      );
    }

    const entry = {
      from: this.state,
      to: newState,
      data,
      timestamp: Date.now(),
    };

    this.history.push(entry);
    this.state = newState;

    eventBus.emit(`agent.${newState}`, {
      agent: this.id,
      name: this.name,
      taskId: this.currentTaskId,
      ...data,
    });

    return this;
  }

  /** Assign a task to this agent */
  assign(taskId) {
    this.currentTaskId = taskId;
    return this.transition('assigned', { taskId });
  }

  /** Mark agent as actively executing */
  startExecution() {
    return this.transition('executing');
  }

  /** Move to review state (waiting for human or T1 review) */
  startReview() {
    return this.transition('reviewing');
  }

  /** Mark task as completed, return to idle */
  complete() {
    const taskId = this.currentTaskId;
    this.currentTaskId = null;
    return this.transition('completed', { taskId });
  }

  /** Mark task as failed */
  fail(reason) {
    const taskId = this.currentTaskId;
    this.currentTaskId = null;
    return this.transition('failed', { taskId, reason });
  }

  /** Pause agent (quota exhausted, budget exceeded, etc.) */
  pause(reason) {
    return this.transition('paused', { reason });
  }

  /** Resume from paused or reset from failed/completed → idle */
  resume() {
    return this.transition('idle');
  }

  isAvailable() {
    return this.state === 'idle';
  }

  getStatus() {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      currentTaskId: this.currentTaskId,
      historyLength: this.history.length,
    };
  }
}

/**
 * AgentPool — Manages all registered agents.
 * Implements GitHub issue #21.
 */
export class AgentPool {
  constructor() {
    this.agents = new Map(); // id → AgentLifecycle
  }

  /**
   * Register an agent from config.
   * @param {Object} agentConfig - Agent config with id, name, etc.
   */
  register(agentConfig) {
    const lifecycle = new AgentLifecycle(agentConfig);
    this.agents.set(agentConfig.id, lifecycle);
    return lifecycle;
  }

  get(id) {
    return this.agents.get(id) || null;
  }

  /** Get all agents in 'idle' state */
  getAvailable() {
    return Array.from(this.agents.values()).filter(a => a.isAvailable());
  }

  /** Get agents currently executing */
  getExecuting() {
    return Array.from(this.agents.values()).filter(a => a.state === 'executing');
  }

  getAll() {
    return Array.from(this.agents.values());
  }

  getAllStatuses() {
    const result = {};
    for (const [id, agent] of this.agents) {
      result[id] = agent.getStatus();
    }
    return result;
  }

  has(id) {
    return this.agents.has(id);
  }
}

export default AgentPool;
