import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OutputCollector } from '../../src/execution/output-collector.js';

describe('OutputCollector', () => {
  const collector = new OutputCollector();

  describe('parse()', () => {
    it('returns a structured output object with correct task_id', () => {
      const response = { content: 'Hello world', tokens_in: 100, tokens_out: 50 };
      const task = { id: 'task-42' };

      const output = collector.parse(response, task);

      assert.equal(output.task_id, 'task-42');
    });

    it('includes all expected fields in the output', () => {
      const response = {
        content: 'Some output',
        tokens_in: 100,
        tokens_out: 50,
        tool_calls: [],
        finish_reason: 'stop',
      };
      const task = { id: 't1' };

      const output = collector.parse(response, task);

      assert.ok('task_id' in output);
      assert.ok('content' in output);
      assert.ok('tool_calls' in output);
      assert.ok('finish_reason' in output);
      assert.ok('tokens_in' in output);
      assert.ok('tokens_out' in output);
      assert.ok('has_tool_calls' in output);
      assert.ok('code_blocks' in output);
      assert.ok('file_paths' in output);
      assert.ok('timestamp' in output);
    });

    it('sets correct token counts from response', () => {
      const response = { content: 'test', tokens_in: 200, tokens_out: 80 };
      const task = { id: 't1' };

      const output = collector.parse(response, task);

      assert.equal(output.tokens_in, 200);
      assert.equal(output.tokens_out, 80);
    });

    it('defaults tokens to 0 when not in response', () => {
      const response = { content: 'test' };
      const task = { id: 't1' };

      const output = collector.parse(response, task);

      assert.equal(output.tokens_in, 0);
      assert.equal(output.tokens_out, 0);
    });

    it('defaults finish_reason to stop when not provided', () => {
      const response = { content: 'done' };
      const task = { id: 't1' };

      const output = collector.parse(response, task);

      assert.equal(output.finish_reason, 'stop');
    });

    it('sets has_tool_calls to true when tool_calls are present', () => {
      const response = {
        content: '',
        tool_calls: [{ name: 'read_file', arguments: {} }],
      };
      const task = { id: 't1' };

      const output = collector.parse(response, task);

      assert.equal(output.has_tool_calls, true);
      assert.equal(output.tool_calls.length, 1);
    });

    it('sets has_tool_calls to false when tool_calls is empty', () => {
      const response = { content: 'Just text', tool_calls: [] };
      const task = { id: 't1' };

      const output = collector.parse(response, task);

      assert.equal(output.has_tool_calls, false);
    });

    it('extracts code blocks from the content', () => {
      const response = {
        content: '```js\nconsole.log("hi");\n```',
      };
      const task = { id: 't1' };

      const output = collector.parse(response, task);

      assert.equal(output.code_blocks.length, 1);
      assert.equal(output.code_blocks[0].language, 'js');
    });

    it('extracts file paths from the content', () => {
      const response = {
        content: 'Edit `src/core/task-queue.js` to fix the bug.',
      };
      const task = { id: 't1' };

      const output = collector.parse(response, task);

      assert.ok(output.file_paths.some(p => p.includes('task-queue.js')));
    });

    it('has a timestamp in the output', () => {
      const before = Date.now();
      const output = collector.parse({ content: 'hi' }, { id: 't1' });
      const after = Date.now();

      assert.ok(output.timestamp >= before);
      assert.ok(output.timestamp <= after);
    });
  });

  describe('extractCodeBlocks()', () => {
    it('returns empty array for empty content', () => {
      assert.deepEqual(collector.extractCodeBlocks(''), []);
    });

    it('returns empty array for null/undefined content', () => {
      assert.deepEqual(collector.extractCodeBlocks(null), []);
      assert.deepEqual(collector.extractCodeBlocks(undefined), []);
    });

    it('finds a single fenced code block', () => {
      const content = '```js\nconst x = 1;\n```';
      const blocks = collector.extractCodeBlocks(content);

      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].language, 'js');
      assert.ok(blocks[0].code.includes('const x = 1;'));
    });

    it('finds multiple fenced code blocks', () => {
      const content = [
        '```python\nprint("hello")\n```',
        'Some text',
        '```bash\nls -la\n```',
      ].join('\n');

      const blocks = collector.extractCodeBlocks(content);

      assert.equal(blocks.length, 2);
      assert.equal(blocks[0].language, 'python');
      assert.equal(blocks[1].language, 'bash');
    });

    it('uses "text" as language when no language is specified', () => {
      const content = '```\nplain code\n```';
      const blocks = collector.extractCodeBlocks(content);

      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].language, 'text');
    });

    it('trims whitespace from code block content', () => {
      const content = '```js\n  const x = 1;  \n```';
      const blocks = collector.extractCodeBlocks(content);

      assert.equal(blocks[0].code, 'const x = 1;');
    });

    it('handles code blocks without trailing newline', () => {
      const content = '```js\ncode here```';
      const blocks = collector.extractCodeBlocks(content);
      assert.equal(blocks.length, 1);
    });

    it('handles content with no code blocks gracefully', () => {
      const content = 'Just plain text with no code.';
      const blocks = collector.extractCodeBlocks(content);
      assert.deepEqual(blocks, []);
    });
  });

  describe('extractFilePaths()', () => {
    it('returns empty array for empty content', () => {
      assert.deepEqual(collector.extractFilePaths(''), []);
    });

    it('returns empty array for null/undefined content', () => {
      assert.deepEqual(collector.extractFilePaths(null), []);
      assert.deepEqual(collector.extractFilePaths(undefined), []);
    });

    it('finds relative file paths', () => {
      const content = 'Edit `src/core/task-queue.js` to fix this.';
      const paths = collector.extractFilePaths(content);

      assert.ok(paths.some(p => p.includes('task-queue.js')));
    });

    it('finds absolute file paths', () => {
      const content = 'See /home/user/project/src/main.js for details.';
      const paths = collector.extractFilePaths(content);

      assert.ok(paths.some(p => p.includes('main.js')));
    });

    it('finds multiple file paths in content', () => {
      const content = [
        'Modify `src/index.js` and `src/config/loader.js`.',
        'Also look at tests/core/task-queue.test.js',
      ].join('\n');

      const paths = collector.extractFilePaths(content);

      assert.ok(paths.length >= 2);
    });

    it('does not include http URLs as file paths', () => {
      const content = 'See https://example.com/path/to/file.js for more.';
      const paths = collector.extractFilePaths(content);

      assert.ok(!paths.some(p => p.startsWith('http')));
    });

    it('returns unique paths (no duplicates)', () => {
      const content = 'Edit `src/foo.js` and then edit `src/foo.js` again.';
      const paths = collector.extractFilePaths(content);
      const unique = new Set(paths);

      assert.equal(paths.length, unique.size);
    });
  });

  describe('handles empty content gracefully', () => {
    it('parse() works with empty content string', () => {
      const output = collector.parse({ content: '' }, { id: 't1' });

      assert.equal(output.content, '');
      assert.deepEqual(output.code_blocks, []);
      assert.deepEqual(output.file_paths, []);
      assert.equal(output.has_tool_calls, false);
    });

    it('parse() works with missing content in response', () => {
      const output = collector.parse({}, { id: 't1' });

      assert.equal(output.content, '');
      assert.deepEqual(output.code_blocks, []);
    });
  });
});
