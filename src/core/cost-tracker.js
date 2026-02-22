import eventBus from './event-bus.js';

/**
 * CostTracker — Tracks cumulative spend per project and agent.
 * Emits budget warning and exceeded events.
 * Implements GitHub issue #17.
 */
export class CostTracker {
  constructor(config = {}) {
    this.budgets = new Map();   // projectId → { budget, spent }
    this.agentCosts = new Map(); // agentId → total spent
    this.modelCosts = new Map(); // modelId → total spent
    this._config = config;
    this._alertConfig = config.alerts || {
      budget_warning_pct: 0.80,
      budget_pause_pct: 0.95,
    };
  }

  /**
   * Register a project with a budget limit.
   * @param {string} projectId
   * @param {number} budget - Max spend in USD
   */
  initProject(projectId, budget) {
    this.budgets.set(projectId, { budget, spent: 0 });
  }

  /**
   * Record a cost entry for a completed task.
   * @param {string} projectId
   * @param {string} agentId
   * @param {string} modelId
   * @param {number} cost - Cost in USD
   */
  recordCost(projectId, agentId, modelId, cost) {
    if (!cost || cost <= 0) return;

    // Update project budget
    if (projectId && this.budgets.has(projectId)) {
      const proj = this.budgets.get(projectId);
      proj.spent += cost;
      this._checkBudgetAlerts(projectId, proj);
    }

    // Update agent total
    if (agentId) {
      this.agentCosts.set(agentId, (this.agentCosts.get(agentId) || 0) + cost);
    }

    // Update model total
    if (modelId) {
      this.modelCosts.set(modelId, (this.modelCosts.get(modelId) || 0) + cost);
    }

    eventBus.emit('cost.recorded', { projectId, agentId, modelId, cost });
  }

  /**
   * Get budget status for a project.
   * @param {string} projectId
   * @returns {{ budget, spent, remaining, remaining_pct, warning, exceeded } | null}
   */
  getBudgetStatus(projectId) {
    const proj = this.budgets.get(projectId);
    if (!proj) return null;

    const remaining = Math.max(0, proj.budget - proj.spent);
    const remaining_pct = proj.budget > 0 ? remaining / proj.budget : 1;
    const warningPct = this._alertConfig.budget_warning_pct || 0.80;
    const pausePct = this._alertConfig.budget_pause_pct || 0.95;

    return {
      budget: proj.budget,
      spent: proj.spent,
      remaining,
      remaining_pct,
      spent_pct: 1 - remaining_pct,
      warning: remaining_pct < (1 - warningPct),
      exceeded: remaining_pct < (1 - pausePct),
    };
  }

  /**
   * Get remaining budget percentage (0–1) for routing decisions.
   * @param {string} projectId
   * @returns {number} 1.0 if no budget configured
   */
  getBudgetRemainingPct(projectId) {
    const status = this.getBudgetStatus(projectId);
    return status ? status.remaining_pct : 1.0;
  }

  /**
   * Get cost breakdown by agent.
   * @returns {Object} { agentId: totalCost }
   */
  getCostByAgent() {
    return Object.fromEntries(this.agentCosts);
  }

  /**
   * Get cost breakdown by model.
   * @returns {Object} { modelId: totalCost }
   */
  getCostByModel() {
    return Object.fromEntries(this.modelCosts);
  }

  /**
   * Full stats snapshot.
   */
  getAllStats() {
    const projects = {};
    for (const [id] of this.budgets) {
      projects[id] = this.getBudgetStatus(id);
    }
    return {
      projects,
      byAgent: this.getCostByAgent(),
      byModel: this.getCostByModel(),
      totalSpent: Array.from(this.budgets.values()).reduce((s, p) => s + p.spent, 0),
    };
  }

  // ─── Private ────────────────────────────────────────

  _checkBudgetAlerts(projectId, proj) {
    const spent_pct = proj.budget > 0 ? proj.spent / proj.budget : 0;
    const warningPct = this._alertConfig.budget_warning_pct || 0.80;
    const pausePct = this._alertConfig.budget_pause_pct || 0.95;

    if (spent_pct >= pausePct) {
      eventBus.emit('budget.exceeded', { projectId, spent: proj.spent, budget: proj.budget, spent_pct });
    } else if (spent_pct >= warningPct) {
      eventBus.emit('budget.warning', { projectId, spent: proj.spent, budget: proj.budget, spent_pct });
    }
  }
}

export default CostTracker;
