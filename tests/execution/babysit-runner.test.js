import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHUTDOWN, decideApproval, runCodingTask } from '../../src/execution/coding-runner.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { AgentForgeDB } from '../../src/persistence/db.js';

const PR = 'https://github.com/acme/app/pull/7';
const sha = (n) => String(n).repeat(40).slice(0, 40);
const pass = (name) => ({ name, bucket: 'pass', link: null });
const fail = (name) => ({ name, bucket: 'fail', link: `https://github.com/acme/app/actions/runs/1/job/${name.length}` });

/**
 * The runner on a real queue and database, with a fake harness that commits one
 * new sha per run, a fake GitHub whose checks are scripted per head, and a clock
 * that a wait moves forward.
 */
describe('babysitting a task PR', () => {
  let tmp;
  let db;
  let queue;
  let task;
  let bus;
  let runs;
  let pushes;
  let merged;
  let ciByHead;
  let events;
  let t;

  const ci = {
    async pr() {
      const head = pushes.at(-1) ?? sha(1);
      return { state: 'OPEN', head, checks: ciByHead[head] ?? [] };
    },
    async logTail(repo, url) { return `log of ${url}`; },
  };

  const execute = async (runTask, { signal }) => {
    const n = runs.length + 1;
    runs.push({ base: runTask.base, instruction: runTask.instruction, cloneExisted: existsSync(join(tmp, 'clone')), signal });
    mkdirSync(join(tmp, 'clone'), { recursive: true });
    writeFileSync(join(tmp, 'clone', 'marker'), String(n));
    return {
      outcome: 'stopped', cancelReason: null, error: null, costUsd: 0.25, usage: { input_tokens: 10, output_tokens: 1 },
      commits: [{ sha: sha(n), subject: `fix ${n}` }], uncommitted: false,
      observedTestRuns: [{ seq: 9, command: 'npm test', passed: true }], lastEditSeq: 4, step: 5, dir: join(tmp, 'clone'),
    };
  };

  const deps = (over = {}) => ({
    queue,
    eventBus: bus,
    policy: { publish: 'allow', 'push-fix': 'allow', merge: 'approve' },
    execute,
    publish: async () => { pushes.push(sha(1)); return PR; },
    pushFix: async ({ verdict, branch }) => { assert.equal(branch, `agentforge/${task.handle}`); pushes.push(verdict.commits.at(-1).sha); return verdict.commits.at(-1).sha; },
    merge: async ({ url }) => { merged.push(url); },
    babysit: { ci, maxRounds: 2, timeoutMs: 3_600_000, now: () => t, wait: async (ms) => { t += ms; } },
    ...over,
  });

  /** Run legs the way the orchestrator does until the task leaves ci-watch. */
  async function drive(d = deps()) {
    let status = await runCodingTask(queue.get(task.id), d);
    while (status === 'ci-watch') status = await runCodingTask(queue.get(task.id), d);
    return status;
  }

  const trail = (kind) => queue.trail(task.id).filter((e) => e.kind === kind).map((e) => e.summary);
  const rounds = () => queue.get(task.id).babysit.rounds.map((r) => [r.n, r.head.slice(0, 1), r.ci, r.failing.map((c) => c.name)]);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'af-babysit-'));
    db = new AgentForgeDB(join(tmp, 'data.db'));
    queue = new TaskQueue({ store: db });
    task = queue.admit({
      kind: 'coding', title: 'Fix the parser', repo: 'acme/app', base: 'master',
      instruction: 'Fix the parser', issue: 42, playbook: 'bug-fix', test_command: 'npm test',
    }).task;
    bus = new EventEmitter();
    runs = [];
    pushes = [];
    merged = [];
    ciByHead = {};
    events = [];
    t = 1_000;
    for (const e of ['task.executing', 'task.ci_watch', 'task.fixing', 'task.needs_approval', 'task.completed', 'task.failed']) {
      bus.on(e, (d) => events.push(e));
    }
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('green: publishes, watches until the checks pass, then offers the merge', async () => {
    ciByHead[sha(1)] = [pass('Tests'), pass('Lint')];

    assert.equal(await runCodingTask(task, deps()), 'ci-watch', 'the first leg ends at the open PR');
    assert.deepEqual(rounds(), [[0, '1', 'pending', []]]);
    assert.equal(await drive(), 'needs-approval');

    const stored = queue.get(task.id);
    assert.equal(stored.approval.action, 'merge');
    assert.equal(stored.babysit.verdict, 'green');
    assert.equal(stored.babysit.branch, `agentforge/${task.handle}`);
    assert.deepEqual(rounds(), [[0, '1', 'pass', []]]);
    assert.deepEqual(trail('gate').at(-1), 'pass ci round 0: 2 checks passed at 1111111');
    assert.deepEqual(events, ['task.executing', 'task.ci_watch', 'task.needs_approval']);
    assert.equal(runs.length, 1);
  });

  it('red then green: a fresh fix round on the PR branch pushes a fix, CI passes, and the merge is offered', async () => {
    ciByHead[sha(1)] = [fail('Tests'), pass('Lint')];
    ciByHead[sha(2)] = [pass('Tests'), pass('Lint')];
    await runCodingTask(task, deps());

    assert.equal(await drive(), 'needs-approval');

    assert.equal(runs.length, 2);
    assert.equal(runs[1].base, `agentforge/${task.handle}`, 'the fix round clones the PR branch');
    assert.equal(runs[1].cloneExisted, false, 'the previous clone was removed first');
    assert.match(runs[1].instruction, /^Fix round 1 of 2 for https:\/\/github.com\/acme\/app\/pull\/7/);
    assert.match(runs[1].instruction, /### Tests \(https:\/\/github.com\/acme\/app\/actions\/runs\/1\/job\/5\)\n```\nlog of /);
    assert.match(runs[1].instruction, /Original task \(issue #42\): Fix the parser/);
    assert.match(runs[1].instruction, /- gate: fail ci round 0: Tests failed at 1111111/);
    assert.deepEqual(pushes, [sha(1), sha(2)]);

    const stored = queue.get(task.id);
    assert.deepEqual(rounds(), [[0, '1', 'fail', ['Tests']], [1, '2', 'pass', []]]);
    assert.equal(stored.babysit.verdict, 'green');
    assert.equal(stored.cost, 0.5, 'both harness runs are paid for');
    assert.deepEqual(trail('gate').filter((s) => s.includes('ci round')), ['fail ci round 0: Tests failed at 1111111', 'pass ci round 1: 2 checks passed at 2222222']);
    assert.ok(trail('decision').includes(`fix round 1 of 2: fresh run on agentforge/${task.handle} for Tests`));
    assert.ok(trail('evidence').includes(`fix round 1 pushed 1 commit to agentforge/${task.handle} at 2222222`));
    assert.ok(trail('status').includes('ci-watch → fixing'));
    assert.ok(trail('status').includes('fixing → ci-watch'));
    assert.deepEqual(events, ['task.executing', 'task.ci_watch', 'task.fixing', 'task.ci_watch', 'task.needs_approval']);
  });

  it('over the cap: fails red with the reason after max_rounds fix rounds', async () => {
    for (const n of [1, 2, 3]) ciByHead[sha(n)] = [fail('Tests')];
    await runCodingTask(task, deps());

    assert.equal(await drive(), 'failed');

    const stored = queue.get(task.id);
    assert.equal(runs.length, 3, 'the first run and two fix rounds');
    assert.equal(stored.result, 'CI still failing after 2 of 2 fix rounds: Tests');
    assert.equal(stored.babysit.verdict, 'red');
    assert.deepEqual(rounds().map(([n, , c]) => [n, c]), [[0, 'fail'], [1, 'fail'], [2, 'fail']]);
    assert.equal(trail('status').at(-1), 'ci-watch → failed: CI still failing after 2 of 2 fix rounds: Tests');
    assert.deepEqual(merged, []);
  });

  it('max_rounds 0 fails on the first red without a fix round', async () => {
    ciByHead[sha(1)] = [fail('Tests')];
    const d = deps({ babysit: { ...deps().babysit, maxRounds: 0 } });
    await runCodingTask(task, d);
    assert.equal(await drive(d), 'failed');
    assert.equal(runs.length, 1);
  });

  it('a fix round that fails the evidence gate fails the task red and pushes nothing', async () => {
    ciByHead[sha(1)] = [fail('Tests')];
    await runCodingTask(task, deps());
    const noTests = async (runTask, opts) => ({ ...(await execute(runTask, opts)), observedTestRuns: [] });

    assert.equal(await drive(deps({ execute: noTests })), 'failed');
    assert.match(queue.get(task.id).result, /^fix round 1: evidence gate: `npm test` did not pass after the last edit/);
    assert.equal(queue.get(task.id).babysit.verdict, 'red');
    assert.deepEqual(pushes, [sha(1)]);
  });

  it('push-fix: approve parks the fix, and approving it pushes and watches again', async () => {
    ciByHead[sha(1)] = [fail('Tests')];
    ciByHead[sha(2)] = [pass('Tests')];
    const d = deps({ policy: { publish: 'allow', 'push-fix': 'approve', merge: 'approve' } });
    await runCodingTask(task, d);

    assert.equal(await drive(d), 'needs-approval');
    const { approval } = queue.get(task.id);
    assert.equal(approval.action, 'push-fix');
    assert.equal(approval.summary, `push 1 commit to agentforge/${task.handle} for fix round 1 of ${PR}`);
    assert.deepEqual(pushes, [sha(1)]);

    assert.deepEqual(await decideApproval(queue.get(task.id), { decision: 'approved', by: 'operator' }, d), { ok: true, status: 'ci-watch' });
    assert.deepEqual(pushes, [sha(1), sha(2)]);
    assert.equal(await drive(d), 'needs-approval');
    assert.equal(queue.get(task.id).approval.action, 'merge');
  });

  it('push-fix: a rejected fix fails the task red', async () => {
    ciByHead[sha(1)] = [fail('Tests')];
    const d = deps({ policy: { publish: 'allow', 'push-fix': 'approve', merge: 'approve' } });
    await runCodingTask(task, d);
    await drive(d);

    assert.deepEqual(await decideApproval(queue.get(task.id), { decision: 'rejected', by: 'operator' }, d), { ok: true, status: 'failed' });
    assert.equal(queue.get(task.id).result, 'push-fix rejected');
    assert.equal(queue.get(task.id).babysit.verdict, 'red');
  });

  it('restart mid-watch: a shutdown leaves the task in ci-watch, and the next process resumes the same round', async () => {
    ciByHead[sha(1)] = [{ name: 'Tests', bucket: 'pending', link: null }];
    await runCodingTask(task, deps());
    const controller = new AbortController();
    const shutdownWait = (ms, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort(SHUTDOWN);
    });

    const leg = await runCodingTask(queue.get(task.id), deps({ signal: controller.signal, babysit: { ...deps().babysit, wait: shutdownWait } }));
    assert.equal(leg, 'ci-watch');
    const startedAt = queue.get(task.id).babysit.rounds[0].started_at;

    db.close();
    db = new AgentForgeDB(join(tmp, 'data.db'));
    queue = new TaskQueue({ store: db });
    const restored = queue.get(task.id);
    assert.equal(restored.status, 'ci-watch');
    assert.deepEqual(restored.babysit.rounds.map((r) => [r.n, r.ci, r.started_at]), [[0, 'pending', startedAt]]);
    const again = queue.admit({
      kind: 'coding', title: 'Fix the parser', repo: 'acme/app', base: 'master',
      instruction: 'Fix the parser', issue: 42, playbook: 'bug-fix', test_command: 'npm test',
    });
    assert.equal(again.created, false, 'the watched task still holds its issue');

    ciByHead[sha(1)] = [pass('Tests')];
    assert.equal(await drive(), 'needs-approval');
    assert.equal(runs.length, 1, 'the resumed watch did not run the harness again');
    assert.equal(queue.get(task.id).babysit.verdict, 'green');
  });

  it('restart mid-fix: a task left fixing goes back to ci-watch and the round runs again on a fresh clone', async () => {
    ciByHead[sha(1)] = [fail('Tests')];
    ciByHead[sha(3)] = [pass('Tests')];
    await runCodingTask(task, deps());
    const controller = new AbortController();
    const interrupted = async (runTask, opts) => {
      await execute(runTask, opts);
      controller.abort(SHUTDOWN);
      return { outcome: 'cancelled', cancelReason: 'signal', error: null, costUsd: 0.1, usage: {}, commits: [], observedTestRuns: [], lastEditSeq: -1 };
    };

    assert.equal(await runCodingTask(queue.get(task.id), deps({ execute: interrupted, signal: controller.signal })), 'ci-watch');
    assert.deepEqual(pushes, [sha(1)]);
    assert.deepEqual(rounds(), [[0, '1', 'fail', ['Tests']]]);

    queue.updateStatus(task.id, 'fixing');
    db.close();
    db = new AgentForgeDB(join(tmp, 'data.db'));
    queue = new TaskQueue({ store: db });
    assert.equal(queue.get(task.id).status, 'ci-watch', 'boot sends fixing back to ci-watch');

    assert.equal(await drive(), 'needs-approval');
    assert.equal(runs[2].cloneExisted, false);
    assert.deepEqual(rounds().map(([n, h, c]) => [n, h, c]), [[0, '1', 'fail'], [1, '3', 'pass']]);
  });

  it('an operator cancel during the watch cancels the task', async () => {
    ciByHead[sha(1)] = [{ name: 'Tests', bucket: 'pending', link: null }];
    await runCodingTask(task, deps());
    const controller = new AbortController();
    const cancelWait = (ms, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort();
    });

    assert.equal(await runCodingTask(queue.get(task.id), deps({ signal: controller.signal, babysit: { ...deps().babysit, wait: cancelWait } })), 'cancelled');
    assert.equal(queue.get(task.id).babysit.verdict, 'stopped');
  });

  it('a PR merged outside AgentForge completes the task without a merge', async () => {
    await runCodingTask(task, deps());
    const mergedCi = { ...ci, pr: async () => ({ state: 'MERGED', head: sha(1), checks: [] }) };
    assert.equal(await drive(deps({ babysit: { ...deps().babysit, ci: mergedCi } })), 'completed');
    assert.equal(queue.get(task.id).babysit.verdict, 'merged');
    assert.deepEqual(merged, []);
  });
});
