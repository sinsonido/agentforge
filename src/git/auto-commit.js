import eventBus from '../core/event-bus.js';

/**
 * AutoCommit — Auto-commits changes after agent task completion.
 * Implements GitHub issue #29.
 */
export class AutoCommit {
  constructor({ gitManager, config = {} }) {
    this.git = gitManager;
    this.commitFormat = config.commit_format || '[AgentForge] {task_title} (#{task_id})';
    this.enabled = config.auto_commit !== false;
  }

  /**
   * Format a commit message from task context.
   * @param {Object} task
   * @param {Object} [model] - Model info { tier }
   * @returns {string}
   */
  formatMessage(task, model = {}) {
    return this.commitFormat
      .replace('{task_id}', task.id)
      .replace('{task_title}', (task.title || 'task').slice(0, 72))
      .replace('{task_type}', task.type || 'implement')
      .replace('{tier}', model.tier || '?')
      .replace('{agent_id}', task.agent_id || 'agent');
  }

  /**
   * Commit all pending changes for a completed task.
   * @param {Object} task - Completed task
   * @param {Object} [model] - Model config used { tier, provider }
   * @returns {Promise<string|null>} Commit SHA or null if nothing to commit
   */
  async commitTask(task, model = {}) {
    if (!this.enabled) return null;
    if (!this.git.hasUncommittedChanges()) return null;

    const message = this.formatMessage(task, model);
    const sha = await this.git.commit(message);

    if (sha) {
      eventBus.emit('git.committed', {
        task_id: task.id,
        sha,
        message,
        branch: this.git.getCurrentBranch(),
      });
    }

    return sha;
  }
}

export default AutoCommit;
