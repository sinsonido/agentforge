/**
 * @file tests/execution/task-decomposition.test.js
 * @description Unit tests for src/execution/task-decomposition.js
 *
 * Covers:
 *  - _buildPrompt(): includes task title, type, format instructions
 *  - _parseSubtasks(): valid JSON array, markdown-fenced JSON, invalid JSON,
 *    no array found, empty array, limits to 10 subtasks
 *  - decompose(): throws when router returns non-execute action,
 *    calls provider with correct params, adds subtasks to queue,
 *    returns created tasks, handles empty parse result
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskDecomposition } from '../../src/execution/task-decomposition.js';

// ---------------------------------------------------------------------------
// Helpers — minimal stubs
// ---------------------------------------------------------------------------

function makeTask(overrides = {}) {
  return {
    id: 'parent-1',
    title: 'Build authentication system',
    type: 'implement',
    project_id: 'proj-1',
    ...overrides,
  };
}

function makeRouter(action = 'execute', provider = 'anthropic', model = 'claude-opus-4-6') {
  return {
    resolve: (_task, _agents) => ({ action, provider, model }),
  };
}

function makeProviders(content) {
  return {
    async execute(_providerId, _params) {
      return { content, tokens_in: 10, tokens_out: 50, tool_calls: [], finish_reason: 'stop' };
    },
  };
}

function makeTaskQueue() {
  const added = [];
  let counter = 0;
  return {
    added,
    add(spec) {
      const task = { ...spec, id: `subtask-${++counter}` };
      added.push(task);
      return task;
    },
  };
}

// ---------------------------------------------------------------------------
// _buildPrompt()
// ---------------------------------------------------------------------------

describe('TaskDecomposition._buildPrompt()', () => {
  let decomp;

  beforeEach(() => {
    decomp = new TaskDecomposition({
      taskQueue: makeTaskQueue(),
      router: makeRouter(),
      providerRegistry: makeProviders('[]'),
      agents: {},
    });
  });

  it('includes the task title', () => {
    const prompt = decomp._buildPrompt(makeTask({ title: 'Migrate database schema' }));
    assert.ok(prompt.includes('Migrate database schema'));
  });

  it('includes the task type', () => {
    const prompt = decomp._buildPrompt(makeTask({ type: 'review' }));
    assert.ok(prompt.includes('review'));
  });

  it('includes the JSON format instruction with required fields', () => {
    const prompt = decomp._buildPrompt(makeTask());
    assert.ok(prompt.includes('title'), 'prompt should mention title field');
    assert.ok(prompt.includes('type'), 'prompt should mention type field');
    assert.ok(prompt.includes('priority'), 'prompt should mention priority field');
  });

  it('mentions the expected subtask count range', () => {
    const prompt = decomp._buildPrompt(makeTask());
    // Prompt should indicate 3–8 subtasks
    assert.ok(prompt.includes('3') || prompt.includes('eight'), 'subtask count hint missing');
  });
});

// ---------------------------------------------------------------------------
// _parseSubtasks()
// ---------------------------------------------------------------------------

describe('TaskDecomposition._parseSubtasks()', () => {
  let decomp;

  beforeEach(() => {
    decomp = new TaskDecomposition({
      taskQueue: makeTaskQueue(),
      router: makeRouter(),
      providerRegistry: makeProviders('[]'),
      agents: {},
    });
  });

  const parent = makeTask();

  it('parses a plain JSON array', () => {
    const content = JSON.stringify([
      { title: 'Setup DB', type: 'implement', priority: 'high' },
      { title: 'Write tests', type: 'test', priority: 'medium' },
    ]);
    const subs = decomp._parseSubtasks(content, parent);
    assert.equal(subs.length, 2);
    assert.equal(subs[0].title, 'Setup DB');
    assert.equal(subs[1].type, 'test');
  });

  it('parses JSON array wrapped in a markdown code fence', () => {
    const content = '```json\n[{"title":"Task A","type":"implement","priority":"high"}]\n```';
    const subs = decomp._parseSubtasks(content, parent);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].title, 'Task A');
  });

  it('parses JSON array embedded in surrounding prose', () => {
    const content = 'Here are the subtasks:\n[{"title":"Task B","type":"test","priority":"low"}]\nDone.';
    const subs = decomp._parseSubtasks(content, parent);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].title, 'Task B');
  });

  it('returns empty array when content contains no JSON array', () => {
    const subs = decomp._parseSubtasks('No JSON here at all.', parent);
    assert.deepEqual(subs, []);
  });

  it('returns empty array on invalid JSON', () => {
    const subs = decomp._parseSubtasks('[not valid json', parent);
    assert.deepEqual(subs, []);
  });

  it('returns empty array when parsed value is not an array', () => {
    const subs = decomp._parseSubtasks('{"key":"value"}', parent);
    // No top-level array — regex match fails
    assert.deepEqual(subs, []);
  });

  it('limits output to 10 subtasks even if more are returned', () => {
    const bigArray = Array.from({ length: 15 }, (_, i) => ({
      title: `Task ${i}`,
      type: 'implement',
      priority: 'low',
    }));
    const subs = decomp._parseSubtasks(JSON.stringify(bigArray), parent);
    assert.equal(subs.length, 10);
  });

  it('returns empty array for empty JSON array', () => {
    const subs = decomp._parseSubtasks('[]', parent);
    assert.deepEqual(subs, []);
  });
});

// ---------------------------------------------------------------------------
// decompose()
// ---------------------------------------------------------------------------

describe('TaskDecomposition.decompose()', () => {
  it('throws when router returns action other than "execute"', async () => {
    const decomp = new TaskDecomposition({
      taskQueue: makeTaskQueue(),
      router: makeRouter('skip'),
      providerRegistry: makeProviders('[]'),
      agents: {},
    });
    await assert.rejects(
      () => decomp.decompose(makeTask()),
      /No T1 model available/,
    );
  });

  it('calls router.resolve() with type="planning"', async () => {
    let resolvedType;
    const router = {
      resolve: (task, _agents) => {
        resolvedType = task.type;
        return { action: 'execute', provider: 'anthropic', model: 'claude-opus-4-6' };
      },
    };
    const queue = makeTaskQueue();
    const subtaskJson = JSON.stringify([{ title: 'Sub', type: 'implement', priority: 'high' }]);
    const decomp = new TaskDecomposition({
      taskQueue: queue,
      router,
      providerRegistry: makeProviders(subtaskJson),
      agents: {},
    });

    await decomp.decompose(makeTask());
    assert.equal(resolvedType, 'planning');
  });

  it('calls provider.execute() with system prompt, user message, and token limit', async () => {
    let capturedParams;
    const providers = {
      async execute(_providerId, params) {
        capturedParams = params;
        return { content: '[]', tokens_in: 5, tokens_out: 5, tool_calls: [], finish_reason: 'stop' };
      },
    };
    const decomp = new TaskDecomposition({
      taskQueue: makeTaskQueue(),
      router: makeRouter(),
      providerRegistry: providers,
      agents: {},
    });

    await decomp.decompose(makeTask({ title: 'My Task' }));

    assert.ok(Array.isArray(capturedParams.messages), 'messages should be array');
    assert.equal(capturedParams.messages[0].role, 'system');
    assert.equal(capturedParams.messages[1].role, 'user');
    assert.ok(capturedParams.messages[1].content.includes('My Task'));
    assert.equal(capturedParams.max_tokens, 2048);
  });

  it('adds parsed subtasks to the task queue and returns them', async () => {
    const queue = makeTaskQueue();
    const subtasks = [
      { title: 'Design schema', type: 'architecture', priority: 'high' },
      { title: 'Implement API', type: 'implement', priority: 'medium' },
    ];
    const decomp = new TaskDecomposition({
      taskQueue: queue,
      router: makeRouter(),
      providerRegistry: makeProviders(JSON.stringify(subtasks)),
      agents: {},
    });

    const created = await decomp.decompose(makeTask({ project_id: 'proj-42' }));

    assert.equal(created.length, 2);
    assert.equal(queue.added.length, 2);
    assert.equal(queue.added[0].title, 'Design schema');
    assert.equal(queue.added[1].title, 'Implement API');
    // project_id should be propagated from parent
    assert.equal(queue.added[0].project_id, 'proj-42');
  });

  it('returns empty array when model returns no parseable subtasks', async () => {
    const queue = makeTaskQueue();
    const decomp = new TaskDecomposition({
      taskQueue: queue,
      router: makeRouter(),
      providerRegistry: makeProviders('Sorry, I cannot decompose this.'),
      agents: {},
    });

    const created = await decomp.decompose(makeTask());
    assert.deepEqual(created, []);
    assert.equal(queue.added.length, 0);
  });
});
