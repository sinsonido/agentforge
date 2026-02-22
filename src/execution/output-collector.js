/**
 * OutputCollector — Parses and structures provider response results.
 * Implements GitHub issue #18.
 */
export class OutputCollector {
  /**
   * Parse raw provider response into a structured output object.
   * @param {Object} response - { content, tokens_in, tokens_out, tool_calls, finish_reason }
   * @param {Object} task - The task that was executed
   * @returns {Object} Structured output
   */
  parse(response, task) {
    const content = response.content || '';

    return {
      task_id: task.id,
      content,
      tool_calls: response.tool_calls || [],
      finish_reason: response.finish_reason || 'stop',
      tokens_in: response.tokens_in || 0,
      tokens_out: response.tokens_out || 0,
      has_tool_calls: (response.tool_calls || []).length > 0,
      code_blocks: this.extractCodeBlocks(content),
      file_paths: this.extractFilePaths(content),
      timestamp: Date.now(),
    };
  }

  /**
   * Extract fenced code blocks from markdown-style content.
   * @param {string} content
   * @returns {Array<{ language: string, code: string }>}
   */
  extractCodeBlocks(content) {
    if (!content) return [];
    const blocks = [];
    const regex = /```(\w*)\n?([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      blocks.push({
        language: match[1] || 'text',
        code: match[2].trim(),
      });
    }
    return blocks;
  }

  /**
   * Extract file paths mentioned in the content.
   * Looks for patterns like `src/foo/bar.js`, `/absolute/path.ts`, etc.
   * @param {string} content
   * @returns {string[]}
   */
  extractFilePaths(content) {
    if (!content) return [];
    // Match paths like src/foo.js, ./bar/baz.ts, /home/user/file.py
    const pathRegex = /(?:^|\s|`|")(\/?(?:[\w.-]+\/)+[\w.-]+\.[\w]+)/gm;
    const paths = new Set();
    let match;
    while ((match = pathRegex.exec(content)) !== null) {
      const p = match[1].trim();
      if (p.length > 3 && !p.startsWith('http')) {
        paths.add(p);
      }
    }
    return Array.from(paths);
  }

  /**
   * Summarize output for logging (truncate long content).
   * @param {Object} output - Result of parse()
   * @param {number} maxLen
   * @returns {string}
   */
  summarize(output, maxLen = 200) {
    const preview = (output.content || '').slice(0, maxLen);
    const suffix = output.content?.length > maxLen ? '...' : '';
    const tools = output.has_tool_calls
      ? ` | tool_calls: ${output.tool_calls.length}`
      : '';
    return `[${output.finish_reason}] ${preview}${suffix}${tools}`;
  }
}

export default OutputCollector;
