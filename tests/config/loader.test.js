/**
 * @file tests/config/loader.test.js
 * @description Unit tests for src/config/loader.js
 *
 * Covers:
 *  - loadConfig(): defaults when file missing, YAML parsing, deep-merge,
 *    ${ENV_VAR} interpolation, unset vars → empty string
 *  - buildFromConfig(): models registry, agent ID normalisation, agent
 *    defaults, routing rules, empty config
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { loadConfig, buildFromConfig } from '../../src/config/loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP = '/tmp/agentforge-loader-test.yml';

function writeTmp(content) {
  writeFileSync(TMP, content, 'utf-8');
}

function cleanTmp() {
  try { rmSync(TMP); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  afterEach(cleanTmp);

  it('returns DEFAULT_CONFIG when the file does not exist', () => {
    const cfg = loadConfig('/nonexistent/path/agentforge.yml');
    assert.equal(cfg.project.name, 'AgentForge Project');
    assert.equal(cfg.project.budget, 100);
    assert.equal(cfg.project.currency, 'USD');
    assert.equal(cfg.server.port, 4242);
    assert.equal(cfg.server.host, 'localhost');
    assert.equal(cfg.routing.fallback_strategy, 'same_tier_then_downgrade');
    assert.equal(cfg.routing.cost_optimization, true);
    assert.equal(cfg.git.enabled, false);
    assert.equal(cfg.alerts.budget_warning_pct, 0.80);
    assert.equal(cfg.alerts.budget_pause_pct, 0.95);
  });

  it('loads a valid YAML file and overrides defaults', () => {
    writeTmp(`
project:
  name: My Forge
  budget: 250
server:
  port: 9090
`);
    const cfg = loadConfig(TMP);
    assert.equal(cfg.project.name, 'My Forge');
    assert.equal(cfg.project.budget, 250);
    assert.equal(cfg.server.port, 9090);
  });

  it('deep-merges: missing keys fall back to defaults', () => {
    writeTmp(`
project:
  name: Partial Config
`);
    const cfg = loadConfig(TMP);
    assert.equal(cfg.project.name, 'Partial Config');
    assert.equal(cfg.project.budget, 100);        // default preserved
    assert.equal(cfg.server.port, 4242);          // default preserved
    assert.equal(cfg.routing.fallback_strategy, 'same_tier_then_downgrade');
  });

  it('arrays in config are NOT deep-merged (overwrite)', () => {
    writeTmp(`
team:
  - name: Developer
routing:
  rules:
    - { type: implement, tier: 2 }
`);
    const cfg = loadConfig(TMP);
    // Arrays replace, not merge
    assert.equal(cfg.team.length, 1);
    assert.equal(cfg.routing.rules.length, 1);
  });

  it('resolves ${ENV_VAR} references to environment variables', () => {
    process.env._FORGE_TEST_KEY = 'sk-abc-123';
    writeTmp(`
providers:
  anthropic:
    api_key: \${_FORGE_TEST_KEY}
`);
    const cfg = loadConfig(TMP);
    assert.equal(cfg.providers.anthropic.api_key, 'sk-abc-123');
    delete process.env._FORGE_TEST_KEY;
  });

  it('replaces unset ${ENV_VAR} references (YAML parses empty as null)', () => {
    writeTmp(`
providers:
  test:
    key: "\${DEFINITELY_NOT_SET_AGENTFORGE_VAR}"
`);
    const cfg = loadConfig(TMP);
    // The env var is substituted to '' and the quoted YAML empty string is ''
    assert.equal(cfg.providers.test.key, '');
  });

  it('resolves multiple env var references in the same file', () => {
    process.env._FORGE_A = 'alice';
    process.env._FORGE_B = 'bob';
    writeTmp(`
providers:
  a:
    user: \${_FORGE_A}
  b:
    user: \${_FORGE_B}
`);
    const cfg = loadConfig(TMP);
    assert.equal(cfg.providers.a.user, 'alice');
    assert.equal(cfg.providers.b.user, 'bob');
    delete process.env._FORGE_A;
    delete process.env._FORGE_B;
  });

  it('handles an empty YAML file gracefully (returns defaults)', () => {
    writeTmp('');
    const cfg = loadConfig(TMP);
    assert.equal(cfg.project.name, 'AgentForge Project');
    assert.equal(cfg.server.port, 4242);
  });
});

// ---------------------------------------------------------------------------
// buildFromConfig
// ---------------------------------------------------------------------------

describe('buildFromConfig', () => {
  it('returns empty models, agents, rules for a minimal config', () => {
    const { models, agents, rules } = buildFromConfig({});
    assert.deepEqual(models, {});
    assert.deepEqual(agents, {});
    assert.deepEqual(rules, []);
  });

  it('builds the models registry from config.models', () => {
    const cfg = {
      models: {
        'claude-opus': { provider: 'anthropic', tier: 1, cost_per_1k_in: 0.015 },
        'gemini-pro': { provider: 'google', tier: 2 },
      },
    };
    const { models } = buildFromConfig(cfg);
    assert.ok(models['claude-opus'], 'claude-opus model missing');
    assert.equal(models['claude-opus'].provider, 'anthropic');
    assert.equal(models['claude-opus'].tier, 1);
    assert.ok(models['gemini-pro'], 'gemini-pro model missing');
  });

  it('normalises agent IDs: lowercase + spaces to dashes', () => {
    const cfg = {
      team: [
        { name: 'Senior Developer' },
        { name: 'QA Tester' },
        { name: 'singleword' },
      ],
    };
    const { agents } = buildFromConfig(cfg);
    assert.ok(agents['senior-developer'], 'senior-developer missing');
    assert.ok(agents['qa-tester'], 'qa-tester missing');
    assert.ok(agents['singleword'], 'singleword missing');
  });

  it('maps agent fields correctly from config', () => {
    const cfg = {
      team: [{
        name: 'Coder',
        role: 'implementation',
        model: 'claude-opus',
        fallback_models: ['gemini-pro'],
        system_prompt: 'You are a coder.',
        require_review: true,
        reviewer: 'reviewer-agent',
        max_cost_per_task: 0.50,
        max_tokens_per_task: 8000,
        allow_tier_downgrade: false,
        tools: ['read_file', 'write_file'],
      }],
    };
    const { agents } = buildFromConfig(cfg);
    const agent = agents['coder'];
    assert.equal(agent.id, 'coder');
    assert.equal(agent.name, 'Coder');
    assert.equal(agent.role, 'implementation');
    assert.equal(agent.model, 'claude-opus');
    assert.deepEqual(agent.fallback_models, ['gemini-pro']);
    assert.equal(agent.system_prompt, 'You are a coder.');
    assert.equal(agent.require_review, true);
    assert.equal(agent.reviewer, 'reviewer-agent');
    assert.equal(agent.max_cost_per_task, 0.50);
    assert.equal(agent.max_tokens_per_task, 8000);
    assert.equal(agent.allow_tier_downgrade, false);
    assert.deepEqual(agent.tools, ['read_file', 'write_file']);
  });

  it('applies correct defaults for unspecified agent fields', () => {
    const cfg = { team: [{ name: 'Minimal' }] };
    const { agents } = buildFromConfig(cfg);
    const agent = agents['minimal'];
    assert.equal(agent.role, '');
    assert.equal(agent.model, null);
    assert.deepEqual(agent.fallback_models, []);
    assert.equal(agent.system_prompt, '');
    assert.equal(agent.system_prompt_file, null);
    assert.deepEqual(agent.tools, []);
    assert.equal(agent.require_review, false);
    assert.equal(agent.reviewer, null);
    assert.equal(agent.max_cost_per_task, null);
    assert.equal(agent.max_tokens_per_task, null);
    assert.equal(agent.allow_tier_downgrade, true);
  });

  it('returns routing rules from config.routing.rules', () => {
    const cfg = {
      routing: {
        rules: [
          { type: 'architecture', tier: 1 },
          { type: 'implement', tier: 2 },
          { type: 'test', tier: 3 },
        ],
      },
    };
    const { rules } = buildFromConfig(cfg);
    assert.equal(rules.length, 3);
    assert.equal(rules[0].type, 'architecture');
    assert.equal(rules[2].type, 'test');
  });

  it('returns empty rules when routing section is absent', () => {
    const { rules } = buildFromConfig({ team: [] });
    assert.deepEqual(rules, []);
  });

  it('handles multiple agents without collision', () => {
    const cfg = {
      team: [
        { name: 'Agent One', role: 'r1' },
        { name: 'Agent Two', role: 'r2' },
        { name: 'Agent Three', role: 'r3' },
      ],
    };
    const { agents } = buildFromConfig(cfg);
    assert.equal(Object.keys(agents).length, 3);
    assert.equal(agents['agent-one'].role, 'r1');
    assert.equal(agents['agent-two'].role, 'r2');
    assert.equal(agents['agent-three'].role, 'r3');
  });
});
