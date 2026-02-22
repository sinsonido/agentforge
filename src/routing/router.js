
/**
 * The Router is the brain of AgentForge.
 * Given a task, it decides which model to use.
 *
 * Decision order:
 * 1. User override (force_model on task or agent.model)
 * 2. Context size rules (>200K → Gemini)
 * 3. Budget rules (low budget → cheap/local)
 * 4. Tier rules (task.type → tier → model pool)
 * 5. Cost optimization (cheapest valid model)
 * 6. Quota check (is provider available?)
 * 7. Fallback chain
 */
export class Router {
  constructor({ rules, models, agents, quotaManager, budgetTracker }) {
    this.rules = rules || [];
    this.models = models || {};
    this.agents = agents || {};
    this.quotaManager = quotaManager;
    this.budgetTracker = budgetTracker;
  }

  /**
   * Resolve the best model for a task.
   * @param {Object} task - Task from the queue
   * @param {Object} context - { project, budget_remaining_pct }
   * @returns {{ model, provider, tier, action: 'execute'|'wait', fallback_used: boolean }}
   */
  resolve(task, context = {}) {
    // 1. User override: force_model on task
    if (task.force_model) {
      return this._tryModel(task.force_model, task, false);
    }

    // 2. Agent has fixed model
    const agent = this.agents[task.agent_id];
    if (agent?.model) {
      const result = this._tryModel(agent.model, task, false);
      if (result.action === 'execute') return result;
      // Agent model unavailable → try agent's fallback_models
      if (agent.fallback_models?.length) {
        for (const fbModel of agent.fallback_models) {
          const fbResult = this._tryModel(fbModel, task, true);
          if (fbResult.action === 'execute') return fbResult;
        }
      }
      // All agent models unavailable → try general rules
    }

    // 3. Evaluate routing rules (ordered, first match wins)
    for (const rule of this.rules) {
      if (this._matchesRule(rule, task, context)) {
        const resolved = this._resolveRule(rule, task);
        if (resolved.action === 'execute') return resolved;
      }
    }

    // 4. Default: resolve by tier
    const tier = this._resolveTier(task.type);
    const result = this._selectFromTier(tier, task);
    if (result.action === 'execute') return result;

    // 5. Fallback chain
    return this._runFallbackChain(tier, task);
  }

  // ─── Rule matching ──────────────────────────────────

  _matchesRule(rule, task, context) {
    const match = rule.match;
    if (!match) return false;

    if (match.type) {
      const types = Array.isArray(match.type) ? match.type : [match.type];
      if (!types.includes(task.type)) return false;
    }

    if (match.context_tokens_gt != null) {
      if ((task.context_tokens_estimate || 0) <= match.context_tokens_gt) return false;
    }

    if (match.budget_remaining_lt != null) {
      if ((context.budget_remaining_pct || 1) >= match.budget_remaining_lt) return false;
    }

    return true;
  }

  _resolveRule(rule, task) {
    // force: specific model
    if (rule.force) {
      return this._tryModel(rule.force, task, false);
    }

    // prefer + fallback
    if (rule.prefer) {
      const result = this._tryModel(rule.prefer, task, false);
      if (result.action === 'execute') return result;
    }

    // Try fallbacks
    if (rule.fallback) {
      for (const fb of rule.fallback) {
        const result = this._tryModel(fb, task, true);
        if (result.action === 'execute') return result;
      }
    }

    // Try any in tier
    if (rule.tier) {
      return this._selectFromTier(rule.tier, task);
    }

    return { action: 'wait', reason: 'no_model_available' };
  }

  // ─── Model selection ────────────────────────────────

  _tryModel(modelId, task, isFallback) {
    const model = this.models[modelId];
    if (!model) return { action: 'wait', reason: `model_not_found: ${modelId}` };

    // Check context window
    if (task.context_tokens_estimate > 0 && model.context) {
      if (task.context_tokens_estimate > model.context) {
        return { action: 'wait', reason: `context_too_large: ${modelId}` };
      }
    }

    // Check quota
    if (!this.quotaManager.canExecute(model.provider, task.context_tokens_estimate)) {
      return { action: 'wait', reason: `quota_exhausted: ${model.provider}` };
    }

    return {
      action: 'execute',
      model: modelId,
      provider: model.provider,
      tier: model.tier,
      fallback_used: isFallback,
    };
  }

  _selectFromTier(tier, task) {
    // Get all models in this tier, sorted by cost (cheapest first)
    const candidates = Object.entries(this.models)
      .filter(([, m]) => m.tier === tier)
      .filter(([, m]) => {
        if (task.context_tokens_estimate > 0 && m.context) {
          return task.context_tokens_estimate <= m.context;
        }
        return true;
      })
      .sort(([, a], [, b]) => (a.cost_in || 0) - (b.cost_in || 0));

    // Prefer local (cost 0) models
    const localFirst = candidates.sort(([, a], [, b]) => {
      if (a.cost_in === 0 && b.cost_in !== 0) return -1;
      if (a.cost_in !== 0 && b.cost_in === 0) return 1;
      return (a.cost_in || 0) - (b.cost_in || 0);
    });

    for (const [modelId] of localFirst) {
      const result = this._tryModel(modelId, task, false);
      if (result.action === 'execute') return result;
    }

    return { action: 'wait', reason: `no_available_model_in_tier_${tier}` };
  }

  _runFallbackChain(originalTier, task) {
    // Strategy: same_tier_then_downgrade
    // 1. Try all models in same tier
    const sameTier = this._selectFromTier(originalTier, task);
    if (sameTier.action === 'execute') return sameTier;

    // 2. Try tier below (if allowed)
    if (task.allow_tier_downgrade !== false) {
      for (let t = originalTier + 1; t <= 3; t++) {
        const lower = this._selectFromTier(t, task);
        if (lower.action === 'execute') return { ...lower, fallback_used: true };
      }
    }

    // 3. Nothing available → wait for quota reset
    return { action: 'wait', reason: 'all_providers_exhausted' };
  }

  // ─── Tier resolution ────────────────────────────────

  _resolveTier(taskType) {
    const tierMap = {
      architecture: 1, planning: 1, review: 1, security_audit: 1,
      implement: 2, refactor: 2, code_review: 2, debug: 2,
      test: 3, script: 3, bulk: 3, migration: 3, format: 3,
    };
    return tierMap[taskType] || 2;
  }
}

export default Router;
