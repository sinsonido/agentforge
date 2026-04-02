import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewWorkflow } from '../../src/execution/review-workflow.js';
import eventBus from '../../src/core/event-bus.js';

const agents = {
  developer: { require_review: true, reviewer: 'senior-dev' },
  tester: { require_review: true, reviewer: 'qa-lead' },
  solo: { require_review: false, reviewer: null },
  no_reviewer: { require_review: true, reviewer: null },
};

function makeComm(feedback = 'APPROVE: looks good') {
  return {
    ask: async () => feedback,
  };
}

describe('ReviewWorkflow', () => {
  let wf;

  beforeEach(() => {
    wf = new ReviewWorkflow({ taskQueue: {}, interAgentComm: makeComm(), agents });
  });

  describe('needsReview()', () => {
    it('returns true when agent has require_review and a reviewer set', () => {
      assert.equal(wf.needsReview({ agent_id: 'developer' }), true);
    });

    it('returns false when require_review is false', () => {
      assert.equal(wf.needsReview({ agent_id: 'solo' }), false);
    });

    it('returns false when reviewer is not set', () => {
      assert.equal(wf.needsReview({ agent_id: 'no_reviewer' }), false);
    });

    it('returns false for an unknown agent_id', () => {
      assert.equal(wf.needsReview({ agent_id: 'ghost' }), false);
    });
  });

  describe('_buildReviewPrompt()', () => {
    it('includes the task title', () => {
      const prompt = wf._buildReviewPrompt({ title: 'Add login', type: 'implement', model_used: 'opus', result: 'done' });
      assert.ok(prompt.includes('Add login'));
    });

    it('includes the task type', () => {
      const prompt = wf._buildReviewPrompt({ title: 't', type: 'review', model_used: 'opus', result: 'x' });
      assert.ok(prompt.includes('review'));
    });

    it('includes model_used', () => {
      const prompt = wf._buildReviewPrompt({ title: 't', type: 'implement', model_used: 'claude-opus-4-6', result: 'x' });
      assert.ok(prompt.includes('claude-opus-4-6'));
    });

    it('truncates result to 2000 characters', () => {
      const longResult = 'X'.repeat(3000);
      const prompt = wf._buildReviewPrompt({ title: 't', type: 'implement', model_used: 'x', result: longResult });
      // The result section should not contain more than 2000 Xs
      assert.ok(!prompt.includes('X'.repeat(2001)));
    });

    it('handles null result gracefully', () => {
      const prompt = wf._buildReviewPrompt({ title: 't', type: 'implement', model_used: 'x', result: null });
      assert.ok(prompt.includes('(no result)'));
    });

    it('asks for APPROVE or REJECT', () => {
      const prompt = wf._buildReviewPrompt({ title: 't', type: 'implement', model_used: 'x', result: 'ok' });
      assert.ok(prompt.includes('APPROVE') && prompt.includes('REJECT'));
    });
  });

  describe('submitForReview()', () => {
    const task = { id: 'T-1', agent_id: 'developer', title: 'Build login', type: 'implement', model_used: 'opus', result: 'done' };

    it('returns approved:true when reviewer replies APPROVE', async () => {
      const result = await wf.submitForReview(task);
      assert.equal(result.approved, true);
    });

    it('returns approved:false when reviewer replies REJECT', async () => {
      const wf2 = new ReviewWorkflow({
        taskQueue: {},
        interAgentComm: makeComm('REJECT: missing tests'),
        agents,
      });
      const result = await wf2.submitForReview(task);
      assert.equal(result.approved, false);
    });

    it('returns the feedback string from the reviewer', async () => {
      const result = await wf.submitForReview(task);
      assert.ok(result.feedback.includes('APPROVE'));
    });

    it('returns approved:true when no reviewer is configured', async () => {
      const noRevTask = { ...task, agent_id: 'no_reviewer' };
      const result = await wf.submitForReview(noRevTask);
      assert.equal(result.approved, true);
      assert.ok(result.feedback.includes('No reviewer'));
    });

    it('emits review.submitted event before asking the reviewer', async () => {
      let submitted = null;
      eventBus.once('review.submitted', (d) => { submitted = d; });
      await wf.submitForReview(task);
      assert.ok(submitted);
      assert.equal(submitted.task_id, 'T-1');
      assert.equal(submitted.reviewer, 'senior-dev');
    });

    it('emits review.completed event with approved status', async () => {
      let completed = null;
      eventBus.once('review.completed', (d) => { completed = d; });
      await wf.submitForReview(task);
      assert.ok(completed);
      assert.equal(completed.task_id, 'T-1');
      assert.equal(completed.approved, true);
    });

    it('emits review.completed with approved:false when reviewer rejects', async () => {
      let completed = null;
      eventBus.once('review.completed', (d) => { completed = d; });
      const wf2 = new ReviewWorkflow({
        taskQueue: {},
        interAgentComm: makeComm('REJECT: needs work'),
        agents,
      });
      await wf2.submitForReview(task);
      assert.equal(completed.approved, false);
    });

    it('returns approved:false and feedback with error message when comm.ask throws', async () => {
      const errComm = { ask: async () => { throw new Error('reviewer unavailable'); } };
      const wf3 = new ReviewWorkflow({ taskQueue: {}, interAgentComm: errComm, agents });
      const result = await wf3.submitForReview(task);
      assert.equal(result.approved, false);
      assert.ok(result.feedback.includes('reviewer unavailable'));
    });

    it('emits review.completed with error when comm.ask throws', async () => {
      let completed = null;
      eventBus.once('review.completed', (d) => { completed = d; });
      const errComm = { ask: async () => { throw new Error('timeout'); } };
      const wf4 = new ReviewWorkflow({ taskQueue: {}, interAgentComm: errComm, agents });
      await wf4.submitForReview(task);
      assert.ok(completed);
      assert.equal(completed.approved, false);
      assert.ok(completed.error.includes('timeout'));
    });
  });
});
