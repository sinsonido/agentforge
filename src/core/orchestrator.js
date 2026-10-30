import eventBus from './event-bus.js';
import { ContextBuilder } from '../execution/context-builder.js';
import { OutputCollector } from '../execution/output-collector.js';
import { CostTracker } from './cost-tracker.js';
import { Budget, parseBudget, pauseEntry, pauseReason, resumeEntry, resumeStatus } from './budget.js';
import { SHUTDOWN } from '../execution/coding-runner.js';

/**
 * The Orchestrator is the main loop of AgentForge.
 * It pulls tasks from the queue, routes them, and dispatches execution.
 * Implements GitHub issue #2.
 */
export class Orchestrator {
  /**
   * `coding` runs `kind: 'coding'` tasks: `run(task, signal)` drives one leg of a task, to a
   * terminal status, `needs-approval` or `ci-watch`, at most `concurrency` legs at a time. A task
   * left in `ci-watch`, by a leg or by the previous process, gets its next leg before any queued
   * task starts. `decide(task, choice)`
   * applies the operator's approve or reject. Without it coding tasks stay queued.
   * `intake` polls for new coding tasks while the orchestrator runs.
   * Before each leg, `budget` decides whether the task may spend: a task over a
   * limit parks in `paused_budget` and resumes once the budget has room again.
   */
  constructor({ taskQueue, router, quotaManager, providerRegistry, agents, config, coding = null, intake = null, costTracker = null, budget = null }) {
    this.taskQueue = taskQueue;
    this.router = router;
    this.quotaManager = quotaManager;
    this.providers = providerRegistry;
    this.agents = agents || {};
    this.config = config || {};
    this._running = false;
    this._loopInterval = null;
    this.coding = coding;
    this.intake = intake;
    this._codingRuns = new Map();

    // Execution helpers
    this.contextBuilder = new ContextBuilder({ agents, config });
    this.outputCollector = new OutputCollector();
    this.costTracker = costTracker ?? new CostTracker(config);
    this.budget = budget ?? new Budget(parseBudget(this.config.budget).value, this.costTracker);

    // Init project budget
    if (config.project) {
      this.costTracker.initProject(
        config.project.name || 'default',
        config.project.budget || Infinity
      );
    }

    this._setupEventHandlers();
  }

  start(intervalMs = 500) {
    this._running = true;
    this.quotaManager.startWatcher();
    console.log('[orchestrator] Started. Polling every %dms.', intervalMs);
    this._loopInterval = setInterval(() => this._tick(), intervalMs);
    this.intake?.start();
  }

  /**
   * Stop the loop and abort every running coding task, which stops its container
   * and ends it `cancelled`, except a CI watch or fix round, which stays in `ci-watch`
   * for the next process. Resolves once those runs settle, or after `graceMs`.
   */
  stop({ graceMs = 20_000 } = {}) {
    this._running = false;
    this.quotaManager.stopWatcher();
    this.intake?.stop();
    if (this._loopInterval) {
      clearInterval(this._loopInterval);
      this._loopInterval = null;
    }
    const runs = [...this._codingRuns.values()];
    for (const run of runs) run.controller.abort(SHUTDOWN);
    console.log('[orchestrator] Stopped. Cancelling %d coding task(s).', runs.length);
    let timer;
    const grace = new Promise((r) => { timer = setTimeout(r, graceMs).unref(); });
    return Promise.race([Promise.all(runs.map((run) => run.done)), grace]).finally(() => clearTimeout(timer));
  }

  async _tick() {
    if (!this._running) return;
    this._resumeBudgetPaused();
    this._dispatchCoding();

    const task = this.taskQueue.next(t => t.kind !== 'coding');
    if (!task) return;

    // Route the task
    const projectId = task.project_id || this.config.project?.name || 'default';
    const budgetPct = this.costTracker.getBudgetRemainingPct(projectId);
    const route = this.router.resolve(task, { budget_remaining_pct: budgetPct });

    if (route.action === 'wait') {
      this.taskQueue.updateStatus(task.id, 'waiting_quota');
      console.log('[orchestrator] Task %s waiting: %s', task.id, route.reason);
      return;
    }

    // Assign and execute
    this.taskQueue.updateStatus(task.id, 'executing', { model_used: route.model });
    eventBus.emit('task.executing', { task, route });

    try {
      const result = await this._executeTask(task, route);

      // Record quota usage
      this.quotaManager.recordUsage(route.provider, result.tokens_in, result.tokens_out);

      // Calculate and record cost
      const cost = this._calculateCost(route.model, result.tokens_in, result.tokens_out);
      eventBus.emit('cost.recorded', {
        projectId,
        agentId: task.agent_id,
        model: route.model,
        tokensIn: result.tokens_in,
        tokensOut: result.tokens_out,
        cost,
        taskId: task.id,
      });

      // Parse output
      const output = this.outputCollector.parse(result, task);

      // Update task
      this.taskQueue.updateStatus(task.id, 'completed', {
        result: output.content,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        cost,
      });

      eventBus.emit('task.completed', { task: this.taskQueue.get(task.id), cost, route, output });
      console.log(
        '[orchestrator] Task %s completed. Model: %s, Cost: $%s, Tokens: %d/%d',
        task.id, route.model, cost.toFixed(4), result.tokens_in, result.tokens_out
      );

    } catch (error) {
      this.taskQueue.updateStatus(task.id, 'failed', { result: error.message });
      eventBus.emit('task.failed', { task, error: error.message });
      console.error('[orchestrator] Task %s failed: %s', task.id, error.message);
    }
  }

  /** Abort a running coding task. It ends `cancelled` and never opens a PR. */
  cancelTask(id) {
    const run = this._codingRuns.get(id);
    run?.controller.abort();
    return Boolean(run);
  }

  /**
   * Apply the operator's decision to a coding task in `needs-approval`.
   * @returns {Promise<object>|null} the coding loop's answer, or null without one
   */
  decideApproval(id, choice) {
    const task = this.taskQueue.get(id);
    if (!task || !this.coding?.decide) return null;
    if (choice.decision === 'approved' && task.status === 'needs-approval' && task.approval?.action === 'verify') {
      const over = this.budget.check(task, ['verify']);
      if (over) {
        this._pauseForBudget(task, over);
        return Promise.resolve({ ok: false, conflict: true, error: pauseReason(over) });
      }
    }
    return this.coding.decide(task, choice);
  }

  _dispatchCoding() {
    if (!this.coding) return;
    while (this._codingRuns.size < this.coding.concurrency) {
      const task = this.taskQueue.getByStatus('ci-watch').find(t => !this._codingRuns.has(t.id))
        ?? this.taskQueue.next(t => t.kind === 'coding');
      if (!task) return;
      const over = this.budget.check(task);
      if (over) {
        this._pauseForBudget(task, over);
        continue;
      }
      const controller = new globalThis.AbortController();
      const before = { cost: task.cost ?? 0, tokens_in: task.tokens_in ?? 0, tokens_out: task.tokens_out ?? 0 };
      const done = this.coding.run(task, controller.signal)
        .then(() => this._recordCodingCost(this.taskQueue.get(task.id), before))
        .catch((err) => console.error('[orchestrator] Coding task %s: %s', task.id, err.message))
        .finally(() => this._codingRuns.delete(task.id));
      this._codingRuns.set(task.id, { controller, done });
    }
  }

  /**
   * Record what one leg spent on its build: the task's totals minus what it had
   * spent `before`. `task.cost` counts only build runs; a verification emits its
   * own `cost.recorded` with `phase: 'verify'`.
   */
  _recordCodingCost(task, before) {
    const cost = (task.cost ?? 0) - before.cost;
    if (!cost) return;
    eventBus.emit('cost.recorded', {
      projectId: task.project_id || this.config.project?.name || 'default',
      agentId: task.agent_id,
      model: 'coding-executor',
      tokensIn: (task.tokens_in ?? 0) - before.tokens_in,
      tokensOut: (task.tokens_out ?? 0) - before.tokens_out,
      cost,
      taskId: task.id,
      repo: task.repo,
      phase: 'build',
    });
  }

  /** Park a coding task whose next leg would spend past `limit`. */
  _pauseForBudget(task, limit) {
    this.taskQueue.appendTrail(task.id, pauseEntry(limit, this.budget.policy.min_run_usd));
    this.taskQueue.updateStatus(task.id, 'paused_budget', { result: pauseReason(limit) });
    eventBus.emit('task.paused_budget', { task, limit });
  }

  /** Send back every parked coding task whose budget has room again. */
  _resumeBudgetPaused() {
    for (const task of this.taskQueue.getByStatus('paused_budget')) {
      if (task.kind !== 'coding' || this.budget.check(task)) continue;
      const status = resumeStatus(task);
      this.taskQueue.appendTrail(task.id, resumeEntry(status));
      this.taskQueue.updateStatus(task.id, status, { result: null });
      eventBus.emit(status === 'queued' ? 'task.queued' : 'task.ci_watch', { task });
    }
  }

  async _executeTask(task, route) {
    const agent = this.agents[task.agent_id] || {};

    // Build context-aware messages
    const { messages, estimated_tokens } = this.contextBuilder.buildFull(task, agent);

    // Update estimated tokens on task for quota pre-check
    if (estimated_tokens > 0) {
      task.context_tokens_estimate = estimated_tokens;
    }

    return this.providers.execute(route.provider, {
      model: route.model,
      messages,
      max_tokens: agent.max_tokens_per_task || 4096,
    });
  }

  _calculateCost(modelId, tokensIn, tokensOut) {
    const model = this.router.models[modelId];
    if (!model) return 0;
    // Pricing is per 1M tokens
    return (tokensIn * (model.cost_in || 0) / 1_000_000)
         + (tokensOut * (model.cost_out || 0) / 1_000_000);
  }

  _setupEventHandlers() {
    // When quota exhausted → pause waiting tasks
    eventBus.on('quota.exhausted', ({ provider }) => {
      console.log('[orchestrator] Quota exhausted for %s. Pausing related tasks.', provider);
      const executing = this.taskQueue.getByStatus('executing');
      for (const task of executing) {
        const model = this.router.models[task.model_used];
        if (model?.provider === provider) {
          this.taskQueue.updateStatus(task.id, 'waiting_quota');
          eventBus.emit('agent.paused', { agent: task.agent_id, reason: 'quota_exhausted' });
        }
      }
    });

    // When quota resets → re-queue waiting tasks
    eventBus.on('quota.reset', ({ provider }) => {
      console.log('[orchestrator] Quota reset for %s. Resuming agents.', provider);
      const waiting = this.taskQueue.getByStatus('waiting_quota');
      for (const task of waiting) {
        this.taskQueue.updateStatus(task.id, 'queued');
        eventBus.emit('agent.resumed', { agent: task.agent_id });
      }
    });

    // When the project budget is exceeded → pause queued text tasks. Coding tasks
    // answer to `budget` instead, before each leg.
    eventBus.on('budget.exceeded', ({ projectId, spent_pct }) => {
      console.warn(
        '[orchestrator] Budget exceeded for project %s (%.0f%% spent). Pausing queued tasks.',
        projectId, spent_pct * 100
      );
      const queued = this.taskQueue.getByStatus('queued').filter(t => t.kind !== 'coding');
      for (const task of queued) {
        if (!task.project_id || task.project_id === projectId) {
          this.taskQueue.updateStatus(task.id, 'paused_budget');
        }
      }
    });

    // Every tranche of spend, build or verify, goes into the ledger the budget reads.
    eventBus.on('cost.recorded', (record) => {
      this.costTracker.recordCost({ ...record, repo: record.repo ?? this.taskQueue.get(record.taskId)?.repo ?? null });
    });

    eventBus.on('task.step_changed', ({ taskId, step }) => {
      const task = this.taskQueue.get(taskId);
      if (task) this.taskQueue.updateStatus(taskId, task.status, { step });
    });

    // Budget warning — just log
    eventBus.on('budget.warning', ({ projectId, spent_pct }) => {
      console.warn(
        '[orchestrator] Budget warning for project %s: %.0f%% spent.',
        projectId, spent_pct * 100
      );
    });
  }
}

export default Orchestrator;
