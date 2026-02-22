import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ContextBuilder } from '../../src/execution/context-builder.js';

describe('ContextBuilder', () => {
  let builder;

  beforeEach(() => {
    builder = new ContextBuilder();
  });

  describe('build()', () => {
    it('includes system prompt from agent config when present', () => {
      const agent = { system_prompt: 'You are a senior engineer.' };
      const task = { title: 'Write a function', type: 'implement' };

      const { system_prompt } = builder.build(task, agent);

      assert.ok(system_prompt.includes('You are a senior engineer.'));
    });

    it('uses default prompt when agent has no system_prompt', () => {
      const agent = {};
      const task = { title: 'Write tests', type: 'test' };

      const { system_prompt } = builder.build(task, agent);

      assert.ok(
        system_prompt.includes('helpful AI assistant') ||
        system_prompt.includes('AI agent'),
        'should contain a default assistant description'
      );
    });

    it('uses agent role in default prompt when role is provided', () => {
      const agent = { name: 'CodeBot', role: 'senior developer' };
      const task = { title: 'Implement auth', type: 'implement' };

      const { system_prompt } = builder.build(task, agent);

      assert.ok(system_prompt.includes('CodeBot'));
      assert.ok(system_prompt.includes('senior developer'));
    });

    it('appends task type context to system prompt', () => {
      const agent = { system_prompt: 'Custom prompt.' };
      const task = { title: 'Do something', type: 'architecture' };

      const { system_prompt } = builder.build(task, agent);

      assert.ok(system_prompt.includes('architecture'));
    });

    it('adds task context when present as string', () => {
      const agent = {};
      const task = { title: 'Fix bug', type: 'debug', context: 'The bug is in line 42.' };

      const { messages } = builder.build(task, agent);
      const userMessage = messages[messages.length - 1];

      assert.ok(userMessage.content.includes('The bug is in line 42.'));
    });

    it('adds task context when present as object', () => {
      const agent = {};
      const task = {
        title: 'Implement feature',
        type: 'implement',
        context: { repo: 'my-repo', branch: 'main' },
      };

      const { messages } = builder.build(task, agent);
      const userMessage = messages[messages.length - 1];

      assert.ok(userMessage.content.includes('my-repo'));
      assert.ok(userMessage.content.includes('main'));
    });

    it('includes task title in the user message', () => {
      const agent = {};
      const task = { title: 'Add unit tests for auth module', type: 'test' };

      const { messages } = builder.build(task, agent);
      const userMessage = messages[messages.length - 1];

      assert.ok(userMessage.content.includes('Add unit tests for auth module'));
    });

    it('includes conversation history in messages', () => {
      const agent = {};
      const task = { title: 'Continue work', type: 'implement' };
      const history = [
        { role: 'user', content: 'Prior question' },
        { role: 'assistant', content: 'Prior answer' },
      ];

      const { messages } = builder.build(task, agent, history);

      // history + current user message = 3 total
      assert.equal(messages.length, 3);
      assert.equal(messages[0].content, 'Prior question');
      assert.equal(messages[1].content, 'Prior answer');
      assert.equal(messages[2].role, 'user');
    });

    it('returns estimated_tokens as a positive integer', () => {
      const agent = { system_prompt: 'You are helpful.' };
      const task = { title: 'Do something useful', type: 'implement' };

      const { estimated_tokens } = builder.build(task, agent);

      assert.ok(Number.isInteger(estimated_tokens));
      assert.ok(estimated_tokens > 0);
    });

    it('works with an empty agent object', () => {
      const task = { title: 'Simple task', type: 'implement' };
      assert.doesNotThrow(() => builder.build(task, {}));
    });

    it('works with an empty history array', () => {
      const task = { title: 'Simple task', type: 'implement' };
      const { messages } = builder.build(task, {}, []);
      assert.equal(messages.length, 1);
    });
  });

  describe('estimateTokens()', () => {
    it('returns a reasonable token estimate for short content', () => {
      const messages = [{ role: 'user', content: 'Hello' }];
      const estimate = builder.estimateTokens(messages);

      // "Hello" = 5 chars → ceil(5/4) = 2 tokens
      assert.equal(estimate, 2);
    });

    it('returns 0 for empty messages array', () => {
      assert.equal(builder.estimateTokens([]), 0);
    });

    it('returns 0 for messages with empty content', () => {
      const messages = [{ role: 'user', content: '' }];
      assert.equal(builder.estimateTokens(messages), 0);
    });

    it('sums content across multiple messages', () => {
      const messages = [
        { role: 'system', content: 'ABCD' },    // 4 chars
        { role: 'user', content: 'EFGH' },       // 4 chars
        { role: 'assistant', content: 'IJKL' },  // 4 chars
      ];
      // 12 chars → ceil(12/4) = 3 tokens
      const estimate = builder.estimateTokens(messages);
      assert.equal(estimate, 3);
    });

    it('handles messages without content gracefully', () => {
      const messages = [{ role: 'user' }];
      assert.doesNotThrow(() => builder.estimateTokens(messages));
      assert.equal(builder.estimateTokens(messages), 0);
    });

    it('returns a larger estimate for longer content', () => {
      const shortMessages = [{ role: 'user', content: 'Short' }];
      const longMessages  = [{ role: 'user', content: 'A'.repeat(400) }];

      const shortEstimate = builder.estimateTokens(shortMessages);
      const longEstimate  = builder.estimateTokens(longMessages);

      assert.ok(longEstimate > shortEstimate);
    });
  });

  describe('buildFull()', () => {
    it('prepends a system message as the first message', () => {
      const agent = { system_prompt: 'Full system prompt.' };
      const task = { title: 'Do work', type: 'implement' };

      const { messages } = builder.buildFull(task, agent);

      assert.equal(messages[0].role, 'system');
      assert.ok(messages[0].content.includes('Full system prompt.'));
    });

    it('has system message followed by the user message', () => {
      const agent = {};
      const task = { title: 'Test task', type: 'test' };

      const { messages } = builder.buildFull(task, agent);

      assert.equal(messages[0].role, 'system');
      assert.equal(messages[messages.length - 1].role, 'user');
    });

    it('also returns system_prompt and estimated_tokens', () => {
      const task = { title: 'Test', type: 'implement' };
      const result = builder.buildFull(task, {});

      assert.ok('system_prompt' in result);
      assert.ok('estimated_tokens' in result);
    });

    it('includes history messages between system and user messages', () => {
      const agent = {};
      const task = { title: 'Continue', type: 'implement' };
      const history = [{ role: 'user', content: 'Step 1' }, { role: 'assistant', content: 'Done 1' }];

      const { messages } = builder.buildFull(task, agent, history);

      // system + history[0] + history[1] + current user = 4 messages
      assert.equal(messages.length, 4);
      assert.equal(messages[0].role, 'system');
      assert.equal(messages[1].content, 'Step 1');
      assert.equal(messages[2].content, 'Done 1');
      assert.equal(messages[3].role, 'user');
    });
  });
});
