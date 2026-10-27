import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/loader.js';

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

describe('loadConfig model validation', () => {
  let dir;
  const write = (name, body) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  before(() => { dir = mkdtempSync(join(tmpdir(), 'agentforge-config-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

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
