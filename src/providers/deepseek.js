import OpenAI from 'openai';
import { BaseProvider } from './interface.js';

/**
 * DeepSeek provider — DeepSeek API via OpenAI-compatible SDK.
 * Implements GitHub issue #15.
 */
export class DeepSeekProvider extends BaseProvider {
  constructor(config = {}) {
    super('deepseek', config);
    this.endpoint = config.endpoint || 'https://api.deepseek.com';
    this._client = null;
  }

  _getClient() {
    if (!this._client) {
      this._client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.endpoint,
      });
    }
    return this._client;
  }

  /**
   * Execute a DeepSeek model call.
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
    return ['deepseek-chat', 'deepseek-reasoner'];
  }

  async healthCheck() {
    return !!this.apiKey;
  }
}

export default DeepSeekProvider;
