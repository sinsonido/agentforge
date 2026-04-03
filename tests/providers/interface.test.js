import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BaseProvider, OllamaProvider, ProviderRegistry } from '../../src/providers/interface.js';

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch(status, body) {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

function mockFetchThrow() {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
}

describe('BaseProvider', () => {
  it('constructor sets id, endpoint from config, and apiKey from config.api_key', () => {
    const p = new BaseProvider('my-provider', { endpoint: 'https://api.example.com', api_key: 'secret' });
    assert.equal(p.id, 'my-provider');
    assert.equal(p.endpoint, 'https://api.example.com');
    assert.equal(p.apiKey, 'secret');
  });

  it('constructor sets empty string defaults when config omitted', () => {
    const p = new BaseProvider('bare');
    assert.equal(p.id, 'bare');
    assert.equal(p.endpoint, '');
    assert.equal(p.apiKey, '');
  });

  it('execute() throws containing "not implemented"', async () => {
    const p = new BaseProvider('test');
    await assert.rejects(() => p.execute({}), /not implemented/);
  });

  it('listModels() throws containing "not implemented"', async () => {
    const p = new BaseProvider('test');
    await assert.rejects(() => p.listModels(), /not implemented/);
  });

  it('healthCheck() throws containing "not implemented"', async () => {
    const p = new BaseProvider('test');
    await assert.rejects(() => p.healthCheck(), /not implemented/);
  });
});

describe('OllamaProvider', () => {
  it('constructor sets id to "ollama"', () => {
    const p = new OllamaProvider();
    assert.equal(p.id, 'ollama');
  });

  it('defaults endpoint to "http://localhost:11434" when no config given', () => {
    const p = new OllamaProvider();
    assert.equal(p.endpoint, 'http://localhost:11434');
  });

  it('uses config.endpoint if provided', () => {
    const p = new OllamaProvider({ endpoint: 'http://custom:11434' });
    assert.equal(p.endpoint, 'http://custom:11434');
  });

  it('execute() calls fetch with correct URL (/api/chat)', async () => {
    let capturedUrl;
    globalThis.fetch = async (url, _opts) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ message: { content: 'hi' }, prompt_eval_count: 5, eval_count: 10 }),
      };
    };

    const p = new OllamaProvider({ endpoint: 'http://localhost:11434' });
    await p.execute({ model: 'llama3', messages: [] });
    assert.equal(capturedUrl, 'http://localhost:11434/api/chat');
  });

  it('execute() returns {content, tokens_in, tokens_out, tool_calls:[], finish_reason:"stop"}', async () => {
    mockFetch(200, { message: { content: 'hello' }, prompt_eval_count: 7, eval_count: 13 });

    const p = new OllamaProvider();
    const result = await p.execute({ model: 'llama3', messages: [] });
    assert.deepEqual(result, {
      content: 'hello',
      tokens_in: 7,
      tokens_out: 13,
      tool_calls: [],
      finish_reason: 'stop',
    });
  });

  it('execute() maps prompt_eval_count → tokens_in and eval_count → tokens_out', async () => {
    mockFetch(200, { message: { content: '' }, prompt_eval_count: 42, eval_count: 99 });

    const p = new OllamaProvider();
    const result = await p.execute({ model: 'llama3', messages: [] });
    assert.equal(result.tokens_in, 42);
    assert.equal(result.tokens_out, 99);
  });

  it('execute() throws on non-ok response (status 500)', async () => {
    mockFetch(500, { error: 'internal server error' });

    const p = new OllamaProvider();
    await assert.rejects(
      () => p.execute({ model: 'llama3', messages: [] }),
      /Ollama error 500/
    );
  });

  it('listModels() returns model names from data.models[].name', async () => {
    mockFetch(200, { models: [{ name: 'llama3' }, { name: 'mistral' }] });

    const p = new OllamaProvider();
    const models = await p.listModels();
    assert.deepEqual(models, ['llama3', 'mistral']);
  });

  it('listModels() returns [] on non-ok response', async () => {
    mockFetch(503, {});

    const p = new OllamaProvider();
    const models = await p.listModels();
    assert.deepEqual(models, []);
  });

  it('healthCheck() returns true when fetch ok', async () => {
    mockFetch(200, { models: [] });

    const p = new OllamaProvider();
    const result = await p.healthCheck();
    assert.equal(result, true);
  });

  it('healthCheck() returns false when fetch throws', async () => {
    mockFetchThrow();

    const p = new OllamaProvider();
    const result = await p.healthCheck();
    assert.equal(result, false);
  });
});

describe('ProviderRegistry', () => {
  it('register() and get() work', () => {
    const registry = new ProviderRegistry();
    const p = new BaseProvider('test-provider', {});
    registry.register(p);
    assert.equal(registry.get('test-provider'), p);
  });

  it('get() returns null for unknown id', () => {
    const registry = new ProviderRegistry();
    assert.equal(registry.get('nonexistent'), null);
  });

  it('execute() calls provider.execute with params', async () => {
    const registry = new ProviderRegistry();
    const params = { model: 'llama3', messages: [{ role: 'user', content: 'hi' }] };
    let capturedParams;

    const fakeProvider = {
      id: 'fake',
      execute: async (p) => { capturedParams = p; return { content: 'ok' }; },
      healthCheck: async () => true,
    };
    registry.register(fakeProvider);

    const result = await registry.execute('fake', params);
    assert.deepEqual(capturedParams, params);
    assert.deepEqual(result, { content: 'ok' });
  });

  it('execute() throws "Provider not found" for unknown provider', async () => {
    const registry = new ProviderRegistry();
    await assert.rejects(
      () => registry.execute('ghost', {}),
      /Provider not found/
    );
  });

  it('healthCheckAll() returns map of id → healthCheck result', async () => {
    const registry = new ProviderRegistry();

    registry.register({ id: 'a', execute: async () => {}, healthCheck: async () => true });
    registry.register({ id: 'b', execute: async () => {}, healthCheck: async () => false });

    const results = await registry.healthCheckAll();
    assert.deepEqual(results, { a: true, b: false });
  });
});
