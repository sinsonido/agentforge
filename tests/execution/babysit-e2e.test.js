import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentForgeDB } from '../../src/persistence/db.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { run as runExecutor } from '../../src/execution/coding-executor.js';
import { runCodingTask } from '../../src/execution/coding-runner.js';
import { publish, pushFix } from '../../src/execution/publish.js';
import { ghCiReader } from '../../src/execution/babysit.js';
import { fakeVerifier } from '../fixtures/fake-verifier.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const GITHUB = 'https://github.com/acme/widget.git';
const PR = 'https://github.com/acme/widget/pull/9';

/**
 * Red, fix, green end to end: the real executor on the fake docker, real git
 * pushes from publish and push-fix into a bare repository standing in for
 * GitHub, and a fake gh whose checks fail on the published head and pass on
 * any later one.
 */
describe('babysit end to end', () => {
  let tmp;
  let db;
  const savedEnv = { ...process.env };

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'af-babysit-e2e-'));
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

  it('pushes a fix round onto the PR branch after red CI and offers the merge once CI is green', async () => {
    const upstream = join(tmp, 'upstream.git');
    git(tmp, 'init', '--bare', '--initial-branch=master', upstream);
    const seed = join(tmp, 'seed');
    git(tmp, 'clone', upstream, seed);
    writeFileSync(join(seed, 'README.md'), 'hello\n');
    git(seed, 'add', 'README.md');
    git(seed, 'commit', '-m', 'initial');
    git(seed, 'push', 'origin', 'HEAD:master');

    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const docker = join(bin, 'docker');
    copyFileSync(join(fixtures, 'fake-docker.mjs'), docker);
    chmodSync(docker, 0o755);
    writeFileSync(join(bin, 'fake-docker.json'), JSON.stringify({ mode: 'replay', stream: join(fixtures, 'agent-streams', 'two-commits.jsonl') }));
    const credentialsFile = join(tmp, 'creds.json');
    writeFileSync(credentialsFile, '{}');

    const queue = new TaskQueue({ store: db });
    const task = queue.admit({
      kind: 'coding', title: 'Fix sum', repo: 'acme/widget', base: 'master', instruction: 'sum(2, 3) returns -1',
      issue: 7, playbook: 'bug-fix', setup_command: 'npm ci', test_command: 'npm test',
    }).task;
    const branch = `agentforge/${task.handle}`;
    const headOf = () => git(upstream, 'rev-parse', `refs/heads/${branch}`);

    let published = null;
    const gh = async (cmd, args, opts = {}) => {
      if (cmd === 'git') return git(opts.cwd ?? tmp, ...args.map((a) => (a === GITHUB ? upstream : a)));
      const line = args.join(' ');
      if (line.startsWith('pr list')) return '[]';
      if (line.startsWith('pr create')) { published = headOf(); return PR; }
      if (line.startsWith('pr view')) return JSON.stringify({ state: 'OPEN', headRefOid: headOf() });
      if (line.startsWith('pr checks')) {
        const red = headOf() === published;
        return JSON.stringify([
          { name: 'Tests', bucket: red ? 'fail' : 'pass', link: 'https://github.com/acme/widget/actions/runs/3/job/4' },
          { name: 'Lint', bucket: 'pass', link: null },
        ]);
      }
      if (line.startsWith('run view --job 4')) return 'not ok 1 - sum adds\n  expected 5, got -1';
      throw new Error(`unexpected gh ${line}`);
    };

    const instructions = [];
    let t = 0;
    const deps = {
      queue,
      eventBus: new EventEmitter(),
      execute: (runTask, opts) => {
        instructions.push({ base: runTask.base, instruction: runTask.instruction });
        return runExecutor(runTask, {
          ...opts, stateDir: join(tmp, 'state'), pstackDir: join(fixtures, 'pstack'), claudeBin: '/bin/claude',
          dockerBin: docker, repoUrl: upstream, credentialsFile, eventBus: deps.eventBus,
        });
      },
      publish: (opts) => publish({ ...opts, run: gh }),
      pushFix: (opts) => pushFix({ ...opts, run: gh }),
      merge: async () => { throw new Error('merge needs approval'); },
      verifier: fakeVerifier({ head: headOf }),
      babysit: { ci: ghCiReader({ run: gh }), maxRounds: 2, timeoutMs: 3_600_000, now: () => t, wait: async (ms) => { t += ms; } },
    };

    let status = await runCodingTask(task, deps);
    const statuses = [status];
    while (status === 'ci-watch') {
      status = await runCodingTask(queue.get(task.id), deps);
      statuses.push(status);
    }

    assert.deepEqual(statuses, ['ci-watch', 'ci-watch', 'needs-approval']);
    const stored = queue.get(task.id);
    assert.equal(stored.approval.action, 'merge');
    assert.equal(stored.babysit.verdict, 'green');

    const fixHead = headOf();
    assert.notEqual(fixHead, published);
    assert.equal(git(upstream, 'rev-parse', `${fixHead}^`), published, 'the fix commit sits on top of the published head');
    assert.equal(git(upstream, 'show', `${fixHead}:fix.txt`), 'fixed\nfixed');
    assert.deepEqual(stored.babysit.rounds.map((r) => [r.n, r.head, r.ci]), [[0, published, 'fail'], [1, fixHead, 'pass']]);

    assert.equal(instructions[1].base, branch);
    assert.match(instructions[1].instruction, /expected 5, got -1/);
    const ciGates = db.getTrail(task.id).filter((e) => e.evidence?.gate === 'ci').map((e) => e.summary);
    assert.deepEqual(ciGates, [
      `fail ci round 0: Tests failed at ${published.slice(0, 7)}`,
      `pass ci round 1: 2 checks passed at ${fixHead.slice(0, 7)}`,
    ]);
  });
});
