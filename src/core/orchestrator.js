import eventBus from './event-bus.js';
import { ContextBuilder } from '../execution/context-builder.js';
import { OutputCollector } from '../execution/output-collector.js';
import { CostTracker } from './cost-tracker.js';

/**
 * The Orchestrator is the main loop of AgentForge.
 * It pulls tasks from the queue, routes them, and dispatches execution.
 * Implements GitHub issue #2.
 */
export class Orchestrator {
  /**
   * `coding` runs `kind: 'coding'` tasks: `run(task, signal)` drives one task to a
   * terminal status, at most `concurrency` at a time. Without it coding tasks stay queued.
   * `intake` polls for new coding tasks while the orchestrator runs.
   */
  constructor({ taskQueue, router, quotaManager, providerRegistry, agents, config, coding = null, intake = null }) {
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
    this.costTracker = new CostTracker(config);

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

  stop() {
    this._running = false;
    this.quotaManager.stopWatcher();
    this.intake?.stop();
    if (this._loopInterval) {
      clearInterval(this._loopInterval);
      this._loopInterval = null;
    }
    console.log('[orchestrator] Stopped.');
  }

  async _tick() {
    if (!this._running) return;
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
      this.costTracker.recordCost(projectId, task.agent_id, route.model, cost);
      eventBus.emit('cost.recorded', {
        projectId,
        agentId: task.agent_id,
        model: route.model,
        tokensIn: result.tokens_in,
        tokensOut: result.tokens_out,
        cost,
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
    run?.abort();
    return Boolean(run);
  }

  _dispatchCoding() {
    if (!this.coding) return;
    while (this._codingRuns.size < this.coding.concurrency) {
      const task = this.taskQueue.next(t => t.kind === 'coding');
      if (!task) return;
      const controller = new globalThis.AbortController();
      this._codingRuns.set(task.id, controller);
      this.coding.run(task, controller.signal)
        .then(() => this._recordCodingCost(this.taskQueue.get(task.id)))
        .catch((err) => console.error('[orchestrator] Coding task %s: %s', task.id, err.message))
        .finally(() => this._codingRuns.delete(task.id));
    }
  }

  _recordCodingCost(task) {
    if (!task.cost) return;
    const projectId = task.project_id || this.config.project?.name || 'default';
    this.costTracker.recordCost(projectId, task.agent_id, 'coding-executor', task.cost);
    eventBus.emit('cost.recorded', {
      projectId,
      agentId: task.agent_id,
      model: 'coding-executor',
      tokensIn: task.tokens_in,
      tokensOut: task.tokens_out,
      cost: task.cost,
    });
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
      tools: agent.tools?.length ? this._resolveTools(agent.tools) : undefined,
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

  /** Resolve tool names to tool definitions (placeholder — tools registry TBD) */
  _resolveTools(_toolNames) {
    // For now return empty — tool registry comes in a future issue
    return [];
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

    // When budget exceeded → pause all new executions
    eventBus.on('budget.exceeded', ({ projectId, spent_pct }) => {
      console.warn(
        '[orchestrator] Budget exceeded for project %s (%.0f%% spent). Pausing queued tasks.',
        projectId, spent_pct * 100
      );
      const queued = this.taskQueue.getByStatus('queued');
      for (const task of queued) {
        if (!task.project_id || task.project_id === projectId) {
          this.taskQueue.updateStatus(task.id, 'paused_budget');
        }
      }
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
