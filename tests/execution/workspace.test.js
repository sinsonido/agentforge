import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceManager } from '../../src/execution/workspace.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

describe('createWorkspaceManager', () => {
  let tmp, upstream, stateDir, ws, repo;
  const savedEnv = { ...process.env };

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'af-workspace-'));
    const emptyConfig = join(tmp, 'gitconfig');
    writeFileSync(emptyConfig, '');
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    });

    upstream = join(tmp, 'upstream.git');
    git(tmp, 'init', '--bare', '--initial-branch=master', upstream);
    const seed = join(tmp, 'seed');
    git(tmp, 'clone', upstream, seed);
    writeFileSync(join(seed, 'README.md'), 'hello\n');
    git(seed, 'add', 'README.md');
    git(seed, 'commit', '-m', 'initial');
    git(seed, 'push', 'origin', 'HEAD:master');

    stateDir = join(tmp, 'state');
    ws = createWorkspaceManager({ stateDir });
    repo = { slug: 'acme/widget', url: upstream };
  });

  after(() => {
    process.env = savedEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('clones the task repo on agentforge/<taskId> with origin at the local mirror', async () => {
    const { dir, home, branch } = await ws.prepare({ taskId: 't1', repo, base: 'master' });

    assert.equal(dir, join(stateDir, 'tasks', 't1', 'repo'));
    assert.equal(home, join(stateDir, 'tasks', 't1', 'home'));
    assert.ok(existsSync(home));
    assert.equal(branch, 'agentforge/t1');
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agentforge/t1');
    assert.equal(git(dir, 'remote', 'get-url', 'origin'), join(stateDir, 'mirrors', 'acme__widget.git'));
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'initial');
  });

  it('reports no evidence before the agent commits', async () => {
    const dir = join(stateDir, 'tasks', 't1', 'repo');
    assert.deepEqual(await ws.evidence(dir, 'master'), []);
  });

  it('lists commits ahead of base as evidence, oldest first', async () => {
    const dir = join(stateDir, 'tasks', 't1', 'repo');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-m', 'feat: add a');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', 'b.txt');
    git(dir, 'commit', '-m', 'feat: add b');

    const commits = await ws.evidence(dir, 'master');

    assert.deepEqual(commits.map((c) => c.subject), ['feat: add a', 'feat: add b']);
    assert.equal(commits[1].sha, git(dir, 'rev-parse', 'HEAD'));
  });

  it('resumes the existing clone on a second prepare and keeps its commits', async () => {
    const { dir } = await ws.prepare({ taskId: 't1', repo, base: 'master' });

    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agentforge/t1');
    assert.equal((await ws.evidence(dir, 'master')).length, 2);
  });

  it('replaces a clone left without its branch by a crashed prepare', async () => {
    const { dir } = await ws.prepare({ taskId: 't2', repo, base: 'master' });
    git(dir, 'checkout', '--detach');
    git(dir, 'branch', '-D', 'agentforge/t2');

    const again = await ws.prepare({ taskId: 't2', repo, base: 'master' });

    assert.equal(git(again.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agentforge/t2');
  });

  it('fetches new upstream commits into the mirror before preparing', async () => {
    const seed = join(tmp, 'seed');
    writeFileSync(join(seed, 'README.md'), 'updated\n');
    git(seed, 'commit', '-am', 'upstream change');
    git(seed, 'push', 'origin', 'HEAD:master');

    const { dir } = await ws.prepare({ taskId: 't3', repo, base: 'master' });

    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'upstream change');
  });

  it('removes the task directory on cleanup and treats a missing one as done', async () => {
    await ws.cleanup('t1');
    assert.equal(existsSync(join(stateDir, 'tasks', 't1')), false);
    await ws.cleanup('t1');
    await ws.cleanup('never-prepared');
  });

  it('rejects a taskId that could escape the state directory', async () => {
    await assert.rejects(ws.prepare({ taskId: '../x', repo, base: 'master' }), /invalid taskId/);
    await assert.rejects(ws.cleanup('../x'), /invalid taskId/);
  });
});
