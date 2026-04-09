/**
 * @file tests/providers/interface.test.js
 * @description Unit tests for src/providers/interface.js
 *
 * Covers:
 *  - BaseProvider: constructor, execute/listModels/healthCheck throw "not implemented"
 *  - OllamaProvider: constructor defaults, execute() parses Ollama response,
 *    execute() throws on HTTP error, listModels(), healthCheck()
 *  - ProviderRegistry: register/get, execute() delegates, execute() throws for
 *    unknown provider, healthCheckAll()
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BaseProvider, OllamaProvider, ProviderRegistry } from '../../src/providers/interface.js';

// ---------------------------------------------------------------------------
// Helpers — minimal Ollama HTTP stub
// ---------------------------------------------------------------------------

/**
 * Creates a tiny HTTP server that responds to Ollama API paths.
 * Returns { server, port, setResponse }.
 */
function createOllamaStub() {
  let responseConfig = {
    '/api/chat': {
      status: 200,
      body: {
        message: { content: 'Hello from Ollama' },
        prompt_eval_count: 10,
        eval_count: 20,
      },
    },
    '/api/tags': {
      status: 200,
      body: { models: [{ name: 'llama3' }, { name: 'mistral' }] },
    },
  };

  const server = http.createServer((req, res) => {
    const cfg = responseConfig[req.url] || { status: 404, body: { error: 'not found' } };
    res.writeHead(cfg.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cfg.body));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const endpoint = `http://127.0.0.1:${port}`;
      resolve({
        server,
        port,
        endpoint,
        setRoute(path, status, body) {
          responseConfig[path] = { status, body };
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// BaseProvider
// ---------------------------------------------------------------------------

describe('BaseProvider', () => {
  it('constructor sets id, endpoint, apiKey from config', () => {
    const p = new BaseProvider('test-provider', { endpoint: 'https://api.test.com', api_key: 'sk-123' });
    assert.equal(p.id, 'test-provider');
    assert.equal(p.endpoint, 'https://api.test.com');
    assert.equal(p.apiKey, 'sk-123');
  });

  it('constructor uses empty defaults when config is omitted', () => {
    const p = new BaseProvider('bare');
    assert.equal(p.id, 'bare');
    assert.equal(p.endpoint, '');
    assert.equal(p.apiKey, '');
  });

  it('execute() throws "not implemented" error', async () => {
    const p = new BaseProvider('x');
    await assert.rejects(() => p.execute({}), /not implemented/);
  });

  it('listModels() throws "not implemented" error', async () => {
    const p = new BaseProvider('x');
    await assert.rejects(() => p.listModels(), /not implemented/);
  });

  it('healthCheck() throws "not implemented" error', async () => {
    const p = new BaseProvider('x');
    await assert.rejects(() => p.healthCheck(), /not implemented/);
  });

  it('error messages include the provider id', async () => {
    const p = new BaseProvider('my-provider');
    await assert.rejects(() => p.execute({}), /my-provider/);
  });
});

// ---------------------------------------------------------------------------
// OllamaProvider
// ---------------------------------------------------------------------------

describe('OllamaProvider', () => {
  let stub;

  before(async () => { stub = await createOllamaStub(); });
  after(() => new Promise((resolve) => stub.server.close(resolve)));

  it('constructor defaults endpoint to http://localhost:11434', () => {
    const p = new OllamaProvider();
    assert.equal(p.endpoint, 'http://localhost:11434');
    assert.equal(p.id, 'ollama');
  });

  it('constructor accepts a custom endpoint', () => {
    const p = new OllamaProvider({ endpoint: 'http://remote:11434' });
    assert.equal(p.endpoint, 'http://remote:11434');
  });

  it('execute() returns normalised response shape', async () => {
    const p = new OllamaProvider({ endpoint: stub.endpoint });
    const result = await p.execute({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.content, 'Hello from Ollama');
    assert.equal(result.tokens_in, 10);
    assert.equal(result.tokens_out, 20);
    assert.deepEqual(result.tool_calls, []);
    assert.equal(result.finish_reason, 'stop');
  });

  it('execute() throws on non-OK HTTP status', async () => {
    stub.setRoute('/api/chat', 500, { error: 'Internal Server Error' });
    const p = new OllamaProvider({ endpoint: stub.endpoint });
    await assert.rejects(
      () => p.execute({ model: 'llama3', messages: [] }),
      /Ollama error 500/,
    );
    // restore
    stub.setRoute('/api/chat', 200, {
      message: { content: 'Hello from Ollama' },
      prompt_eval_count: 10,
      eval_count: 20,
    });
  });

  it('execute() handles missing token counts (defaults to 0)', async () => {
    stub.setRoute('/api/chat', 200, { message: { content: 'sparse' } });
    const p = new OllamaProvider({ endpoint: stub.endpoint });
    const result = await p.execute({ model: 'llama3', messages: [] });
    assert.equal(result.tokens_in, 0);
    assert.equal(result.tokens_out, 0);
    // restore
    stub.setRoute('/api/chat', 200, {
      message: { content: 'Hello from Ollama' },
      prompt_eval_count: 10,
      eval_count: 20,
    });
  });

  it('listModels() returns array of model name strings', async () => {
    const p = new OllamaProvider({ endpoint: stub.endpoint });
    const models = await p.listModels();
    assert.deepEqual(models, ['llama3', 'mistral']);
  });

  it('listModels() returns empty array on HTTP error', async () => {
    stub.setRoute('/api/tags', 503, {});
    const p = new OllamaProvider({ endpoint: stub.endpoint });
    const models = await p.listModels();
    assert.deepEqual(models, []);
    stub.setRoute('/api/tags', 200, { models: [{ name: 'llama3' }, { name: 'mistral' }] });
  });

  it('healthCheck() returns true when server responds OK', async () => {
    const p = new OllamaProvider({ endpoint: stub.endpoint });
    assert.equal(await p.healthCheck(), true);
  });

  it('healthCheck() returns false when server is unreachable', async () => {
    const p = new OllamaProvider({ endpoint: 'http://127.0.0.1:1' }); // nothing listens on port 1
    assert.equal(await p.healthCheck(), false);
  });

  it('healthCheck() returns false on HTTP error status', async () => {
    stub.setRoute('/api/tags', 503, {});
    const p = new OllamaProvider({ endpoint: stub.endpoint });
    assert.equal(await p.healthCheck(), false);
    stub.setRoute('/api/tags', 200, { models: [{ name: 'llama3' }, { name: 'mistral' }] });
  });
});

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

describe('ProviderRegistry', () => {
  /** Minimal provider stub */
  function makeProvider(id, executeResult = { content: 'ok', tokens_in: 1, tokens_out: 1, tool_calls: [], finish_reason: 'stop' }) {
    return {
      id,
      execute: async (_params) => executeResult,
      healthCheck: async () => true,
    };
  }

  it('get() returns null for unknown provider', () => {
    const reg = new ProviderRegistry();
    assert.equal(reg.get('missing'), null);
  });

  it('register() + get() round-trip', () => {
    const reg = new ProviderRegistry();
    const p = makeProvider('anthropic');
    reg.register(p);
    assert.equal(reg.get('anthropic'), p);
  });

  it('execute() delegates to the registered provider', async () => {
    const reg = new ProviderRegistry();
    reg.register(makeProvider('anthropic', { content: 'delegate works', tokens_in: 5, tokens_out: 8, tool_calls: [], finish_reason: 'stop' }));
    const result = await reg.execute('anthropic', { model: 'claude-opus-4-6', messages: [] });
    assert.equal(result.content, 'delegate works');
    assert.equal(result.tokens_in, 5);
  });

  it('execute() throws when provider is not registered', async () => {
    const reg = new ProviderRegistry();
    await assert.rejects(() => reg.execute('unknown', {}), /Provider not found: unknown/);
  });

  it('healthCheckAll() returns a map of provider → boolean', async () => {
    const reg = new ProviderRegistry();
    const healthy = { ...makeProvider('a'), healthCheck: async () => true };
    const unhealthy = { ...makeProvider('b'), healthCheck: async () => false };
    reg.register(healthy);
    reg.register(unhealthy);
    const results = await reg.healthCheckAll();
    assert.equal(results.a, true);
    assert.equal(results.b, false);
  });

  it('healthCheckAll() returns empty object when no providers are registered', async () => {
    const reg = new ProviderRegistry();
    const results = await reg.healthCheckAll();
    assert.deepEqual(results, {});
  });

  it('register() overwrites a provider with the same id', () => {
    const reg = new ProviderRegistry();
    const p1 = makeProvider('x');
    const p2 = makeProvider('x');
    reg.register(p1);
    reg.register(p2);
    assert.equal(reg.get('x'), p2);
  });
});
