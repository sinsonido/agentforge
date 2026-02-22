import eventBus from '../core/event-bus.js';

/**
 * ReviewWorkflow — Orchestrates the review process for agent tasks.
 * When an agent completes a task and require_review is true,
 * the task is submitted to a reviewer agent before final completion.
 *
 * Implements GitHub issue #24.
 */
export class ReviewWorkflow {
  /**
   * @param {Object} deps
   * @param {import('../core/task-queue.js').TaskQueue} deps.taskQueue
   * @param {import('./inter-agent-comm.js').InterAgentComm} deps.interAgentComm
   * @param {Object} deps.agents - Agent config map keyed by agent ID
   */
  constructor({ taskQueue, interAgentComm, agents }) {
    this.taskQueue = taskQueue;
    this.comm = interAgentComm;
    this.agents = agents;
    /** @type {Map<string, { task: Object, reviewTaskId: string }>} */
    this._pendingReviews = new Map(); // taskId → { task, reviewTaskId }
  }

  /**
   * Check if a task needs review based on the executing agent's config.
   * A task requires review when the agent has both `require_review: true`
   * and a `reviewer` agent ID configured.
   *
   * @param {Object} task
   * @returns {boolean}
   */
  needsReview(task) {
    const agent = this.agents[task.agent_id];
    return !!(agent?.require_review && agent?.reviewer);
  }

  /**
   * Submit a completed task for review.
   * Creates a review subtask delegated to the reviewer agent via InterAgentComm.
   *
   * @param {Object} task - The completed task
   * @returns {Promise<{ approved: boolean, feedback: string }>}
   */
  async submitForReview(task) {
    const agent = this.agents[task.agent_id];
    const reviewerId = agent?.reviewer;

    if (!reviewerId) {
      return { approved: true, feedback: 'No reviewer configured' };
    }

    eventBus.emit('review.submitted', { task_id: task.id, reviewer: reviewerId });

    try {
      const feedback = await this.comm.ask(
        task.agent_id,
        reviewerId,
        this._buildReviewPrompt(task),
        { type: 'review', priority: 'high' }
      );

      const approved = !feedback.toLowerCase().includes('reject');

      eventBus.emit('review.completed', {
        task_id: task.id,
        reviewer: reviewerId,
        approved,
      });

      return { approved, feedback };
    } catch (err) {
      eventBus.emit('review.completed', {
        task_id: task.id,
        reviewer: reviewerId,
        approved: false,
        error: err.message,
      });
      return { approved: false, feedback: err.message };
    }
  }

  /**
   * Build the review prompt sent to the reviewer agent.
   * Truncates the result to 2000 characters to stay within context limits.
   *
   * @param {Object} task
   * @returns {string}
   */
  _buildReviewPrompt(task) {
    return [
      `Please review the following completed task:`,
      ``,
      `Task: ${task.title}`,
      `Type: ${task.type}`,
      `Model used: ${task.model_used}`,
      ``,
      `Result:`,
      String(task.result || '(no result)').slice(0, 2000),
      ``,
      `Is this result acceptable? Reply with APPROVE or REJECT followed by feedback.`,
    ].join('\n');
  }
}

export default ReviewWorkflow;
