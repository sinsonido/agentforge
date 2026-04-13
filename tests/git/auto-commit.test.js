import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AutoCommit } from '../../src/git/auto-commit.js';
import eventBus from '../../src/core/event-bus.js';

/** Build a minimal fake GitManager */
function makeGit({ hasChanges = true, sha = 'abc1234', branch = 'main' } = {}) {
  return {
    hasUncommittedChanges: () => hasChanges,
    commit: mock.fn(async () => (hasChanges ? sha : null)),
    getCurrentBranch: () => branch,
  };
}

describe('AutoCommit', () => {
  let git;

  beforeEach(() => {
    git = makeGit();
  });

  describe('constructor', () => {
    it('uses default commit format when none provided', () => {
      const ac = new AutoCommit({ gitManager: git });
      assert.ok(ac.commitFormat.includes('{task_id}'));
    });

    it('accepts a custom commit format', () => {
      const ac = new AutoCommit({ gitManager: git, config: { commit_format: 'custom: {task_title}' } });
      assert.equal(ac.commitFormat, 'custom: {task_title}');
    });

    it('is enabled by default', () => {
      const ac = new AutoCommit({ gitManager: git });
      assert.equal(ac.enabled, true);
    });

    it('can be disabled via config', () => {
      const ac = new AutoCommit({ gitManager: git, config: { auto_commit: false } });
      assert.equal(ac.enabled, false);
    });
  });

  describe('formatMessage()', () => {
    let ac;

    beforeEach(() => {
      ac = new AutoCommit({ gitManager: git });
    });

    it('replaces {task_id}', () => {
      const msg = ac.formatMessage({ id: 'T-42', title: 'Update API', type: 'implement' });
      assert.ok(msg.includes('T-42'));
    });

    it('replaces {task_title} and truncates to 72 characters', () => {
      const longTitle = 'A'.repeat(100);
      const msg = ac.formatMessage({ id: 'T-1', title: longTitle, type: 'implement' });
      const titlePart = msg.match(/\[AgentForge\] (.+) \(#/)?.[1] ?? '';
      assert.ok(titlePart.length <= 72);
    });

    it('replaces {task_type}', () => {
      const ac2 = new AutoCommit({
        gitManager: git,
        config: { commit_format: '{task_type}: {task_title}' },
      });
      const msg = ac2.formatMessage({ id: 'T-1', title: 'My task', type: 'review' });
      assert.ok(msg.startsWith('review:'));
    });

    it('replaces {tier}', () => {
      const ac2 = new AutoCommit({
        gitManager: git,
        config: { commit_format: 'tier={tier}' },
      });
      const msg = ac2.formatMessage({ id: 'T-1', title: 't', type: 'implement' }, { tier: 'T2' });
      assert.equal(msg, 'tier=T2');
    });

    it('uses ? for unknown tier', () => {
      const ac2 = new AutoCommit({
        gitManager: git,
        config: { commit_format: 'tier={tier}' },
      });
      const msg = ac2.formatMessage({ id: 'T-1', title: 't', type: 'implement' });
      assert.equal(msg, 'tier=?');
    });

    it('replaces {agent_id}', () => {
      const ac2 = new AutoCommit({
        gitManager: git,
        config: { commit_format: 'agent={agent_id}' },
      });
      const msg = ac2.formatMessage({ id: 'T-1', title: 't', type: 'implement', agent_id: 'developer' });
      assert.equal(msg, 'agent=developer');
    });

    it('defaults agent to "agent" when not set', () => {
      const ac2 = new AutoCommit({
        gitManager: git,
        config: { commit_format: 'agent={agent_id}' },
      });
      const msg = ac2.formatMessage({ id: 'T-1', title: 't', type: 'implement' });
      assert.equal(msg, 'agent=agent');
    });
  });

  describe('commitTask()', () => {
    it('returns null when disabled', async () => {
      const ac = new AutoCommit({ gitManager: git, config: { auto_commit: false } });
      const sha = await ac.commitTask({ id: 'T-1', title: 'task' });
      assert.equal(sha, null);
    });

    it('returns null when there are no uncommitted changes', async () => {
      const noChangeGit = makeGit({ hasChanges: false });
      const ac = new AutoCommit({ gitManager: noChangeGit });
      const sha = await ac.commitTask({ id: 'T-1', title: 'task' });
      assert.equal(sha, null);
    });

    it('calls git.commit with formatted message', async () => {
      const ac = new AutoCommit({ gitManager: git });
      await ac.commitTask({ id: 'T-42', title: 'Deploy feature', type: 'implement' });
      assert.equal(git.commit.mock.calls.length, 1);
      const msg = git.commit.mock.calls[0].arguments[0];
      assert.ok(msg.includes('T-42'));
      assert.ok(msg.includes('Deploy feature'));
    });

    it('returns the SHA from git.commit', async () => {
      const ac = new AutoCommit({ gitManager: git });
      const sha = await ac.commitTask({ id: 'T-1', title: 'task' });
      assert.equal(sha, 'abc1234');
    });

    it('emits git.committed event with task_id, sha, message and branch', async () => {
      let emitted = null;
      eventBus.once('git.committed', (data) => { emitted = data; });

      const ac = new AutoCommit({ gitManager: git });
      await ac.commitTask({ id: 'T-99', title: 'Ship it', type: 'implement' });

      assert.ok(emitted);
      assert.equal(emitted.task_id, 'T-99');
      assert.equal(emitted.sha, 'abc1234');
      assert.equal(emitted.branch, 'main');
      assert.ok(typeof emitted.message === 'string');
    });

    it('does not emit event when git.commit returns null (nothing staged)', async () => {
      let emitted = false;
      eventBus.once('git.committed', () => { emitted = true; });

      // git.commit resolves to null — simulate "nothing to commit"
      const nullGit = {
        hasUncommittedChanges: () => true,
        commit: mock.fn(async () => null),
        getCurrentBranch: () => 'main',
      };
      const ac = new AutoCommit({ gitManager: nullGit });
      await ac.commitTask({ id: 'T-1', title: 'task' });

      assert.equal(emitted, false);
    });
  });
});
