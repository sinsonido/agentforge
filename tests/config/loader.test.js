import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, buildFromConfig } from '../../src/config/loader.js';

const examplePath = fileURLToPath(new URL('../../agentforge.example.yml', import.meta.url));

const BASE = `
providers:
  anthropic:
    api_key: x
  ollama:
    enabled: false
models:
  claude-sonnet-5-5:
    provider: anthropic
    tier: 2
  codestral:22b:
    provider: ollama
    tier: 3
`;

let dir;
const write = (name, body) => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

before(() => { dir = mkdtempSync(join(tmpdir(), 'agentforge-config-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe('loadConfig model validation', () => {
  it('accepts agentforge.example.yml', () => {
    const config = loadConfig(examplePath);
    assert.ok(Object.keys(config.models).length > 0);
  });

  it('accepts references to models whose provider is configured, even if disabled', () => {
    const path = write('ok.yml', `${BASE}
team:
  - name: Dev
    model: claude-sonnet-5-5
    fallback_models: [codestral:22b]
`);
    assert.equal(loadConfig(path).team[0].model, 'claude-sonnet-5-5');
  });

  it('rejects an agent fallback that is not a configured model', () => {
    const path = write('agent-fallback.yml', `${BASE}
team:
  - name: Dev
    model: claude-sonnet-5-5
    fallback_models: [gpt-4o]
`);
    assert.throws(() => loadConfig(path), /team "Dev" fallback_models references "gpt-4o"/);
  });

  it('rejects a routing fallback that is not a configured model', () => {
    const path = write('rule-fallback.yml', `${BASE}
routing:
  rules:
    - match: { type: [implement] }
      prefer: claude-sonnet-5-5
      fallback: [codestral]
`);
    assert.throws(() => loadConfig(path), /routing rule #1 fallback references "codestral"/);
  });

  it('rejects a model whose provider is not configured', () => {
    const path = write('no-provider.yml', `${BASE}
  gpt-6-astra:
    provider: openai
    tier: 1
routing:
  rules:
    - match: { type: [planning] }
      force: gpt-6-astra
`);
    assert.throws(() => loadConfig(path), /model "gpt-6-astra" uses provider "openai"/);
  });

  it('lists every problem in one error', () => {
    const path = write('many.yml', `${BASE}
team:
  - name: Dev
    model: claude-opus-4
routing:
  rules:
    - match: { type: [test] }
      prefer: deepseek-v3
`);
    assert.throws(() => loadConfig(path), (err) => {
      assert.match(err.message, /"claude-opus-4"/);
      assert.match(err.message, /"deepseek-v3"/);
      return true;
    });
  });
});

describe('loadConfig defaults and env vars', () => {
  it('returns defaults when the file does not exist', () => {
    const cfg = loadConfig(join(dir, 'nonexistent.yml'));
    assert.equal(cfg.project.name, 'AgentForge Project');
    assert.equal(cfg.project.budget, 100);
    assert.equal(cfg.server.port, 4242);
    assert.deepEqual(cfg.team, []);
  });

  it('returns defaults for an empty file', () => {
    const cfg = loadConfig(write('empty.yml', ''));
    assert.equal(cfg.project.budget, 100);
    assert.equal(cfg.routing.fallback_strategy, 'same_tier_then_downgrade');
  });

  it('overrides only the keys the file sets and keeps sibling defaults', () => {
    const cfg = loadConfig(write('partial.yml', `
project:
  name: My Project
routing:
  fallback_strategy: cheapest
server:
  port: 3000
`));
    assert.equal(cfg.project.name, 'My Project');
    assert.equal(cfg.project.budget, 100);
    assert.equal(cfg.project.currency, 'USD');
    assert.equal(cfg.routing.fallback_strategy, 'cheapest');
    assert.equal(cfg.routing.cost_optimization, true);
    assert.equal(cfg.server.port, 3000);
    assert.equal(cfg.server.host, 'localhost');
  });

  it('resolves ${VAR} references from the environment', (t) => {
    process.env.AGENTFORGE_TEST_KEY = 'secret-key-123';
    t.after(() => { delete process.env.AGENTFORGE_TEST_KEY; });
    const cfg = loadConfig(write('env.yml', 'providers:\n  anthropic:\n    api_key: "${AGENTFORGE_TEST_KEY}"\n'));
    assert.equal(cfg.providers.anthropic.api_key, 'secret-key-123');
  });

  it('resolves an unset ${VAR} to an empty string', () => {
    delete process.env.AGENTFORGE_TEST_UNSET;
    const cfg = loadConfig(write('missing-env.yml', 'providers:\n  anthropic:\n    api_key: "${AGENTFORGE_TEST_UNSET}"\n'));
    assert.equal(cfg.providers.anthropic.api_key, '');
  });
});

describe('loadConfig intake', () => {
  it('reads the intake block from agentforge.example.yml', () => {
    const { intake } = loadConfig(examplePath);
    assert.deepEqual(intake.repos, [{ repo: 'sinsonido/agentforge', base: 'master', setup_command: 'npm ci', test_command: 'npm test' }]);
    assert.equal(intake.label, 'agentforge');
  });

  it('defaults to no repos, label agentforge, 60 s and the feature playbook', () => {
    assert.deepEqual(loadConfig(write('no-intake.yml', '')).intake, {
      repos: [], label: 'agentforge', interval_seconds: 60, default_playbook: 'feature',
    });
  });

  it('keeps sibling defaults when the file sets only repos', () => {
    const { intake } = loadConfig(write('intake-repos.yml', `
intake:
  repos:
    - repo: acme/app
      base: main
`));
    assert.deepEqual(intake.repos, [{ repo: 'acme/app', base: 'main' }]);
    assert.equal(intake.interval_seconds, 60);
  });

  it('lists every intake problem in one error', () => {
    const path = write('intake-bad.yml', `
intake:
  repos:
    - repo: not-a-slug
      test_command: ""
    - base: main
      setup_command: 3
  label: ""
  interval_seconds: 0
  default_playbook: rewrite
`);
    assert.throws(() => loadConfig(path), (err) => {
      for (const part of [
        'repos[0].repo must be "owner/name"', 'repos[0].base is required',
        'repos[0].test_command must be a non-empty string', 'repos[1].setup_command must be a non-empty string',
        'repos[1].repo must be "owner/name"', 'label must be a non-empty string',
        'interval_seconds must be a positive number', 'default_playbook must be one of',
      ]) assert.ok(err.message.includes(part), part);
      return true;
    });
  });

  it('rejects an empty intake block', () => {
    assert.throws(() => loadConfig(write('intake-null.yml', 'intake:\n')), /intake must be a mapping/);
  });
});

describe('buildFromConfig', () => {
  it('returns empty registries for an empty config', () => {
    assert.deepEqual(buildFromConfig({}), { models: {}, agents: {}, rules: [] });
  });

  it('copies models and routing rules through', () => {
    const rule = { match: { type: ['planning'] }, prefer: 'claude-sonnet-5-5' };
    const { models, rules } = buildFromConfig({
      models: { 'claude-sonnet-5-5': { provider: 'anthropic', tier: 2 } },
      routing: { rules: [rule] },
    });
    assert.deepEqual(models, { 'claude-sonnet-5-5': { provider: 'anthropic', tier: 2 } });
    assert.deepEqual(rules, [rule]);
  });

  it('keys agents by slugified name and fills defaults', () => {
    const { agents } = buildFromConfig({ team: [{ name: 'Senior Developer' }] });
    assert.deepEqual(Object.keys(agents), ['senior-developer']);
    const agent = agents['senior-developer'];
    assert.equal(agent.id, 'senior-developer');
    assert.equal(agent.name, 'Senior Developer');
    assert.equal(agent.model, null);
    assert.deepEqual(agent.fallback_models, []);
    assert.equal(agent.system_prompt, '');
    assert.deepEqual(agent.tools, []);
    assert.equal(agent.require_review, false);
    assert.equal(agent.reviewer, null);
    assert.equal(agent.allow_tier_downgrade, true);
  });

  it('keeps explicit agent settings, including allow_tier_downgrade: false', () => {
    const { agents } = buildFromConfig({
      team: [{ name: 'Dev', require_review: true, reviewer: 'qa-lead', allow_tier_downgrade: false }],
    });
    assert.equal(agents.dev.require_review, true);
    assert.equal(agents.dev.reviewer, 'qa-lead');
    assert.equal(agents.dev.allow_tier_downgrade, false);
  });

  it('loads system_prompt from system_prompt_file', () => {
    const file = write('prompt.md', 'You review code.');
    const { agents } = buildFromConfig({ team: [{ name: 'Reviewer', system_prompt_file: file }] });
    assert.equal(agents.reviewer.system_prompt, 'You review code.');
  });
});
