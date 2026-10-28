import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/execution/coding-executor.js';

const LIVE = process.env.AGENTFORGE_LIVE === '1';

// Runs the real harness in docker against a one-bug repo. Costs about $0.15 on sonnet.
// Needs docker, AGENTFORGE_PSTACK_DIR, and CLAUDE_CODE_OAUTH_TOKEN or AGENTFORGE_CREDENTIALS_FILE.
// TMPDIR must be a path the docker daemon sees at the same location.
describe('coding executor (live)', { skip: !LIVE && 'set AGENTFORGE_LIVE=1' }, () => {
  it('fixes a one-line bug with commits and a passing test run', { timeout: 15 * 60 * 1000 }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'af-live-'));
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    const upstream = join(tmp, 'upstream.git');
    git(tmp, 'init', '--bare', '--initial-branch=master', upstream);
    const seed = join(tmp, 'seed');
    git(tmp, 'clone', upstream, seed);
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'sum', type: 'module', scripts: { test: 'node --test' } }, null, 2));
    writeFileSync(join(seed, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
    writeFileSync(join(seed, 'sum.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.js';\n\ntest('sum of zeros', () => assert.equal(sum(0, 0), 0));\n");
    git(seed, 'add', '.');
    git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-m', 'initial');
    git(seed, 'push', 'origin', 'HEAD:master');

    const events = [];
    const eventBus = { emit: (_name, e) => events.push(e.event) };
    const result = await run({
      id: 'live1',
      kind: 'coding',
      repo: 'fixture/sum',
      base: 'master',
      instruction: '`sum(2, 3)` in sum.js returns -1. Expected 5.',
      issue: null,
      playbook: 'bug-fix',
      budget: 1,
    }, {
      stateDir: join(tmp, 'state'),
      pstackDir: process.env.AGENTFORGE_PSTACK_DIR,
      claudeBin: process.env.AGENTFORGE_CLAUDE_BIN,
      credentialsFile: process.env.AGENTFORGE_CREDENTIALS_FILE,
      repoUrl: upstream,
      eventBus,
    });

    console.log(JSON.stringify({
      outcome: result.outcome,
      error: result.error,
      costUsd: result.costUsd,
      commits: result.commits.map((c) => c.subject),
      uncommitted: result.uncommitted,
      observedTestRuns: result.observedTestRuns.map(({ seq, passed }) => ({ seq, passed })),
      lastEditSeq: result.lastEditSeq,
      rateLimits: result.rateLimits,
      events: events.length,
    }, null, 2));

    assert.equal(result.outcome, 'stopped');
    assert.ok(result.commits.length >= 1);
    assert.ok(result.observedTestRuns.some((r) => r.passed && r.seq > result.lastEditSeq));
  });
});
