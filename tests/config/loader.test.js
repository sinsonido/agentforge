import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, buildFromConfig } from '../../src/config/loader.js';

const TMP = '/tmp/agentforge-config-test';

before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** Write a YAML file under TMP and return its path. */
function writeYml(name, content) {
  const p = resolve(TMP, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('loadConfig()', () => {
  it('returns defaults when config file does not exist', () => {
    const cfg = loadConfig(resolve(TMP, 'nonexistent.yml'));
    assert.equal(cfg.project.name, 'AgentForge Project');
    assert.equal(cfg.project.budget, 100);
    assert.deepEqual(cfg.team, []);
  });

  it('merges project name from YAML over defaults', () => {
    const path = writeYml('project.yml', 'project:\n  name: "My Project"\n');
    const cfg = loadConfig(path);
    assert.equal(cfg.project.name, 'My Project');
  });

  it('preserves default budget when not specified in YAML', () => {
    const path = writeYml('no-budget.yml', 'project:\n  name: "Test"\n');
    const cfg = loadConfig(path);
    assert.equal(cfg.project.budget, 100);
  });

  it('resolves ${ENV_VAR} references from environment', () => {
    process.env._TEST_API_KEY = 'secret-key-123';
    const path = writeYml('env.yml', 'providers:\n  anthropic:\n    api_key: "${_TEST_API_KEY}"\n');
    const cfg = loadConfig(path);
    assert.equal(cfg.providers.anthropic.api_key, 'secret-key-123');
    delete process.env._TEST_API_KEY;
  });

  it('substitutes empty string for undefined env vars', () => {
    delete process.env._UNDEFINED_VAR;
    const path = writeYml('missing-env.yml', 'providers:\n  test:\n    key: "${_UNDEFINED_VAR}"\n');
    const cfg = loadConfig(path);
    assert.equal(cfg.providers.test.key, '');
  });

  it('deep-merges routing rules from YAML', () => {
    const path = writeYml('routing.yml', [
      'routing:',
      '  fallback_strategy: cheapest',
      '  rules:',
      '    - type: planning',
      '      model: claude-opus-4-6',
    ].join('\n'));
    const cfg = loadConfig(path);
    assert.equal(cfg.routing.fallback_strategy, 'cheapest');
    assert.equal(cfg.routing.rules.length, 1);
    assert.equal(cfg.routing.rules[0].type, 'planning');
  });

  it('preserves default routing.cost_optimization when not overridden', () => {
    const path = writeYml('routing-no-cost.yml', 'routing:\n  fallback_strategy: same_tier\n');
    const cfg = loadConfig(path);
    assert.equal(cfg.routing.cost_optimization, true);
  });

  it('loads team array from YAML', () => {
    const path = writeYml('team.yml', [
      'team:',
      '  - name: Developer',
      '    role: engineer',
      '    model: claude-sonnet-4-6',
    ].join('\n'));
    const cfg = loadConfig(path);
    assert.equal(cfg.team.length, 1);
    assert.equal(cfg.team[0].name, 'Developer');
  });

  it('loads server port from YAML', () => {
    const path = writeYml('server.yml', 'server:\n  port: 3000\n');
    const cfg = loadConfig(path);
    assert.equal(cfg.server.port, 3000);
  });

  it('handles empty YAML (null document) gracefully', () => {
    const path = writeYml('empty.yml', '');
    const cfg = loadConfig(path);
    assert.equal(cfg.project.budget, 100); // defaults intact
  });
});

describe('buildFromConfig()', () => {
  it('builds an empty models map when config.models is absent', () => {
    const { models } = buildFromConfig({ team: [], routing: {} });
    assert.deepEqual(models, {});
  });

  it('builds models map from config.models entries', () => {
    const config = {
      models: {
        'claude-opus-4-6': { tier: 1, provider: 'anthropic', cost_per_1k_tokens: 0.015 },
        'claude-sonnet-4-6': { tier: 2, provider: 'anthropic', cost_per_1k_tokens: 0.003 },
      },
      team: [],
      routing: {},
    };
    const { models } = buildFromConfig(config);
    assert.ok('claude-opus-4-6' in models);
    assert.equal(models['claude-opus-4-6'].tier, 1);
    assert.ok('claude-sonnet-4-6' in models);
  });

  it('builds agents map keyed by slugified agent name', () => {
    const config = {
      models: {},
      team: [{ name: 'Senior Developer', role: 'engineer', model: 'claude-opus-4-6' }],
      routing: {},
    };
    const { agents } = buildFromConfig(config);
    assert.ok('senior-developer' in agents);
    assert.equal(agents['senior-developer'].name, 'Senior Developer');
  });

  it('slugifies agent name with spaces to hyphens', () => {
    const config = { models: {}, team: [{ name: 'QA Lead' }], routing: {} };
    const { agents } = buildFromConfig(config);
    assert.ok('qa-lead' in agents);
  });

  it('sets default values for optional agent fields', () => {
    const config = { models: {}, team: [{ name: 'Dev' }], routing: {} };
    const { agents } = buildFromConfig(config);
    const agent = agents['dev'];
    assert.deepEqual(agent.fallback_models, []);
    assert.equal(agent.system_prompt, '');
    assert.deepEqual(agent.tools, []);
    assert.equal(agent.require_review, false);
    assert.equal(agent.reviewer, null);
    assert.equal(agent.allow_tier_downgrade, true);
  });

  it('maps require_review and reviewer from team config', () => {
    const config = {
      models: {},
      team: [{ name: 'Dev', require_review: true, reviewer: 'qa-lead' }],
      routing: {},
    };
    const { agents } = buildFromConfig(config);
    assert.equal(agents['dev'].require_review, true);
    assert.equal(agents['dev'].reviewer, 'qa-lead');
  });

  it('returns routing rules from config.routing.rules', () => {
    const config = {
      models: {},
      team: [],
      routing: { rules: [{ type: 'planning', model: 'claude-opus-4-6' }] },
    };
    const { rules } = buildFromConfig(config);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].type, 'planning');
  });

  it('returns empty rules array when routing is absent', () => {
    const { rules } = buildFromConfig({ models: {}, team: [] });
    assert.deepEqual(rules, []);
  });
});
