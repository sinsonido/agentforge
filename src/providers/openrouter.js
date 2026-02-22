import OpenAI from 'openai';
import { BaseProvider } from './interface.js';

/**
 * OpenRouter provider — Universal model proxy via OpenAI-compatible API.
 * Supports 200+ models from multiple providers through one endpoint.
 * Implements GitHub issue #42.
 */
export class OpenRouterProvider extends BaseProvider {
  constructor(config = {}) {
    super('openrouter', config);
    this.endpoint = config.endpoint || 'https://openrouter.ai/api/v1';
    this.siteName = config.site_name || 'AgentForge';
    this.siteUrl = config.site_url || 'https://agentforge.dev';
    this._client = null;
  }

  _getClient() {
    if (!this._client) {
      this._client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.endpoint,
        defaultHeaders: {
          'HTTP-Referer': this.siteUrl,
          'X-Title': this.siteName,
        },
      });
    }
    return this._client;
  }

  /**
   * Execute a model call through OpenRouter.
   * @param {Object} params
   * @param {string} params.model - Full model ID e.g. 'anthropic/claude-opus-4'
   * @param {Array} params.messages
   * @param {Array} [params.tools]
   * @param {number} [params.max_tokens]
   * @param {number} [params.temperature]
   * @returns {Promise<{ content, tokens_in, tokens_out, tool_calls, finish_reason }>}
   */
  async execute({ model, messages, tools, max_tokens = 4096, temperature = 0.7 }) {
    const client = this._getClient();

    const params = {
      model,
      messages,
      max_tokens,
      temperature,
    };

    if (tools?.length) {
      params.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters || t.input_schema || { type: 'object', properties: {} },
        },
      }));
      params.tool_choice = 'auto';
    }

    const response = await client.chat.completions.create(params);
    const choice = response.choices[0];
    const message = choice.message;

    const tool_calls = (message.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || '{}'),
    }));

    return {
      content: message.content || '',
      tokens_in: response.usage?.prompt_tokens || 0,
      tokens_out: response.usage?.completion_tokens || 0,
      tool_calls,
      finish_reason: choice.finish_reason,
    };
  }

  async listModels() {
    // Curated list of popular OpenRouter models
    return [
      'anthropic/claude-opus-4-5',
      'anthropic/claude-sonnet-4-5',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'deepseek/deepseek-chat',
      'meta-llama/llama-3.3-70b-instruct',
      'mistralai/mistral-large',
      'qwen/qwen-2.5-72b-instruct',
    ];
  }

  async healthCheck() {
    if (!this.apiKey) return false;
    try {
      const response = await fetch(`${this.endpoint}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': this.siteUrl,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export default OpenRouterProvider;
