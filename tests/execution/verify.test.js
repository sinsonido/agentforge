import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPORT_FILE, currentVerdict, judge, parseVerify, readReport, verdictAt, verdictEntries, withHead, withVerdict,
} from '../../src/execution/verify.js';
import { buildVerifyPrompt } from '../../src/execution/coding-executor.js';
import { SHUTDOWN, decideApproval, runCodingTask } from '../../src/execution/coding-runner.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { AgentForgeDB } from '../../src/persistence/db.js';
import { fakeVerifier } from '../fixtures/fake-verifier.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const task = { id: 't1', test_command: 'npm test', setup_command: 'npm ci', base: 'master', instruction: 'Fix sum', issue: 7, pr_url: 'https://github.com/o/r/pull/9' };
const run = (over = {}) => ({
  outcome: 'stopped', error: null, commits: [], head: A, uncommitted: false, costUsd: 0.07,
  observedTestRuns: [{ seq: 4, command: 'npm test', passed: true, counts: { pass: 9, fail: 0 } }], ...over,
});
const report = { tests: { pass: true, evidence: 'ran it' }, review: { pass: true, evidence: 'diff matches the task' } };

describe('parseVerify', () => {
  it('defaults to the tests and review lanes and a $1 budget', () => {
    assert.deepEqual(parseVerify(undefined), { ok: true, value: { lanes: ['tests', 'review'], budget_usd: 1, model: null } });
  });

  it('takes one lane, a budget and a model', () => {
    assert.deepEqual(parseVerify({ lanes: ['tests'], budget_usd: 0.5, model: 'opus' }).value, { lanes: ['tests'], budget_usd: 0.5, model: 'opus' });
  });

  it('rejects an unknown lane, a repeated lane, no lanes, a bad budget and an unknown key', () => {
    assert.match(parseVerify({ lanes: ['tests', 'smoke'] }).error, /unknown lanes: smoke; lanes are: tests, review/);
    assert.match(parseVerify({ lanes: ['tests', 'tests'] }).error, /lanes must not repeat/);
    assert.match(parseVerify({ lanes: [] }).error, /lanes must list at least one/);
    assert.match(parseVerify({ budget_usd: 0 }).error, /budget_usd must be a positive number/);
    assert.match(parseVerify({ rounds: 2 }).error, /unknown keys: rounds/);
  });
});

describe('judge', () => {
  it('passes when every lane passes; the host decides tests from what it saw run', () => {
    const v = judge(run(), { sha: A, lanes: ['tests', 'review'], task, report }, 5);
    assert.deepEqual(v, {
      sha: A, pass: true, error: null, cost_usd: 0.07, at: 5,
      lanes: [
        { name: 'tests', pass: true, evidence: '`npm test` passed: 9 passed, 0 failed. Verifier: ran it' },
        { name: 'review', pass: true, evidence: 'diff matches the task' },
      ],
    });
  });

  it('fails tests when the host saw them fail, even if the verifier says they passed', () => {
    const failed = run({ observedTestRuns: [{ seq: 4, command: 'npm test', passed: false, counts: { pass: 8, fail: 1 } }] });
    const v = judge(failed, { sha: A, lanes: ['tests'], task, report }, 5);
    assert.equal(v.pass, false);
    assert.match(v.lanes[0].evidence, /^`npm test` failed: 8 passed, 1 failed/);
  });

  it('fails tests that never ran, and a review lane with no report', () => {
    const v = judge(run({ observedTestRuns: [] }), { sha: A, lanes: ['tests', 'review'], task, report: null }, 5);
    assert.deepEqual(v.lanes.map((l) => [l.pass, l.evidence]), [
      [false, '`npm test` was never run'],
      [false, 'the verifier reported nothing for this lane'],
    ]);
  });

  it('voids a run that committed, moved HEAD, changed tracked files or did not finish', () => {
    const at = (over) => judge(run(over), { sha: A, lanes: ['tests', 'review'], task, report }, 5);
    assert.equal(at({ commits: [{ sha: B }], head: B }).error, 'the verifier made 1 commit, so the run does not count');
    assert.equal(at({ head: B }).error, 'the verifier moved HEAD to bbbbbbb, so the run does not count');
    assert.equal(at({ uncommitted: true }).error, 'the verifier changed tracked files, so the run does not count');
    assert.equal(at({ outcome: 'error', error: 'harness result error_max_budget_usd' }).error, 'harness result error_max_budget_usd');
    for (const over of [{ head: B }, { uncommitted: true }]) assert.equal(at(over).pass, false, 'lanes that passed do not save a void run');
  });
});

describe('verdicts by SHA', () => {
  const pass = (sha) => ({ sha, pass: true, error: null, lanes: [], cost_usd: 0, at: 1 });

  it('only the verdict at the current head counts; moving the head invalidates it', () => {
    let v = withVerdict(withHead(null, A), pass(A));
    assert.equal(currentVerdict(v).sha, A);
    v = withHead(v, B);
    assert.equal(currentVerdict(v), null, 'a new head has no verdict');
    assert.equal(verdictAt(v, A).sha, A, 'the old verdict is kept for the record');
  });

  it('records one verdict per SHA, the newest replacing an older one', () => {
    const v = withVerdict(withVerdict(withHead(null, A), { ...pass(A), pass: false }), pass(A));
    assert.deepEqual(v.verdicts.map((x) => x.pass), [true]);
  });

  it('turns a verdict into one gate entry per lane, and one for a void run', () => {
    const v = { ...pass(A), pass: false, error: 'the verifier made 1 commit', lanes: [{ name: 'tests', pass: true, evidence: 'ok' }] };
    assert.deepEqual(verdictEntries(v).map((e) => [e.kind, e.summary, e.evidence.lane]), [
      ['gate', 'fail verify run at aaaaaaa: the verifier made 1 commit', null],
      ['gate', 'pass verify tests at aaaaaaa: ok', 'tests'],
    ]);
  });
});

describe('readReport', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'af-report-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads lanes by name and treats anything but true as a fail', async () => {
    writeFileSync(join(dir, REPORT_FILE), JSON.stringify({ lanes: [{ name: 'review', pass: 'yes', evidence: 'x' }, { name: 'tests', pass: true }] }));
    assert.deepEqual(await readReport(dir), { review: { pass: false, evidence: 'x' }, tests: { pass: true, evidence: '' } });
  });

  it('returns null for a missing or broken report', async () => {
    assert.equal(await readReport(dir), null);
    writeFileSync(join(dir, REPORT_FILE), '{not json');
    assert.equal(await readReport(dir), null);
  });
});

describe('buildVerifyPrompt', () => {
  it('asks for a read-only Investigation of the exact head, one finding per lane, in the report file', () => {
    const prompt = buildVerifyPrompt(task, { sha: A, lanes: ['tests', 'review'] });
    assert.match(prompt, /^\/pstack:poteto-mode Verify a pull request with the \*\*Investigation\*\* playbook, fully autonomous\./);
    assert.ok(prompt.includes(`independent verifier of ${task.pr_url} at commit ${A}`));
    assert.ok(prompt.includes('Any commit or change to a tracked file voids this verification.'));
    assert.ok(prompt.includes('Task the change was made for (issue #7): Fix sum'));
    assert.ok(prompt.includes('`git diff origin/master...HEAD`'));
    assert.ok(prompt.includes('- tests: run exactly `npm test` as its own command'));
    assert.ok(prompt.includes('- review: read the diff against the base and the task.'));
    assert.ok(prompt.includes(`write \`${REPORT_FILE}\` at the clone root`));
    assert.ok(prompt.includes('Do NOT push, do NOT open a PR, do NOT call gh.'));
    assert.ok(!prompt.includes('TaskCreate'), 'a verifier tracks no build steps');
  });
});

describe('the verify step in the runner', () => {
  let tmp;
  let db;
  let queue;
  let t;
  const stoppedRun = async () => ({
    outcome: 'stopped', cancelReason: null, error: null, costUsd: 0.1, usage: {},
    commits: [{ sha: A, subject: 'fix' }], uncommitted: false,
    observedTestRuns: [{ seq: 9, command: 'npm test', passed: true }], lastEditSeq: 4, step: 6, dir: '/clone',
  });
  const deps = (over = {}) => ({
    queue, eventBus: new EventEmitter(), execute: stoppedRun,
    publish: async () => 'https://github.com/o/r/pull/9',
    merge: async () => {},
    verifier: fakeVerifier({ head: () => A }),
    ...over,
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'af-verify-'));
    db = new AgentForgeDB(join(tmp, 'data.db'));
    queue = new TaskQueue({ store: db });
    t = queue.admit({
      kind: 'coding', title: 'Fix sum', repo: 'o/r', base: 'master', instruction: 'Fix sum', issue: 7, playbook: 'bug-fix', test_command: 'npm test',
    }).task;
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a failing verdict fails the task and never offers the merge', async () => {
    assert.equal(await runCodingTask(t, deps({ verifier: fakeVerifier({ head: () => A, pass: false }) })), 'failed');
    const stored = queue.get(t.id);
    assert.equal(stored.approval, null);
    assert.equal(stored.result, 'verification failed at aaaaaaa: tests: `npm test` failed: 11 passed, 1 failed');
    assert.equal(stored.verification.verdicts[0].pass, false);
  });

  it('verify: approve parks before spending on verification; approving runs it and then asks for the merge', async () => {
    const verifier = fakeVerifier({ head: () => A });
    const d = deps({ verifier, policy: { publish: 'allow', 'push-fix': 'allow', verify: 'approve', merge: 'approve' } });
    assert.equal(await runCodingTask(t, d), 'needs-approval');
    assert.equal(queue.get(t.id).approval.action, 'verify');
    assert.deepEqual(verifier.runs, []);

    const out = await decideApproval(queue.get(t.id), { decision: 'approved', by: 'operator' }, d);
    assert.deepEqual(out, { ok: true, status: 'needs-approval' });
    assert.deepEqual(verifier.runs, [A]);
    assert.equal(queue.get(t.id).approval.action, 'merge');
  });

  it('a host without a verifier stops at pr-opened: nothing merges unverified', async () => {
    assert.equal(await runCodingTask(t, deps({ verifier: undefined })), 'pr-opened');
    assert.match(queue.get(t.id).result, /is not verified: this host has no verifier/);
  });

  it('a shutdown during verification leaves the babysat task in ci-watch, and a restart from verifying does too', async () => {
    const controller = new AbortController();
    const verifier = fakeVerifier({ head: () => A });
    const blocking = { ...verifier, run: async () => { controller.abort(SHUTDOWN); return { outcome: 'cancelled', cancelReason: 'signal' }; } };
    queue.updateStatus(t.id, 'ci-watch', {
      pr_url: 'https://github.com/o/r/pull/9',
      babysit: { branch: `agentforge/${t.handle}`, dir: null, max_rounds: 2, verdict: null, rounds: [{ n: 0, head: A, ci: 'pass', failing: [], started_at: 1, finished_at: 2 }] },
    });
    const ci = { pr: async () => ({ state: 'OPEN', head: A, checks: [] }), logTail: async () => null };
    const status = await runCodingTask(queue.get(t.id), deps({ verifier: blocking, signal: controller.signal, babysit: { ci, maxRounds: 2, timeoutMs: 1000 } }));
    assert.equal(status, 'ci-watch');
    assert.equal(queue.get(t.id).verification.verdicts.length, 0, 'no verdict from an interrupted run');

    queue.updateStatus(t.id, 'verifying');
    db.close();
    db = new AgentForgeDB(join(tmp, 'data.db'));
    queue = new TaskQueue({ store: db });
    assert.equal(queue.get(t.id).status, 'ci-watch');
    assert.equal(queue.get(t.id).result, 'verification interrupted; running it again');
  });
});
