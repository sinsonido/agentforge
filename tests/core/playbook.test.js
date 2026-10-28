import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStepTracker, parsePlaybook, readPlaybook, verdict } from '../../src/core/playbook.js';
import { createStreamParser } from '../../src/execution/coding-executor.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const pstackDir = join(fixtures, 'pstack');

function replay(name) {
  const parser = createStreamParser();
  const events = readFileSync(join(fixtures, 'agent-streams', `${name}.jsonl`), 'utf8').split('\n').flatMap((l) => parser.push(l));
  return { events, summary: parser.summary() };
}

const evidenceFrom = (summary, commits, { cancelled = false, uncommitted = false } = {}) => ({
  commits,
  observedTestRuns: summary.observedTestRuns,
  lastEditSeq: summary.lastEditSeq,
  uncommitted,
  cancelled,
});

describe('readPlaybook', () => {
  it('reads the numbered steps of the pinned bug-fix playbook', async () => {
    const playbook = await readPlaybook(pstackDir, 'bug-fix');
    assert.equal(playbook.title, 'Bug fix');
    assert.deepEqual(playbook.steps.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
    assert.equal(playbook.steps[0].title, 'Reproduce it yourself on the matching surface via the control skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce.');
    assert.equal(playbook.steps[5].title, 'Run Opening a PR.');
    assert.match(playbook.steps[4].text, /sequence-verifiable-units/, 'indented lines join their step');
  });

  it('keeps a nested numbered list inside its step', async () => {
    const playbook = await readPlaybook(pstackDir, 'perf-issue');
    assert.deepEqual(playbook.steps.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
    assert.match(playbook.steps[1].text, /Do it later/);
  });

  it('rejects a file with no steps and a missing playbook', async () => {
    assert.throws(() => parsePlaybook('empty', '### Empty\n\nNo steps.'), /no numbered steps/);
    await assert.rejects(readPlaybook(pstackDir, 'nope'), /ENOENT/);
  });
});

describe('verdict', () => {
  const twoCommits = [
    { sha: 'a18903e', subject: 'test(router): budget_remaining_pct 0 should match budget_remaining_lt' },
    { sha: '0e5cc08', subject: 'fix(router): treat budget_remaining_pct 0 as spent, not healthy' },
  ];

  it('passes run 4: two commits and the suite passing after the last edit', () => {
    const { summary } = replay('two-commits');
    const v = verdict(evidenceFrom(summary, twoCommits));
    assert.equal(v.pass, true, v.reasons.join('; '));
    assert.equal(v.cancelled, false);
    assert.deepEqual(v.commits, twoCommits);
    assert.equal(v.testRun.sha, '0e5cc08');
    assert.match(v.testRun.command, /npm test/);
  });

  it('fails run 3: the harness stopped with success but committed nothing', () => {
    const { summary } = replay('no-commit');
    assert.equal(summary.result.subtype, 'success');
    const v = verdict(evidenceFrom(summary, []));
    assert.equal(v.pass, false);
    assert.equal(v.testRun, null);
    assert.deepEqual(v.reasons, ['no commit ahead of base', 'no test run passed after the last edit']);
  });

  it('fails a cancelled run even with a commit on the branch', () => {
    const { summary } = replay('cancelled');
    const v = verdict(evidenceFrom(summary, [twoCommits[0]], { cancelled: true }));
    assert.equal(v.pass, false);
    assert.equal(v.cancelled, true);
    assert.ok(v.reasons.includes('the run was cancelled'));
  });

  it('fails a cancelled run that otherwise has full evidence', () => {
    const { summary } = replay('two-commits');
    const v = verdict(evidenceFrom(summary, twoCommits, { cancelled: true }));
    assert.equal(v.pass, false);
    assert.deepEqual(v.reasons, ['the run was cancelled']);
  });

  it('fails when the clone has uncommitted changes', () => {
    const { summary } = replay('two-commits');
    assert.equal(verdict(evidenceFrom(summary, twoCommits, { uncommitted: true })).pass, false);
  });

  it('fails when the only passing test ran before the last edit', () => {
    const v = verdict({
      commits: twoCommits,
      observedTestRuns: [{ seq: 10.5, command: 'npm test', passed: true }],
      lastEditSeq: 12,
      uncommitted: false,
      cancelled: false,
    });
    assert.deepEqual(v.reasons, ['no test run passed after the last edit']);
  });
});

describe('createStepTracker', () => {
  it('follows the TaskUpdate hint and moves to the commit step on the first commit', async () => {
    const tracker = createStepTracker(await readPlaybook(pstackDir, 'bug-fix'));
    const { events } = replay('two-commits');
    const changes = [];
    for (const e of events) if (tracker.push(e)) changes.push({ seq: e.seq, step: tracker.step });
    assert.deepEqual(changes.map((c) => c.step), [1, 5]);
    assert.equal(tracker.step, 5);
  });

  it('stays on the hinted step when the run never commits', async () => {
    const tracker = createStepTracker(await readPlaybook(pstackDir, 'bug-fix'));
    for (const e of replay('cancelled').events) tracker.push(e);
    assert.equal(tracker.step, 1);
  });
});
