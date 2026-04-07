/**
 * @file tests/execution/task-decomposition.test.js
 * @description Unit tests for src/execution/task-decomposition.js
 *
 * Covers:
 *  - _buildPrompt() produces a string containing task title and type
 *  - _parseSubtasks() parses plain JSON arrays
 *  - _parseSubtasks() extracts JSON from markdown code fences
 *  - _parseSubtasks() returns [] for malformed / non-array content
 *  - _parseSubtasks() caps results at 10 subtasks
 *  - decompose() throws when router returns action !== 'execute'
 *  - decompose() calls providerRegistry.execute with correct arguments
 *  - decompose() adds subtasks returned by the model to the task queue
 *  - decompose() returns the created task objects
 *  - decompose() propagates project_id to subtasks
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskDecomposition } from '../../src/execution/task-decomposition.js';
import { TaskQueue } from '../../src/core/task-queue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecomposer({
  routerResult = { action: 'execute', provider: 'anthropic', model: 'claude-opus-4-6' },
  providerContent = '[{"title":"Sub 1","type":"implement","priority":"high","agent_id":"developer"}]',
} = {}) {
  const taskQueue = new TaskQueue();

  const router = {
    resolve: () => routerResult,
  };

  const providerRegistry = {
    _calls: [],
    async execute(provider, opts) {
      this._calls.push({ provider, opts });
      return { content: providerContent, tokens_in: 10, tokens_out: 50 };
    },
  };

  const agents = {
    developer: { id: 'developer', name: 'Developer' },
  };

  const decomposer = new TaskDecomposition({ taskQueue, router, providerRegistry, agents });
  return { decomposer, taskQueue, providerRegistry };
}

function makeTask(overrides = {}) {
  return {
    id: 'parent-1',
    title: 'Build authentication system',
    type: 'implement',
    project_id: 'proj-auth',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// _buildPrompt()
// ---------------------------------------------------------------------------

describe('TaskDecomposition — _buildPrompt()', () => {
  it('includes the task title', () => {
    const { decomposer } = makeDecomposer();
    const prompt = decomposer._buildPrompt(makeTask());
    assert.ok(prompt.includes('Build authentication system'));
  });

  it('includes the task type', () => {
    const { decomposer } = makeDecomposer();
    const prompt = decomposer._buildPrompt(makeTask());
    assert.ok(prompt.includes('implement'));
  });

  it('includes instructions to return a JSON array', () => {
    const { decomposer } = makeDecomposer();
    const prompt = decomposer._buildPrompt(makeTask());
    assert.ok(prompt.includes('JSON'));
  });
});

// ---------------------------------------------------------------------------
// _parseSubtasks()
// ---------------------------------------------------------------------------

describe('TaskDecomposition — _parseSubtasks()', () => {
  let decomposer;

  beforeEach(() => {
    ({ decomposer } = makeDecomposer());
  });

  it('parses a plain JSON array', () => {
    const content = '[{"title":"A","type":"implement"},{"title":"B","type":"test"}]';
    const result = decomposer._parseSubtasks(content, {});
    assert.equal(result.length, 2);
    assert.equal(result[0].title, 'A');
    assert.equal(result[1].title, 'B');
  });

  it('extracts JSON from markdown code fences', () => {
    const content = '```json\n[{"title":"Fenced","type":"review"}]\n```';
    const result = decomposer._parseSubtasks(content, {});
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Fenced');
  });

  it('extracts JSON from plain markdown code fences (no language)', () => {
    const content = '```\n[{"title":"Plain fence","type":"implement"}]\n```';
    const result = decomposer._parseSubtasks(content, {});
    assert.equal(result.length, 1);
  });

  it('returns [] for malformed JSON', () => {
    const result = decomposer._parseSubtasks('{not valid json[', {});
    assert.deepEqual(result, []);
  });

  it('returns [] when there is no JSON array in the content', () => {
    const result = decomposer._parseSubtasks('Here are your subtasks: see below.', {});
    assert.deepEqual(result, []);
  });

  it('returns [] for empty string', () => {
    const result = decomposer._parseSubtasks('', {});
    assert.deepEqual(result, []);
  });

  it('returns [] when the parsed value is not an array', () => {
    const result = decomposer._parseSubtasks('{"key": "value"}', {});
    assert.deepEqual(result, []);
  });

  it('caps results at 10 subtasks', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ title: `Task ${i}`, type: 'implement' }));
    const content = JSON.stringify(items);
    const result = decomposer._parseSubtasks(content, {});
    assert.equal(result.length, 10);
  });
});

// ---------------------------------------------------------------------------
// decompose()
// ---------------------------------------------------------------------------

describe('TaskDecomposition — decompose()', () => {
  it('throws when router returns action !== execute', async () => {
    const { decomposer } = makeDecomposer({
      routerResult: { action: 'skip', reason: 'no T1 model' },
    });

    await assert.rejects(
      () => decomposer.decompose(makeTask()),
      /No T1 model available for task decomposition/
    );
  });

  it('calls providerRegistry.execute with the resolved provider and model', async () => {
    const { decomposer, providerRegistry } = makeDecomposer();
    await decomposer.decompose(makeTask());

    assert.equal(providerRegistry._calls.length, 1);
    const call = providerRegistry._calls[0];
    assert.equal(call.provider, 'anthropic');
    assert.equal(call.opts.model, 'claude-opus-4-6');
  });

  it('passes a system message and a user message', async () => {
    const { decomposer, providerRegistry } = makeDecomposer();
    await decomposer.decompose(makeTask());

    const { messages } = providerRegistry._calls[0].opts;
    const roles = messages.map((m) => m.role);
    assert.ok(roles.includes('system'));
    assert.ok(roles.includes('user'));
  });

  it('adds subtasks from model response to the task queue', async () => {
    const modelResponse = JSON.stringify([
      { title: 'Design DB schema', type: 'implement', priority: 'high', agent_id: 'developer' },
      { title: 'Write unit tests', type: 'test', priority: 'medium', agent_id: 'developer' },
    ]);
    const { decomposer, taskQueue } = makeDecomposer({ providerContent: modelResponse });

    await decomposer.decompose(makeTask());

    const tasks = taskQueue.getAll();
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].title, 'Design DB schema');
    assert.equal(tasks[1].title, 'Write unit tests');
  });

  it('returns the array of created task objects', async () => {
    const { decomposer } = makeDecomposer();
    const subtasks = await decomposer.decompose(makeTask());

    assert.ok(Array.isArray(subtasks));
    assert.equal(subtasks.length, 1);
    assert.equal(subtasks[0].title, 'Sub 1');
  });

  it('propagates project_id to every subtask', async () => {
    const modelResponse = JSON.stringify([
      { title: 'Step A', type: 'implement' },
      { title: 'Step B', type: 'test' },
    ]);
    const { decomposer, taskQueue } = makeDecomposer({ providerContent: modelResponse });

    await decomposer.decompose(makeTask({ project_id: 'proj-xyz' }));

    const tasks = taskQueue.getAll();
    for (const t of tasks) {
      assert.equal(t.project_id, 'proj-xyz');
    }
  });

  it('returns [] and adds no tasks when model returns malformed JSON', async () => {
    const { decomposer, taskQueue } = makeDecomposer({ providerContent: 'not json at all' });

    const subtasks = await decomposer.decompose(makeTask());

    assert.deepEqual(subtasks, []);
    assert.equal(taskQueue.getAll().length, 0);
  });
});
