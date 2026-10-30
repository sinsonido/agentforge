import eventBus from './event-bus.js';

/**
 * CostTracker: the cost ledger. One record per tranche of spend, a provider
 * call for a text task or one executor run for a coding task.
 *
 * With a `store` (AgentForgeDB), every record is written through and
 * construction reloads the ledger, so budgets survive a restart.
 * Emits `cost.recorded` with each record, and budget warning and exceeded
 * events for a project budget.
 *
 * @typedef {import('./budget.js').Phase} Phase
 * @typedef {{
 *   projectId: string|null, agentId: string|null, model: string|null,
 *   tokensIn: number, tokensOut: number, cost: number,
 *   taskId: string|null, repo: string|null, phase: Phase, at: number,
 * }} CostRecord
 */
export class CostTracker {
  constructor(config = {}, { store = null } = {}) {
    this.budgets = new Map();   // projectId → { budget, spent }
    this._store = store;
    /** @type {CostRecord[]} */
    this._records = store ? store.costRecords() : [];
    this._alertConfig = config.alerts || {
      budget_warning_pct: 0.80,
      budget_pause_pct: 0.95,
    };
  }

  /**
   * Register a project with a budget limit. Spend already in the ledger counts.
   * @param {string} projectId
   * @param {number} budget - Max spend in USD
   */
  initProject(projectId, budget) {
    const spent = this._records.filter((r) => r.projectId === projectId).reduce((s, r) => s + r.cost, 0);
    this.budgets.set(projectId, { budget, spent });
  }

  /**
   * Record one tranche of spend. Zero or negative cost records nothing.
   * @param {Partial<CostRecord> & { cost: number }} input
   * @returns {CostRecord|null}
   */
  recordCost({ projectId = null, agentId = null, model = null, tokensIn = 0, tokensOut = 0, cost, taskId = null, repo = null, phase = 'build', at = Date.now() }) {
    if (!cost || cost <= 0) return null;
    const record = { projectId, agentId, model, tokensIn, tokensOut, cost, taskId, repo, phase, at };
    this._records.push(record);
    this._store?.recordCost(record);

    if (projectId && this.budgets.has(projectId)) {
      const proj = this.budgets.get(projectId);
      proj.spent += cost;
      this._checkBudgetAlerts(projectId, proj);
    }
    eventBus.emit('cost.recorded', record);
    return record;
  }

  /**
   * Spend per phase over the records that match every given filter.
   * @param {{ taskId?: string, repo?: string, since?: number }} [filter]
   * @returns {Record<Phase, number> & { total: number }}
   */
  spent({ taskId, repo, since } = {}) {
    const out = { build: 0, verify: 0, total: 0 };
    for (const r of this._records) {
      if (taskId !== undefined && r.taskId !== taskId) continue;
      if (repo !== undefined && r.repo !== repo) continue;
      if (since !== undefined && r.at < since) continue;
      out[r.phase] = (out[r.phase] ?? 0) + r.cost;
      out.total += r.cost;
    }
    return out;
  }

  /** The newest `limit` records, oldest first. */
  records(limit = 200) {
    return this._records.slice(-limit);
  }

  /** Repositories that have spent anything. */
  repos() {
    return [...new Set(this._records.map((r) => r.repo).filter(Boolean))];
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

  /** @returns {Object} { agentId: totalCost }, records without an agent left out */
  getCostByAgent() {
    return this._sumBy('agentId');
  }

  /** @returns {Object} { modelId: totalCost } */
  getCostByModel() {
    return this._sumBy('model');
  }

  /**
   * Full stats snapshot. `totalSpent` is every record in the ledger, whether
   * or not it names an agent or a registered project.
   */
  getAllStats() {
    const projects = {};
    for (const [id] of this.budgets) {
      projects[id] = this.getBudgetStatus(id);
    }
    const { build, verify, total } = this.spent();
    return {
      projects,
      byAgent: this.getCostByAgent(),
      byModel: this.getCostByModel(),
      byPhase: { build, verify },
      totalSpent: total,
    };
  }

  // ─── Private ────────────────────────────────────────

  _sumBy(key) {
    const out = {};
    for (const r of this._records) {
      if (r[key]) out[r[key]] = (out[r[key]] ?? 0) + r.cost;
    }
    return out;
  }

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
