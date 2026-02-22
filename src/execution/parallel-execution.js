import eventBus from '../core/event-bus.js';

/**
 * ParallelExecution — Manages concurrent agent execution.
 * The orchestrator uses this to run multiple tasks at the same time.
 *
 * Implements GitHub issue #25.
 */
export class ParallelExecution {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxConcurrent=4] - Maximum number of tasks to execute simultaneously
   */
  constructor({ maxConcurrent = 4 } = {}) {
    this.maxConcurrent = maxConcurrent;
    /** @type {Map<string, Promise<any>>} */
    this._running = new Map(); // taskId → Promise
  }

  /**
   * How many execution slots are currently available.
   * @returns {number}
   */
  availableSlots() {
    return Math.max(0, this.maxConcurrent - this._running.size);
  }

  /**
   * Whether there is room to start at least one more task.
   * @returns {boolean}
   */
  hasCapacity() {
    return this._running.size < this.maxConcurrent;
  }

  /**
   * Start executing a task. Non-blocking — registers the promise and returns it.
   * Emits 'parallel.task_started' on start and 'parallel.slot_freed' on completion.
   *
   * @param {string} taskId
   * @param {Function} executeFn - Async function that executes the task
   * @returns {Promise<any>} Resolves/rejects with the executeFn result
   * @throws {Error} If already at capacity
   */
  async start(taskId, executeFn) {
    if (!this.hasCapacity()) {
      throw new Error(`ParallelExecution: at capacity (${this.maxConcurrent} max)`);
    }

    const promise = executeFn().finally(() => {
      this._running.delete(taskId);
      eventBus.emit('parallel.slot_freed', { taskId, running: this._running.size });
    });

    this._running.set(taskId, promise);
    eventBus.emit('parallel.task_started', { taskId, running: this._running.size });

    return promise;
  }

  /**
   * Wait for all currently running tasks to settle (resolve or reject).
   * @returns {Promise<PromiseSettledResult<any>[]>}
   */
  async waitAll() {
    await Promise.allSettled(Array.from(this._running.values()));
  }

  /**
   * Current execution statistics.
   * @returns {{ running: number, capacity: number, available: number, taskIds: string[] }}
   */
  getStats() {
    return {
      running: this._running.size,
      capacity: this.maxConcurrent,
      available: this.availableSlots(),
      taskIds: Array.from(this._running.keys()),
    };
  }
}

export default ParallelExecution;
