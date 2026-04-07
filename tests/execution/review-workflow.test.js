/**
 * @file tests/execution/review-workflow.test.js
 * @description Unit tests for src/execution/review-workflow.js
 *
 * Covers:
 *  - needsReview() returns true only when agent has both require_review and reviewer
 *  - submitForReview() returns approved:true when feedback lacks "reject"
 *  - submitForReview() returns approved:false when feedback contains "reject"
 *  - submitForReview() returns approved:true with "No reviewer configured" when reviewer absent
 *  - submitForReview() returns approved:false and wraps error on comm failure
 *  - review.submitted and review.completed events are emitted
 *  - _buildReviewPrompt() includes task title, type, model, and result
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewWorkflow } from '../../src/execution/review-workflow.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import eventBus from '../../src/core/event-bus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(agents = {}, commOverride = null) {
  const taskQueue = new TaskQueue();

  /** Stub interAgentComm — returns configurable feedback. */
  const comm = commOverride ?? {
    _response: 'APPROVE looks good',
    ask(_from, _to, _prompt, _opts) {
      return Promise.resolve(this._response);
    },
  };

  const workflow = new ReviewWorkflow({ taskQueue, interAgentComm: comm, agents });
  return { workflow, taskQueue, comm };
}

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Build feature X',
    type: 'implement',
    agent_id: 'developer',
    model_used: 'claude-opus-4-6',
    result: 'Done. See PR #42.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// needsReview()
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — needsReview()', () => {
  it('returns true when agent has require_review=true and a reviewer', () => {
    const { workflow } = makeWorkflow({
      developer: { require_review: true, reviewer: 'reviewer-agent' },
    });
    assert.equal(workflow.needsReview(makeTask()), true);
  });

  it('returns false when require_review is false', () => {
    const { workflow } = makeWorkflow({
      developer: { require_review: false, reviewer: 'reviewer-agent' },
    });
    assert.equal(workflow.needsReview(makeTask()), false);
  });

  it('returns false when reviewer is absent', () => {
    const { workflow } = makeWorkflow({
      developer: { require_review: true },
    });
    assert.equal(workflow.needsReview(makeTask()), false);
  });

  it('returns false when agent is not found in config', () => {
    const { workflow } = makeWorkflow({});
    assert.equal(workflow.needsReview(makeTask()), false);
  });

  it('returns false when agents map is empty', () => {
    const { workflow } = makeWorkflow({});
    assert.equal(workflow.needsReview(makeTask({ agent_id: 'unknown' })), false);
  });
});

// ---------------------------------------------------------------------------
// submitForReview() — approval logic
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — submitForReview() approval', () => {
  const agents = {
    developer: { require_review: true, reviewer: 'reviewer-agent' },
  };

  it('returns approved:true when feedback does not contain "reject"', async () => {
    const comm = { ask: async () => 'APPROVE everything looks fine' };
    const { workflow } = makeWorkflow(agents, comm);

    const result = await workflow.submitForReview(makeTask());
    assert.equal(result.approved, true);
    assert.equal(result.feedback, 'APPROVE everything looks fine');
  });

  it('returns approved:false when feedback contains "reject" (case-insensitive)', async () => {
    const comm = { ask: async () => 'REJECT the implementation is incomplete' };
    const { workflow } = makeWorkflow(agents, comm);

    const result = await workflow.submitForReview(makeTask());
    assert.equal(result.approved, false);
    assert.ok(result.feedback.toLowerCase().includes('reject'));
  });

  it('returns approved:false when feedback contains lowercase "reject"', async () => {
    const comm = { ask: async () => 'I must reject this work' };
    const { workflow } = makeWorkflow(agents, comm);

    const result = await workflow.submitForReview(makeTask());
    assert.equal(result.approved, false);
  });

  it('returns approved:true and feedback when feedback is just APPROVE', async () => {
    const comm = { ask: async () => 'APPROVE' };
    const { workflow } = makeWorkflow(agents, comm);

    const result = await workflow.submitForReview(makeTask());
    assert.equal(result.approved, true);
    assert.equal(result.feedback, 'APPROVE');
  });
});

// ---------------------------------------------------------------------------
// submitForReview() — no reviewer configured
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — submitForReview() without reviewer', () => {
  it('returns approved:true with "No reviewer configured" when reviewer is absent', async () => {
    const agents = { developer: { require_review: true } }; // no reviewer
    const { workflow } = makeWorkflow(agents);

    const result = await workflow.submitForReview(makeTask());
    assert.equal(result.approved, true);
    assert.equal(result.feedback, 'No reviewer configured');
  });

  it('returns approved:true when agent is not found in agents map', async () => {
    const { workflow } = makeWorkflow({});
    const result = await workflow.submitForReview(makeTask({ agent_id: 'ghost' }));
    assert.equal(result.approved, true);
    assert.equal(result.feedback, 'No reviewer configured');
  });
});

// ---------------------------------------------------------------------------
// submitForReview() — error handling
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — submitForReview() error handling', () => {
  const agents = {
    developer: { require_review: true, reviewer: 'reviewer-agent' },
  };

  it('returns approved:false and includes error message when comm throws', async () => {
    const comm = { ask: async () => { throw new Error('timeout'); } };
    const { workflow } = makeWorkflow(agents, comm);

    const result = await workflow.submitForReview(makeTask());
    assert.equal(result.approved, false);
    assert.ok(result.feedback.includes('timeout'));
  });
});

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — event emission', () => {
  const agents = {
    developer: { require_review: true, reviewer: 'reviewer-agent' },
  };

  beforeEach(() => {
    eventBus.removeAllListeners('review.submitted');
    eventBus.removeAllListeners('review.completed');
  });

  it('emits review.submitted before calling the reviewer', async () => {
    let submittedPayload = null;
    eventBus.once('review.submitted', (payload) => { submittedPayload = payload; });

    const comm = { ask: async () => 'APPROVE' };
    const { workflow } = makeWorkflow(agents, comm);

    await workflow.submitForReview(makeTask());

    assert.ok(submittedPayload !== null, 'review.submitted should have been emitted');
    assert.equal(submittedPayload.task_id, 'task-1');
    assert.equal(submittedPayload.reviewer, 'reviewer-agent');
  });

  it('emits review.completed with approved=true on approval', async () => {
    let completedPayload = null;
    eventBus.once('review.completed', (payload) => { completedPayload = payload; });

    const comm = { ask: async () => 'APPROVE' };
    const { workflow } = makeWorkflow(agents, comm);

    await workflow.submitForReview(makeTask());

    assert.ok(completedPayload !== null);
    assert.equal(completedPayload.approved, true);
    assert.equal(completedPayload.task_id, 'task-1');
  });

  it('emits review.completed with approved=false on rejection', async () => {
    let completedPayload = null;
    eventBus.once('review.completed', (payload) => { completedPayload = payload; });

    const comm = { ask: async () => 'REJECT not good enough' };
    const { workflow } = makeWorkflow(agents, comm);

    await workflow.submitForReview(makeTask());

    assert.ok(completedPayload !== null);
    assert.equal(completedPayload.approved, false);
  });

  it('emits review.completed with approved=false when comm throws', async () => {
    let completedPayload = null;
    eventBus.once('review.completed', (payload) => { completedPayload = payload; });

    const comm = { ask: async () => { throw new Error('network error'); } };
    const { workflow } = makeWorkflow(agents, comm);

    await workflow.submitForReview(makeTask());

    assert.ok(completedPayload !== null);
    assert.equal(completedPayload.approved, false);
    assert.ok(completedPayload.error.includes('network error'));
  });
});

// ---------------------------------------------------------------------------
// _buildReviewPrompt()
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — _buildReviewPrompt()', () => {
  it('includes task title in the prompt', () => {
    const { workflow } = makeWorkflow();
    const prompt = workflow._buildReviewPrompt(makeTask());
    assert.ok(prompt.includes('Build feature X'));
  });

  it('includes task type in the prompt', () => {
    const { workflow } = makeWorkflow();
    const prompt = workflow._buildReviewPrompt(makeTask());
    assert.ok(prompt.includes('implement'));
  });

  it('includes model_used in the prompt', () => {
    const { workflow } = makeWorkflow();
    const prompt = workflow._buildReviewPrompt(makeTask());
    assert.ok(prompt.includes('claude-opus-4-6'));
  });

  it('includes task result in the prompt', () => {
    const { workflow } = makeWorkflow();
    const prompt = workflow._buildReviewPrompt(makeTask());
    assert.ok(prompt.includes('Done. See PR #42.'));
  });

  it('truncates result to 2000 characters', () => {
    const { workflow } = makeWorkflow();
    const longResult = 'x'.repeat(5000);
    const prompt = workflow._buildReviewPrompt(makeTask({ result: longResult }));
    // The 2000-char slice of 'x' should appear, but not the full 5000
    assert.ok(prompt.includes('x'.repeat(2000)));
    assert.ok(!prompt.includes('x'.repeat(2001)));
  });

  it('handles missing result gracefully', () => {
    const { workflow } = makeWorkflow();
    const prompt = workflow._buildReviewPrompt(makeTask({ result: undefined }));
    assert.ok(prompt.includes('(no result)'));
  });
});
