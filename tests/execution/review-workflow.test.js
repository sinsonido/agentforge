/**
 * @file tests/execution/review-workflow.test.js
 * @description Unit tests for src/execution/review-workflow.js — ReviewWorkflow.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewWorkflow } from '../../src/execution/review-workflow.js';
import eventBus from '../../src/core/event-bus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Implement auth',
    type: 'implement',
    model_used: 'claude-opus-4-6',
    agent_id: 'developer',
    result: 'Here is the implementation…',
    ...overrides,
  };
}

/** Build a ReviewWorkflow with an InterAgentComm stub. */
function makeWorkflow({ agents = {}, commResponse = 'APPROVE looks good', commThrows = null } = {}) {
  const commStub = {
    ask: async (_from, _to, _question, _opts) => {
      if (commThrows) throw new Error(commThrows);
      return commResponse;
    },
  };
  return new ReviewWorkflow({ taskQueue: {}, interAgentComm: commStub, agents });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewWorkflow', () => {
  afterEach(() => {
    eventBus.removeAllListeners('review.submitted');
    eventBus.removeAllListeners('review.completed');
  });

  // ── needsReview() ──────────────────────────────────────────────────────────

  it('needsReview() returns false when agent not found', () => {
    const wf = makeWorkflow({ agents: {} });
    assert.equal(wf.needsReview(makeTask()), false);
  });

  it('needsReview() returns false when agent lacks require_review', () => {
    const wf = makeWorkflow({
      agents: { developer: { require_review: false, reviewer: 'reviewer' } },
    });
    assert.equal(wf.needsReview(makeTask()), false);
  });

  it('needsReview() returns false when agent lacks reviewer', () => {
    const wf = makeWorkflow({
      agents: { developer: { require_review: true, reviewer: null } },
    });
    assert.equal(wf.needsReview(makeTask()), false);
  });

  it('needsReview() returns true when both require_review and reviewer are set', () => {
    const wf = makeWorkflow({
      agents: { developer: { require_review: true, reviewer: 'senior-dev' } },
    });
    assert.equal(wf.needsReview(makeTask()), true);
  });

  // ── submitForReview() — approved ───────────────────────────────────────────

  it('submitForReview() returns approved:true when feedback contains APPROVE', async () => {
    const wf = makeWorkflow({
      agents: { developer: { require_review: true, reviewer: 'reviewer' } },
      commResponse: 'APPROVE: looks good to me',
    });
    const { approved, feedback } = await wf.submitForReview(makeTask());
    assert.equal(approved, true);
    assert.ok(feedback.includes('APPROVE'));
  });

  it('submitForReview() returns approved:false when feedback contains REJECT', async () => {
    const wf = makeWorkflow({
      agents: { developer: { require_review: true, reviewer: 'reviewer' } },
      commResponse: 'REJECT: missing error handling',
    });
    const { approved } = await wf.submitForReview(makeTask());
    assert.equal(approved, false);
  });

  it('approval is case-insensitive: lowercase "reject" counts as rejection', async () => {
    const wf = makeWorkflow({
      agents: { developer: { require_review: true, reviewer: 'reviewer' } },
      commResponse: 'reject this implementation',
    });
    const { approved } = await wf.submitForReview(makeTask());
    assert.equal(approved, false);
  });

  it('submitForReview() emits review.submitted and review.completed events', async () => {
    const events = [];
    eventBus.on('review.submitted', e => events.push({ type: 'submitted', ...e }));
    eventBus.on('review.completed', e => events.push({ type: 'completed', ...e }));

    const wf = makeWorkflow({
      agents: { developer: { require_review: true, reviewer: 'reviewer' } },
    });
    await wf.submitForReview(makeTask());

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'submitted');
    assert.equal(events[0].task_id, 'task-1');
    assert.equal(events[1].type, 'completed');
    assert.equal(events[1].task_id, 'task-1');
    assert.equal(events[1].approved, true);
  });

  // ── submitForReview() — no reviewer configured ─────────────────────────────

  it('submitForReview() returns approved:true when no reviewer configured', async () => {
    const wf = makeWorkflow({
      agents: { developer: { require_review: true, reviewer: null } },
    });
    const { approved, feedback } = await wf.submitForReview(makeTask());
    assert.equal(approved, true);
    assert.ok(feedback.includes('No reviewer'));
  });

  // ── submitForReview() — comm error ─────────────────────────────────────────

  it('submitForReview() returns approved:false and emits review.completed on comm error', async () => {
    const completedEvents = [];
    eventBus.on('review.completed', e => completedEvents.push(e));

    const wf = makeWorkflow({
      agents: { developer: { require_review: true, reviewer: 'reviewer' } },
      commThrows: 'ask_agent timeout',
    });
    const { approved, feedback } = await wf.submitForReview(makeTask());
    assert.equal(approved, false);
    assert.ok(feedback.includes('ask_agent timeout'));
    assert.equal(completedEvents.length, 1);
    assert.equal(completedEvents[0].approved, false);
    assert.ok(completedEvents[0].error);
  });

  // ── _buildReviewPrompt() ───────────────────────────────────────────────────

  it('_buildReviewPrompt() includes task title, type, model, and result', () => {
    const wf = makeWorkflow();
    const prompt = wf._buildReviewPrompt(makeTask());
    assert.ok(prompt.includes('Implement auth'));
    assert.ok(prompt.includes('implement'));
    assert.ok(prompt.includes('claude-opus-4-6'));
    assert.ok(prompt.includes('Here is the implementation'));
  });

  it('_buildReviewPrompt() truncates result longer than 2000 characters', () => {
    const longResult = 'x'.repeat(3000);
    const wf = makeWorkflow();
    const prompt = wf._buildReviewPrompt(makeTask({ result: longResult }));
    // The prompt should not contain 3000 x's
    const resultSection = prompt.split('Result:')[1] || '';
    assert.ok(resultSection.length < 2100); // some slack for surrounding text
  });

  it('_buildReviewPrompt() handles missing result gracefully', () => {
    const wf = makeWorkflow();
    const prompt = wf._buildReviewPrompt(makeTask({ result: null }));
    assert.ok(prompt.includes('(no result)'));
  });

  it('_buildReviewPrompt() ends with APPROVE or REJECT instruction', () => {
    const wf = makeWorkflow();
    const prompt = wf._buildReviewPrompt(makeTask());
    assert.ok(prompt.includes('APPROVE') && prompt.includes('REJECT'));
  });
});
