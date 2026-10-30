import { describe, it, beforeEach, afterEach } from 'node:test';
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
import { decideApproval, runCodingTask } from '../../src/execution/coding-runner.js';
import { merge, publish, pushFix } from '../../src/execution/publish.js';
import { ghCiReader } from '../../src/execution/babysit.js';
import { ghPrHead } from '../../src/execution/verify.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const GITHUB = 'https://github.com/acme/widget.git';
const PR = 'https://github.com/acme/widget/pull/9';
const REPORT = JSON.stringify({ lanes: [
  { name: 'tests', pass: true, evidence: 'npm test: 12 passed' },
  { name: 'review', pass: true, evidence: 'fix.txt does what the task asks' },
] });

/**
 * Verification end to end: the real executor builds on the fake docker, publish
 * pushes into a bare repository standing in for GitHub, CI is green, and then the
 * real executor verifies the PR head on a fresh clone in verify mode. The real
 * merge reads the head from a fake gh and merges only at a verified head.
 */
describe('verification verdict before merge, end to end', () => {
  let tmp;
  let db;
  let upstream;
  let docker;
  let bin;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'af-verify-e2e-'));
    const emptyConfig = join(tmp, 'gitconfig');
    writeFileSync(emptyConfig, '');
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    db = new AgentForgeDB(join(tmp, 'data.db'));

    upstream = join(tmp, 'upstream.git');
    git(tmp, 'init', '--bare', '--initial-branch=master', upstream);
    const seed = join(tmp, 'seed');
    git(tmp, 'clone', upstream, seed);
    writeFileSync(join(seed, 'README.md'), 'hello\n');
    git(seed, 'add', 'README.md');
    git(seed, 'commit', '-m', 'initial');
    git(seed, 'push', 'origin', 'HEAD:master');

    bin = join(tmp, 'bin');
    mkdirSync(bin);
    docker = join(bin, 'docker');
    copyFileSync(join(fixtures, 'fake-docker.mjs'), docker);
    chmodSync(docker, 0o755);
    writeFileSync(join(tmp, 'creds.json'), '{}');
  });

  afterEach(() => {
    process.env = savedEnv;
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function setup({ verifierCommits = false } = {}) {
    writeFileSync(join(bin, 'fake-docker.json'), JSON.stringify({
      mode: 'replay',
      stream: join(fixtures, 'agent-streams', 'two-commits.jsonl'),
      verify: { stream: join(fixtures, 'agent-streams', 'verify-pass.jsonl'), commit: verifierCommits, leave: { 'agentforge-verdict.json': REPORT } },
    }));
    const queue = new TaskQueue({ store: db });
    const task = queue.admit({
      kind: 'coding', title: 'Fix sum', repo: 'acme/widget', base: 'master', instruction: 'sum(2, 3) returns -1',
      issue: 7, playbook: 'bug-fix', setup_command: 'npm ci', test_command: 'npm test',
    }).task;
    const branch = `agentforge/${task.handle}`;
    const headOf = () => git(upstream, 'rev-parse', `refs/heads/${branch}`);
    const merges = [];
    const gh = async (cmd, args, opts = {}) => {
      if (cmd === 'git') return git(opts.cwd ?? tmp, ...args.map((a) => (a === GITHUB ? upstream : a)));
      const line = args.join(' ');
      if (line.startsWith('pr list')) return '[]';
      if (line.startsWith('pr create')) return PR;
      if (line.startsWith('pr view')) return JSON.stringify({ state: merges.length ? 'MERGED' : 'OPEN', headRefOid: headOf() });
      if (line.startsWith('pr checks')) return JSON.stringify([{ name: 'Tests', bucket: 'pass', link: null }]);
      if (line.startsWith('pr merge')) { merges.push(args); return ''; }
      throw new Error(`unexpected gh ${line}`);
    };
    const bus = new EventEmitter();
    const costs = [];
    bus.on('cost.recorded', (c) => costs.push(c));
    const executor = {
      stateDir: join(tmp, 'state'), pstackDir: join(fixtures, 'pstack'), claudeBin: '/bin/claude',
      dockerBin: docker, repoUrl: upstream, credentialsFile: join(tmp, 'creds.json'), eventBus: bus,
    };
    let t = 0;
    const deps = {
      queue,
      eventBus: bus,
      execute: (runTask, opts) => runExecutor(runTask, { ...executor, ...opts }),
      publish: (opts) => publish({ ...opts, run: gh }),
      pushFix: (opts) => pushFix({ ...opts, run: gh }),
      merge: (opts) => merge({ ...opts, run: gh }),
      verifier: {
        lanes: ['tests', 'review'],
        pr: ghPrHead({ run: gh }).pr,
        run: (runTask, { sha, signal }) => runExecutor(runTask, { ...executor, signal, verify: { sha, lanes: ['tests', 'review'], budgetUsd: 0.5 } }),
      },
      babysit: { ci: ghCiReader({ run: gh }), maxRounds: 2, timeoutMs: 3_600_000, now: () => t, wait: async (ms) => { t += ms; } },
    };
    const drive = async () => {
      let status = await runCodingTask(queue.get(task.id), deps);
      while (status === 'ci-watch') status = await runCodingTask(queue.get(task.id), deps);
      return status;
    };
    const approve = () => decideApproval(queue.get(task.id), { decision: 'approved', by: 'operator' }, deps);
    const dockerRuns = () => readFileSync(join(bin, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((c) => c.args?.[0] === 'run');
    return { queue, task, branch, headOf, merges, costs, drive, approve, dockerRuns };
  }

  it('verifies the green head on a fresh read-only clone, then merges only at that head', async () => {
    const { queue, task, branch, headOf, merges, costs, drive, approve, dockerRuns } = setup();

    assert.equal(await drive(), 'needs-approval');
    const published = headOf();
    const stored = queue.get(task.id);
    assert.equal(stored.approval.action, 'merge');
    assert.equal(stored.verification.head, published);
    const [verdict] = stored.verification.verdicts;
    assert.equal(verdict.sha, published);
    assert.equal(verdict.pass, true);
    assert.equal(verdict.error, null);
    assert.equal(verdict.cost_usd, 0.08);
    assert.deepEqual(verdict.lanes.map((l) => [l.name, l.pass]), [['tests', true], ['review', true]]);
    assert.match(verdict.lanes[0].evidence, /^`npm test` passed: 12 passed, 0 failed/);

    const verifyClone = join(tmp, 'state', 'tasks', `${task.id}-verify`, 'repo');
    assert.equal(git(verifyClone, 'rev-parse', 'HEAD'), published, 'the verifier ran at the exact head');
    assert.equal(git(verifyClone, 'status', '--porcelain', '--untracked-files=no'), '', 'and left it untouched');

    const [build, verifyRun] = dockerRuns();
    assert.equal(build.args[build.args.indexOf('--name') + 1], `af-task-${task.handle}`);
    assert.equal(verifyRun.args[verifyRun.args.indexOf('--name') + 1], `af-task-${task.handle}-verify`);
    assert.equal(verifyRun.args[verifyRun.args.indexOf('--max-budget-usd') + 1], '0.5');
    const prompt = verifyRun.args[verifyRun.args.indexOf('-p') + 1];
    assert.match(prompt, /^\/pstack:poteto-mode Verify a pull request with the \*\*Investigation\*\* playbook/);
    assert.ok(prompt.includes(`independent verifier of ${PR} at commit ${published}`));

    assert.deepEqual(costs.map((c) => [c.phase, c.cost, c.taskId]), [['verify', 0.08, task.id]], 'verification is its own cost tranche');
    const gates = db.getTrail(task.id).filter((e) => e.evidence?.gate === 'verify').map((e) => e.summary);
    assert.deepEqual(gates.map((g) => g.replace(published.slice(0, 7), '<sha>').replace(/: .*/, '')), ['pass verify tests at <sha>', 'pass verify review at <sha>']);

    assert.deepEqual(await approve(), { ok: true, status: 'completed' });
    assert.deepEqual(merges, [['pr', 'merge', PR, '--squash', '--match-head-commit', published]]);
    assert.equal(git(upstream, 'rev-parse', `refs/heads/${branch}`), published);
  });

  it('a push after verification invalidates the verdict: merge refuses, CI and verification run again on the new head', async () => {
    const { queue, task, branch, headOf, merges, drive, approve } = setup();
    assert.equal(await drive(), 'needs-approval');
    const verified = headOf();

    const outside = join(tmp, 'outside');
    git(tmp, 'clone', '--branch', branch, upstream, outside);
    writeFileSync(join(outside, 'extra.txt'), 'pushed by someone else\n');
    git(outside, 'add', 'extra.txt');
    git(outside, 'commit', '-m', 'chore: outside push');
    git(outside, 'push', 'origin', `HEAD:${branch}`);
    const moved = headOf();
    assert.notEqual(moved, verified);

    assert.deepEqual(await approve(), { ok: true, status: 'ci-watch' }, 'the approved merge refuses and goes back to watching');
    assert.deepEqual(merges, [], 'gh pr merge never ran');
    const back = queue.get(task.id);
    assert.equal(back.verification.head, moved);
    assert.equal(back.verification.verdicts.at(-1).sha, verified, 'the old verdict is kept, but no longer covers the head');
    assert.deepEqual(back.babysit.rounds.at(-1), { ...back.babysit.rounds.at(-1), head: moved, ci: 'pending', external: true });
    const stale = db.getTrail(task.id).find((e) => e.evidence?.stale);
    assert.equal(stale.summary, `stale verify at ${verified.slice(0, 7)}: the PR head is now ${moved.slice(0, 7)}`);

    assert.equal(await drive(), 'needs-approval');
    const again = queue.get(task.id);
    assert.deepEqual(again.verification.verdicts.map((v) => [v.sha, v.pass]), [[verified, true], [moved, true]]);
    assert.equal(again.verification.head, moved);

    assert.deepEqual(await approve(), { ok: true, status: 'completed' });
    assert.deepEqual(merges, [['pr', 'merge', PR, '--squash', '--match-head-commit', moved]]);
  });

  it('a verifier that commits voids its run: the task fails and the merge is never offered', async () => {
    const { queue, task, merges, drive } = setup({ verifierCommits: true });

    assert.equal(await drive(), 'failed');
    const stored = queue.get(task.id);
    assert.equal(stored.approval, null);
    const [verdict] = stored.verification.verdicts;
    assert.equal(verdict.pass, false);
    assert.equal(verdict.error, 'the verifier made 1 commit, so the run does not count');
    assert.match(stored.result, /^verification failed at [0-9a-f]{7}: the verifier made 1 commit/);
    assert.deepEqual(merges, []);
  });
});
