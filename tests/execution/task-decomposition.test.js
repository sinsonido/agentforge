/**
 * @file tests/execution/task-decomposition.test.js
 * @description Unit tests for src/execution/task-decomposition.js
 *
 * Covers: _buildPrompt(), _parseSubtasks() (plain JSON, markdown fences,
 * invalid content), and decompose() (no T1 model, successful decomposition).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../../src/core/task-queue.js';
import { TaskDecomposition } from '../../src/execution/task-decomposition.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecomposer({
  routerAction = 'execute',
  routerProvider = 'anthropic',
  routerModel = 'claude-opus-4-6',
  providerResponse = null,
} = {}) {
  const taskQueue = new TaskQueue();

  const router = {
    resolve: () => ({
      action: routerAction,
      provider: routerProvider,
      model: routerModel,
    }),
  };

  const providerRegistry = {
    execute: async () => providerResponse ?? {
      content: JSON.stringify([
        { title: 'Subtask A', type: 'implement', priority: 'high', agent_id: 'developer' },
        { title: 'Subtask B', type: 'test',      priority: 'medium', agent_id: 'tester' },
      ]),
      tokens_in: 100,
      tokens_out: 200,
      finish_reason: 'end_turn',
    },
  };

  const agents = { developer: { id: 'developer' }, tester: { id: 'tester' } };

  const decomposer = new TaskDecomposition({ taskQueue, router, providerRegistry, agents });
  return { decomposer, taskQueue };
}

const PARENT_TASK = {
  id: 'parent-1',
  title: 'Build authentication system',
  type: 'implement',
  project_id: 'proj-1',
};

// ---------------------------------------------------------------------------
// _buildPrompt()
// ---------------------------------------------------------------------------

describe('TaskDecomposition — _buildPrompt()', () => {
  it('includes the task title in the prompt', () => {
    const { decomposer } = makeDecomposer();
    const prompt = decomposer._buildPrompt(PARENT_TASK);
    assert.ok(prompt.includes('Build authentication system'));
  });

  it('includes the task type in the prompt', () => {
    const { decomposer } = makeDecomposer();
    const prompt = decomposer._buildPrompt(PARENT_TASK);
    assert.ok(prompt.includes('implement'));
  });

  it('asks for a JSON array response', () => {
    const { decomposer } = makeDecomposer();
    const prompt = decomposer._buildPrompt(PARENT_TASK);
    assert.ok(prompt.includes('JSON array') || prompt.includes('[{'));
  });
});

// ---------------------------------------------------------------------------
// _parseSubtasks()
// ---------------------------------------------------------------------------

describe('TaskDecomposition — _parseSubtasks()', () => {
  const { decomposer } = makeDecomposer();

  it('parses a plain JSON array', () => {
    const content = JSON.stringify([
      { title: 'Do A', type: 'implement', priority: 'high', agent_id: 'dev' },
    ]);
    const result = decomposer._parseSubtasks(content, PARENT_TASK);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Do A');
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const content = [
      '```json',
      JSON.stringify([{ title: 'Fenced', type: 'test', priority: 'low', agent_id: 'tester' }]),
      '```',
    ].join('\n');
    const result = decomposer._parseSubtasks(content, PARENT_TASK);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Fenced');
  });

  it('returns empty array for content with no JSON array', () => {
    const result = decomposer._parseSubtasks('Sorry, I cannot help with that.', PARENT_TASK);
    assert.deepEqual(result, []);
  });

  it('returns empty array for invalid JSON', () => {
    const result = decomposer._parseSubtasks('[not valid json', PARENT_TASK);
    assert.deepEqual(result, []);
  });

  it('caps the result at 10 subtasks', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      title: `Task ${i}`, type: 'implement', priority: 'low', agent_id: 'dev',
    }));
    const result = decomposer._parseSubtasks(JSON.stringify(many), PARENT_TASK);
    assert.equal(result.length, 10);
  });
});

// ---------------------------------------------------------------------------
// decompose()
// ---------------------------------------------------------------------------

describe('TaskDecomposition — decompose()', () => {
  it('throws when router returns no T1 model (action !== execute)', async () => {
    const { decomposer } = makeDecomposer({ routerAction: 'quota_exceeded' });
    await assert.rejects(
      () => decomposer.decompose(PARENT_TASK),
      /No T1 model available/
    );
  });

  it('creates subtasks in the queue from provider response', async () => {
    const { decomposer, taskQueue } = makeDecomposer();
    const created = await decomposer.decompose(PARENT_TASK);
    assert.equal(created.length, 2);
    assert.equal(created[0].title, 'Subtask A');
    assert.equal(created[1].title, 'Subtask B');
    // Tasks should be in the queue
    const all = taskQueue.getAll();
    assert.equal(all.length, 2);
  });

  it('passes project_id to created subtasks', async () => {
    const { decomposer, taskQueue } = makeDecomposer();
    await decomposer.decompose(PARENT_TASK);
    const all = taskQueue.getAll();
    assert.ok(all.every(t => t.project_id === 'proj-1'));
  });

  it('returns empty array when provider returns non-JSON content', async () => {
    const { decomposer, taskQueue } = makeDecomposer({
      providerResponse: {
        content: 'I cannot decompose this task.',
        tokens_in: 50, tokens_out: 10, finish_reason: 'end_turn',
      },
    });
    const created = await decomposer.decompose(PARENT_TASK);
    assert.deepEqual(created, []);
    assert.equal(taskQueue.getAll().length, 0);
  });
});
