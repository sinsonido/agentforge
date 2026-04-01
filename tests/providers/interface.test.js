/**
 * @file tests/providers/interface.test.js
 * @description Unit tests for src/providers/interface.js —
 *   BaseProvider, OllamaProvider, and ProviderRegistry.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BaseProvider, OllamaProvider, ProviderRegistry } from '../../src/providers/interface.js';

// ---------------------------------------------------------------------------
// BaseProvider
// ---------------------------------------------------------------------------

describe('BaseProvider', () => {
  it('stores id, endpoint, and apiKey from config', () => {
    const p = new BaseProvider('my-provider', { endpoint: 'https://api.example.com', api_key: 'key123' });
    assert.equal(p.id, 'my-provider');
    assert.equal(p.endpoint, 'https://api.example.com');
    assert.equal(p.apiKey, 'key123');
  });

  it('uses empty strings for missing config fields', () => {
    const p = new BaseProvider('bare');
    assert.equal(p.endpoint, '');
    assert.equal(p.apiKey, '');
  });

  it('execute() throws "not implemented"', async () => {
    const p = new BaseProvider('test');
    await assert.rejects(() => p.execute({}), /not implemented/);
  });

  it('listModels() throws "not implemented"', async () => {
    const p = new BaseProvider('test');
    await assert.rejects(() => p.listModels(), /not implemented/);
  });

  it('healthCheck() throws "not implemented"', async () => {
    const p = new BaseProvider('test');
    await assert.rejects(() => p.healthCheck(), /not implemented/);
  });
});

// ---------------------------------------------------------------------------
// OllamaProvider
// ---------------------------------------------------------------------------

describe('OllamaProvider', () => {
  it('defaults to localhost:11434 endpoint', () => {
    const p = new OllamaProvider();
    assert.equal(p.id, 'ollama');
    assert.equal(p.endpoint, 'http://localhost:11434');
  });

  it('accepts a custom endpoint', () => {
    const p = new OllamaProvider({ endpoint: 'http://192.168.1.5:11434' });
    assert.equal(p.endpoint, 'http://192.168.1.5:11434');
  });

  it('execute() returns normalised response shape on success', async () => {
    const p = new OllamaProvider({ endpoint: 'http://localhost:11434' });

    // Stub global fetch
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        message: { content: 'Hello from Ollama' },
        prompt_eval_count: 10,
        eval_count: 20,
      }),
    });

    try {
      const result = await p.execute({
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(result.content, 'Hello from Ollama');
      assert.equal(result.tokens_in, 10);
      assert.equal(result.tokens_out, 20);
      assert.deepEqual(result.tool_calls, []);
      assert.equal(result.finish_reason, 'stop');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('execute() defaults tokens to 0 when counts are missing', async () => {
    const p = new OllamaProvider();
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ message: { content: 'ok' } }),
    });
    try {
      const result = await p.execute({ model: 'llama3', messages: [] });
      assert.equal(result.tokens_in, 0);
      assert.equal(result.tokens_out, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('execute() throws on non-ok HTTP response', async () => {
    const p = new OllamaProvider();
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });
    try {
      await assert.rejects(
        () => p.execute({ model: 'llama3', messages: [] }),
        /Ollama error 503/
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('listModels() returns model names on success', async () => {
    const p = new OllamaProvider();
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3' }, { name: 'mistral' }] }),
    });
    try {
      const models = await p.listModels();
      assert.deepEqual(models, ['llama3', 'mistral']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('listModels() returns empty array on non-ok response', async () => {
    const p = new OllamaProvider();
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false });
    try {
      const models = await p.listModels();
      assert.deepEqual(models, []);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('healthCheck() returns true when endpoint responds ok', async () => {
    const p = new OllamaProvider();
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true });
    try {
      assert.equal(await p.healthCheck(), true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('healthCheck() returns false when fetch throws (unreachable)', async () => {
    const p = new OllamaProvider();
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
      assert.equal(await p.healthCheck(), false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('healthCheck() returns false when endpoint responds not-ok', async () => {
    const p = new OllamaProvider();
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false });
    try {
      assert.equal(await p.healthCheck(), false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

describe('ProviderRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it('starts empty', () => {
    assert.equal(registry.providers.size, 0);
  });

  it('register() and get() roundtrip', () => {
    const p = new OllamaProvider();
    registry.register(p);
    assert.equal(registry.get('ollama'), p);
  });

  it('get() returns null for unknown provider', () => {
    assert.equal(registry.get('unknown'), null);
  });

  it('execute() calls provider.execute() with correct params', async () => {
    let capturedParams;
    const fake = {
      id: 'fake',
      execute: async (params) => {
        capturedParams = params;
        return { content: 'done', tokens_in: 1, tokens_out: 2, tool_calls: [], finish_reason: 'stop' };
      },
    };
    registry.register(fake);
    const result = await registry.execute('fake', { model: 'x', messages: [] });
    assert.equal(result.content, 'done');
    assert.deepEqual(capturedParams, { model: 'x', messages: [] });
  });

  it('execute() throws when provider not found', async () => {
    await assert.rejects(
      () => registry.execute('missing', {}),
      /Provider not found: missing/
    );
  });

  it('healthCheckAll() aggregates results from all providers', async () => {
    registry.register({ id: 'a', healthCheck: async () => true });
    registry.register({ id: 'b', healthCheck: async () => false });
    const results = await registry.healthCheckAll();
    assert.equal(results.a, true);
    assert.equal(results.b, false);
  });

  it('healthCheckAll() returns empty object when no providers registered', async () => {
    const results = await registry.healthCheckAll();
    assert.deepEqual(results, {});
  });
});
