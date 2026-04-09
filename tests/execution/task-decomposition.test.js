/**
 * @file tests/execution/task-decomposition.test.js
 * @description Unit tests for src/execution/task-decomposition.js — TaskDecomposition.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskDecomposition } from '../../src/execution/task-decomposition.js';
import { TaskQueue } from '../../src/core/task-queue.js';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeRouter(action = 'execute', provider = 'anthropic', model = 'claude-opus-4-6') {
  return {
    resolve: () => ({ action, provider, model }),
  };
}

function makeRegistry(responseContent) {
  return {
    execute: async (_providerId, _params) => ({
      content: responseContent,
      tokens_in: 5,
      tokens_out: 50,
      tool_calls: [],
      finish_reason: 'stop',
    }),
  };
}

const VALID_JSON_RESPONSE = JSON.stringify([
  { title: 'Design schema', type: 'implement', priority: 'high',   agent_id: 'developer' },
  { title: 'Write tests',   type: 'test',      priority: 'medium', agent_id: 'tester'    },
  { title: 'Code review',   type: 'review',    priority: 'low',    agent_id: 'reviewer'  },
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskDecomposition', () => {
  let queue;
  let decomposer;

  beforeEach(() => {
    queue = new TaskQueue();
    decomposer = new TaskDecomposition({
      taskQueue: queue,
      router: makeRouter(),
      providerRegistry: makeRegistry(VALID_JSON_RESPONSE),
      agents: {},
    });
  });

  // ── decompose() ────────────────────────────────────────────────────────────

  it('returns an array of created subtasks', async () => {
    const parent = { id: 'parent-1', title: 'Build feature X', type: 'implement', project_id: 'proj-1' };
    const subtasks = await decomposer.decompose(parent);
    assert.equal(subtasks.length, 3);
  });

  it('adds each subtask to the queue', async () => {
    const parent = { id: 'parent-1', title: 'Build feature X', type: 'implement', project_id: 'proj-1' };
    const before = queue.getAll().length;
    await decomposer.decompose(parent);
    assert.equal(queue.getAll().length, before + 3);
  });

  it('propagates project_id to subtasks', async () => {
    const parent = { id: 'p1', title: 'Task', type: 'implement', project_id: 'my-project' };
    const subtasks = await decomposer.decompose(parent);
    for (const t of subtasks) {
      assert.equal(t.project_id, 'my-project');
    }
  });

  it('throws when router returns action !== execute', async () => {
    const noRouteDecomposer = new TaskDecomposition({
      taskQueue: queue,
      router: makeRouter('skip'),
      providerRegistry: makeRegistry(''),
      agents: {},
    });
    await assert.rejects(
      () => noRouteDecomposer.decompose({ id: '1', title: 'x', type: 'planning' }),
      /No T1 model available/
    );
  });

  it('returns empty array and adds no tasks when model returns unparseable content', async () => {
    const badDecomposer = new TaskDecomposition({
      taskQueue: queue,
      router: makeRouter(),
      providerRegistry: makeRegistry('Sorry, I cannot help with that.'),
      agents: {},
    });
    const before = queue.getAll().length;
    const subtasks = await badDecomposer.decompose({ id: '1', title: 'x', type: 'implement' });
    assert.equal(subtasks.length, 0);
    assert.equal(queue.getAll().length, before);
  });

  it('caps at 10 subtasks even when model returns more', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      title: `Task ${i}`, type: 'implement', priority: 'low', agent_id: 'dev',
    }));
    const bigDecomposer = new TaskDecomposition({
      taskQueue: queue,
      router: makeRouter(),
      providerRegistry: makeRegistry(JSON.stringify(many)),
      agents: {},
    });
    const subtasks = await bigDecomposer.decompose({ id: '1', title: 'big task', type: 'implement' });
    assert.equal(subtasks.length, 10);
  });

  // ── _buildPrompt() ─────────────────────────────────────────────────────────

  it('_buildPrompt() includes task title and type', () => {
    const prompt = decomposer._buildPrompt({ title: 'My Task', type: 'review' });
    assert.ok(prompt.includes('My Task'));
    assert.ok(prompt.includes('review'));
  });

  it('_buildPrompt() mentions expected subtask count range', () => {
    const prompt = decomposer._buildPrompt({ title: 'T', type: 'implement' });
    assert.ok(prompt.includes('3-8'));
  });

  // ── _parseSubtasks() ───────────────────────────────────────────────────────

  it('_parseSubtasks() parses plain JSON array', () => {
    const result = decomposer._parseSubtasks(VALID_JSON_RESPONSE, {});
    assert.equal(result.length, 3);
    assert.equal(result[0].title, 'Design schema');
  });

  it('_parseSubtasks() extracts JSON array wrapped in markdown fences', () => {
    const fenced = `Here are the subtasks:\n\`\`\`json\n${VALID_JSON_RESPONSE}\n\`\`\``;
    const result = decomposer._parseSubtasks(fenced, {});
    assert.equal(result.length, 3);
  });

  it('_parseSubtasks() returns empty array on invalid JSON', () => {
    const result = decomposer._parseSubtasks('{not valid json}', {});
    assert.deepEqual(result, []);
  });

  it('_parseSubtasks() returns empty array when no array found in content', () => {
    const result = decomposer._parseSubtasks('No JSON here at all.', {});
    assert.deepEqual(result, []);
  });

  it('_parseSubtasks() returns empty array when parsed value is not an array', () => {
    const result = decomposer._parseSubtasks('{"key": "value"}', {});
    assert.deepEqual(result, []);
  });
});
