import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDockerArgs,
  buildPrompt,
  classifyToolCall,
  createStreamParser,
  run,
} from '../../src/execution/coding-executor.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const stream = (name) => join(fixtures, 'agent-streams', `${name}.jsonl`);
const pstackDir = join(fixtures, 'pstack');

function parse(name) {
  const parser = createStreamParser();
  const events = readFileSync(stream(name), 'utf8').split('\n').flatMap((l) => parser.push(l));
  return { events, summary: parser.summary() };
}

const task = {
  id: 't1',
  kind: 'coding',
  repo: 'acme/widget',
  base: 'master',
  instruction: 'sum(2, 3) returns -1. Expected 5.',
  issue: 7,
  playbook: 'bug-fix',
  budget: null,
  setup_command: 'npm ci',
  test_command: 'npm test',
};

describe('createStreamParser', () => {
  it('reads session, cost, rate limits and harness tasks from a finished run', () => {
    const { events, summary } = parse('two-commits');
    assert.equal(summary.sessionId, '1aab4f88-871b-4efc-adbe-66c5b4d32dc0');
    assert.equal(summary.costUsd, 0.1922828);
    assert.equal(summary.result.subtype, 'success');
    assert.equal(summary.usage.output_tokens, 3795);
    assert.deepEqual(summary.rateLimits.five_hour, { utilization: 0.77, resetsAt: 1793156400, status: 'allowed' });

    const created = events.filter((e) => e.type === 'harness_task' && e.op === 'create');
    assert.deepEqual(created.map((e) => e.subject).slice(0, 2), ['step 1: Reproduce it yourself', 'step 2: Binary-search the cause']);
    const updates = events.filter((e) => e.type === 'harness_task' && e.op === 'update');
    assert.deepEqual(updates[0], { seq: updates[0].seq, type: 'harness_task', op: 'update', taskId: '1', status: 'in_progress' });
    assert.equal(events.at(-1).type, 'result');
  });

  it('sees the full suite pass after the last edit, then the commit', () => {
    const { events, summary } = parse('two-commits');
    const passed = summary.observedTestRuns.filter((r) => r.passed);
    assert.ok(passed.length >= 1, 'a passing test run was observed');
    assert.ok(passed.at(-1).seq > summary.lastEditSeq, 'the passing run follows the last edit');
    const commits = events.filter((e) => e.type === 'tool_result' && e.evidence.committed);
    assert.equal(commits.length, 2);
    assert.ok(commits.at(-1).seq > passed.at(-1).seq);
  });

  it('reports a stopped run that never committed or passed a test', () => {
    const { events, summary } = parse('no-commit');
    assert.equal(summary.result.subtype, 'success');
    assert.equal(summary.observedTestRuns.filter((r) => r.passed).length, 0);
    assert.equal(events.filter((e) => e.type === 'tool_result' && e.evidence.committed).length, 0);
    assert.ok(summary.lastEditSeq > 0, 'its edits were seen');
  });

  it('falls back to per-message usage when a cancelled run has no result', () => {
    const { summary } = parse('cancelled');
    assert.equal(summary.result, null);
    assert.equal(summary.costUsd, null);
    assert.ok(summary.usage.cache_read_input_tokens > 0);
    assert.ok(summary.usage.output_tokens > 0);
  });

  it('ignores blank and non-JSON lines', () => {
    const parser = createStreamParser();
    assert.deepEqual(parser.push(''), []);
    assert.deepEqual(parser.push('npm notice'), []);
  });
});

describe('classifyToolCall', () => {
  const bash = (command, output = '', isError = false, testCommand = 'npm test') => classifyToolCall('Bash', { command }, { isError, output, testCommand });

  it('does not count a commit message that quotes shell operators as an edit', () => {
    const r = bash('git add a.js && git commit -m "use `?? 1`; `|| 1` coerced 0" && git log --oneline -2');
    assert.deepEqual(r, { edited: false, tested: null, test: null, counts: null, testedAfterEdit: false, committed: true });
  });

  it('orders edit, test and commit inside one command by their segments', () => {
    const live = [
      'echo "test(\'sum of 2 and 3\', () => assert.equal(sum(2, 3), 5));" >> sum.test.js',
      'npm test 2>&1 | grep -E "✖|expected|actual|^ℹ (pass|fail)"',
      'git commit -qam "Add failing test"',
      "sed -i 's/a - b/a + b/' sum.js",
      'npm test 2>&1 | grep -E "✔|✖|^ℹ (pass|fail)"',
      'git commit -qam "Fix sum"',
      'git log --oneline',
    ].join('\n');
    const output = 'ℹ pass 1\nℹ fail 1\n✖ sum of 2 and 3\n✔ sum of zeros\n✔ sum of 2 and 3\nℹ pass 2\nℹ fail 0\n4999c53 Fix sum';
    assert.deepEqual(bash(live, output), {
      edited: true, tested: 'passed', test: 'npm test', counts: { pass: 2, fail: 0 }, testedAfterEdit: true, committed: true,
    });

    const editLast = bash('npm test; sed -i s/a/b/ x.js', 'ℹ pass 2\nℹ fail 0');
    assert.equal(editLast.testedAfterEdit, false);
  });

  it('counts sed -i, redirects into the tree and unknown commands as edits', () => {
    assert.equal(bash("sed -i 's/a/b/' src/x.js").edited, true);
    assert.equal(bash('echo x > src/x.js').edited, true);
    assert.equal(bash('python3 fix.py').edited, true);
    assert.equal(bash('npm ci >/tmp/npmci.log 2>&1; tail -2 /tmp/npmci.log').edited, false);
  });

  it('passes a test run only on a summary with zero failures', () => {
    assert.equal(bash('npm test 2>&1 | tail -3', 'ℹ tests 3\nℹ pass 3\nℹ fail 0').tested, 'passed');
    assert.equal(bash('npm test', 'ℹ pass 2\nℹ fail 1').tested, 'failed');
    assert.equal(bash('node --test x.js | grep ok', '✔ ok').tested, 'failed');
    assert.equal(bash('npm test', 'ℹ pass 3\nℹ fail 0', true).tested, 'failed');
    assert.equal(bash('ls').tested, null);
  });

  it('names the test that ran last, so a single test file is not the configured command', () => {
    const partial = bash('npm test | tail -3; node --test tests/a.test.js', 'ℹ pass 9\nℹ fail 1\nℹ pass 3\nℹ fail 0');
    assert.equal(partial.test, 'node --test tests/a.test.js');
    assert.equal(partial.tested, 'passed');
    assert.equal(bash('npm test -- tests/a.test.js', 'ℹ pass 3\nℹ fail 0').test, 'npm test -- tests/a.test.js');
    assert.equal(bash('cd /w;  npm  test 2>&1 | tail -5', 'ℹ pass 3\nℹ fail 0').test, 'npm test');
  });

  it('counts a configured test command as a test and not as an edit', () => {
    const r = bash('git commit -qam fix && make check', '# pass 4\n# fail 0', false, 'make check');
    assert.deepEqual(r, { edited: false, tested: 'passed', test: 'make check', counts: { pass: 4, fail: 0 }, testedAfterEdit: true, committed: true });
    const compound = bash('npm run build && npm test', 'ℹ pass 4\nℹ fail 0', false, 'npm run build && npm test');
    assert.equal(compound.test, 'npm run build && npm test');
    assert.equal(compound.testedAfterEdit, true);
    assert.equal(bash('make check', '# pass 4\n# fail 0').edited, true, 'an unconfigured unknown command is an edit');
  });

  it('counts Edit and Write tool calls as edits', () => {
    assert.equal(classifyToolCall('Edit', {}, { isError: false, output: '' }).edited, true);
    assert.equal(classifyToolCall('Read', {}, { isError: false, output: '' }).edited, false);
  });
});

describe('buildDockerArgs', () => {
  const base = {
    task, dir: '/state/tasks/t1/repo', home: '/state/tasks/t1/home', uid: 1000, gid: 1000,
    image: 'node:24', claudeBin: '/bin/claude', pstackDir: '/pstack', model: 'sonnet', effort: 'medium',
    budgetUsd: 2, gitAuthor: { name: 'agentforge', email: 'agentforge@localhost' },
  };

  it('mounts only the task clone, home, claude and pstack, and runs as the host user', () => {
    const args = buildDockerArgs({ ...base, withToken: false });
    const mounts = args.flatMap((a, i) => (a === '-v' ? [args[i + 1]] : []));
    assert.deepEqual(mounts, [
      '/state/tasks/t1/home:/home/agent',
      '/bin/claude:/usr/local/bin/claude:ro',
      '/pstack:/opt/pstack:ro',
      '/state/tasks/t1/repo:/state/tasks/t1/repo',
    ]);
    assert.deepEqual(args.slice(0, 6), ['run', '--rm', '--name', 'af-task-t1', '--user', '1000:1000']);
    for (const flag of ['bypassPermissions', '--strict-mcp-config', 'project,local', 'CLAUDE_CODE_ENABLE_TODO_TOOLS=1', 'CLAUDE_CODE_TMPDIR=/home/agent/tmp']) {
      assert.ok(args.includes(flag), flag);
    }
    assert.equal(args[args.indexOf('--max-budget-usd') + 1], '2');
    assert.ok(!args.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  });

  it('passes the OAuth token by name only', () => {
    const args = buildDockerArgs({ ...base, withToken: true });
    assert.equal(args[args.indexOf('CLAUDE_CODE_OAUTH_TOKEN') - 1], '-e');
  });

  it('starts the prompt with poteto-mode and the playbook, and forbids pushing', () => {
    const prompt = buildPrompt(task);
    assert.match(prompt, /^\/pstack:poteto-mode Work this task with the \*\*Bug fix\*\* playbook/);
    assert.match(prompt, /issue #7/);
    assert.match(prompt, /Do NOT push/);
  });

  it('names the repository setup and test commands the gate will require', () => {
    const prompt = buildPrompt({ ...task, setup_command: 'pnpm install --frozen-lockfile', test_command: 'pnpm test' });
    assert.match(prompt, /set up the clone with exactly: `pnpm install --frozen-lockfile`/);
    assert.match(prompt, /test command for this repository is exactly: `pnpm test`/);
  });
});

describe('run (fake docker)', () => {
  let tmp, upstream, docker, calls;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const savedEnv = { ...process.env };

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'af-executor-'));
    const emptyConfig = join(tmp, 'gitconfig');
    writeFileSync(emptyConfig, '');
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
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
  });

  after(() => {
    process.env = savedEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  const fake = (config) => {
    writeFileSync(join(dirname(docker), 'fake-docker.json'), JSON.stringify(config));
    writeFileSync(calls, '');
  };
  const readCalls = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  it('returns stopped with the clone commits and streams events to the bus', async () => {
    fake({ mode: 'replay', stream: stream('two-commits') });
    const credentialsFile = join(tmp, 'creds.json');
    writeFileSync(credentialsFile, '{"secret":"x"}');
    const bus = new EventEmitter();
    const seen = [];
    const stepChanges = [];
    bus.on('task.agent_event', (e) => seen.push(e));
    bus.on('task.step_changed', (e) => stepChanges.push(e.step));
    const replayTask = { ...task, id: 'replay1' };

    const result = await run(replayTask, {
      stateDir: join(tmp, 'state'), pstackDir, claudeBin: '/bin/claude', dockerBin: docker,
      repoUrl: upstream, credentialsFile, eventBus: bus,
    });

    assert.equal(result.outcome, 'stopped');
    assert.equal(result.sessionId, '1aab4f88-871b-4efc-adbe-66c5b4d32dc0');
    assert.equal(result.costUsd, 0.1922828);
    assert.deepEqual(result.commits.map((c) => c.subject), ['fix: the bug']);
    assert.equal(result.uncommitted, false);
    assert.ok(seen.length > 50 && seen.every((e) => e.taskId === 'replay1'));
    assert.deepEqual(stepChanges, [1, 5], 'TaskUpdate hints step 1, the first commit moves it to the commit step');
    assert.equal(replayTask.step, 5);

    const runCall = readCalls().find((c) => c.args?.[0] === 'run');
    assert.equal(runCall.args[runCall.args.indexOf('--max-budget-usd') + 1], '2');
    assert.ok(!runCall.envKeys.some((k) => k.startsWith('GIT_')), 'docker client env is clean');
    assert.ok(readCalls().some((c) => c.credentialsPresent === true), 'credentials were staged');
    assert.equal(existsSync(join(tmp, 'state', 'tasks', 'replay1', 'home', '.claude', '.credentials.json')), false);
  });

  it('announces each event with the entry recordEvent stored', async () => {
    fake({ mode: 'replay', stream: stream('no-commit') });
    const bus = new EventEmitter();
    const seen = [];
    bus.on('task.agent_event', (e) => seen.push(e));
    const stored = [];
    const recordEvent = (taskId, event) => {
      const entry = { seq: stored.length + 1, at: 7, event: { ...event, recorded: taskId } };
      stored.push(entry);
      return entry;
    };

    await run({ ...task, id: 'rec1' }, {
      stateDir: join(tmp, 'state'), pstackDir, claudeBin: '/bin/claude', dockerBin: docker,
      repoUrl: upstream, oauthToken: 'tok', eventBus: bus, recordEvent,
    });

    assert.ok(stored.length > 5);
    assert.deepEqual(seen, stored.map((entry) => ({ taskId: 'rec1', ...entry })));
  });

  it('prefers the OAuth token and never puts it in argv', async () => {
    fake({ mode: 'replay', stream: stream('no-commit') });
    const result = await run({ ...task, id: 'token1', budget: 0.5 }, {
      stateDir: join(tmp, 'state'), pstackDir, claudeBin: '/bin/claude', dockerBin: docker,
      repoUrl: upstream, oauthToken: 'tok-secret', eventBus: new EventEmitter(),
    });
    assert.equal(result.outcome, 'stopped');
    const runCall = readCalls().find((c) => c.args?.[0] === 'run');
    assert.equal(runCall.tokenInEnv, 'tok-secret');
    assert.ok(!runCall.args.some((a) => a.includes('tok-secret')));
    assert.equal(runCall.args[runCall.args.indexOf('--max-budget-usd') + 1], '0.5');
  });

  it('cancels on abort with SIGTERM and docker stop, and reports cancelled', async () => {
    fake({ mode: 'hang', stream: stream('cancelled'), linesBeforeHang: 5 });
    const controller = new AbortController();
    const bus = new EventEmitter();
    bus.once('task.agent_event', () => controller.abort());

    const result = await run({ ...task, id: 'cancel1' }, {
      stateDir: join(tmp, 'state'), pstackDir, claudeBin: '/bin/claude', dockerBin: docker,
      repoUrl: upstream, oauthToken: 'tok', eventBus: bus, signal: controller.signal,
    });

    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.cancelReason, 'signal');
    assert.equal(result.costUsd, null);
    assert.ok(readCalls().some((c) => c.args?.join(' ') === 'stop -t 10 af-task-cancel1'));
  });

  it('cancels on timeout', async () => {
    fake({ mode: 'hang', stream: stream('cancelled'), linesBeforeHang: 1 });
    const result = await run({ ...task, id: 'timeout1' }, {
      stateDir: join(tmp, 'state'), pstackDir, claudeBin: '/bin/claude', dockerBin: docker,
      repoUrl: upstream, oauthToken: 'tok', eventBus: new EventEmitter(), timeoutMs: 300,
    });
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.cancelReason, 'timeout');
  });

  it('reports error when the harness exits without a result', async () => {
    const result = await run({ ...task, id: 'err1' }, {
      stateDir: join(tmp, 'state'), pstackDir, claudeBin: '/bin/claude', dockerBin: join(tmp, 'missing-docker'),
      repoUrl: upstream, oauthToken: 'tok', eventBus: new EventEmitter(),
    });
    assert.equal(result.outcome, 'error');
    assert.match(result.error, /ENOENT/);
  });
});
