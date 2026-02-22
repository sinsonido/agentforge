/**
 * Base interface for all providers.
 * Every provider adapter must implement these methods.
 */
export class BaseProvider {
  constructor(id, config = {}) {
    this.id = id;
    this.endpoint = config.endpoint || '';
    this.apiKey = config.api_key || '';
  }

  /**
   * Execute a model call.
   * @param {Object} params
   * @param {string} params.model - Model identifier
   * @param {Array} params.messages - [{ role, content }]
   * @param {Array} [params.tools] - Tool definitions
   * @param {number} [params.max_tokens] - Max output tokens
   * @param {number} [params.temperature] - Sampling temperature
   * @returns {Promise<{ content, tokens_in, tokens_out, tool_calls, finish_reason }>}
   */
  async execute(params) {
    throw new Error(`${this.id}: execute() not implemented`);
  }

  /** List available models on this provider */
  async listModels() {
    throw new Error(`${this.id}: listModels() not implemented`);
  }

  /** Health check — can we reach the provider? */
  async healthCheck() {
    throw new Error(`${this.id}: healthCheck() not implemented`);
  }
}

/**
 * Ollama provider — local models, no API key, no quota.
 * Perfect for development and Tier 3 execution tasks.
 */
export class OllamaProvider extends BaseProvider {
  constructor(config = {}) {
    super('ollama', config);
    this.endpoint = config.endpoint || 'http://localhost:11434';
  }

  async execute({ model, messages, max_tokens = 4096, temperature = 0.7 }) {
    const url = `${this.endpoint}/api/chat`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          num_predict: max_tokens,
          temperature,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error ${response.status}: ${text}`);
    }

    const data = await response.json();

    return {
      content: data.message?.content || '',
      tokens_in: data.prompt_eval_count || 0,
      tokens_out: data.eval_count || 0,
      tool_calls: [],
      finish_reason: 'stop',
    };
  }

  async listModels() {
    const response = await fetch(`${this.endpoint}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || []).map(m => m.name);
  }

  async healthCheck() {
    try {
      const response = await fetch(`${this.endpoint}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Provider registry — manages all configured providers.
 */
export class ProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    this.providers.set(provider.id, provider);
  }

  get(id) {
    return this.providers.get(id) || null;
  }

  async execute(providerId, params) {
    const provider = this.get(providerId);
    if (!provider) throw new Error(`Provider not found: ${providerId}`);
    return provider.execute(params);
  }

  async healthCheckAll() {
    const results = {};
    for (const [id, provider] of this.providers) {
      results[id] = await provider.healthCheck();
    }
    return results;
  }
}
