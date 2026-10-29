import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentForgeDB } from '../../src/persistence/db.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { run as runExecutor } from '../../src/execution/coding-executor.js';
import { runCodingTask } from '../../src/execution/coding-runner.js';
import { publish } from '../../src/execution/publish.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const DECISIONS = [
  'ts\tphase\tdecision\twhy\tevidence\tresult',
  '2026-10-29T09:00:00Z\treproduce\twrote a failing test for sum(2, 3)\tprove the bug before fixing it\ttest/sum.test.js\tfails as reported',
  '2026-10-29T09:05:00Z\tfix\tfixed the sign in sum\troot cause is a subtraction\tsrc/sum.js:2\ttests green',
].join('\n');

/**
 * One coding task end to end with the real executor on the fake docker, the real
 * queue on a real database, and the real publish against a fake GitHub.
 */
describe('decision trail of a coding task', () => {
  let tmp;
  let db;
  const savedEnv = { ...process.env };

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'af-trail-e2e-'));
    const emptyConfig = join(tmp, 'gitconfig');
    writeFileSync(emptyConfig, '');
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    db = new AgentForgeDB(join(tmp, 'data.db'));
  });

  after(() => {
    process.env = savedEnv;
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function runFixTask(name, fakeDocker) {
    const root = join(tmp, name);
    mkdirSync(root);
    const upstream = join(root, 'upstream.git');
    git(root, 'init', '--bare', '--initial-branch=master', upstream);
    const seed = join(root, 'seed');
    git(root, 'clone', upstream, seed);
    writeFileSync(join(seed, 'README.md'), 'hello\n');
    git(seed, 'add', 'README.md');
    git(seed, 'commit', '-m', 'initial');
    git(seed, 'push', 'origin', 'HEAD:master');

    const bin = join(root, 'bin');
    mkdirSync(bin);
    const docker = join(bin, 'docker');
    copyFileSync(join(fixtures, 'fake-docker.mjs'), docker);
    chmodSync(docker, 0o755);
    writeFileSync(join(bin, 'fake-docker.json'), JSON.stringify({ mode: 'replay', ...fakeDocker }));
    const credentialsFile = join(root, 'creds.json');
    writeFileSync(credentialsFile, '{}');

    const queue = new TaskQueue({ store: db });
    const task = queue.admit({
      kind: 'coding', title: 'Fix sum', repo: 'acme/widget', base: 'master', instruction: 'sum(2, 3) returns -1',
      issue: 7, playbook: 'bug-fix', setup_command: 'npm ci', test_command: 'npm test',
    }).task;
    const bus = new EventEmitter();
    let body = null;
    const gh = async (cmd, args) => {
      if (cmd === 'git') return '';
      if (args[1] === 'list') return '[]';
      body = args[args.indexOf('--body') + 1];
      return 'https://github.com/acme/widget/pull/9';
    };

    const status = await runCodingTask(task, {
      queue,
      eventBus: bus,
      execute: (t, opts) => runExecutor(t, {
        ...opts, stateDir: join(root, 'state'), pstackDir: join(fixtures, 'pstack'), claudeBin: '/bin/claude',
        dockerBin: docker, repoUrl: upstream, credentialsFile, eventBus: bus,
      }),
      publish: (opts) => publish({ ...opts, run: gh }),
    });
    return { status, task, body };
  }

  it('records status, steps, decisions, gates and evidence, serves them in order and attaches them to the PR', async () => {
    const { status, task, body } = await runFixTask('with-log', {
      stream: join(fixtures, 'agent-streams', 'two-commits.jsonl'), leave: { 'decisions.tsv': DECISIONS },
    });

    assert.equal(status, 'pr-opened');
    const trail = db.getTrail(task.id);
    assert.deepEqual(trail.map((e) => e.seq), trail.map((_, i) => i + 1), 'seq counts from 1 without gaps');
    const sha = trail.find((e) => e.kind === 'evidence').evidence.sha.slice(0, 7);
    assert.deepEqual(trail.map((e) => [e.kind, e.summary.replaceAll(sha, '<sha>')]), [
      ['status', 'queued'],
      ['status', 'queued → executing'],
      ['step', 'step 1: Reproduce it yourself'],
      ['step', 'step 5: Stage the commits so'],
      ['decision', 'skipped step 6: Run Opening a PR'],
      ['decision', 'wrote a failing test for sum(2, 3)'],
      ['decision', 'fixed the sign in sum'],
      ['gate', 'pass not cancelled: the run was not cancelled'],
      ['gate', 'pass commits ahead: 1 commit ahead of base'],
      ['gate', 'pass clean tree: no uncommitted tracked changes'],
      ['gate', 'pass tests after last edit: `npm test` passed after the last edit (314 passed, 0 failed)'],
      ['evidence', 'commit <sha> fix: the bug'],
      ['evidence', '`npm test` passed at <sha>'],
      ['evidence', 'PR https://github.com/acme/widget/pull/9'],
      ['status', 'executing → pr-opened'],
    ]);

    assert.match(body, /## Decision trail/);
    assert.match(body, /- pass clean tree: no uncommitted tracked changes/);
    assert.match(body, /- \*\*fix\*\* fixed the sign in sum\. Why: root cause is a subtraction\. Evidence: src\/sum\.js:2\. Result: tests green\./);
    assert.match(body, /- skipped step 6: Run Opening a PR\./);
    assert.match(body, /<details><summary>Full trail \(13 entries\)<\/summary>/);
  });

  it('publishes a run that left no decision log and says so in the PR body', async () => {
    const skip = 'toolu_01G66aMohEcCD8oqBwcGB7wg';
    const noSkip = join(tmp, 'no-skip.jsonl');
    writeFileSync(noSkip, readFileSync(join(fixtures, 'agent-streams', 'two-commits.jsonl'), 'utf8')
      .split('\n').filter((l) => !l.includes(skip)).join('\n'));

    const { status, task, body } = await runFixTask('without-log', { stream: noSkip });

    assert.equal(status, 'pr-opened');
    const trail = db.getTrail(task.id);
    assert.deepEqual(trail.filter((e) => e.kind === 'decision'), []);
    assert.ok(trail.filter((e) => e.kind === 'gate').every((e) => e.evidence.pass), 'every gate passes');
    assert.match(body, /\*\*Decisions\*\*\n\nThe agent left no decision log\./);
  });
});
