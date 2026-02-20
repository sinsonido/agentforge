import eventBus from './event-bus.js';

/**
 * The Orchestrator is the main loop of AgentForge.
 * It pulls tasks from the queue, routes them, and dispatches execution.
 */
export class Orchestrator {
  constructor({ taskQueue, router, quotaManager, providerRegistry, agents, config }) {
    this.taskQueue = taskQueue;
    this.router = router;
    this.quotaManager = quotaManager;
    this.providers = providerRegistry;
    this.agents = agents || {};
    this.config = config || {};
    this._running = false;
    this._loopInterval = null;

    this._setupEventHandlers();
  }

  start(intervalMs = 500) {
    this._running = true;
    this.quotaManager.startWatcher();
    console.log('[orchestrator] Started. Polling every %dms.', intervalMs);
    this._loopInterval = setInterval(() => this._tick(), intervalMs);
  }

  stop() {
    this._running = false;
    this.quotaManager.stopWatcher();
    if (this._loopInterval) {
      clearInterval(this._loopInterval);
      this._loopInterval = null;
    }
    console.log('[orchestrator] Stopped.');
  }

  async _tick() {
    if (!this._running) return;

    const task = this.taskQueue.next();
    if (!task) return;

    // Route the task
    const budgetPct = this._getBudgetRemainingPct(task.project_id);
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

      // Record usage
      this.quotaManager.recordUsage(route.provider, result.tokens_in, result.tokens_out);

      // Calculate cost
      const cost = this._calculateCost(route.model, result.tokens_in, result.tokens_out);

      // Update task
      this.taskQueue.updateStatus(task.id, 'completed', {
        result: result.content,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        cost,
      });

      eventBus.emit('task.completed', { task: this.taskQueue.get(task.id), cost, route });
      console.log('[orchestrator] Task %s completed. Model: %s, Cost: $%s', task.id, route.model, cost.toFixed(4));

    } catch (error) {
      this.taskQueue.updateStatus(task.id, 'failed', { result: error.message });
      eventBus.emit('task.failed', { task, error: error.message });
      console.error('[orchestrator] Task %s failed: %s', task.id, error.message);
    }
  }

  async _executeTask(task, route) {
    const agent = this.agents[task.agent_id];
    const systemPrompt = agent?.system_prompt || 'You are a helpful assistant.';

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task.title },
    ];

    return this.providers.execute(route.provider, {
      model: route.model,
      messages,
      max_tokens: agent?.max_tokens_per_task || 4096,
    });
  }

  _calculateCost(modelId, tokensIn, tokensOut) {
    const model = this.router.models[modelId];
    if (!model) return 0;
    // Pricing is per 1M tokens
    return (tokensIn * (model.cost_in || 0) / 1_000_000)
         + (tokensOut * (model.cost_out || 0) / 1_000_000);
  }

  _getBudgetRemainingPct(projectId) {
    // TODO: Read from cost tracker / DB
    return 1.0;
  }

  _setupEventHandlers() {
    // When quota exhausted → re-queue waiting tasks
    eventBus.on('quota.exhausted', ({ provider }) => {
      console.log('[orchestrator] Quota exhausted for %s. Pausing related agents.', provider);
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
  }
}

export default Orchestrator;
