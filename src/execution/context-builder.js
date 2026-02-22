/**
 * ContextBuilder — Assembles prompts and messages for agent task execution.
 * Implements GitHub issue #16.
 */
export class ContextBuilder {
  constructor({ agents = {}, config = {} } = {}) {
    this.agents = agents;
    this.config = config;
  }

  /**
   * Build the messages array for a provider.execute() call.
   * @param {Object} task - Task from TaskQueue
   * @param {Object} agent - Agent config object
   * @param {Array} history - Previous messages for this task (optional)
   * @returns {{ messages: Array, system_prompt: string, estimated_tokens: number }}
   */
  build(task, agent = {}, history = []) {
    const system_prompt = this._buildSystemPrompt(task, agent);

    const messages = [];

    // Add history (previous turns)
    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content });
    }

    // Build the current user message
    const userContent = this._buildUserMessage(task);
    messages.push({ role: 'user', content: userContent });

    const estimated_tokens = this.estimateTokens([
      { role: 'system', content: system_prompt },
      ...messages,
    ]);

    return { messages, system_prompt, estimated_tokens };
  }

  /**
   * Build the full messages array including system message (for providers that use it inline).
   */
  buildFull(task, agent = {}, history = []) {
    const { messages, system_prompt, estimated_tokens } = this.build(task, agent, history);
    return {
      messages: [{ role: 'system', content: system_prompt }, ...messages],
      system_prompt,
      estimated_tokens,
    };
  }

  /**
   * Estimate token count for a messages array.
   * Rule of thumb: ~1 token per 4 chars.
   * @param {Array} messages
   * @returns {number}
   */
  estimateTokens(messages) {
    let chars = 0;
    for (const m of messages) {
      chars += (m.content || '').length;
    }
    return Math.ceil(chars / 4);
  }

  // ─── Private ────────────────────────────────────────

  _buildSystemPrompt(task, agent) {
    const parts = [];

    // Agent system prompt
    if (agent.system_prompt) {
      parts.push(agent.system_prompt);
    } else {
      parts.push(this._defaultSystemPrompt(agent));
    }

    // Append task type context
    if (task.type) {
      parts.push(`\nCurrent task type: ${task.type}`);
    }

    return parts.join('\n\n');
  }

  _defaultSystemPrompt(agent) {
    if (agent.role) {
      return `You are ${agent.name || 'an AI agent'}, working as ${agent.role}. Complete the given task efficiently and accurately.`;
    }
    return 'You are a helpful AI assistant. Complete the given task efficiently and accurately.';
  }

  _buildUserMessage(task) {
    const parts = [];

    // Task title/description
    parts.push(task.title);

    // Additional context if present
    if (task.context) {
      if (typeof task.context === 'string') {
        parts.push(`\n## Context\n${task.context}`);
      } else if (typeof task.context === 'object') {
        parts.push(`\n## Context\n${JSON.stringify(task.context, null, 2)}`);
      }
    }

    // Task metadata hints
    if (task.type && task.type !== 'implement') {
      parts.push(`\nTask type: ${task.type}`);
    }

    return parts.join('\n');
  }
}

export default ContextBuilder;
