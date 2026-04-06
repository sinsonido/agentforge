/**
 * @file tests/execution/review-workflow.test.js
 * @description Unit tests for src/execution/review-workflow.js
 *
 * Covers: needsReview() logic, submitForReview() approval / rejection /
 * error handling, event emissions, and review prompt building.
 *
 * NOTE: review-workflow.js imports the eventBus singleton. We listen on the
 * same singleton to verify events are emitted correctly.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../../src/core/task-queue.js';
import eventBus from '../../src/core/event-bus.js';
import { ReviewWorkflow } from '../../src/execution/review-workflow.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENTS = {
  developer: {
    id: 'developer',
    require_review: true,
    reviewer: 'senior-reviewer',
  },
  tester: {
    id: 'tester',
    require_review: false,
    reviewer: null,
  },
  solo: {
    id: 'solo',
    require_review: true,
    reviewer: null, // has flag but no reviewer assigned
  },
};

const COMPLETED_TASK = {
  id: 't-review-1',
  title: 'Implement OAuth login',
  type: 'implement',
  agent_id: 'developer',
  model_used: 'claude-opus-4-6',
  result: 'Added OAuth flow with PKCE.',
};

/**
 * Build a ReviewWorkflow with a stubbed InterAgentComm.
 * @param {string|Error} commResponse - String to resolve with, or Error to reject with.
 */
function makeWorkflow(commResponse = 'APPROVE — looks good') {
  const taskQueue = new TaskQueue();
  const interAgentComm = {
    ask: async () => {
      if (commResponse instanceof Error) throw commResponse;
      return commResponse;
    },
  };
  const workflow = new ReviewWorkflow({ taskQueue, interAgentComm, agents: AGENTS });
  return workflow;
}

// ---------------------------------------------------------------------------
// needsReview()
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — needsReview()', () => {
  it('returns true when agent has require_review=true and a reviewer', () => {
    const w = makeWorkflow();
    assert.equal(w.needsReview({ agent_id: 'developer' }), true);
  });

  it('returns false when agent has require_review=false', () => {
    const w = makeWorkflow();
    assert.equal(w.needsReview({ agent_id: 'tester' }), false);
  });

  it('returns false when require_review=true but reviewer is null', () => {
    const w = makeWorkflow();
    assert.equal(w.needsReview({ agent_id: 'solo' }), false);
  });

  it('returns false when agent_id is not in the agents map', () => {
    const w = makeWorkflow();
    assert.equal(w.needsReview({ agent_id: 'unknown-agent' }), false);
  });
});

// ---------------------------------------------------------------------------
// submitForReview() — approved path
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — submitForReview() approval', () => {
  beforeEach(() => {
    eventBus.removeAllListeners('review.submitted');
    eventBus.removeAllListeners('review.completed');
  });

  it('returns approved:true when feedback does not contain "reject"', async () => {
    const w = makeWorkflow('APPROVE — looks good');
    const result = await w.submitForReview(COMPLETED_TASK);
    assert.equal(result.approved, true);
    assert.equal(result.feedback, 'APPROVE — looks good');
  });

  it('emits review.submitted with task_id and reviewer', async () => {
    let emittedSubmit = null;
    eventBus.once('review.submitted', d => { emittedSubmit = d; });
    const w = makeWorkflow('APPROVE');
    await w.submitForReview(COMPLETED_TASK);
    assert.equal(emittedSubmit?.task_id, COMPLETED_TASK.id);
    assert.equal(emittedSubmit?.reviewer, 'senior-reviewer');
  });

  it('emits review.completed with approved:true', async () => {
    let emittedComplete = null;
    eventBus.once('review.completed', d => { emittedComplete = d; });
    const w = makeWorkflow('APPROVE');
    await w.submitForReview(COMPLETED_TASK);
    assert.equal(emittedComplete?.approved, true);
    assert.equal(emittedComplete?.task_id, COMPLETED_TASK.id);
  });
});

// ---------------------------------------------------------------------------
// submitForReview() — rejected path
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — submitForReview() rejection', () => {
  beforeEach(() => {
    eventBus.removeAllListeners('review.submitted');
    eventBus.removeAllListeners('review.completed');
  });

  it('returns approved:false when feedback contains "reject"', async () => {
    const w = makeWorkflow('REJECT — missing error handling');
    const result = await w.submitForReview(COMPLETED_TASK);
    assert.equal(result.approved, false);
    assert.equal(result.feedback, 'REJECT — missing error handling');
  });

  it('is case-insensitive for reject keyword', async () => {
    const w = makeWorkflow('Reject: does not meet standards');
    const result = await w.submitForReview(COMPLETED_TASK);
    assert.equal(result.approved, false);
  });

  it('emits review.completed with approved:false on rejection', async () => {
    let emitted = null;
    eventBus.once('review.completed', d => { emitted = d; });
    const w = makeWorkflow('REJECT');
    await w.submitForReview(COMPLETED_TASK);
    assert.equal(emitted?.approved, false);
  });
});

// ---------------------------------------------------------------------------
// submitForReview() — no reviewer configured
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — submitForReview() no reviewer', () => {
  it('returns approved:true immediately when no reviewer configured', async () => {
    const w = makeWorkflow();
    const taskWithNoReviewer = { ...COMPLETED_TASK, agent_id: 'solo' };
    const result = await w.submitForReview(taskWithNoReviewer);
    assert.equal(result.approved, true);
    assert.match(result.feedback, /No reviewer/);
  });
});

// ---------------------------------------------------------------------------
// submitForReview() — error handling
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — submitForReview() error path', () => {
  beforeEach(() => {
    eventBus.removeAllListeners('review.submitted');
    eventBus.removeAllListeners('review.completed');
  });

  it('returns approved:false and the error message when comm.ask throws', async () => {
    const w = makeWorkflow(new Error('Reviewer agent timed out'));
    const result = await w.submitForReview(COMPLETED_TASK);
    assert.equal(result.approved, false);
    assert.match(result.feedback, /Reviewer agent timed out/);
  });

  it('emits review.completed with approved:false on error', async () => {
    let emitted = null;
    eventBus.once('review.completed', d => { emitted = d; });
    const w = makeWorkflow(new Error('Network failure'));
    await w.submitForReview(COMPLETED_TASK);
    assert.equal(emitted?.approved, false);
    assert.ok(emitted?.error);
  });
});

// ---------------------------------------------------------------------------
// _buildReviewPrompt()
// ---------------------------------------------------------------------------

describe('ReviewWorkflow — _buildReviewPrompt()', () => {
  it('includes the task title', () => {
    const w = makeWorkflow();
    const prompt = w._buildReviewPrompt(COMPLETED_TASK);
    assert.ok(prompt.includes('Implement OAuth login'));
  });

  it('includes the task result', () => {
    const w = makeWorkflow();
    const prompt = w._buildReviewPrompt(COMPLETED_TASK);
    assert.ok(prompt.includes('Added OAuth flow with PKCE.'));
  });

  it('truncates result to 2000 characters', () => {
    const w = makeWorkflow();
    const longTask = { ...COMPLETED_TASK, result: 'x'.repeat(5000) };
    const prompt = w._buildReviewPrompt(longTask);
    // Ensure the full 5000-char result is NOT present
    assert.ok(!prompt.includes('x'.repeat(2001)));
  });

  it('handles null result gracefully', () => {
    const w = makeWorkflow();
    const nullResultTask = { ...COMPLETED_TASK, result: null };
    const prompt = w._buildReviewPrompt(nullResultTask);
    assert.ok(prompt.includes('(no result)'));
  });
});
