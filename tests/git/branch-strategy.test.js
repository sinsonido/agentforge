import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BranchStrategy } from '../../src/git/branch-strategy.js';

/** Minimal fake GitManager */
function makeGit({ currentBranch = 'master' } = {}) {
  return {
    getCurrentBranch: () => currentBranch,
    checkout: mock.fn(async () => {}),
    createBranch: mock.fn(async (name) => name),
    _run: mock.fn(() => ''),
  };
}

describe('BranchStrategy', () => {
  describe('constructor', () => {
    it('uses default pattern when none provided', () => {
      const bs = new BranchStrategy();
      assert.equal(bs.pattern, 'agent/{agent_name}/{task_id}');
    });

    it('accepts custom pattern', () => {
      const bs = new BranchStrategy({ branch_pattern: 'task/{task_id}' });
      assert.equal(bs.pattern, 'task/{task_id}');
    });

    it('defaults base_branch to main', () => {
      const bs = new BranchStrategy();
      assert.equal(bs.baseBranch, 'main');
    });

    it('accepts custom base_branch', () => {
      const bs = new BranchStrategy({ base_branch: 'develop' });
      assert.equal(bs.baseBranch, 'develop');
    });

    it('is enabled by default', () => {
      const bs = new BranchStrategy();
      assert.equal(bs.enabled, true);
    });

    it('can be disabled via config', () => {
      const bs = new BranchStrategy({ auto_branch: false });
      assert.equal(bs.enabled, false);
    });
  });

  describe('branchFor()', () => {
    let bs;

    beforeEach(() => {
      bs = new BranchStrategy();
    });

    it('fills {agent_name} from agent.id', () => {
      const branch = bs.branchFor({ id: 'developer' }, { id: 'T-42' });
      assert.ok(branch.includes('developer'));
    });

    it('fills {task_id} from task.id', () => {
      const branch = bs.branchFor({ id: 'dev' }, { id: 'T-99' });
      assert.ok(branch.includes('t-99'));
    });

    it('lowercases the entire branch name', () => {
      const branch = bs.branchFor({ id: 'Dev' }, { id: 'TASK-1' });
      assert.equal(branch, branch.toLowerCase());
    });

    it('replaces spaces in agent name with hyphens', () => {
      const branch = bs.branchFor({ id: 'senior dev' }, { id: 'T-1' });
      assert.ok(!branch.includes(' '));
      assert.ok(branch.includes('senior-dev'));
    });

    it('strips invalid characters', () => {
      const branch = bs.branchFor({ id: 'dev@corp' }, { id: 'T-1' });
      // @ is not in [a-z0-9\-/] — should be replaced with -
      assert.ok(!branch.includes('@'));
    });

    it('collapses consecutive hyphens', () => {
      const branch = bs.branchFor({ id: 'dev--corp' }, { id: 'T-1' });
      assert.ok(!branch.includes('--'));
    });

    it('removes trailing slash', () => {
      const bs2 = new BranchStrategy({ branch_pattern: 'tasks/{task_type}/' });
      const branch = bs2.branchFor({ id: 'dev' }, { id: 'T-1', type: 'review' });
      assert.ok(!branch.endsWith('/'));
    });

    it('fills {task_type} from task.type', () => {
      const bs2 = new BranchStrategy({ branch_pattern: 'work/{task_type}/{task_id}' });
      const branch = bs2.branchFor({ id: 'dev' }, { id: 'T-1', type: 'review' });
      assert.ok(branch.includes('review'));
    });

    it('falls back to agent.name when agent.id is absent', () => {
      const branch = bs.branchFor({ name: 'My Agent' }, { id: 'T-5' });
      assert.ok(branch.includes('my-agent'));
    });
  });

  describe('ensureBranch()', () => {
    it('returns the current branch when strategy is disabled', async () => {
      const bs = new BranchStrategy({ auto_branch: false });
      const git = makeGit({ currentBranch: 'feature-x' });
      const result = await bs.ensureBranch(git, { id: 'dev' }, { id: 'T-1' });
      assert.equal(result, 'feature-x');
    });

    it('returns branch name without calling checkout when already on correct branch', async () => {
      const agent = { id: 'developer' };
      const task = { id: 'T-1' };
      const bs = new BranchStrategy();
      const expectedBranch = bs.branchFor(agent, task);
      const git = makeGit({ currentBranch: expectedBranch });

      const result = await bs.ensureBranch(git, agent, task);
      assert.equal(result, expectedBranch);
      assert.equal(git.checkout.mock.calls.length, 0);
      assert.equal(git.createBranch.mock.calls.length, 0);
    });

    it('checks out existing branch when it already exists', async () => {
      const bs = new BranchStrategy();
      const agent = { id: 'dev' };
      const task = { id: 'T-5' };
      const expectedBranch = bs.branchFor(agent, task);

      const git = makeGit({ currentBranch: 'master' });
      // _run succeeds → branch exists
      git._run = mock.fn(() => 'refs/heads/' + expectedBranch);

      const result = await bs.ensureBranch(git, agent, task);
      assert.equal(result, expectedBranch);
      assert.equal(git.checkout.mock.calls.length, 1);
      assert.equal(git.checkout.mock.calls[0].arguments[0], expectedBranch);
    });

    it('creates a new branch when it does not exist', async () => {
      const bs = new BranchStrategy();
      const agent = { id: 'dev' };
      const task = { id: 'T-6' };
      const expectedBranch = bs.branchFor(agent, task);

      const git = makeGit({ currentBranch: 'master' });
      // _run throws → branch does not exist
      git._run = mock.fn(() => { throw new Error('no ref'); });

      const result = await bs.ensureBranch(git, agent, task);
      assert.equal(result, expectedBranch);
      assert.equal(git.createBranch.mock.calls.length, 1);
      assert.equal(git.createBranch.mock.calls[0].arguments[0], expectedBranch);
    });
  });
});
