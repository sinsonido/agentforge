import { EventEmitter } from 'node:events';

/**
 * Central event bus for AgentForge.
 * All components communicate through events, not direct references.
 *
 * Events:
 *   task.queued, task.assigned, task.executing, task.completed, task.failed
 *   quota.throttled, quota.exhausted, quota.reset
 *   agent.paused, agent.resumed
 *   budget.warning, budget.exceeded
 *   git.committed, git.pr_created
 */
class AgentForgeEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._log = [];
  }

  emit(event, data) {
    const entry = { event, data, timestamp: Date.now() };
    this._log.push(entry);
    if (this._log.length > 1000) this._log.shift();
    return super.emit(event, data);
  }

  getRecentEvents(n = 50) {
    return this._log.slice(-n);
  }
}

// Singleton
const eventBus = new AgentForgeEventBus();
export default eventBus;
