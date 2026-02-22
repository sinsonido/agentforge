import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from './interface.js';

/**
 * Anthropic provider — Claude models via @anthropic-ai/sdk.
 * Implements GitHub issue #12.
 */
export class AnthropicProvider extends BaseProvider {
  constructor(config = {}) {
    super('anthropic', config);
    this.endpoint = config.endpoint || 'https://api.anthropic.com';
    this._client = null;
  }

  _getClient() {
    if (!this._client) {
      this._client = new Anthropic({
        apiKey: this.apiKey,
        baseURL: this.endpoint !== 'https://api.anthropic.com' ? this.endpoint : undefined,
      });
    }
    return this._client;
  }

  /**
   * Execute a Claude model call.
   * @param {Object} params
   * @param {string} params.model
   * @param {Array} params.messages - [{ role, content }]
   * @param {Array} [params.tools]
   * @param {number} [params.max_tokens]
   * @param {number} [params.temperature]
   * @returns {Promise<{ content, tokens_in, tokens_out, tool_calls, finish_reason }>}
   */
  async execute({ model, messages, tools, max_tokens = 4096, temperature = 0.7 }) {
    const client = this._getClient();

    // Extract system message if present
    const systemMsg = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role !== 'system');

    const params = {
      model,
      max_tokens,
      temperature,
      messages: userMessages,
    };

    if (systemMsg) params.system = systemMsg.content;

    // Convert tools to Anthropic format
    if (tools?.length) {
      params.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema || t.parameters || { type: 'object', properties: {} },
      }));
    }

    const response = await client.messages.create(params);

    // Parse content blocks
    let content = '';
    const tool_calls = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        tool_calls.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }

    return {
      content,
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
      tool_calls,
      finish_reason: response.stop_reason,
    };
  }

  async listModels() {
    return [
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-5-20251101',
    ];
  }

  async healthCheck() {
    if (!this.apiKey) return false;
    try {
      const client = this._getClient();
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return true;
    } catch {
      return false;
    }
  }
}

export default AnthropicProvider;
