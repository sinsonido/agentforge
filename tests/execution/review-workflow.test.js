import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewWorkflow } from '../../src/execution/review-workflow.js';
import eventBus from '../../src/core/event-bus.js';

describe('ReviewWorkflow', () => {
  let workflow;
  let mockTaskQueue;
  let mockComm;
  let agents;

  beforeEach(() => {
    mockTaskQueue = {};
    mockComm = {
      calls: [],
      async ask(fromId, toId, question, opts) {
        this.calls.push({ fromId, toId, question, opts });
        return this._response || 'APPROVE looks good';
      },
    };
    agents = {
      'developer': { require_review: true, reviewer: 'reviewer' },
      'reviewer': { require_review: false, reviewer: null },
      'solo': { require_review: false },
    };
    workflow = new ReviewWorkflow({ taskQueue: mockTaskQueue, interAgentComm: mockComm, agents });
  });

  describe('needsReview()', () => {
    it('returns true when agent has require_review and reviewer', () => {
      const task = { agent_id: 'developer' };
      assert.equal(workflow.needsReview(task), true);
    });

    it('returns false when agent has require_review but no reviewer', () => {
      agents['dev2'] = { require_review: true, reviewer: null };
      assert.equal(workflow.needsReview({ agent_id: 'dev2' }), false);
    });

    it('returns false when require_review is false', () => {
      assert.equal(workflow.needsReview({ agent_id: 'solo' }), false);
    });

    it('returns false when agent is not in agents map', () => {
      assert.equal(workflow.needsReview({ agent_id: 'unknown' }), false);
    });

    it('returns false when task has no agent_id', () => {
      assert.equal(workflow.needsReview({}), false);
    });
  });

  describe('submitForReview()', () => {
    it('returns approved:true when response does not include "reject"', async () => {
      mockComm._response = 'APPROVE everything looks good';
      const task = { id: 't1', agent_id: 'developer', title: 'Task 1', type: 'implement', model_used: 'claude', result: 'result text' };
      const result = await workflow.submitForReview(task);
      assert.equal(result.approved, true);
      assert.equal(result.feedback, 'APPROVE everything looks good');
    });

    it('returns approved:false when response includes "reject"', async () => {
      mockComm._response = 'REJECT the code has issues';
      const task = { id: 't2', agent_id: 'developer', title: 'Task 2', type: 'implement', model_used: 'claude', result: 'bad result' };
      const result = await workflow.submitForReview(task);
      assert.equal(result.approved, false);
    });

    it('is case-insensitive when checking for reject', async () => {
      mockComm._response = 'I must REJECT this submission';
      const task = { id: 't3', agent_id: 'developer', title: 'T', type: 'test', model_used: 'claude', result: 'x' };
      const result = await workflow.submitForReview(task);
      assert.equal(result.approved, false);
    });

    it('calls interAgentComm.ask with reviewer as target', async () => {
      const task = { id: 't4', agent_id: 'developer', title: 'Fix bug', type: 'implement', model_used: 'claude', result: 'done' };
      await workflow.submitForReview(task);
      assert.equal(mockComm.calls.length, 1);
      assert.equal(mockComm.calls[0].fromId, 'developer');
      assert.equal(mockComm.calls[0].toId, 'reviewer');
      assert.equal(mockComm.calls[0].opts.type, 'review');
      assert.equal(mockComm.calls[0].opts.priority, 'high');
    });

    it('returns approved:true and skips comm when no reviewer configured', async () => {
      const task = { id: 't5', agent_id: 'solo', title: 'T', type: 'test', model_used: 'claude', result: '' };
      const result = await workflow.submitForReview(task);
      assert.equal(result.approved, true);
      assert.equal(mockComm.calls.length, 0);
    });

    it('returns approved:false when comm.ask throws', async () => {
      mockComm.ask = async () => { throw new Error('timeout'); };
      const task = { id: 't6', agent_id: 'developer', title: 'T', type: 'test', model_used: 'claude', result: '' };
      const result = await workflow.submitForReview(task);
      assert.equal(result.approved, false);
      assert.match(result.feedback, /timeout/);
    });

    it('emits review.submitted event', async () => {
      const events = [];
      eventBus.on('review.submitted', e => events.push(e));

      const task = { id: 't7', agent_id: 'developer', title: 'T', type: 'test', model_used: 'claude', result: '' };
      await workflow.submitForReview(task);

      assert.equal(events.length, 1);
      assert.equal(events[0].task_id, 't7');
      assert.equal(events[0].reviewer, 'reviewer');

      eventBus.removeAllListeners('review.submitted');
    });

    it('emits review.completed event with approved status', async () => {
      const events = [];
      eventBus.on('review.completed', e => events.push(e));

      mockComm._response = 'APPROVE';
      const task = { id: 't8', agent_id: 'developer', title: 'T', type: 'test', model_used: 'claude', result: '' };
      await workflow.submitForReview(task);

      assert.equal(events.length, 1);
      assert.equal(events[0].task_id, 't8');
      assert.equal(events[0].approved, true);

      eventBus.removeAllListeners('review.completed');
    });
  });

  describe('_buildReviewPrompt()', () => {
    it('includes task title, type, model, and result', () => {
      const task = { id: 'x', title: 'My Task', type: 'implement', model_used: 'claude-opus', result: 'The output' };
      const prompt = workflow._buildReviewPrompt(task);
      assert.ok(prompt.includes('My Task'));
      assert.ok(prompt.includes('implement'));
      assert.ok(prompt.includes('claude-opus'));
      assert.ok(prompt.includes('The output'));
    });

    it('falls back to "(no result)" when result is absent', () => {
      const task = { id: 'x', title: 'T', type: 'test', model_used: 'claude' };
      const prompt = workflow._buildReviewPrompt(task);
      assert.ok(prompt.includes('(no result)'));
    });

    it('truncates result to 2000 characters', () => {
      const longResult = 'x'.repeat(5000);
      const task = { id: 'x', title: 'T', type: 'test', model_used: 'claude', result: longResult };
      const prompt = workflow._buildReviewPrompt(task);
      // The truncated result in the prompt should include exactly the first 2000 characters of the result
      const first2000 = longResult.slice(0, 2000);
      const rest = longResult.slice(2000);
      assert.ok(prompt.includes(first2000));
      assert.ok(!prompt.includes(rest));
    });

    it('instructs reviewer to reply APPROVE or REJECT', () => {
      const task = { id: 'x', title: 'T', type: 'test', model_used: 'claude', result: 'r' };
      const prompt = workflow._buildReviewPrompt(task);
      assert.ok(prompt.includes('APPROVE') && prompt.includes('REJECT'));
    });
  });
});
