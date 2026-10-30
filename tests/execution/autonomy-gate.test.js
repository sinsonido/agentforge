import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingTask, decideApproval } from '../../src/execution/coding-runner.js';
import { merge } from '../../src/execution/publish.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { AgentForgeDB } from '../../src/persistence/db.js';
import { fakeVerifier } from '../fixtures/fake-verifier.js';

const SHA = 'c'.repeat(40);
const PR = 'https://github.com/acme/app/pull/7';

const stoppedRun = async () => ({
  outcome: 'stopped', cancelReason: null, error: null, costUsd: 0.1, usage: {},
  commits: [{ sha: SHA, subject: 'fix: parser' }], uncommitted: false,
  observedTestRuns: [{ seq: 9, command: 'npm test', passed: true }], lastEditSeq: 4,
  step: 6, dir: '/state/tasks/t1/repo',
});

describe('autonomy gate', () => {
  let tmp;
  let db;
  let queue;
  let task;
  let bus;
  let published;
  let merged;
  let mergeError;
  let events;
  let verifier;

  const deps = (policy) => ({
    queue,
    eventBus: bus,
    policy,
    publish: async (opts) => { published.push(opts); return PR; },
    merge: async ({ url }) => {
      if (mergeError) throw new Error(mergeError);
      merged.push(url);
    },
    verifier,
  });
  const run = (policy) => runCodingTask(task, { ...deps(policy), execute: stoppedRun });
  const approve = (policy, reason) => decideApproval(task, { decision: 'approved', by: 'operator', reason }, deps(policy));
  const reject = (policy, reason) => decideApproval(task, { decision: 'rejected', by: 'operator', reason }, deps(policy));
  const decisions = () => queue.trail(task.id).filter((e) => e.kind === 'decision').map((e) => [e.evidence.source, e.summary]);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'af-autonomy-'));
    db = new AgentForgeDB(join(tmp, 'data.db'));
    queue = new TaskQueue({ store: db });
    task = queue.admit({
      kind: 'coding', title: 'Fix the parser', repo: 'acme/app', base: 'master',
      instruction: 'Fix it', issue: 42, playbook: 'bug-fix', test_command: 'npm test',
    }).task;
    bus = new EventEmitter();
    published = [];
    merged = [];
    mergeError = null;
    events = [];
    verifier = fakeVerifier({ head: () => SHA });
    for (const e of ['task.executing', 'task.needs_approval', 'task.completed', 'task.failed']) bus.on(e, (d) => events.push([e, d.status]));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('default policy: publish allow, merge approve', () => {
    it('opens the PR, then parks the task with a pending merge approval', async () => {
      assert.equal(await run(), 'needs-approval');

      const stored = queue.get(task.id);
      assert.equal(published.length, 1);
      assert.equal(stored.pr_url, PR);
      assert.equal(stored.completed_at, null);
      assert.equal(stored.result, `awaiting approval: merge ${PR} into master (verified at ccccccc)`);
      assert.deepEqual({ ...stored.approval, requested_at: 0 }, {
        action: 'merge', summary: `merge ${PR} into master (verified at ccccccc)`, payload: { pr_url: PR }, requested_at: 0,
        decision: null, decided_by: null, decided_at: null, reason: null,
      });
      assert.deepEqual(decisions(), [
        ['policy', 'publish allowed by policy'], ['policy', 'verify allowed by policy'], ['policy', 'merge needs approval by policy'],
      ]);
      assert.deepEqual(verifier.runs, [SHA], 'the merge is offered only after the head was verified');
      assert.equal(stored.verification.head, SHA);
      assert.equal(stored.verification.verdicts[0].pass, true);
      assert.deepEqual(events.at(-1), ['task.needs_approval', 'needs-approval']);
    });

    it('merges on approve and completes, logging the operator', async () => {
      await run();
      const out = await approve(undefined, 'CI green');

      assert.deepEqual(out, { ok: true, status: 'completed' });
      assert.deepEqual(merged, [PR]);
      const stored = queue.get(task.id);
      assert.equal(stored.status, 'completed');
      assert.equal(stored.result, `merged ${PR}`);
      assert.equal(stored.approval.decision, 'approved');
      assert.equal(stored.approval.decided_by, 'operator');
      assert.equal(stored.approval.reason, 'CI green');
      assert.deepEqual(decisions().at(-1), ['operator', 'operator approved merge: CI green']);
      assert.ok(queue.trail(task.id).some((e) => e.kind === 'evidence' && e.summary === `merged ${PR}`));
      assert.deepEqual(events.slice(-2), [['task.executing', undefined], ['task.completed', 'completed']]);
    });

    it('ends pr-opened on reject and never merges', async () => {
      await run();
      const out = await reject(undefined, 'not this one');

      assert.deepEqual(out, { ok: true, status: 'pr-opened' });
      assert.deepEqual(merged, []);
      const stored = queue.get(task.id);
      assert.equal(stored.pr_url, PR);
      assert.equal(stored.result, 'merge rejected: not this one');
      assert.equal(stored.approval.decision, 'rejected');
      assert.deepEqual(decisions().at(-1), ['operator', 'operator rejected merge: not this one']);
    });

    it('waits again with the error when the approved merge fails, and a second approve retries it', async () => {
      await run();
      mergeError = 'gh pr merge failed: required checks pending';

      const first = await approve();
      assert.deepEqual(first, { ok: false, conflict: false, error: 'merge: gh pr merge failed: required checks pending' });
      const parked = queue.get(task.id);
      assert.equal(parked.status, 'needs-approval');
      assert.equal(parked.approval.decision, null);
      assert.equal(parked.approval.error, 'gh pr merge failed: required checks pending');
      assert.ok(queue.trail(task.id).some((e) => e.summary === 'executing → needs-approval: merge failed: gh pr merge failed: required checks pending'));

      mergeError = null;
      assert.deepEqual(await approve(), { ok: true, status: 'completed' });
      assert.equal(queue.get(task.id).approval.error, undefined);
      assert.deepEqual(merged, [PR]);
    });

    it('refuses a decision when nothing waits, including a second click while the action runs', async () => {
      assert.equal((await approve()).conflict, true);

      await run();
      const [a, b] = await Promise.all([approve(), approve()]);
      assert.deepEqual(a, { ok: true, status: 'completed' });
      assert.equal(b.conflict, true);
      assert.deepEqual(merged, [PR]);
    });
  });

  it('with publish: approve, parks before pushing and publishes the gated commits on approve', async () => {
    const policy = { publish: 'approve', merge: 'approve' };
    assert.equal(await run(policy), 'needs-approval');
    assert.equal(published.length, 0);
    const { approval } = queue.get(task.id);
    assert.equal(approval.action, 'publish');
    assert.equal(approval.summary, `push agentforge/${task.handle} and open a PR into master (1 commit)`);
    assert.equal(approval.payload.dir, '/state/tasks/t1/repo');
    assert.deepEqual(approval.payload.verdict.commits, [{ sha: SHA, subject: 'fix: parser' }]);

    assert.deepEqual(await approve(policy), { ok: true, status: 'needs-approval' });
    assert.equal(published.length, 1);
    assert.equal(published[0].clone.dir, '/state/tasks/t1/repo');
    assert.equal(queue.get(task.id).approval.action, 'merge');
  });

  it('with publish: approve, cancels on reject without publishing', async () => {
    const policy = { publish: 'approve', merge: 'approve' };
    await run(policy);
    assert.deepEqual(await reject(policy), { ok: true, status: 'cancelled' });
    assert.equal(published.length, 0);
    assert.equal(queue.get(task.id).result, 'publish rejected');
    assert.deepEqual(events.at(-1), ['task.failed', 'cancelled']);
  });

  it('with publish: deny, fails without publishing', async () => {
    assert.equal(await run({ publish: 'deny', merge: 'approve' }), 'failed');
    assert.equal(published.length, 0);
    assert.equal(queue.get(task.id).result, 'publish denied by policy');
    assert.deepEqual(decisions(), [['policy', 'publish denied by policy']]);
  });

  it('with merge: deny, ends pr-opened as before', async () => {
    assert.equal(await run({ publish: 'allow', merge: 'deny' }), 'pr-opened');
    assert.equal(queue.get(task.id).pr_url, PR);
    assert.deepEqual(decisions().at(-1), ['policy', 'merge denied by policy']);
  });

  it('keeps a parked task across a restart and holds its issue, then resumes it from the store', async () => {
    await run();
    db.close();
    db = new AgentForgeDB(join(tmp, 'data.db'));
    queue = new TaskQueue({ store: db });
    task = queue.get(task.id);

    assert.equal(task.status, 'needs-approval');
    assert.equal(task.approval.action, 'merge');
    const again = queue.admit({
      kind: 'coding', title: 'Fix the parser', repo: 'acme/app', base: 'master',
      instruction: 'Fix it', issue: 42, playbook: 'bug-fix', test_command: 'npm test',
    });
    assert.equal(again.created, false);
    assert.equal(again.task.id, task.id);

    assert.deepEqual(await approve(), { ok: true, status: 'completed' });
    assert.equal(db.findTask(task.id).approval.decision, 'approved');
  });
});

describe('merge', () => {
  const OTHER = 'd'.repeat(40);
  const verdict = (sha, pass = true) => ({ sha, pass, error: null, cost_usd: 0.05, at: 1, lanes: [{ name: 'tests', pass, evidence: 'npm test' }] });
  const verified = (head, ...verdicts) => ({ head, verdicts });
  const gh = (state, head = SHA) => {
    const calls = [];
    const run = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return args[1] === 'view' ? JSON.stringify({ state, headRefOid: head }) : '';
    };
    return { run, calls };
  };

  it('squash-merges an open PR at the verified head, pinned with --match-head-commit', async () => {
    const { run, calls } = gh('OPEN');
    await merge({ url: PR, verification: verified(SHA, verdict(SHA)), run });
    assert.deepEqual(calls, [
      ['gh', 'pr', 'view', PR, '--json', 'state,headRefOid'],
      ['gh', 'pr', 'merge', PR, '--squash', '--match-head-commit', SHA],
    ]);
  });

  it('refuses without a verdict at the current head and never calls gh pr merge', async () => {
    const { run, calls } = gh('OPEN');
    await assert.rejects(merge({ url: PR, verification: null, run }), { name: 'MergeRefused', reason: 'no-verdict', message: /no verification verdict at ccccccc/ });
    assert.equal(calls.length, 1);
  });

  it('refuses a failing verdict at the current head', async () => {
    const { run, calls } = gh('OPEN');
    await assert.rejects(merge({ url: PR, verification: verified(SHA, verdict(SHA, false)), run }), { reason: 'no-verdict', message: /the verdict at ccccccc failed/ });
    assert.equal(calls.length, 1);
  });

  it('refuses when the head moved after a passing verdict: the new head is not covered', async () => {
    const { run, calls } = gh('OPEN', OTHER);
    await assert.rejects(merge({ url: PR, verification: verified(SHA, verdict(SHA)), run }), (err) => {
      assert.equal(err.reason, 'head-moved');
      assert.equal(err.head, OTHER);
      assert.match(err.message, /head moved from ccccccc to ddddddd after verification/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it('does nothing for a merged PR', async () => {
    const { run, calls } = gh('MERGED');
    await merge({ url: PR, verification: null, run });
    assert.equal(calls.length, 1);
  });

  it('refuses a closed PR', async () => {
    await assert.rejects(merge({ url: PR, verification: null, run: gh('CLOSED').run }), /pull\/7 is closed/);
  });
});
