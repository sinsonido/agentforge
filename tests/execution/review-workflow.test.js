/**
 * @file tests/execution/review-workflow.test.js
 * @description Unit tests for src/execution/review-workflow.js
 *
 * Covers:
 *  - needsReview(): false when agent missing, no require_review, no reviewer;
 *    true when both require_review and reviewer are set
 *  - _buildReviewPrompt(): contains task title, type, model, result; truncates long results
 *  - submitForReview(): early return when no reviewer, emits review.submitted,
 *    calls interAgentComm.ask(), interprets "APPROVE"/"REJECT" in feedback,
 *    emits review.completed, handles errors gracefully
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import eventBus from '../../src/core/event-bus.js';
import { ReviewWorkflow } from '../../src/execution/review-workflow.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Implement feature X',
    type: 'implement',
    model_used: 'claude-opus-4-6',
    agent_id: 'developer',
    result: 'Here is the implementation.',
    ...overrides,
  };
}

function makeComm(feedbackOrError) {
  return {
    async ask(_fromAgent, _toAgent, _prompt, _opts) {
      if (feedbackOrError instanceof Error) throw feedbackOrError;
      return feedbackOrError;
    },
  };
}

const agents = {
  developer: { require_review: true, reviewer: 'reviewer' },
  unreviewed: { require_review: false },
  'no-reviewer': { require_review: true }, // reviewer not set
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewWorkflow.needsReview()', () => {
  let workflow;

  beforeEach(() => {
    workflow = new ReviewWorkflow({
      taskQueue: {},
      interAgentComm: makeComm('APPROVE'),
      agents,
    });
  });

  it('returns false for an unknown agent_id', () => {
    assert.equal(workflow.needsReview(makeTask({ agent_id: 'unknown-agent' })), false);
  });

  it('returns false when agent has require_review: false', () => {
    assert.equal(workflow.needsReview(makeTask({ agent_id: 'unreviewed' })), false);
  });

  it('returns false when agent has require_review but no reviewer', () => {
    assert.equal(workflow.needsReview(makeTask({ agent_id: 'no-reviewer' })), false);
  });

  it('returns true when agent has both require_review: true and a reviewer', () => {
    assert.equal(workflow.needsReview(makeTask({ agent_id: 'developer' })), true);
  });
});

describe('ReviewWorkflow._buildReviewPrompt()', () => {
  let workflow;

  beforeEach(() => {
    workflow = new ReviewWorkflow({ taskQueue: {}, interAgentComm: makeComm(''), agents });
  });

  it('includes task title, type, and model_used', () => {
    const task = makeTask();
    const prompt = workflow._buildReviewPrompt(task);
    assert.ok(prompt.includes('Implement feature X'), 'title missing');
    assert.ok(prompt.includes('implement'), 'type missing');
    assert.ok(prompt.includes('claude-opus-4-6'), 'model missing');
  });

  it('includes APPROVE or REJECT instruction', () => {
    const prompt = workflow._buildReviewPrompt(makeTask());
    assert.ok(prompt.includes('APPROVE') || prompt.includes('REJECT'), 'instruction missing');
  });

  it('includes the task result', () => {
    const task = makeTask({ result: 'My wonderful output' });
    const prompt = workflow._buildReviewPrompt(task);
    assert.ok(prompt.includes('My wonderful output'));
  });

  it('truncates result to 2000 characters', () => {
    const longResult = 'x'.repeat(5000);
    const task = makeTask({ result: longResult });
    const prompt = workflow._buildReviewPrompt(task);
    // The result in the prompt should be at most 2000 chars
    assert.ok(!prompt.includes(longResult), 'full long result should not appear');
    assert.ok(prompt.includes('x'.repeat(2000)), 'truncated result should appear');
  });

  it('uses "(no result)" when result is empty', () => {
    const task = makeTask({ result: '' });
    const prompt = workflow._buildReviewPrompt(task);
    assert.ok(prompt.includes('(no result)'));
  });

  it('uses "(no result)" when result is undefined', () => {
    const task = makeTask({ result: undefined });
    const prompt = workflow._buildReviewPrompt(task);
    assert.ok(prompt.includes('(no result)'));
  });
});

describe('ReviewWorkflow.submitForReview()', () => {
  let capturedEvents;

  beforeEach(() => {
    capturedEvents = [];
    eventBus._log = [];
    eventBus.on('review.submitted', (d) => capturedEvents.push({ event: 'review.submitted', data: d }));
    eventBus.on('review.completed', (d) => capturedEvents.push({ event: 'review.completed', data: d }));
  });

  afterEach(() => {
    eventBus.removeAllListeners('review.submitted');
    eventBus.removeAllListeners('review.completed');
  });

  it('returns approved:true without calling comm when agent has no reviewer', async () => {
    let askCalled = false;
    const comm = { async ask() { askCalled = true; return 'should not be called'; } };
    const workflow = new ReviewWorkflow({
      taskQueue: {},
      interAgentComm: comm,
      agents: { developer: { require_review: true } }, // no reviewer
    });

    const result = await workflow.submitForReview(makeTask({ agent_id: 'developer' }));
    assert.equal(result.approved, true);
    assert.equal(askCalled, false, 'ask() should not be called');
  });

  it('emits review.submitted with task_id and reviewer before asking', async () => {
    const workflow = new ReviewWorkflow({
      taskQueue: {},
      interAgentComm: makeComm('APPROVE — looks good'),
      agents,
    });
    await workflow.submitForReview(makeTask({ agent_id: 'developer' }));
    const submitted = capturedEvents.find((e) => e.event === 'review.submitted');
    assert.ok(submitted, 'review.submitted not emitted');
    assert.equal(submitted.data.task_id, 'task-1');
    assert.equal(submitted.data.reviewer, 'reviewer');
  });

  it('returns approved:true when feedback does not contain "reject"', async () => {
    const workflow = new ReviewWorkflow({
      taskQueue: {},
      interAgentComm: makeComm('APPROVE — looks great!'),
      agents,
    });
    const result = await workflow.submitForReview(makeTask({ agent_id: 'developer' }));
    assert.equal(result.approved, true);
    assert.equal(result.feedback, 'APPROVE — looks great!');
  });

  it('returns approved:false when feedback contains "reject" (case-insensitive)', async () => {
    const workflow = new ReviewWorkflow({
      taskQueue: {},
      interAgentComm: makeComm('REJECT — needs more work'),
      agents,
    });
    const result = await workflow.submitForReview(makeTask({ agent_id: 'developer' }));
    assert.equal(result.approved, false);
  });

  it('returns approved:false when feedback contains lowercase "reject"', async () => {
    const workflow = new ReviewWorkflow({
      taskQueue: {},
      interAgentComm: makeComm('I must reject this implementation'),
      agents,
    });
    const result = await workflow.submitForReview(makeTask({ agent_id: 'developer' }));
    assert.equal(result.approved, false);
  });

  it('emits review.completed with task_id, reviewer, and approved fields', async () => {
    const workflow = new ReviewWorkflow({
      taskQueue: {},
      interAgentComm: makeComm('APPROVE'),
      agents,
    });
    await workflow.submitForReview(makeTask({ agent_id: 'developer' }));
    const completed = capturedEvents.find((e) => e.event === 'review.completed');
    assert.ok(completed, 'review.completed not emitted');
    assert.equal(completed.data.task_id, 'task-1');
    assert.equal(completed.data.reviewer, 'reviewer');
    assert.equal(completed.data.approved, true);
  });

  it('returns approved:false and feedback with error message when comm.ask() throws', async () => {
    const workflow = new ReviewWorkflow({
      taskQueue: {},
      interAgentComm: makeComm(new Error('Agent timeout')),
      agents,
    });
    const result = await workflow.submitForReview(makeTask({ agent_id: 'developer' }));
    assert.equal(result.approved, false);
    assert.ok(result.feedback.includes('Agent timeout'), 'error message should be in feedback');
  });

  it('emits review.completed with approved:false when comm.ask() throws', async () => {
    const workflow = new ReviewWorkflow({
      taskQueue: {},
      interAgentComm: makeComm(new Error('Comm error')),
      agents,
    });
    await workflow.submitForReview(makeTask({ agent_id: 'developer' }));
    const completed = capturedEvents.find((e) => e.event === 'review.completed');
    assert.ok(completed);
    assert.equal(completed.data.approved, false);
    assert.equal(completed.data.error, 'Comm error');
  });
});
