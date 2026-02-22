import eventBus from '../core/event-bus.js';

/**
 * InterAgentComm — ask_agent tool implementation.
 * Allows agents to delegate sub-questions to other agents.
 *
 * Implements GitHub issue #23.
 */
export class InterAgentComm {
  /**
   * @param {Object} deps
   * @param {import('../core/task-queue.js').TaskQueue} deps.taskQueue
   * @param {import('../core/orchestrator.js').Orchestrator} deps.orchestrator
   */
  constructor({ taskQueue, orchestrator }) {
    this.taskQueue = taskQueue;
    this.orchestrator = orchestrator;
    /** @type {Map<string, { resolve: Function, reject: Function }>} */
    this._pending = new Map(); // taskId → { resolve, reject }
  }

  /**
   * Ask another agent a question. Creates a subtask and waits for result.
   * This is the "ask_agent" tool that agents can call.
   *
   * @param {string} fromAgentId - Requesting agent
   * @param {string} toAgentId - Target agent
   * @param {string} question - The question/task
   * @param {Object} [opts]
   * @param {string} [opts.type] - Task type (default: 'implement')
   * @param {string} [opts.priority] - Task priority (default: 'high')
   * @param {string} [opts.project_id] - Project to associate the subtask with
   * @param {Object} [opts.context] - Additional context forwarded to the subtask
   * @returns {Promise<string>} The agent's response
   */
  async ask(fromAgentId, toAgentId, question, opts = {}) {
    const task = this.taskQueue.add({
      title: question,
      type: opts.type || 'implement',
      priority: opts.priority || 'high',
      agent_id: toAgentId,
      project_id: opts.project_id,
      context: opts.context,
    });

    return new Promise((resolve, reject) => {
      this._pending.set(task.id, { resolve, reject });

      // Listen for completion
      const onComplete = ({ task: t }) => {
        if (t.id === task.id) {
          eventBus.off('task.completed', onComplete);
          eventBus.off('task.failed', onFailed);
          this._pending.delete(task.id);
          resolve(t.result || '');
        }
      };

      const onFailed = ({ task: t, error }) => {
        if (t.id === task.id) {
          eventBus.off('task.completed', onComplete);
          eventBus.off('task.failed', onFailed);
          this._pending.delete(task.id);
          reject(new Error(error));
        }
      };

      eventBus.on('task.completed', onComplete);
      eventBus.on('task.failed', onFailed);

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this._pending.has(task.id)) {
          eventBus.off('task.completed', onComplete);
          eventBus.off('task.failed', onFailed);
          this._pending.delete(task.id);
          reject(new Error(`ask_agent timeout: task ${task.id} did not complete in 5 minutes`));
        }
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Get the ask_agent tool definition for provider.execute().
   * @returns {Object} Tool definition in Anthropic input_schema format
   */
  getToolDefinition() {
    return {
      name: 'ask_agent',
      description: 'Ask another agent to perform a task and return the result',
      input_schema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent to ask' },
          question: { type: 'string', description: 'The task or question' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'], default: 'high' },
        },
        required: ['agent_id', 'question'],
      },
    };
  }

  /**
   * Number of in-flight inter-agent requests.
   * @returns {number}
   */
  pendingCount() {
    return this._pending.size;
  }
}

export default InterAgentComm;
