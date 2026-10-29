import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/execution/coding-executor.js';
import { publish } from '../../src/execution/publish.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { AgentForgeDB } from '../../src/persistence/db.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

/**
 * One GitHub repo shared by every instance in a test: real pushes go to a bare
 * repo on disk, PRs live in memory with their head branch and state.
 */
function sharedGitHub(bare, prs = []) {
  const state = { prs: [...prs] };
  const run = async (cmd, args, opts = {}) => {
    if (cmd === 'git') {
      const mapped = args.map((a) => (a.startsWith('https://github.com/') ? bare : a));
      return execFileSync('git', mapped, { cwd: opts.cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    }
    const head = args[args.indexOf('--head') + 1];
    if (args[1] === 'list') {
      return JSON.stringify(state.prs.filter((p) => p.head === head).map(({ url, state: s }) => ({ url, state: s })));
    }
    if (args[1] === 'create') {
      const url = `https://github.com/acme/widget/pull/${300 + state.prs.length}`;
      state.prs.push({ url, head, state: 'OPEN' });
      return url;
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, state };
}

describe('names shared by every instance on one repo and one docker daemon', () => {
  let tmp, upstream, docker, calls;
  const savedEnv = { ...process.env };

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'af-names-'));
    const emptyConfig = join(tmp, 'gitconfig');
    writeFileSync(emptyConfig, '');
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
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

    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    docker = join(bin, 'docker');
    copyFileSync(join(fixtures, 'fake-docker.mjs'), docker);
    chmodSync(docker, 0o755);
    calls = join(bin, 'calls.jsonl');
    writeFileSync(join(bin, 'fake-docker.json'), JSON.stringify({ mode: 'replay', stream: join(fixtures, 'agent-streams', 'no-commit.jsonl') }));
  });

  after(() => {
    process.env = savedEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  const dockerRuns = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((c) => c.args?.[0] === 'run').map((c) => c.args);

  function instance(name) {
    const db = new AgentForgeDB(join(tmp, name, 'data.db'));
    const queue = new TaskQueue({ store: db });
    const { task } = queue.admit({
      kind: 'coding', title: `Fix from ${name}`, repo: 'acme/widget', base: 'master',
      instruction: 'Fix it', issue: 7, playbook: 'bug-fix', setup_command: 'npm ci', test_command: 'npm test',
    });
    const opts = {
      stateDir: join(tmp, name, 'state'), pstackDir: join(fixtures, 'pstack'), claudeBin: '/bin/claude',
      dockerBin: docker, repoUrl: upstream, oauthToken: 'tok', eventBus: new EventEmitter(), instance: name,
    };
    return { db, queue, task, opts };
  }

  async function runAndPublish({ queue, task, opts }, gh) {
    const result = await run(task, opts);
    queue.updateStatus(task.id, 'executing');
    const verdict = { pass: true, cancelled: false, commits: result.commits, testRun: null };
    const url = await publish({ task: queue.get(task.id), clone: { dir: result.dir }, verdict, queue, run: gh.run });
    return { result, url };
  }

  it('two instances with fresh DBs each open their own PR on their own branch and container', async () => {
    writeFileSync(calls, '');
    const a = instance('af-a');
    const b = instance('af-b');
    assert.equal(a.task.id, b.task.id, 'both fresh DBs start at the same task id');

    const gh = sharedGitHub(upstream);
    const ra = await runAndPublish(a, gh);
    const rb = await runAndPublish(b, gh);

    assert.notEqual(ra.result.branch, rb.result.branch);
    assert.notEqual(ra.url, rb.url);
    assert.equal(gh.state.prs.length, 2);
    assert.equal(git(upstream, 'rev-parse', `refs/heads/${ra.result.branch}`), ra.result.commits.at(-1).sha, 'A keeps its branch');
    assert.equal(git(upstream, 'rev-parse', `refs/heads/${rb.result.branch}`), rb.result.commits.at(-1).sha, 'B keeps its branch');

    const [runA, runB] = dockerRuns();
    const flag = (args, f) => args[args.indexOf(f) + 1];
    assert.notEqual(flag(runA, '--name'), flag(runB, '--name'));
    assert.ok(runA.includes('agentforge.instance=af-a'), 'A labels its container with its instance');
    assert.ok(runB.includes('agentforge.instance=af-b'), 'B labels its container with its instance');
    a.db.close();
    b.db.close();
  });

  it('never adopts a merged PR or overwrites a remote branch someone else pushed', async () => {
    const c = instance('af-c');
    const first = await run(c.task, c.opts);
    const foreign = join(tmp, 'foreign');
    git(tmp, 'clone', upstream, foreign);
    writeFileSync(join(foreign, 'other.txt'), 'someone else\n');
    git(foreign, 'add', 'other.txt');
    git(foreign, 'commit', '-m', 'feat: someone else');
    git(foreign, 'push', '--force', 'origin', `HEAD:refs/heads/${first.branch}`);
    const foreignSha = git(foreign, 'rev-parse', 'HEAD');
    const gh = sharedGitHub(upstream, [{ url: 'https://github.com/acme/widget/pull/258', head: first.branch, state: 'MERGED' }]);

    c.queue.updateStatus(c.task.id, 'executing');
    const verdict = { pass: true, cancelled: false, commits: first.commits, testRun: null };
    await assert.rejects(
      publish({ task: c.queue.get(c.task.id), clone: { dir: first.dir }, verdict, queue: c.queue, run: gh.run }),
      /refusing/,
    );
    assert.equal(git(upstream, 'rev-parse', `refs/heads/${first.branch}`), foreignSha, 'the foreign branch is untouched');
    assert.equal(c.queue.get(c.task.id).pr_url, null, 'the merged PR is not adopted');
    c.db.close();
  });

  it('two coding tasks on one repo started at once both get a clone (#280)', async () => {
    const stateDir = join(tmp, 'concurrent', 'state');
    const opts = {
      stateDir, pstackDir: join(fixtures, 'pstack'), claudeBin: '/bin/claude',
      dockerBin: docker, repoUrl: upstream, oauthToken: 'tok', eventBus: new EventEmitter(), instance: 'af-d',
    };
    const queue = new TaskQueue();
    const tasks = [1, 2].map((n) => queue.admit({
      kind: 'coding', title: `Task ${n}`, repo: 'acme/widget', base: 'master',
      instruction: 'Fix it', issue: n, playbook: 'bug-fix', setup_command: 'npm ci', test_command: 'npm test',
    }).task);

    const results = await Promise.all(tasks.map((t) => run(t, opts)));
    for (const r of results) assert.equal(r.outcome, 'stopped');
    assert.notEqual(results[0].dir, results[1].dir);
  });
});
