import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskInput, admissionKey } from '../../src/core/task-model.js';

const coding = (over = {}) => ({
  kind: 'coding', repo: 'sinsonido/agentforge', base: 'master',
  instruction: 'Add task model v2\nDetails follow.', playbook: 'feature', ...over,
});

describe('parseTaskInput()', () => {
  it('keeps a body without kind on the text path', () => {
    assert.deepEqual(parseTaskInput({ title: 'Hi', priority: 'high' }), {
      ok: true,
      value: { kind: 'text', title: 'Hi', type: undefined, priority: 'high', agent_id: undefined },
    });
  });

  it('requires a title for a text task', () => {
    assert.deepEqual(parseTaskInput({}), { ok: false, error: '`title` is required' });
    assert.deepEqual(parseTaskInput(null), { ok: false, error: '`title` is required' });
  });

  it('rejects an unknown kind', () => {
    assert.match(parseTaskInput({ kind: 'magic', title: 'x' }).error, /`kind` must be one of: text, coding/);
  });

  it('parses a coding task, titling it from the first instruction line', () => {
    const { ok, value } = parseTaskInput(coding({ issue: 195, budget: 2.5 }));
    assert.equal(ok, true);
    assert.equal(value.title, 'Add task model v2');
    assert.equal(value.issue, 195);
    assert.equal(value.budget, 2.5);
    assert.equal(value.playbook, 'feature');
  });

  it('defaults issue and budget to null', () => {
    const { value } = parseTaskInput(coding());
    assert.equal(value.issue, null);
    assert.equal(value.budget, null);
  });

  it('names every missing required field of a coding task', () => {
    assert.deepEqual(parseTaskInput({ kind: 'coding', repo: 'a/b', base: '  ' }), {
      ok: false,
      error: 'a coding task requires `base`, `instruction`, `playbook`',
    });
  });

  it('rejects a malformed repo, unknown playbook, bad issue and bad budget together', () => {
    const { ok, error } = parseTaskInput(coding({ repo: 'agentforge', playbook: 'yolo', issue: -1, budget: '5' }));
    assert.equal(ok, false);
    assert.match(error, /`repo` must be "owner\/name"/);
    assert.match(error, /`playbook` must be one of: bug-fix, feature, refactoring, investigation, perf-issue/);
    assert.match(error, /`issue` must be a positive integer/);
    assert.match(error, /`budget` must be a positive number of USD/);
  });
});

describe('admissionKey()', () => {
  it('identifies a coding task by repo, issue and playbook', () => {
    assert.equal(admissionKey({ ...coding(), issue: 7 }), 'sinsonido/agentforge#7:feature');
  });

  it('gives no key to text tasks or coding tasks without an issue', () => {
    assert.equal(admissionKey({ kind: 'text', title: 'x' }), null);
    assert.equal(admissionKey({ ...coding(), issue: null }), null);
  });
});
