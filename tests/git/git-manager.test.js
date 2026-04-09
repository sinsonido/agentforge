import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GitManager } from '../../src/git/git-manager.js';
import eventBus from '../../src/core/event-bus.js';

describe('GitManager', () => {
  let gm;

  beforeEach(() => {
    gm = new GitManager({ remote: 'origin', base_branch: 'master' });
  });

  describe('constructor', () => {
    it('sets defaults', () => {
      const g = new GitManager();
      assert.equal(g.remote, 'origin');
      assert.equal(g.baseBranch, 'main');
    });

    it('accepts custom config', () => {
      const g = new GitManager({ remote: 'upstream', base_branch: 'develop' });
      assert.equal(g.remote, 'upstream');
      assert.equal(g.baseBranch, 'develop');
    });
  });

  describe('isGitRepo()', () => {
    it('returns true when _run succeeds', () => {
      mock.method(gm, '_run', () => '.git');
      assert.equal(gm.isGitRepo(), true);
    });

    it('returns false when _run throws', () => {
      mock.method(gm, '_run', () => { throw new Error('not a git repo'); });
      assert.equal(gm.isGitRepo(), false);
    });
  });

  describe('getCurrentBranch()', () => {
    it('returns the branch name from _run', () => {
      mock.method(gm, '_run', () => 'feature/my-branch');
      assert.equal(gm.getCurrentBranch(), 'feature/my-branch');
    });
  });

  describe('hasUncommittedChanges()', () => {
    it('returns true when status output is non-empty', () => {
      mock.method(gm, '_run', () => 'M  src/foo.js');
      assert.equal(gm.hasUncommittedChanges(), true);
    });

    it('returns false when status output is empty', () => {
      mock.method(gm, '_run', () => '');
      assert.equal(gm.hasUncommittedChanges(), false);
    });
  });

  describe('getModifiedFiles()', () => {
    it('parses modified file names from git status --porcelain', () => {
      mock.method(gm, '_run', () => ' M src/foo.js\n?? tests/bar.test.js');
      const files = gm.getModifiedFiles();
      assert.deepEqual(files, ['src/foo.js', 'tests/bar.test.js']);
    });

    it('returns empty array when no files are modified', () => {
      mock.method(gm, '_run', () => '');
      assert.deepEqual(gm.getModifiedFiles(), []);
    });
  });

  describe('getHeadSha()', () => {
    it('returns the SHA from _run', () => {
      mock.method(gm, '_run', () => 'abc1234def5678');
      assert.equal(gm.getHeadSha(), 'abc1234def5678');
    });
  });

  describe('getLog()', () => {
    it('passes correct n to git log', () => {
      const calls = [];
      mock.method(gm, '_run', (cmd) => { calls.push(cmd); return 'abc Fix bug'; });
      gm.getLog(5);
      assert.ok(calls[0].includes('-5'));
    });

    it('defaults to 10 entries', () => {
      const calls = [];
      mock.method(gm, '_run', (cmd) => { calls.push(cmd); return ''; });
      gm.getLog();
      assert.ok(calls[0].includes('-10'));
    });
  });

  describe('commit()', () => {
    it('returns null when there are no uncommitted changes', async () => {
      mock.method(gm, '_run', () => '');
      const sha = await gm.commit('some message');
      assert.equal(sha, null);
    });

    it('returns the short SHA after a successful commit', async () => {
      const calls = [];
      mock.method(gm, '_run', (cmd) => {
        calls.push(cmd);
        if (cmd.includes('status --porcelain')) return 'M  file.js';
        if (cmd.includes('rev-parse --short')) return 'abc1234';
        if (cmd.includes('rev-parse --abbrev-ref')) return 'master';
        return '';
      });

      const sha = await gm.commit('fix: update logic');
      assert.equal(sha, 'abc1234');
    });

    it('escapes double quotes in the commit message', async () => {
      const calls = [];
      mock.method(gm, '_run', (cmd) => {
        calls.push(cmd);
        if (cmd.includes('status --porcelain')) return 'M  file.js';
        if (cmd.includes('rev-parse --short')) return 'def5678';
        if (cmd.includes('rev-parse --abbrev-ref')) return 'master';
        return '';
      });

      await gm.commit('feat: say "hello world"');
      const commitCmd = calls.find(c => c.startsWith('commit -m'));
      assert.ok(commitCmd, 'commit -m command should be called');
      assert.ok(commitCmd.includes('\\"hello world\\"'), 'double quotes should be escaped');
    });

    it('escapes backslashes in the commit message (regression: fix(git))', async () => {
      const calls = [];
      mock.method(gm, '_run', (cmd) => {
        calls.push(cmd);
        if (cmd.includes('status --porcelain')) return 'M  file.js';
        if (cmd.includes('rev-parse --short')) return 'bcd1234';
        if (cmd.includes('rev-parse --abbrev-ref')) return 'master';
        return '';
      });

      await gm.commit('fix: path C:\\Users\\test');
      const commitCmd = calls.find(c => c.startsWith('commit -m'));
      assert.ok(commitCmd, 'commit -m command should be called');
      // Backslash must be doubled before double-quote escaping
      assert.ok(commitCmd.includes('C:\\\\Users\\\\test'), 'backslashes should be escaped');
    });

    it('escapes backslash immediately before a double quote', async () => {
      const calls = [];
      mock.method(gm, '_run', (cmd) => {
        calls.push(cmd);
        if (cmd.includes('status --porcelain')) return 'M  file.js';
        if (cmd.includes('rev-parse --short')) return 'cde1234';
        if (cmd.includes('rev-parse --abbrev-ref')) return 'master';
        return '';
      });

      // message: trailing backslash before quote: foo\"bar
      await gm.commit('msg: foo\\"bar');
      const commitCmd = calls.find(c => c.startsWith('commit -m'));
      assert.ok(commitCmd, 'commit -m command should be called');
      // The backslash should be doubled: \\ then the quote escaped: \"
      assert.ok(commitCmd.includes('\\\\'), 'backslash before quote should be escaped');
    });

    it('emits git.committed event with sha and branch', async () => {
      let emitted = null;
      eventBus.once('git.committed', (data) => { emitted = data; });

      mock.method(gm, '_run', (cmd) => {
        if (cmd.includes('status --porcelain')) return 'M  file.js';
        if (cmd.includes('rev-parse --short')) return 'fed4321';
        if (cmd.includes('rev-parse --abbrev-ref')) return 'feature-x';
        return '';
      });

      await gm.commit('chore: update deps');
      assert.ok(emitted);
      assert.equal(emitted.sha, 'fed4321');
      assert.equal(emitted.branch, 'feature-x');
      assert.equal(emitted.message, 'chore: update deps');
    });
  });

  describe('stageFiles()', () => {
    it('does nothing when given an empty list', async () => {
      const calls = [];
      mock.method(gm, '_run', (cmd) => { calls.push(cmd); return ''; });
      await gm.stageFiles([]);
      assert.equal(calls.length, 0);
    });

    it('calls git add with quoted file names', async () => {
      const calls = [];
      mock.method(gm, '_run', (cmd) => { calls.push(cmd); return ''; });
      await gm.stageFiles(['src/foo.js', 'src/bar.js']);
      assert.ok(calls[0].includes('"src/foo.js"'));
      assert.ok(calls[0].includes('"src/bar.js"'));
    });
  });

  describe('createBranch()', () => {
    it('creates branch from remote base branch', async () => {
      const calls = [];
      mock.method(gm, '_run', (cmd) => { calls.push(cmd); return ''; });
      const name = await gm.createBranch('feature/new');
      assert.equal(name, 'feature/new');
      assert.ok(calls[0].includes('checkout -b feature/new'));
    });

    it('falls back to current HEAD when remote branch is unavailable', async () => {
      const calls = [];
      let first = true;
      mock.method(gm, '_run', (cmd) => {
        calls.push(cmd);
        if (first) { first = false; throw new Error('no remote'); }
        return '';
      });
      const name = await gm.createBranch('feature/fallback');
      assert.equal(name, 'feature/fallback');
      assert.ok(calls[1].includes('checkout -b feature/fallback'));
    });
  });
});
