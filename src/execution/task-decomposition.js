/**
 * TaskDecomposition — T1 (strategy-tier) agent breaks tasks into subtasks.
 * The decomposer calls the T1 model to plan, then adds subtasks to the queue.
 *
 * Implements GitHub issue #26.
 */
export class TaskDecomposition {
  /**
   * @param {Object} deps
   * @param {import('../core/task-queue.js').TaskQueue} deps.taskQueue
   * @param {import('../routing/router.js').Router} deps.router
   * @param {import('../providers/interface.js').ProviderRegistry} deps.providerRegistry
   * @param {Object} deps.agents - Agent config map keyed by agent ID
   */
  constructor({ taskQueue, router, providerRegistry, agents }) {
    this.taskQueue = taskQueue;
    this.router = router;
    this.providers = providerRegistry;
    this.agents = agents;
  }

  /**
   * Decompose a task into subtasks using a T1 agent.
   *
   * @param {Object} task - The parent task
   * @param {Object} [options]
   * @param {string} [options.decomposerAgent] - Agent ID to use for decomposition
   * @returns {Promise<Object[]>} Created subtasks
   */
  async decompose(task, options = {}) {
    // Build decomposition prompt
    const prompt = this._buildPrompt(task);

    // Find a T1 model for planning
    const route = this.router.resolve({ ...task, type: 'planning' }, {});
    if (route.action !== 'execute') {
      throw new Error('No T1 model available for task decomposition');
    }

    // Call the model
    const response = await this.providers.execute(route.provider, {
      model: route.model,
      messages: [
        {
          role: 'system',
          content:
            'You are a task planner. Break down the given task into concrete, executable subtasks. Return a JSON array of subtask objects.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 2048,
    });

    // Parse subtasks from response
    const subtasks = this._parseSubtasks(response.content, task);

    // Add to queue with parent dependency tracking
    const created = [];
    for (const sub of subtasks) {
      const t = this.taskQueue.add({
        ...sub,
        project_id: task.project_id,
        depends_on: sub.depends_on || [],
      });
      created.push(t);
    }

    return created;
  }

  /**
   * Build the decomposition prompt for the T1 model.
   * @param {Object} task
   * @returns {string}
   */
  _buildPrompt(task) {
    return [
      `Task to decompose: "${task.title}"`,
      `Type: ${task.type}`,
      ``,
      `Break this into 3-8 concrete subtasks. Return JSON array:`,
      `[{ "title": "...", "type": "implement|test|review|...", "priority": "high|medium|low", "agent_id": "developer|tester|..." }]`,
    ].join('\n');
  }

  /**
   * Parse the model response into an array of subtask objects.
   * Handles responses wrapped in markdown code fences.
   *
   * @param {string} content - Raw model response
   * @param {Object} parentTask - Parent task (unused, kept for future enrichment)
   * @returns {Object[]}
   */
  _parseSubtasks(content, parentTask) {
    try {
      // Extract JSON from content (may be wrapped in markdown)
      const match = content.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed.slice(0, 10) : [];
    } catch {
      return [];
    }
  }
}

export default TaskDecomposition;
