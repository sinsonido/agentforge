import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  boundEntry,
  createStreamTrail,
  gateEntries,
  parseDecisionLog,
  readDecisionLogs,
  renderTrail,
} from '../../src/core/trail.js';
import { verdict } from '../../src/core/playbook.js';

const HEADER = 'ts\tphase\tdecision\twhy\tevidence\tresult';
const row = (...cells) => cells.join('\t');

describe('parseDecisionLog', () => {
  it('turns each show-me-your-work row into a decision entry', () => {
    const log = [
      HEADER,
      row('2026-10-29T09:00:00Z', 'frame', 'kept the parser, fixed the tokenizer', 'the bug is in tokenizing', 'src/tok.js:12', 'tests green'),
      row('2026-10-29T09:10:00Z', 'verify', 'ran the full suite', '', 'npm test', ''),
    ].join('\n');

    assert.deepEqual(parseDecisionLog(log, 'decisions.tsv'), [
      {
        kind: 'decision',
        summary: 'kept the parser, fixed the tokenizer',
        evidence: {
          source: 'decisions.tsv', ts: '2026-10-29T09:00:00Z', phase: 'frame',
          why: 'the bug is in tokenizing', evidence: 'src/tok.js:12', result: 'tests green',
        },
      },
      {
        kind: 'decision',
        summary: 'ran the full suite',
        evidence: { source: 'decisions.tsv', ts: '2026-10-29T09:10:00Z', phase: 'verify', evidence: 'npm test' },
      },
    ]);
  });

  it('ignores a file without a decision column and rows without a decision', () => {
    assert.deepEqual(parseDecisionLog('a\tb\n1\t2', 'x.tsv'), []);
    assert.deepEqual(parseDecisionLog(`${HEADER}\n${row('t', 'p', '', 'w', 'e', 'r')}`, 'x.tsv'), []);
  });
});

describe('readDecisionLogs', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'af-trail-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('reads decisions.tsv and .audit/*.tsv from the clone, and nothing when absent', async () => {
    assert.deepEqual(await readDecisionLogs(dir), []);
    writeFileSync(join(dir, 'decisions.tsv'), `${HEADER}\n${row('t', 'p', 'root log', '', '', '')}\n`);
    mkdirSync(join(dir, '.audit'));
    writeFileSync(join(dir, '.audit', 'fix-parser.tsv'), `${HEADER}\n${row('t', 'p', 'audit log', '', '', '')}\n`);
    writeFileSync(join(dir, '.audit', 'notes.md'), 'not a log');

    const entries = await readDecisionLogs(dir);
    assert.deepEqual(entries.map((e) => [e.summary, e.evidence.source]), [
      ['root log', 'decisions.tsv'],
      ['audit log', join('.audit', 'fix-parser.tsv')],
    ]);
  });
});

describe('gateEntries', () => {
  it('reports every gate check with pass or fail and why', () => {
    const v = verdict({
      commits: [{ sha: 'a'.repeat(40), subject: 'fix' }],
      observedTestRuns: [{ seq: 9, command: 'npm test', passed: true, counts: { pass: 12, fail: 0 } }],
      lastEditSeq: 4, uncommitted: true, cancelled: false, testCommand: 'npm test',
    });
    assert.deepEqual(gateEntries(v).map((e) => [e.summary, e.evidence.pass]), [
      ['pass not cancelled: the run was not cancelled', true],
      ['pass commits ahead: 1 commit ahead of base', true],
      ['fail clean tree: uncommitted changes in the clone', false],
      ['pass tests after last edit: `npm test` passed after the last edit (12 passed, 0 failed)', true],
    ]);
  });
});

describe('createStreamTrail', () => {
  it('names a step by the subject of its harness task and records skipped steps as decisions', () => {
    const trail = createStreamTrail();
    trail.push({ type: 'harness_task', op: 'create', taskId: '3', subject: 'step 3: Plan the fix' });
    trail.push({ type: 'harness_task', op: 'create', taskId: '6', subject: 'step 6: Run Opening a PR' });

    assert.deepEqual(trail.step(3), { kind: 'step', summary: 'step 3: Plan the fix', evidence: { step: 3 } });
    assert.deepEqual(trail.step(4), { kind: 'step', summary: 'step 4', evidence: { step: 4 } });
    assert.deepEqual(trail.push({ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '6', status: 'deleted', description: 'the host opens the PR' } }), [{
      kind: 'decision',
      summary: 'skipped step 6: Run Opening a PR: the host opens the PR',
      evidence: { source: 'stream', why: 'the host opens the PR' },
    }]);
    assert.deepEqual(trail.push({ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '3', status: 'completed' } }), []);
  });
});

describe('boundEntry', () => {
  it('clips long text and rejects unknown kinds', () => {
    const e = boundEntry({ kind: 'decision', summary: 'x'.repeat(1000), evidence: { why: 'y'.repeat(1000), n: 3 } });
    assert.equal(e.summary.length, 300);
    assert.equal(e.evidence.why.length, 500);
    assert.equal(e.evidence.n, 3);
    assert.throws(() => boundEntry({ kind: 'mood', summary: 'x' }), /unknown trail kind/);
  });
});

describe('renderTrail', () => {
  const at = Date.UTC(2026, 9, 29, 9, 0, 0);
  const entry = (seq, kind, summary, evidence = null) => ({ seq, at, kind, summary, evidence });

  it('shows gates and decisions, collapses the full trail, and neutralises agent markup', () => {
    const md = renderTrail([
      entry(1, 'status', 'queued'),
      entry(2, 'gate', 'pass commits ahead: 1 commit ahead of base', { gate: 'commits ahead', pass: true }),
      entry(3, 'decision', 'ping @octocat <script> a|b', { phase: 'frame', why: 'because' }),
    ]);

    assert.match(md, /^## Decision trail/);
    assert.match(md, /- pass commits ahead: 1 commit ahead of base/);
    assert.match(md, /- \*\*frame\*\* ping @&#8203;octocat &lt;script> a\\\|b\. Why: because\./);
    assert.match(md, /<details><summary>Full trail \(3 entries\)<\/summary>/);
    assert.match(md, /\| 1 \| 09:00:00 \| status \| queued \|/);
    assert.doesNotMatch(md, /@octocat|<script>/);
  });

  it('collapses decisions past the first ten and says when there are none', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(i + 1, 'decision', `d${i + 1}`));
    assert.match(renderTrail(many), /<details><summary>2 more decisions<\/summary>\n\n- d11\.\n- d12\./);
    assert.match(renderTrail([entry(1, 'status', 'queued')]), /The agent left no decision log\./);
    assert.equal(renderTrail([]), '');
  });
});
