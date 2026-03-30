import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskDecomposition } from '../../src/execution/task-decomposition.js';

describe('TaskDecomposition', () => {
  let decomposer;
  let mockTaskQueue;
  let mockRouter;
  let mockProviders;
  let addedTasks;

  beforeEach(() => {
    addedTasks = [];
    mockTaskQueue = {
      add(opts) {
        const t = { id: `task-${addedTasks.length + 1}`, ...opts };
        addedTasks.push(t);
        return t;
      },
    };
    mockRouter = {
      resolve(_task, _opts) {
        return { action: 'execute', provider: 'anthropic', model: 'claude-opus' };
      },
    };
    mockProviders = {
      calls: [],
      async execute(providerId, params) {
        this.calls.push({ providerId, params });
        return { content: this._content || '[]', tokens_in: 10, tokens_out: 20 };
      },
    };
    decomposer = new TaskDecomposition({
      taskQueue: mockTaskQueue,
      router: mockRouter,
      providerRegistry: mockProviders,
      agents: {},
    });
  });

  describe('_buildPrompt()', () => {
    it('includes task title in the prompt', () => {
      const prompt = decomposer._buildPrompt({ title: 'Build login page', type: 'implement' });
      assert.ok(prompt.includes('Build login page'));
    });

    it('includes task type in the prompt', () => {
      const prompt = decomposer._buildPrompt({ title: 'T', type: 'review' });
      assert.ok(prompt.includes('review'));
    });

    it('returns a non-empty string', () => {
      const prompt = decomposer._buildPrompt({ title: 'T', type: 'test' });
      assert.ok(typeof prompt === 'string' && prompt.length > 0);
    });
  });

  describe('_parseSubtasks()', () => {
    it('parses a valid JSON array', () => {
      const content = '[{"title": "Step 1", "type": "implement"}, {"title": "Step 2", "type": "test"}]';
      const result = decomposer._parseSubtasks(content, {});
      assert.equal(result.length, 2);
      assert.equal(result[0].title, 'Step 1');
      assert.equal(result[1].type, 'test');
    });

    it('extracts JSON array from markdown code fence', () => {
      const content = '```json\n[{"title": "Step A", "type": "implement"}]\n```';
      const result = decomposer._parseSubtasks(content, {});
      assert.equal(result.length, 1);
      assert.equal(result[0].title, 'Step A');
    });

    it('returns empty array when no JSON array found', () => {
      const result = decomposer._parseSubtasks('No JSON here', {});
      assert.deepEqual(result, []);
    });

    it('returns empty array on invalid JSON', () => {
      const result = decomposer._parseSubtasks('[invalid json}', {});
      assert.deepEqual(result, []);
    });

    it('returns empty array when parsed value is not an array', () => {
      const result = decomposer._parseSubtasks('{"key": "value"}', {});
      // No array match — returns []
      assert.deepEqual(result, []);
    });

    it('limits output to 10 subtasks', () => {
      const items = Array.from({ length: 15 }, (_, i) => ({ title: `Step ${i}`, type: 'implement' }));
      const result = decomposer._parseSubtasks(JSON.stringify(items), {});
      assert.equal(result.length, 10);
    });

    it('returns fewer than 10 when array has fewer items', () => {
      const items = [{ title: 'Only one', type: 'test' }];
      const result = decomposer._parseSubtasks(JSON.stringify(items), {});
      assert.equal(result.length, 1);
    });
  });

  describe('decompose()', () => {
    it('calls provider with planning type resolved from router', async () => {
      mockProviders._content = '[{"title": "Sub 1", "type": "implement", "priority": "high"}]';
      const task = { id: 'parent', title: 'Big feature', type: 'implement', project_id: 'proj-1' };

      await decomposer.decompose(task);

      assert.equal(mockProviders.calls.length, 1);
      assert.equal(mockProviders.calls[0].providerId, 'anthropic');
      assert.equal(mockProviders.calls[0].params.model, 'claude-opus');
    });

    it('adds subtasks to the queue with parent project_id', async () => {
      mockProviders._content = '[{"title": "Sub A", "type": "test"}, {"title": "Sub B", "type": "review"}]';
      const task = { id: 'parent', title: 'Feature', type: 'implement', project_id: 'proj-42' };

      await decomposer.decompose(task);

      assert.equal(addedTasks.length, 2);
      assert.equal(addedTasks[0].title, 'Sub A');
      assert.equal(addedTasks[0].project_id, 'proj-42');
      assert.equal(addedTasks[1].title, 'Sub B');
    });

    it('returns created subtask objects', async () => {
      mockProviders._content = '[{"title": "Step 1", "type": "implement"}]';
      const task = { id: 'p', title: 'T', type: 'implement', project_id: 'proj-1' };

      const created = await decomposer.decompose(task);

      assert.equal(created.length, 1);
      assert.equal(created[0].title, 'Step 1');
    });

    it('throws when router returns action other than execute', async () => {
      mockRouter.resolve = () => ({ action: 'pause' });
      const task = { id: 'p', title: 'T', type: 'implement', project_id: 'proj-1' };

      await assert.rejects(
        () => decomposer.decompose(task),
        /No T1 model available/
      );
    });

    it('returns empty array when provider returns no parseable subtasks', async () => {
      mockProviders._content = 'Unable to decompose this task.';
      const task = { id: 'p', title: 'T', type: 'implement', project_id: 'proj-1' };

      const created = await decomposer.decompose(task);
      assert.equal(created.length, 0);
    });

    it('passes depends_on from parsed subtask to queue', async () => {
      mockProviders._content = '[{"title": "S", "type": "test", "depends_on": ["task-0"]}]';
      const task = { id: 'p', title: 'T', type: 'implement', project_id: 'proj-1' };

      await decomposer.decompose(task);

      assert.deepEqual(addedTasks[0].depends_on, ['task-0']);
    });

    it('defaults depends_on to empty array when not in subtask', async () => {
      mockProviders._content = '[{"title": "S", "type": "test"}]';
      const task = { id: 'p', title: 'T', type: 'implement', project_id: 'proj-1' };

      await decomposer.decompose(task);

      assert.deepEqual(addedTasks[0].depends_on, []);
    });
  });
});
