import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { loadConfig, buildFromConfig } from '../../src/config/loader.js';

// ---------------------------------------------------------------------------
// Temp dir setup
// ---------------------------------------------------------------------------

const tmpDir = join(os.tmpdir(), 'agentforge-config-test-' + process.pid);

before(() => {
  mkdirSync(tmpDir, { recursive: true });
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTmp(name, content) {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// loadConfig()
// ---------------------------------------------------------------------------

describe('loadConfig()', () => {
  afterEach(() => {
    // Clean up any env vars we set during tests
    delete process.env.TEST_API_KEY;
    delete process.env.TEST_HOST;
  });

  it('returns DEFAULT_CONFIG when file does not exist', () => {
    const config = loadConfig(join(tmpDir, 'nonexistent.yml'));
    assert.equal(config.project.name, 'AgentForge Project');
    assert.equal(config.project.budget, 100);
    assert.equal(config.project.currency, 'USD');
    assert.equal(config.server.port, 4242);
    assert.equal(config.server.host, 'localhost');
    assert.equal(config.git.enabled, false);
    assert.deepEqual(config.routing.rules, []);
    assert.equal(config.routing.fallback_strategy, 'same_tier_then_downgrade');
    assert.equal(config.routing.cost_optimization, true);
  });

  it('loads and parses a valid YAML file', () => {
    const filePath = writeTmp('valid.yml', `
project:
  name: MyProject
  budget: 200
  currency: EUR
server:
  port: 3000
`);
    const config = loadConfig(filePath);
    assert.equal(config.project.name, 'MyProject');
    assert.equal(config.project.budget, 200);
    assert.equal(config.project.currency, 'EUR');
    assert.equal(config.server.port, 3000);
    // Default values not in file should still be present
    assert.equal(config.server.host, 'localhost');
    assert.equal(config.git.enabled, false);
  });

  it('resolves ${ENV_VAR} references from process.env', () => {
    process.env.TEST_API_KEY = 'secret-key-123';
    const filePath = writeTmp('env-vars.yml', `
providers:
  anthropic:
    api_key: \${TEST_API_KEY}
`);
    const config = loadConfig(filePath);
    assert.equal(config.providers.anthropic.api_key, 'secret-key-123');
  });

  it('leaves ${MISSING_VAR} as empty string when env var not set', () => {
    // Ensure var is not set
    delete process.env.MISSING_VAR_THAT_DOES_NOT_EXIST;
    const filePath = writeTmp('missing-var.yml', `
providers:
  anthropic:
    api_key: \${MISSING_VAR_THAT_DOES_NOT_EXIST}
`);
    const config = loadConfig(filePath);
    // The loader replaces ${VAR} with '' (empty string), so the YAML line becomes
    // `api_key: ` — an unquoted empty scalar. js-yaml parses that as null.
    assert.equal(config.providers.anthropic.api_key, null);
  });

  it('merges loaded config with defaults (partial override)', () => {
    const filePath = writeTmp('partial.yml', `
project:
  name: PartialProject
routing:
  cost_optimization: false
`);
    const config = loadConfig(filePath);
    // Overridden values
    assert.equal(config.project.name, 'PartialProject');
    assert.equal(config.routing.cost_optimization, false);
    // Default values preserved through merge
    assert.equal(config.project.budget, 100);
    assert.equal(config.project.currency, 'USD');
    assert.equal(config.routing.fallback_strategy, 'same_tier_then_downgrade');
    assert.deepEqual(config.routing.rules, []);
    assert.equal(config.alerts.budget_warning_pct, 0.80);
    assert.equal(config.alerts.budget_pause_pct, 0.95);
  });

  it('handles empty YAML file gracefully (returns defaults)', () => {
    const filePath = writeTmp('empty.yml', '');
    const config = loadConfig(filePath);
    assert.equal(config.project.name, 'AgentForge Project');
    assert.equal(config.project.budget, 100);
    assert.equal(config.server.port, 4242);
    assert.equal(config.git.enabled, false);
  });
});

// ---------------------------------------------------------------------------
// buildFromConfig()
// ---------------------------------------------------------------------------

describe('buildFromConfig()', () => {
  it('builds empty models and agents when config has none', () => {
    const { models, agents, rules } = buildFromConfig({});
    assert.deepEqual(models, {});
    assert.deepEqual(agents, {});
    assert.deepEqual(rules, []);
  });

  it('builds models registry from config.models', () => {
    const config = {
      models: {
        'claude-3-5-sonnet': { provider: 'anthropic', tier: 1, cost_per_1k_tokens: 0.003 },
        'gpt-4o': { provider: 'openai', tier: 1, cost_per_1k_tokens: 0.005 },
      },
    };
    const { models } = buildFromConfig(config);
    assert.ok(models['claude-3-5-sonnet']);
    assert.equal(models['claude-3-5-sonnet'].provider, 'anthropic');
    assert.equal(models['claude-3-5-sonnet'].tier, 1);
    assert.ok(models['gpt-4o']);
    assert.equal(models['gpt-4o'].provider, 'openai');
  });

  it('builds agents map from config.team', () => {
    const config = {
      team: [
        {
          name: 'Alice',
          role: 'developer',
          model: 'claude-3-5-sonnet',
          system_prompt: 'You are a developer.',
        },
      ],
    };
    const { agents } = buildFromConfig(config);
    assert.ok(agents['alice']);
    assert.equal(agents['alice'].name, 'Alice');
    assert.equal(agents['alice'].role, 'developer');
    assert.equal(agents['alice'].model, 'claude-3-5-sonnet');
    assert.equal(agents['alice'].system_prompt, 'You are a developer.');
  });

  it('normalizes agent IDs: spaces become dashes, lowercased', () => {
    const config = {
      team: [
        { name: 'Senior Dev Agent' },
        { name: 'QA Bot' },
        { name: 'UPPERCASE' },
      ],
    };
    const { agents } = buildFromConfig(config);
    assert.ok(agents['senior-dev-agent'], 'expected senior-dev-agent key');
    assert.ok(agents['qa-bot'], 'expected qa-bot key');
    assert.ok(agents['uppercase'], 'expected uppercase key');
  });

  it('sets allow_tier_downgrade default to true when not specified', () => {
    const config = {
      team: [
        { name: 'Agent One' },
        { name: 'Agent Two', allow_tier_downgrade: false },
      ],
    };
    const { agents } = buildFromConfig(config);
    assert.equal(agents['agent-one'].allow_tier_downgrade, true);
    assert.equal(agents['agent-two'].allow_tier_downgrade, false);
  });

  it('returns rules from config.routing.rules', () => {
    const config = {
      routing: {
        rules: [
          { match: { role: 'developer' }, model: 'claude-3-5-sonnet' },
          { match: { role: 'qa' }, model: 'gpt-4o-mini' },
        ],
      },
    };
    const { rules } = buildFromConfig(config);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].model, 'claude-3-5-sonnet');
    assert.equal(rules[1].model, 'gpt-4o-mini');
  });

  it('returns empty rules when routing not specified', () => {
    const config = { models: {}, team: [] };
    const { rules } = buildFromConfig(config);
    assert.deepEqual(rules, []);
  });

  it('agent with system_prompt_file that does not exist keeps empty system_prompt', () => {
    const config = {
      team: [
        {
          name: 'Phantom Agent',
          system_prompt_file: join(tmpDir, 'no-such-prompt.txt'),
        },
      ],
    };
    const { agents } = buildFromConfig(config);
    assert.equal(agents['phantom-agent'].system_prompt, '');
  });

  it('populates agent defaults for optional fields', () => {
    const config = {
      team: [
        { name: 'Minimal Agent' },
      ],
    };
    const { agents } = buildFromConfig(config);
    const a = agents['minimal-agent'];
    assert.equal(a.id, 'minimal-agent');
    assert.equal(a.role, '');
    assert.equal(a.model, null);
    assert.deepEqual(a.fallback_models, []);
    assert.equal(a.system_prompt, '');
    assert.equal(a.system_prompt_file, null);
    assert.deepEqual(a.tools, []);
    assert.equal(a.require_review, false);
    assert.equal(a.reviewer, null);
    assert.equal(a.max_cost_per_task, null);
    assert.equal(a.max_tokens_per_task, null);
    assert.equal(a.allow_tier_downgrade, true);
  });
});
