/**
 * @file tests/config/loader.test.js
 * @description Unit tests for src/config/loader.js
 *
 * Covers: loadConfig (missing file → defaults, valid YAML, env-var substitution),
 * buildFromConfig (models, agents, routing rules).
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, buildFromConfig } from '../../src/config/loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTmp(name, content) {
  const dir = join(tmpdir(), 'agentforge-config-tests');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig — missing file', () => {
  it('returns default config when file does not exist', () => {
    const cfg = loadConfig('/tmp/agentforge-does-not-exist-99999.yml');
    assert.equal(cfg.project.name, 'AgentForge Project');
    assert.equal(cfg.project.budget, 100);
    assert.equal(cfg.routing.fallback_strategy, 'same_tier_then_downgrade');
    assert.equal(cfg.server.port, 4242);
    assert.equal(cfg.git.enabled, false);
  });
});

describe('loadConfig — valid YAML', () => {
  let cfgPath;

  before(() => {
    cfgPath = writeTmp('valid.yml', [
      'project:',
      '  name: TestProject',
      '  budget: 50',
      'server:',
      '  port: 9999',
    ].join('\n'));
  });

  after(() => unlinkSync(cfgPath));

  it('loads project name from YAML', () => {
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.project.name, 'TestProject');
  });

  it('loads project budget from YAML', () => {
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.project.budget, 50);
  });

  it('loads server port from YAML', () => {
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.server.port, 9999);
  });

  it('deep-merges with defaults (git.enabled stays false)', () => {
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.git.enabled, false);
  });
});

describe('loadConfig — env var substitution', () => {
  let cfgPath, savedEnv;

  before(() => {
    savedEnv = process.env.AF_TEST_SECRET;
    process.env.AF_TEST_SECRET = 'my-secret-value';
    cfgPath = writeTmp('envvar.yml', [
      'project:',
      '  name: ${AF_TEST_SECRET}',
    ].join('\n'));
  });

  after(() => {
    if (savedEnv === undefined) delete process.env.AF_TEST_SECRET;
    else process.env.AF_TEST_SECRET = savedEnv;
    unlinkSync(cfgPath);
  });

  it('replaces ${VAR} with the environment variable value', () => {
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.project.name, 'my-secret-value');
  });

  it('substitutes to empty string when env var is not set', () => {
    delete process.env.AF_TEST_SECRET;
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.project.name, '');
  });
});

// ---------------------------------------------------------------------------
// buildFromConfig
// ---------------------------------------------------------------------------

describe('buildFromConfig — models', () => {
  it('builds models registry from config.models', () => {
    const cfg = {
      models: {
        'claude-opus': { provider: 'anthropic', tier: 1, cost_per_1k_tokens: 0.015 },
        'claude-haiku': { provider: 'anthropic', tier: 3, cost_per_1k_tokens: 0.00025 },
      },
      team: [],
      routing: {},
    };
    const { models } = buildFromConfig(cfg);
    assert.ok('claude-opus' in models);
    assert.ok('claude-haiku' in models);
    assert.equal(models['claude-opus'].tier, 1);
    assert.equal(models['claude-haiku'].tier, 3);
  });

  it('returns empty models when config.models is absent', () => {
    const { models } = buildFromConfig({ team: [], routing: {} });
    assert.deepEqual(models, {});
  });
});

describe('buildFromConfig — agents', () => {
  const teamCfg = {
    models: {},
    routing: {},
    team: [
      {
        name: 'Lead Developer',
        role: 'developer',
        model: 'claude-opus-4-6',
        fallback_models: ['claude-haiku-4-5-20251001'],
        require_review: true,
        reviewer: 'senior-reviewer',
      },
      {
        name: 'Tester',
        role: 'tester',
      },
    ],
  };

  it('builds agent IDs by lowercasing and replacing spaces with hyphens', () => {
    const { agents } = buildFromConfig(teamCfg);
    assert.ok('lead-developer' in agents);
    assert.ok('tester' in agents);
  });

  it('preserves agent role, model, and fallback_models', () => {
    const { agents } = buildFromConfig(teamCfg);
    assert.equal(agents['lead-developer'].role, 'developer');
    assert.equal(agents['lead-developer'].model, 'claude-opus-4-6');
    assert.deepEqual(agents['lead-developer'].fallback_models, ['claude-haiku-4-5-20251001']);
  });

  it('preserves require_review and reviewer fields', () => {
    const { agents } = buildFromConfig(teamCfg);
    assert.equal(agents['lead-developer'].require_review, true);
    assert.equal(agents['lead-developer'].reviewer, 'senior-reviewer');
  });

  it('sets sensible defaults for optional agent fields', () => {
    const { agents } = buildFromConfig(teamCfg);
    assert.equal(agents.tester.model, null);
    assert.deepEqual(agents.tester.fallback_models, []);
    assert.equal(agents.tester.require_review, false);
    assert.equal(agents.tester.reviewer, null);
    assert.equal(agents.tester.allow_tier_downgrade, true);
  });

  it('returns empty agents when team is absent', () => {
    const { agents } = buildFromConfig({ models: {}, routing: {} });
    assert.deepEqual(agents, {});
  });
});

describe('buildFromConfig — routing rules', () => {
  it('extracts routing rules from config', () => {
    const cfg = {
      models: {},
      team: [],
      routing: {
        rules: [
          { match: { type: 'architecture' }, model: 'claude-opus-4-6' },
        ],
      },
    };
    const { rules } = buildFromConfig(cfg);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].model, 'claude-opus-4-6');
  });

  it('returns empty rules when routing is absent', () => {
    const { rules } = buildFromConfig({ models: {}, team: [] });
    assert.deepEqual(rules, []);
  });
});
