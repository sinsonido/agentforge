import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BaseProvider, OllamaProvider, ProviderRegistry } from '../../src/providers/interface.js';

describe('BaseProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new BaseProvider('test-provider', { endpoint: 'http://localhost:9000', api_key: 'key-123' });
  });

  describe('constructor', () => {
    it('sets id from first argument', () => {
      assert.equal(provider.id, 'test-provider');
    });

    it('sets endpoint from config', () => {
      assert.equal(provider.endpoint, 'http://localhost:9000');
    });

    it('sets apiKey from config.api_key', () => {
      assert.equal(provider.apiKey, 'key-123');
    });

    it('defaults endpoint to empty string', () => {
      const p = new BaseProvider('x');
      assert.equal(p.endpoint, '');
    });

    it('defaults apiKey to empty string', () => {
      const p = new BaseProvider('x');
      assert.equal(p.apiKey, '');
    });
  });

  describe('execute()', () => {
    it('throws "not implemented" error', async () => {
      await assert.rejects(
        () => provider.execute({ model: 'x', messages: [] }),
        /execute\(\) not implemented/
      );
    });
  });

  describe('listModels()', () => {
    it('throws "not implemented" error', async () => {
      await assert.rejects(
        () => provider.listModels(),
        /listModels\(\) not implemented/
      );
    });
  });

  describe('healthCheck()', () => {
    it('throws "not implemented" error', async () => {
      await assert.rejects(
        () => provider.healthCheck(),
        /healthCheck\(\) not implemented/
      );
    });
  });
});

describe('OllamaProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new OllamaProvider({ endpoint: 'http://localhost:11434' });
  });

  describe('constructor', () => {
    it('sets id to "ollama"', () => {
      assert.equal(provider.id, 'ollama');
    });

    it('defaults endpoint to http://localhost:11434 when not provided', () => {
      const p = new OllamaProvider();
      assert.equal(p.endpoint, 'http://localhost:11434');
    });

    it('accepts a custom endpoint', () => {
      const p = new OllamaProvider({ endpoint: 'http://my-host:5000' });
      assert.equal(p.endpoint, 'http://my-host:5000');
    });
  });

  describe('execute()', () => {
    it('returns normalised response on success', async () => {
      const fakeResponse = {
        ok: true,
        json: async () => ({
          message: { content: 'Hello from Ollama' },
          prompt_eval_count: 10,
          eval_count: 20,
        }),
      };
      mock.method(globalThis, 'fetch', async () => fakeResponse);

      const result = await provider.execute({ model: 'llama3', messages: [{ role: 'user', content: 'Hi' }] });

      assert.equal(result.content, 'Hello from Ollama');
      assert.equal(result.tokens_in, 10);
      assert.equal(result.tokens_out, 20);
      assert.deepEqual(result.tool_calls, []);
      assert.equal(result.finish_reason, 'stop');

      mock.restoreAll();
    });

    it('throws on non-ok HTTP response', async () => {
      const fakeResponse = { ok: false, status: 500, text: async () => 'Internal error' };
      mock.method(globalThis, 'fetch', async () => fakeResponse);

      await assert.rejects(
        () => provider.execute({ model: 'llama3', messages: [] }),
        /Ollama error 500/
      );

      mock.restoreAll();
    });

    it('defaults tokens to 0 when not in response', async () => {
      const fakeResponse = {
        ok: true,
        json: async () => ({ message: { content: 'Hi' } }),
      };
      mock.method(globalThis, 'fetch', async () => fakeResponse);

      const result = await provider.execute({ model: 'llama3', messages: [] });
      assert.equal(result.tokens_in, 0);
      assert.equal(result.tokens_out, 0);

      mock.restoreAll();
    });

    it('returns empty string for content when message is absent', async () => {
      const fakeResponse = {
        ok: true,
        json: async () => ({}),
      };
      mock.method(globalThis, 'fetch', async () => fakeResponse);

      const result = await provider.execute({ model: 'llama3', messages: [] });
      assert.equal(result.content, '');

      mock.restoreAll();
    });
  });

  describe('listModels()', () => {
    it('returns model names on success', async () => {
      const fakeResponse = {
        ok: true,
        json: async () => ({ models: [{ name: 'llama3' }, { name: 'mistral' }] }),
      };
      mock.method(globalThis, 'fetch', async () => fakeResponse);

      const models = await provider.listModels();
      assert.deepEqual(models, ['llama3', 'mistral']);

      mock.restoreAll();
    });

    it('returns empty array on non-ok response', async () => {
      mock.method(globalThis, 'fetch', async () => ({ ok: false }));

      const models = await provider.listModels();
      assert.deepEqual(models, []);

      mock.restoreAll();
    });
  });

  describe('healthCheck()', () => {
    it('returns true when endpoint is reachable', async () => {
      mock.method(globalThis, 'fetch', async () => ({ ok: true }));

      const healthy = await provider.healthCheck();
      assert.equal(healthy, true);

      mock.restoreAll();
    });

    it('returns false when endpoint is not reachable', async () => {
      mock.method(globalThis, 'fetch', async () => ({ ok: false }));

      const healthy = await provider.healthCheck();
      assert.equal(healthy, false);

      mock.restoreAll();
    });

    it('returns false when fetch throws (network error)', async () => {
      mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });

      const healthy = await provider.healthCheck();
      assert.equal(healthy, false);

      mock.restoreAll();
    });
  });
});

describe('ProviderRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  describe('register() / get()', () => {
    it('returns null for an unregistered provider', () => {
      assert.equal(registry.get('missing'), null);
    });

    it('retrieves a registered provider by id', () => {
      const p = new BaseProvider('my-provider');
      registry.register(p);
      assert.strictEqual(registry.get('my-provider'), p);
    });

    it('overwrites a provider when registered with the same id', () => {
      const p1 = new BaseProvider('dup');
      const p2 = new BaseProvider('dup');
      registry.register(p1);
      registry.register(p2);
      assert.strictEqual(registry.get('dup'), p2);
    });
  });

  describe('execute()', () => {
    it('throws when provider is not found', async () => {
      await assert.rejects(
        () => registry.execute('ghost', { model: 'x', messages: [] }),
        /Provider not found: ghost/
      );
    });

    it('delegates to the registered provider.execute()', async () => {
      const fake = new BaseProvider('fake');
      fake.execute = mock.fn(async () => ({ content: 'hi', tokens_in: 1, tokens_out: 2, tool_calls: [], finish_reason: 'stop' }));
      registry.register(fake);

      const result = await registry.execute('fake', { model: 'x', messages: [] });
      assert.equal(result.content, 'hi');
      assert.equal(fake.execute.mock.calls.length, 1);
    });
  });

  describe('healthCheckAll()', () => {
    it('returns health status keyed by provider id', async () => {
      const p1 = new BaseProvider('a');
      const p2 = new BaseProvider('b');
      p1.healthCheck = async () => true;
      p2.healthCheck = async () => false;
      registry.register(p1);
      registry.register(p2);

      const results = await registry.healthCheckAll();
      assert.equal(results.a, true);
      assert.equal(results.b, false);
    });

    it('returns empty object when no providers are registered', async () => {
      const results = await registry.healthCheckAll();
      assert.deepEqual(results, {});
    });
  });
});
