import eventBus from '../core/event-bus.js';

/**
 * ReviewGate — Requires human or T1 agent approval before marking task complete.
 * Implements GitHub issue #31.
 */
export class ReviewGate {
  constructor({ config = {} } = {}) {
    this.requireReview = config.require_review_before_merge !== false;
    this.autoMergeOnCI = config.auto_merge_on_ci_pass || false;
    /** @type {Map<number, { task: Object, resolve: Function, reject: Function, createdAt: number }>} */
    this.pendingReviews = new Map();
  }

  /**
   * Gate a PR on review approval.
   * Returns a promise that resolves when approved or rejects when rejected.
   *
   * @param {number} prNumber - GitHub PR number
   * @param {Object} task - The task awaiting review
   * @returns {Promise<boolean>}
   */
  waitForApproval(prNumber, task) {
    if (!this.requireReview) return Promise.resolve(true);

    return new Promise((resolve, reject) => {
      this.pendingReviews.set(prNumber, {
        task,
        resolve,
        reject,
        createdAt: Date.now(),
      });

      eventBus.emit('review.pending', {
        pr_number: prNumber,
        task_id: task.id,
        message: `PR #${prNumber} awaiting review for task ${task.id}`,
      });

      console.log('[review-gate] PR #%d awaiting review for task %s', prNumber, task.id);
    });
  }

  /**
   * Approve a pending PR review.
   * @param {number} prNumber
   * @param {string} [reviewer] - Who approved
   */
  approve(prNumber, reviewer = 'unknown') {
    const pending = this.pendingReviews.get(prNumber);
    if (!pending) return false;

    pending.resolve(true);
    this.pendingReviews.delete(prNumber);

    eventBus.emit('review.approved', {
      pr_number: prNumber,
      task_id: pending.task.id,
      reviewer,
    });

    console.log('[review-gate] PR #%d approved by %s', prNumber, reviewer);
    return true;
  }

  /**
   * Reject a pending PR review.
   * @param {number} prNumber
   * @param {string} [reason]
   */
  reject(prNumber, reason = 'Review rejected') {
    const pending = this.pendingReviews.get(prNumber);
    if (!pending) return false;

    pending.reject(new Error(reason));
    this.pendingReviews.delete(prNumber);

    eventBus.emit('review.rejected', {
      pr_number: prNumber,
      task_id: pending.task.id,
      reason,
    });

    console.log('[review-gate] PR #%d rejected: %s', prNumber, reason);
    return true;
  }

  /** Get all PRs currently waiting for review */
  getPending() {
    return Array.from(this.pendingReviews.entries()).map(([prNumber, data]) => ({
      prNumber,
      taskId: data.task.id,
      waitingMs: Date.now() - data.createdAt,
    }));
  }

  hasPending() {
    return this.pendingReviews.size > 0;
  }
}

export default ReviewGate;
