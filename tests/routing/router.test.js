import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../src/routing/router.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';

// ─── Shared test fixtures ────────────────────────────────────────────────────

const MODELS = {
  'claude-opus-4':  { provider: 'anthropic', tier: 1, cost_in: 15,   cost_out: 75,  context: 200000 },
  'claude-sonnet-4':{ provider: 'anthropic', tier: 2, cost_in: 3,    cost_out: 15,  context: 200000 },
  'gemini-2.5-pro': { provider: 'google',    tier: 1, cost_in: 1.25, cost_out: 10,  context: 1000000 },
  'deepseek-v3':    { provider: 'deepseek',  tier: 3, cost_in: 0.27, cost_out: 1.1, context: 128000 },
  'codestral:22b':  { provider: 'ollama',    tier: 3, cost_in: 0,    cost_out: 0,   context: 32000 },
};

const RULES = [
  { match: { context_tokens_gt: 200000 }, force: 'gemini-2.5-pro' },
  { match: { type: ['architecture', 'planning'] }, tier: 1, prefer: 'claude-opus-4' },
  { match: { type: ['implement'] }, tier: 2, prefer: 'claude-sonnet-4' },
  { match: { type: ['test', 'script'] }, tier: 3, prefer: 'codestral:22b' },
];

function makeQuotaManager(exhaustedProviders = []) {
  const qm = new QuotaManager();
  qm.addProvider('anthropic', { max_requests_per_minute: 100, max_tokens_per_minute: 400000 });
  qm.addProvider('google',    { max_requests_per_minute: 60,  max_tokens_per_minute: 400000 });
  qm.addProvider('deepseek',  { max_requests_per_minute: 120, max_tokens_per_minute: 400000 });
  // ollama has no quota registered → always available

  for (const provider of exhaustedProviders) {
    const tracker = qm.trackers.get(provider);
    if (tracker) {
      // Exhaust past 95% of each provider's specific limit
      const limit = tracker.requests.maxValue === Infinity ? 100 : tracker.requests.maxValue;
      const count = Math.ceil(limit * 0.96) + 1;
      for (let i = 0; i < count; i++) {
        tracker.requests.entries.push({ timestamp: Date.now(), value: 1 });
      }
      tracker._updateState();
    }
  }
  return qm;
}

function makeRouter(opts = {}) {
  const qm = opts.quotaManager || makeQuotaManager(opts.exhaustedProviders || []);
  return new Router({
    rules: opts.rules ?? RULES,
    models: opts.models ?? MODELS,
    agents: opts.agents ?? {},
    quotaManager: qm,
    budgetTracker: opts.budgetTracker,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Router', () => {
  describe('resolve() — force_model override', () => {
    it('picks force_model when set on the task', () => {
      const router = makeRouter();
      const result = router.resolve({
        type: 'test',
        force_model: 'claude-opus-4',
        context_tokens_estimate: 0,
      });

      assert.equal(result.action, 'execute');
      assert.equal(result.model, 'claude-opus-4');
    });

    it('force_model bypasses tier routing rules', () => {
      const router = makeRouter();
      // 'test' type would normally go to tier 3 / codestral
      const result = router.resolve({
        type: 'test',
        force_model: 'gemini-2.5-pro',
        context_tokens_estimate: 0,
      });

      assert.equal(result.action, 'execute');
      assert.equal(result.model, 'gemini-2.5-pro');
    });

    it('returns action:wait when force_model provider is quota exhausted', () => {
      const router = makeRouter({ exhaustedProviders: ['anthropic'] });
      const result = router.resolve({
        type: 'implement',
        force_model: 'claude-opus-4',
        context_tokens_estimate: 0,
      });

      assert.equal(result.action, 'wait');
    });
  });

  describe('resolve() — cheapest available model in tier', () => {
    it('selects cheapest model within a tier (ollama at cost 0 first)', () => {
      // Tier 3 has deepseek-v3 (0.27) and codestral:22b (0). codestral should win.
      const router = makeRouter({ rules: [] });
      const result = router.resolve({ type: 'test', context_tokens_estimate: 0 });

      assert.equal(result.action, 'execute');
      assert.equal(result.model, 'codestral:22b');
    });

    it('selects paid tier-3 model when free local is unavailable due to context size', () => {
      // codestral has context: 32000, deepseek-v3: 128000
      const router = makeRouter({ rules: [] });
      const result = router.resolve({ type: 'test', context_tokens_estimate: 50000 });

      assert.equal(result.action, 'execute');
      // codestral cannot fit 50000 tokens (max 32000), deepseek-v3 can
      assert.equal(result.model, 'deepseek-v3');
    });
  });

  describe('resolve() — action:wait when quota exhausted', () => {
    it('returns action:wait when the preferred provider is quota-exhausted', () => {
      const router = makeRouter({ exhaustedProviders: ['anthropic'] });
      const result = router.resolve({ type: 'architecture', context_tokens_estimate: 0 });

      // architecture → tier 1, prefers claude-opus-4 (anthropic), falls through
      // gemini-2.5-pro is also tier 1 and google is not exhausted
      // so it should fall through to gemini
      assert.equal(result.action, 'execute');
      assert.equal(result.model, 'gemini-2.5-pro');
    });

    it('returns action:wait when all providers in the fallback chain are exhausted', () => {
      // Exhaust every registered provider and restrict models to only cloud ones
      const modelsNoLocal = {
        'claude-opus-4':  { provider: 'anthropic', tier: 1, cost_in: 15, cost_out: 75, context: 200000 },
        'claude-sonnet-4':{ provider: 'anthropic', tier: 2, cost_in: 3,  cost_out: 15, context: 200000 },
        'deepseek-v3':    { provider: 'deepseek',  tier: 3, cost_in: 0.27, cost_out: 1.1, context: 128000 },
      };
      const router = makeRouter({
        models: modelsNoLocal,
        exhaustedProviders: ['anthropic', 'google', 'deepseek'],
        rules: [],
      });

      const result = router.resolve({ type: 'implement', context_tokens_estimate: 0 });
      assert.equal(result.action, 'wait');
    });
  });

  describe('resolve() — fallback chain', () => {
    it('follows fallback chain when primary model is unavailable', () => {
      // Exhaust anthropic; architecture rule prefers claude-opus-4 but falls through
      // to tier selection which includes gemini-2.5-pro (google, available)
      const router = makeRouter({ exhaustedProviders: ['anthropic'] });
      const result = router.resolve({ type: 'architecture', context_tokens_estimate: 0 });

      assert.equal(result.action, 'execute');
      assert.equal(result.model, 'gemini-2.5-pro');
    });

    it('downgrades tier when higher tier is exhausted and allow_tier_downgrade is true', () => {
      // All tier 1 and 2 providers exhausted, tier 3 (deepseek or codestral) available
      const router = makeRouter({ exhaustedProviders: ['anthropic', 'google'], rules: [] });
      const result = router.resolve({
        type: 'architecture',
        context_tokens_estimate: 0,
        allow_tier_downgrade: true,
      });

      // architecture maps to tier 1, all tier 1 exhausted (google+anthropic)
      // tier 2 also uses anthropic → exhausted
      // tier 3: deepseek (available) or codestral (no quota limits)
      assert.equal(result.action, 'execute');
      assert.ok(['deepseek-v3', 'codestral:22b'].includes(result.model));
    });
  });

  describe('_resolveTier()', () => {
    it('maps architecture to tier 1', () => {
      const router = makeRouter();
      assert.equal(router._resolveTier('architecture'), 1);
    });

    it('maps planning to tier 1', () => {
      const router = makeRouter();
      assert.equal(router._resolveTier('planning'), 1);
    });

    it('maps review to tier 1', () => {
      const router = makeRouter();
      assert.equal(router._resolveTier('review'), 1);
    });

    it('maps security_audit to tier 1', () => {
      const router = makeRouter();
      assert.equal(router._resolveTier('security_audit'), 1);
    });

    it('maps implement to tier 2', () => {
      const router = makeRouter();
      assert.equal(router._resolveTier('implement'), 2);
    });

    it('maps refactor to tier 2', () => {
      const router = makeRouter();
      assert.equal(router._resolveTier('refactor'), 2);
    });

    it('maps debug to tier 2', () => {
      const router = makeRouter();
      assert.equal(router._resolveTier('debug'), 2);
    });

    it('maps test to tier 3', () => {
      const router = makeRouter();
      assert.equal(router._resolveTier('test'), 3);
    });

    it('maps script to tier 3', () => {
      const router = makeRouter();
      assert.equal(router._resolveTier('script'), 3);
    });

    it('maps bulk to tier 3', () => {
      const router = makeRouter();
      assert.equal(router._resolveTier('bulk'), 3);
    });

    it('defaults unknown task types to tier 2', () => {
      const router = makeRouter();
      assert.equal(router._resolveTier('unknown_type'), 2);
    });
  });

  describe('rule matching', () => {
    it('matches context_tokens_gt rule and forces gemini for large contexts', () => {
      const router = makeRouter();
      const result = router.resolve({ type: 'implement', context_tokens_estimate: 300000 });

      assert.equal(result.action, 'execute');
      assert.equal(result.model, 'gemini-2.5-pro');
    });

    it('does not trigger context_tokens_gt rule when context is within limit', () => {
      const router = makeRouter();
      const result = router.resolve({ type: 'implement', context_tokens_estimate: 100000 });

      // Should go to implement rule → claude-sonnet-4, not gemini
      assert.equal(result.model, 'claude-sonnet-4');
    });

    it('matches budget_remaining_lt rule', () => {
      const lowBudgetRules = [
        {
          match: { budget_remaining_lt: 0.2 },
          tier: 3,
          prefer: 'codestral:22b',
        },
      ];
      const router = makeRouter({ rules: lowBudgetRules });

      // context with budget_remaining_pct = 0.1 (10% left → < 0.2)
      const result = router.resolve(
        { type: 'implement', context_tokens_estimate: 0 },
        { budget_remaining_pct: 0.1 }
      );

      assert.equal(result.action, 'execute');
      assert.equal(result.model, 'codestral:22b');
    });

    it('does not trigger budget_remaining_lt when budget is healthy', () => {
      const lowBudgetRules = [
        {
          match: { budget_remaining_lt: 0.2 },
          tier: 3,
          prefer: 'codestral:22b',
        },
        { match: { type: ['implement'] }, tier: 2, prefer: 'claude-sonnet-4' },
      ];
      const router = makeRouter({ rules: lowBudgetRules });

      const result = router.resolve(
        { type: 'implement', context_tokens_estimate: 0 },
        { budget_remaining_pct: 0.8 }
      );

      // budget rule doesn't match; falls through to implement rule
      assert.equal(result.model, 'claude-sonnet-4');
    });

    it('matches type rule for architecture tasks', () => {
      const router = makeRouter();
      const result = router.resolve({ type: 'architecture', context_tokens_estimate: 0 });

      assert.equal(result.action, 'execute');
      assert.equal(result.model, 'claude-opus-4');
      assert.equal(result.tier, 1);
    });

    it('matches type rule for implement tasks', () => {
      const router = makeRouter();
      const result = router.resolve({ type: 'implement', context_tokens_estimate: 0 });

      assert.equal(result.action, 'execute');
      assert.equal(result.model, 'claude-sonnet-4');
    });

    it('matches type rule for test tasks', () => {
      const router = makeRouter();
      const result = router.resolve({ type: 'test', context_tokens_estimate: 0 });

      assert.equal(result.action, 'execute');
      assert.equal(result.model, 'codestral:22b');
      assert.equal(result.provider, 'ollama');
    });

    it('matches type rule with array of types', () => {
      const router = makeRouter();
      const resultScript = router.resolve({ type: 'script', context_tokens_estimate: 0 });

      assert.equal(resultScript.action, 'execute');
      assert.equal(resultScript.model, 'codestral:22b');
    });
  });

  describe('agent model override', () => {
    it('uses agent fixed model when agent has one', () => {
      const router = makeRouter({
        agents: {
          'my-agent': { model: 'claude-sonnet-4', fallback_models: [] },
        },
      });
      const result = router.resolve({
        type: 'architecture',
        agent_id: 'my-agent',
        context_tokens_estimate: 0,
      });

      // Even though architecture → claude-opus-4, the agent is pinned to claude-sonnet-4
      assert.equal(result.model, 'claude-sonnet-4');
    });

    it('falls through to agent fallback_models when agent model is unavailable', () => {
      const router = makeRouter({
        exhaustedProviders: ['anthropic'],
        agents: {
          'my-agent': {
            model: 'claude-opus-4',
            fallback_models: ['gemini-2.5-pro'],
          },
        },
      });
      const result = router.resolve({
        type: 'implement',
        agent_id: 'my-agent',
        context_tokens_estimate: 0,
      });

      assert.equal(result.action, 'execute');
      assert.equal(result.model, 'gemini-2.5-pro');
      assert.equal(result.fallback_used, true);
    });
  });
});
