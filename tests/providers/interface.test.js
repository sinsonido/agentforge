import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BaseProvider, OllamaProvider, ProviderRegistry } from '../../src/providers/interface.js';

let originalFetch;
let calls;
beforeEach(() => { originalFetch = globalThis.fetch; calls = []; });
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch(status, body) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  };
}

describe('BaseProvider', () => {
  it('rejects every method an adapter forgot to implement', async () => {
    const p = new BaseProvider('half-done');
    await assert.rejects(() => p.execute({}), /half-done: execute\(\) not implemented/);
    await assert.rejects(() => p.listModels(), /not implemented/);
    await assert.rejects(() => p.healthCheck(), /not implemented/);
  });
});

describe('OllamaProvider', () => {
  it('registers under the id "ollama" that model configs reference', () => {
    const registry = new ProviderRegistry();
    registry.register(new OllamaProvider());
    assert.ok(registry.get('ollama'));
  });

  it('posts a non-streaming chat request to the default local endpoint', async () => {
    mockFetch(200, { message: { content: 'hi' } });
    const messages = [{ role: 'user', content: 'ping' }];

    await new OllamaProvider().execute({ model: 'llama3', messages, max_tokens: 256, temperature: 0.2 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:11434/api/chat');
    assert.equal(calls[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].opts.body), {
      model: 'llama3',
      messages,
      stream: false,
      options: { num_predict: 256, temperature: 0.2 },
    });
  });

  it('sends requests to a configured endpoint', async () => {
    mockFetch(200, { message: { content: 'hi' } });
    await new OllamaProvider({ endpoint: 'http://gpu-box:11434' }).execute({ model: 'llama3', messages: [] });
    assert.equal(calls[0].url, 'http://gpu-box:11434/api/chat');
  });

  it('returns the provider contract shape with token counts', async () => {
    mockFetch(200, { message: { content: 'hello' }, prompt_eval_count: 7, eval_count: 13 });
    const result = await new OllamaProvider().execute({ model: 'llama3', messages: [] });
    assert.deepEqual(result, {
      content: 'hello',
      tokens_in: 7,
      tokens_out: 13,
      tool_calls: [],
      finish_reason: 'stop',
    });
  });

  it('reports zero tokens and empty content when Ollama omits them', async () => {
    mockFetch(200, {});
    const result = await new OllamaProvider().execute({ model: 'llama3', messages: [] });
    assert.equal(result.content, '');
    assert.equal(result.tokens_in, 0);
    assert.equal(result.tokens_out, 0);
  });

  it('rejects with the HTTP status when Ollama returns an error', async () => {
    mockFetch(500, { error: 'internal server error' });
    await assert.rejects(
      () => new OllamaProvider().execute({ model: 'llama3', messages: [] }),
      /Ollama error 500/,
    );
  });

  it('lists installed model names', async () => {
    mockFetch(200, { models: [{ name: 'llama3' }, { name: 'mistral' }] });
    assert.deepEqual(await new OllamaProvider().listModels(), ['llama3', 'mistral']);
  });

  it('lists no models when Ollama answers with an error', async () => {
    mockFetch(503, {});
    assert.deepEqual(await new OllamaProvider().listModels(), []);
  });

  it('is healthy when the tags endpoint answers ok', async () => {
    mockFetch(200, { models: [] });
    assert.equal(await new OllamaProvider().healthCheck(), true);
  });

  it('is unhealthy when the tags endpoint answers with an error', async () => {
    mockFetch(503, {});
    assert.equal(await new OllamaProvider().healthCheck(), false);
  });

  it('is unhealthy when Ollama is unreachable', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await new OllamaProvider().healthCheck(), false);
  });
});

describe('ProviderRegistry', () => {
  const fake = (id, health = true) => ({
    id,
    received: null,
    async execute(params) { this.received = params; return { content: `from ${id}` }; },
    async healthCheck() { return health; },
  });

  it('returns a registered provider by id and null for an unknown id', () => {
    const registry = new ProviderRegistry();
    const p = fake('anthropic');
    registry.register(p);
    assert.equal(registry.get('anthropic'), p);
    assert.equal(registry.get('nonexistent'), null);
  });

  it('routes execute() to the named provider with the params unchanged', async () => {
    const registry = new ProviderRegistry();
    const a = fake('a');
    const b = fake('b');
    registry.register(a);
    registry.register(b);
    const params = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

    const result = await registry.execute('b', params);

    assert.deepEqual(result, { content: 'from b' });
    assert.deepEqual(b.received, params);
    assert.equal(a.received, null);
  });

  it('rejects execute() for an unregistered provider', async () => {
    await assert.rejects(() => new ProviderRegistry().execute('ghost', {}), /Provider not found: ghost/);
  });

  it('reports health per provider', async () => {
    const registry = new ProviderRegistry();
    registry.register(fake('a', true));
    registry.register(fake('b', false));
    assert.deepEqual(await registry.healthCheckAll(), { a: true, b: false });
  });
});
