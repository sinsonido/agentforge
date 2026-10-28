import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../../src/execution/publish.js';
import { TaskQueue } from '../../src/core/task-queue.js';

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const BRANCH = 'agentforge/t1';
const REMOTE = 'https://github.com/acme/app.git';

function fakeGitHub({ remoteSha = '', prs = [] } = {}) {
  const calls = [];
  const state = { remoteSha, prs: [...prs] };
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const sub = `${cmd} ${args[0]}${cmd === 'gh' ? ` ${args[1]}` : ''}`;
    switch (sub) {
      case 'git ls-remote':
        return state.remoteSha ? `${state.remoteSha}\trefs/heads/${BRANCH}` : '';
      case 'git push':
        state.remoteSha = args.at(-1).split(':')[0];
        return '';
      case 'gh pr list':
        return JSON.stringify(state.prs.map((url) => ({ url })));
      case 'gh pr create': {
        const url = `https://github.com/acme/app/pull/${100 + state.prs.length}`;
        state.prs.push(url);
        return `Creating pull request for ${BRANCH} into master in acme/app\n\n${url}`;
      }
      default:
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    }
  };
  return { run, calls, state };
}

const flag = (args, name) => args[args.indexOf(name) + 1];

describe('publish', () => {
  let queue;
  let task;
  const clone = { dir: '/state/tasks/t1/repo' };
  const verdict = {
    pass: true,
    cancelled: false,
    commits: [{ sha: SHA1, subject: 'fix: first' }, { sha: SHA2, subject: 'test: second' }],
    testRun: { command: 'npm test', sha: SHA2, counts: { pass: 377, fail: 0 } },
  };

  beforeEach(() => {
    queue = new TaskQueue();
    task = queue.admit({
      kind: 'coding', title: 'Fix the parser', repo: 'acme/app', base: 'master',
      instruction: 'Fix it', issue: 42, playbook: 'bug-fix',
    }).task;
    queue.updateStatus(task.id, 'completed', { cost: 1.234, tokens_in: 1200, tokens_out: 340 });
  });

  it('pushes the last checked commit to GitHub and opens a PR that closes the issue', async () => {
    const gh = fakeGitHub();
    const url = await publish({ task, clone, verdict, queue, run: gh.run });

    assert.equal(url, 'https://github.com/acme/app/pull/100');
    assert.equal(queue.get('t1').pr_url, url, 'PR URL stored on the task');
    assert.equal(gh.state.remoteSha, SHA2);

    const push = gh.calls.find((c) => c.args[0] === 'push');
    assert.deepEqual(push.args.slice(-2), [REMOTE, `${SHA2}:refs/heads/${BRANCH}`]);
    assert.equal(push.cwd, clone.dir);

    const create = gh.calls.find((c) => c.args[1] === 'create').args;
    assert.equal(flag(create, '--repo'), 'acme/app');
    assert.equal(flag(create, '--base'), 'master');
    assert.equal(flag(create, '--head'), BRANCH);
    assert.equal(flag(create, '--title'), 'Fix the parser');
    const body = flag(create, '--body');
    assert.match(body, /^Closes #42\n/);
    assert.match(body, /`bug-fix` playbook/);
    assert.match(body, /- aaaaaaa fix: first\n- bbbbbbb test: second/);
    assert.match(body, /## Tests\n`npm test` passed after bbbbbbb: 377 passed, 0 failed\.\n/);
    assert.match(body, /\$1\.23, 1200 tokens in, 340 tokens out/);
  });

  it('ends the PR body with a footer that names AgentForge and the task', async () => {
    const gh = fakeGitHub();
    await publish({ task, clone, verdict, queue, run: gh.run });
    const body = flag(gh.calls.find((c) => c.args[1] === 'create').args, '--body');
    assert.match(body, /\n---\nOpened by AgentForge for task `t1`\.$/);
  });

  it('omits Closes when the task has no issue', async () => {
    const gh = fakeGitHub();
    await publish({ task: { ...task, issue: null }, clone, verdict, queue, run: gh.run });
    const body = flag(gh.calls.find((c) => c.args[1] === 'create').args, '--body');
    assert.doesNotMatch(body, /Closes/);
  });

  it('returns the existing PR and skips the push when GitHub already has both', async () => {
    const gh = fakeGitHub({ remoteSha: SHA2, prs: ['https://github.com/acme/app/pull/7'] });
    const url = await publish({ task, clone, verdict, queue, run: gh.run });

    assert.equal(url, 'https://github.com/acme/app/pull/7');
    assert.equal(queue.get('t1').pr_url, url);
    assert.deepEqual(gh.calls.map((c) => `${c.cmd} ${c.args[0]} ${c.args[1]}`), [
      `git ls-remote ${REMOTE}`,
      'gh pr list',
    ]);
  });

  it('opens exactly one PR when called twice', async () => {
    const gh = fakeGitHub();
    const first = await publish({ task, clone, verdict, queue, run: gh.run });
    const second = await publish({ task, clone, verdict, queue, run: gh.run });
    assert.equal(second, first);
    assert.equal(gh.calls.filter((c) => c.args[1] === 'create').length, 1);
    assert.equal(gh.calls.filter((c) => c.args[0] === 'push').length, 1);
  });

  it('leases the push on the remote SHA it saw when the branch moved', async () => {
    const gh = fakeGitHub({ remoteSha: SHA1 });
    await publish({ task, clone, verdict, queue, run: gh.run });
    const push = gh.calls.find((c) => c.args[0] === 'push');
    assert.equal(push.args[1], `--force-with-lease=refs/heads/${BRANCH}:${SHA1}`);
    assert.equal(gh.state.remoteSha, SHA2);
  });

  for (const [name, bad, pattern] of [
    ['a failed gate', { pass: false }, /did not pass/],
    ['a cancelled run', { cancelled: true }, /cancelled/],
    ['a run that does not say it was not cancelled', { cancelled: undefined }, /cancelled/],
    ['a run with no commits', { commits: [] }, /no commits/],
  ]) {
    it(`refuses ${name} without touching git or gh`, async () => {
      const gh = fakeGitHub();
      await assert.rejects(publish({ task, clone, verdict: { ...verdict, ...bad }, queue, run: gh.run }), pattern);
      assert.equal(gh.calls.length, 0);
      assert.equal(queue.get('t1').pr_url, null);
    });
  }
});
