/**
 * @file tests/config/loader.test.js
 * @description Unit tests for src/config/loader.js
 *
 * Covers:
 *  - loadConfig() returns DEFAULT_CONFIG when file does not exist
 *  - loadConfig() reads and parses a YAML config file
 *  - loadConfig() expands ${ENV_VAR} references from process.env
 *  - loadConfig() deep-merges with defaults (missing keys are filled)
 *  - buildFromConfig() builds the models registry from config.models
 *  - buildFromConfig() builds the agents map from config.team
 *  - buildFromConfig() normalises agent IDs (lowercased, spaces → hyphens)
 *  - buildFromConfig() fills in default agent fields
 *  - buildFromConfig() returns empty objects when models/team are absent
 *  - buildFromConfig() exposes routing rules array
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, buildFromConfig } from '../../src/config/loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a temporary YAML file and return its full path.
 * Caller is responsible for cleanup: rmSync(path.dirname(file), { recursive: true, force: true })
 */
function writeTmpYaml(content) {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-config-test-'));
  const file = join(dir, 'agentforge.yml');
  writeFileSync(file, content, 'utf-8');
  return file;
}

/** Remove the temp dir that writeTmpYaml() created for a given file path. */
function cleanupTmpYaml(file) {
  try { rmSync(join(file, '..'), { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// loadConfig()
// ---------------------------------------------------------------------------

describe('loadConfig() — missing file', () => {
  // Use a path that is guaranteed not to exist (random suffix, never created)
  const missingPath = join(tmpdir(), `agentforge-no-exist-${Math.random().toString(36).slice(2)}.yml`);

  it('returns a config object when the file does not exist', () => {
    const cfg = loadConfig(missingPath);
    assert.ok(typeof cfg === 'object' && cfg !== null);
  });

  it('default config has project.budget=100', () => {
    const cfg = loadConfig(missingPath);
    assert.equal(cfg.project.budget, 100);
  });

  it('default config has server.port=4242', () => {
    const cfg = loadConfig(missingPath);
    assert.equal(cfg.server.port, 4242);
  });

  it('default config has routing.cost_optimization=true', () => {
    const cfg = loadConfig(missingPath);
    assert.equal(cfg.routing.cost_optimization, true);
  });
});

describe('loadConfig() — file parsing', () => {
  let tmpFile;

  before(() => {
    tmpFile = writeTmpYaml(`
project:
  name: My Project
  budget: 50
server:
  port: 8080
`);
  });

  after(() => cleanupTmpYaml(tmpFile));

  it('reads project.name from YAML', () => {
    const cfg = loadConfig(tmpFile);
    assert.equal(cfg.project.name, 'My Project');
  });

  it('reads project.budget from YAML', () => {
    const cfg = loadConfig(tmpFile);
    assert.equal(cfg.project.budget, 50);
  });

  it('reads server.port from YAML', () => {
    const cfg = loadConfig(tmpFile);
    assert.equal(cfg.server.port, 8080);
  });

  it('fills missing keys from defaults (routing.cost_optimization)', () => {
    const cfg = loadConfig(tmpFile);
    assert.equal(cfg.routing.cost_optimization, true);
  });
});

describe('loadConfig() — env var expansion', () => {
  let tmpFile;
  const SAVED = process.env.AF_TEST_SECRET;

  before(() => {
    process.env.AF_TEST_SECRET = 'mysecret123';
    tmpFile = writeTmpYaml(`
project:
  name: EnvTest
providers:
  anthropic:
    api_key: \${AF_TEST_SECRET}
`);
  });

  after(() => {
    if (SAVED === undefined) delete process.env.AF_TEST_SECRET;
    else process.env.AF_TEST_SECRET = SAVED;
    cleanupTmpYaml(tmpFile);
  });

  it('substitutes ${ENV_VAR} with the environment variable value', () => {
    const cfg = loadConfig(tmpFile);
    assert.equal(cfg.providers.anthropic.api_key, 'mysecret123');
  });

  it('substitutes undefined env vars with empty string (YAML null for bare empty)', () => {
    const savedUndefined = process.env.AF_UNDEFINED_VAR;
    try {
      delete process.env.AF_UNDEFINED_VAR;
      // ${AF_UNDEFINED_VAR} → '' → YAML parses bare empty value as null
      const f = writeTmpYaml(`project:\n  name: \${AF_UNDEFINED_VAR}\n`);
      const cfg = loadConfig(f);
      // yaml.load treats `name: ` as null; the substitution still happened
      assert.ok(cfg.project.name === '' || cfg.project.name === null);
      cleanupTmpYaml(f);
    } finally {
      if (savedUndefined === undefined) delete process.env.AF_UNDEFINED_VAR;
      else process.env.AF_UNDEFINED_VAR = savedUndefined;
    }
  });
});

// ---------------------------------------------------------------------------
// buildFromConfig()
// ---------------------------------------------------------------------------

describe('buildFromConfig() — models', () => {
  it('builds the models registry from config.models', () => {
    const cfg = {
      models: {
        'gpt-4': { tier: 'T1', provider: 'openai' },
        'claude-opus': { tier: 'T1', provider: 'anthropic' },
      },
      team: [],
    };
    const { models } = buildFromConfig(cfg);
    assert.ok('gpt-4' in models);
    assert.ok('claude-opus' in models);
    assert.equal(models['claude-opus'].provider, 'anthropic');
  });

  it('returns empty models object when config.models is absent', () => {
    const { models } = buildFromConfig({ team: [] });
    assert.deepEqual(models, {});
  });
});

describe('buildFromConfig() — agents', () => {
  const baseTeam = [
    {
      name: 'Senior Developer',
      role: 'engineer',
      model: 'claude-opus-4-6',
      fallback_models: ['claude-haiku-4-5-20251001'],
      require_review: true,
      reviewer: 'code-reviewer',
    },
  ];

  it('normalises agent id: lowercased with spaces replaced by hyphens', () => {
    const { agents } = buildFromConfig({ team: baseTeam, models: {} });
    assert.ok('senior-developer' in agents, 'Expected agent id "senior-developer"');
  });

  it('copies role, model, and fallback_models', () => {
    const { agents } = buildFromConfig({ team: baseTeam, models: {} });
    const a = agents['senior-developer'];
    assert.equal(a.role, 'engineer');
    assert.equal(a.model, 'claude-opus-4-6');
    assert.deepEqual(a.fallback_models, ['claude-haiku-4-5-20251001']);
  });

  it('copies require_review and reviewer', () => {
    const { agents } = buildFromConfig({ team: baseTeam, models: {} });
    const a = agents['senior-developer'];
    assert.equal(a.require_review, true);
    assert.equal(a.reviewer, 'code-reviewer');
  });

  it('defaults missing optional fields to safe values', () => {
    const { agents } = buildFromConfig({
      team: [{ name: 'Minimal Agent' }],
      models: {},
    });
    const a = agents['minimal-agent'];
    assert.equal(a.require_review, false);
    assert.equal(a.reviewer, null);
    assert.equal(a.model, null);
    assert.deepEqual(a.fallback_models, []);
    assert.deepEqual(a.tools, []);
    assert.equal(a.system_prompt, '');
    assert.equal(a.allow_tier_downgrade, true);
  });

  it('returns empty agents object when team is absent', () => {
    const { agents } = buildFromConfig({ models: {} });
    assert.deepEqual(agents, {});
  });

  it('returns empty agents object when team is empty array', () => {
    const { agents } = buildFromConfig({ team: [], models: {} });
    assert.deepEqual(agents, {});
  });

  it('builds multiple agents from team array', () => {
    const { agents } = buildFromConfig({
      team: [{ name: 'Agent One' }, { name: 'Agent Two' }],
      models: {},
    });
    assert.ok('agent-one' in agents);
    assert.ok('agent-two' in agents);
  });
});

describe('buildFromConfig() — routing rules', () => {
  it('returns rules from config.routing.rules', () => {
    const cfg = {
      team: [],
      models: {},
      routing: { rules: [{ match: { type: 'review' }, model: 'gpt-4' }] },
    };
    const { rules } = buildFromConfig(cfg);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].model, 'gpt-4');
  });

  it('returns empty array when routing.rules is absent', () => {
    const { rules } = buildFromConfig({ team: [], models: {} });
    assert.deepEqual(rules, []);
  });
});
