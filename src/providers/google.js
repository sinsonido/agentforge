import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { BaseProvider } from './interface.js';

/**
 * Google provider — Gemini models via @google/generative-ai.
 * Implements GitHub issue #13.
 */
export class GoogleProvider extends BaseProvider {
  constructor(config = {}) {
    super('google', config);
    this._client = null;
  }

  _getClient() {
    if (!this._client) {
      this._client = new GoogleGenerativeAI(this.apiKey);
    }
    return this._client;
  }

  /**
   * Execute a Gemini model call.
   * @param {Object} params
   * @param {string} params.model
   * @param {Array} params.messages - [{ role, content }]
   * @param {Array} [params.tools]
   * @param {number} [params.max_tokens]
   * @param {number} [params.temperature]
   * @returns {Promise<{ content, tokens_in, tokens_out, tool_calls, finish_reason }>}
   */
  async execute({ model, messages, _tools, max_tokens = 4096, temperature = 0.7 }) {
    const client = this._getClient();

    // Extract system instruction
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const modelConfig = {
      model,
      generationConfig: {
        maxOutputTokens: max_tokens,
        temperature,
      },
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      ],
    };

    if (systemMsg) {
      modelConfig.systemInstruction = systemMsg.content;
    }

    const genModel = client.getGenerativeModel(modelConfig);

    // Convert messages to Gemini chat history format
    // Gemini uses 'user' and 'model' roles (not 'assistant')
    const history = chatMessages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const lastMessage = chatMessages[chatMessages.length - 1];
    const chat = genModel.startChat({ history });

    const result = await chat.sendMessage(lastMessage?.content || '');
    const response = result.response;

    const content = response.text();
    const usageMetadata = response.usageMetadata || {};

    return {
      content,
      tokens_in: usageMetadata.promptTokenCount || 0,
      tokens_out: usageMetadata.candidatesTokenCount || 0,
      tool_calls: [],
      finish_reason: response.candidates?.[0]?.finishReason || 'stop',
    };
  }

  async listModels() {
    return [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-pro',
    ];
  }

  async healthCheck() {
    if (!this.apiKey) return false;
    try {
      const client = this._getClient();
      const model = client.getGenerativeModel({ model: 'gemini-2.0-flash' });
      await model.generateContent('hi');
      return true;
    } catch {
      return false;
    }
  }
}

export default GoogleProvider;
