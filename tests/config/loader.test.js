import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, buildFromConfig } from '../../src/config/loader.js';

const TMP = '/tmp/agentforge-loader-test';
before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

function writeCfg(name, content) {
  const p = join(TMP, name);
  writeFileSync(p, content);
  return p;
}

describe('loadConfig()', () => {
  describe('missing file', () => {
    it('returns DEFAULT_CONFIG when file does not exist', () => {
      const cfg = loadConfig(join(TMP, 'nonexistent.yml'));
      assert.ok(cfg, 'should return a config object');
      assert.ok(typeof cfg === 'object', 'config should be an object');
    });

    it('default project.budget is 100', () => {
      const cfg = loadConfig(join(TMP, 'nonexistent.yml'));
      assert.equal(cfg.project.budget, 100);
    });

    it('default server.port is 4242', () => {
      const cfg = loadConfig(join(TMP, 'nonexistent.yml'));
      assert.equal(cfg.server.port, 4242);
    });
  });

  describe('valid YAML', () => {
    it('parses project name from YAML', () => {
      const p = writeCfg('basic.yml', `
project:
  name: My Project
  budget: 50
`);
      const cfg = loadConfig(p);
      assert.equal(cfg.project.name, 'My Project');
    });

    it('parses project budget from YAML', () => {
      const p = writeCfg('budget.yml', `
project:
  name: My Project
  budget: 50
`);
      const cfg = loadConfig(p);
      assert.equal(cfg.project.budget, 50);
    });

    it('merges with defaults — server.port still 4242 when not in YAML', () => {
      const p = writeCfg('noportyml', `
project:
  name: My Project
  budget: 50
`);
      const cfg = loadConfig(p);
      assert.equal(cfg.server.port, 4242);
    });
  });

  describe('env var substitution', () => {
    it('replaces ${MY_VAR} with process.env.MY_VAR value', () => {
      process.env.TEST_API_KEY = 'secret-123';
      const p = writeCfg('envtest.yml', 'providers:\n  openai:\n    api_key: ${TEST_API_KEY}\n');
      const cfg = loadConfig(p);
      assert.equal(cfg.providers.openai.api_key, 'secret-123');
      delete process.env.TEST_API_KEY;
    });

    it('replaces ${MISSING_VAR} with empty string (YAML parses bare empty as null)', () => {
      delete process.env.MISSING_VAR_XYZ;
      // ${MISSING_VAR_XYZ} is replaced with '' before YAML parsing;
      // js-yaml then parses the bare empty scalar as null.
      const p = writeCfg('missingvar.yml', 'providers:\n  openai:\n    api_key: ${MISSING_VAR_XYZ}\n');
      const cfg = loadConfig(p);
      // The substituted value is falsy (null from yaml empty scalar)
      assert.ok(!cfg.providers.openai.api_key, 'missing var should produce a falsy api_key');
    });
  });

  describe('deep merge', () => {
    it('arrays from YAML override defaults (not merged)', () => {
      const p = writeCfg('arrayyml', `
routing:
  rules:
    - name: rule1
    - name: rule2
`);
      const cfg = loadConfig(p);
      assert.equal(cfg.routing.rules.length, 2);
      assert.equal(cfg.routing.rules[0].name, 'rule1');
    });

    it('nested objects are merged', () => {
      const p = writeCfg('mergeyml', `
server:
  port: 9000
`);
      const cfg = loadConfig(p);
      assert.equal(cfg.server.port, 9000);
      assert.equal(cfg.server.host, 'localhost');
    });
  });
});

describe('buildFromConfig()', () => {
  describe('models', () => {
    it('builds models map keyed by model id', () => {
      const config = {
        models: {
          'gpt-4': { provider: 'openai', tier: 1 },
          'claude-3': { provider: 'anthropic', tier: 2 },
        },
      };
      const { models } = buildFromConfig(config);
      assert.ok('gpt-4' in models);
      assert.ok('claude-3' in models);
    });

    it('preserves model properties', () => {
      const config = {
        models: {
          'gpt-4': { provider: 'openai', tier: 1, cost_per_token: 0.00003 },
        },
      };
      const { models } = buildFromConfig(config);
      assert.equal(models['gpt-4'].provider, 'openai');
      assert.equal(models['gpt-4'].tier, 1);
      assert.equal(models['gpt-4'].cost_per_token, 0.00003);
    });
  });

  describe('agents', () => {
    it('normalises agent name to id — spaces → hyphens, lowercase', () => {
      const config = {
        team: [{ name: 'My Code Agent', model: 'gpt-4' }],
      };
      const { agents } = buildFromConfig(config);
      assert.ok('my-code-agent' in agents);
    });

    it('sets default allow_tier_downgrade to true', () => {
      const config = {
        team: [{ name: 'agent1', model: 'gpt-4' }],
      };
      const { agents } = buildFromConfig(config);
      assert.equal(agents['agent1'].allow_tier_downgrade, true);
    });

    it('sets default fallback_models to []', () => {
      const config = {
        team: [{ name: 'agent1', model: 'gpt-4' }],
      };
      const { agents } = buildFromConfig(config);
      assert.deepEqual(agents['agent1'].fallback_models, []);
    });

    it('sets default tools to []', () => {
      const config = {
        team: [{ name: 'agent1', model: 'gpt-4' }],
      };
      const { agents } = buildFromConfig(config);
      assert.deepEqual(agents['agent1'].tools, []);
    });

    it('sets default require_review to false', () => {
      const config = {
        team: [{ name: 'agent1', model: 'gpt-4' }],
      };
      const { agents } = buildFromConfig(config);
      assert.equal(agents['agent1'].require_review, false);
    });
  });

  describe('agents with all fields', () => {
    it('preserves role, model, reviewer, max_cost_per_task', () => {
      const config = {
        team: [
          {
            name: 'Senior Dev',
            role: 'developer',
            model: 'claude-3',
            reviewer: 'lead-reviewer',
            max_cost_per_task: 0.5,
            require_review: true,
            fallback_models: ['gpt-4'],
            tools: ['bash', 'read'],
            allow_tier_downgrade: false,
          },
        ],
      };
      const { agents } = buildFromConfig(config);
      const agent = agents['senior-dev'];
      assert.equal(agent.role, 'developer');
      assert.equal(agent.model, 'claude-3');
      assert.equal(agent.reviewer, 'lead-reviewer');
      assert.equal(agent.max_cost_per_task, 0.5);
      assert.equal(agent.require_review, true);
      assert.deepEqual(agent.fallback_models, ['gpt-4']);
      assert.deepEqual(agent.tools, ['bash', 'read']);
      assert.equal(agent.allow_tier_downgrade, false);
    });
  });

  describe('rules', () => {
    it('returns routing rules from config', () => {
      const config = {
        routing: {
          rules: [
            { name: 'rule1', condition: 'tier == 1' },
            { name: 'rule2', condition: 'tier == 2' },
          ],
        },
      };
      const { rules } = buildFromConfig(config);
      assert.equal(rules.length, 2);
      assert.equal(rules[0].name, 'rule1');
      assert.equal(rules[1].name, 'rule2');
    });

    it('returns empty array when no rules', () => {
      const config = {};
      const { rules } = buildFromConfig(config);
      assert.deepEqual(rules, []);
    });
  });

  describe('empty config', () => {
    it('returns empty models when config has no models', () => {
      const { models } = buildFromConfig({});
      assert.deepEqual(models, {});
    });

    it('returns empty agents when config has no team', () => {
      const { agents } = buildFromConfig({});
      assert.deepEqual(agents, {});
    });

    it('returns empty rules when config has no routing', () => {
      const { rules } = buildFromConfig({});
      assert.deepEqual(rules, []);
    });
  });
});
