import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify, fixInstruction, ghCiReader, parseBabysit, startRound, watchCi } from '../../src/execution/babysit.js';

const HEAD = 'a'.repeat(40);
const URL = 'https://github.com/acme/app/pull/7';
const check = (name, bucket, link = null) => ({ name, bucket, link });

/** A CI reader that answers each poll with the next scripted PR state; the last one repeats. */
function scripted(states) {
  const polls = [];
  return {
    polls,
    ci: {
      async pr(url) {
        polls.push(url);
        const next = states[Math.min(polls.length - 1, states.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
      async logTail() { return null; },
    },
  };
}

const open = (checks, head = HEAD) => ({ state: 'OPEN', head, checks });

/** A clock that moves forward by each wait. */
function clock(start = 1_000) {
  let t = start;
  const waits = [];
  return { waits, now: () => t, wait: async (ms) => { waits.push(ms); t += ms; } };
}

describe('parseBabysit', () => {
  it('fills defaults and rejects every bad key at once', () => {
    assert.deepEqual(parseBabysit(undefined), { ok: true, value: { max_rounds: 2, timeout_minutes: 60, checks: 'all' } });
    const bad = parseBabysit({ max_rounds: 1.5, timeout_minutes: -1, checks: 'none' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /max_rounds must be a whole number.*timeout_minutes must be a positive number.*checks must be one of: all, required/);
  });
});

describe('classify', () => {
  it('is pending while any check runs, fail when one failed or was cancelled, else pass', () => {
    assert.equal(classify([]), 'none');
    assert.equal(classify([check('a', 'pass'), check('b', 'pending'), check('c', 'fail')]), 'pending');
    assert.equal(classify([check('a', 'pass'), check('b', 'cancel')]), 'fail');
    assert.equal(classify([check('a', 'pass'), check('b', 'skipping')]), 'pass');
  });
});

describe('ghCiReader', () => {
  function fakeGh(answers) {
    const calls = [];
    const run = async (cmd, args) => {
      calls.push(args.join(' '));
      const key = Object.keys(answers).find((k) => args.join(' ').startsWith(k));
      const answer = answers[key];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    };
    return { run, calls };
  }

  it('reads the PR head and only the required checks when asked to', async () => {
    const gh = fakeGh({
      [`pr view ${URL}`]: { state: 'OPEN', headRefOid: HEAD },
      [`pr checks ${URL}`]: [{ name: 'Tests', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/1/job/2' }],
    });
    const pr = await ghCiReader({ checks: 'required', run: gh.run }).pr(URL);

    assert.deepEqual(pr, { state: 'OPEN', head: HEAD, checks: [{ name: 'Tests', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/1/job/2' }] });
    assert.deepEqual(gh.calls, [`pr view ${URL} --json state,headRefOid`, `pr checks ${URL} --required --json name,bucket,link`]);
  });

  it('reads "no checks reported" as an empty list and skips checks on a merged PR', async () => {
    const none = fakeGh({
      [`pr view ${URL}`]: { state: 'OPEN', headRefOid: HEAD },
      [`pr checks ${URL}`]: new Error("gh pr checks failed: no checks reported on the 'agentforge/t1' branch"),
    });
    assert.deepEqual((await ghCiReader({ run: none.run }).pr(URL)).checks, []);

    const merged = fakeGh({ [`pr view ${URL}`]: { state: 'MERGED', headRefOid: HEAD } });
    assert.deepEqual(await ghCiReader({ run: merged.run }).pr(URL), { state: 'MERGED', head: HEAD, checks: [] });
    assert.equal(merged.calls.length, 1);
  });

  it('tails the failed log of an Actions job and has none for other checks', async () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const gh = fakeGh({ 'run view --job 22': log });
    const reader = ghCiReader({ run: gh.run });

    const tail = await reader.logTail('acme/app', 'https://github.com/acme/app/actions/runs/11/job/22');
    assert.equal(tail.split('\n').length, 60);
    assert.ok(tail.endsWith('line 99'));
    assert.deepEqual(gh.calls, ['run view --job 22 --repo acme/app --log-failed']);
    assert.equal(await reader.logTail('acme/app', 'https://github.com/acme/app/runs/5'), null);
  });
});

describe('watchCi', () => {
  const round = { n: 0, head: HEAD, ci: 'pending', failing: [], started_at: 1_000, finished_at: null };

  it('waits for pending checks and passes once the same checks passed on two polls in a row', async () => {
    const { ci, polls } = scripted([
      open([check('Tests', 'pending')]),
      open([check('Tests', 'pass')]),
      open([check('Tests', 'pass'), check('Lint', 'pass')]),
      open([check('Tests', 'pass'), check('Lint', 'pass')]),
    ]);
    const c = clock();
    const seen = await watchCi({ url: URL, round }, { ci, timeoutMs: 3_600_000, ...c });

    assert.deepEqual(seen, { outcome: 'pass', failing: [], checks: 2 });
    assert.equal(polls.length, 4, 'a check that registered late reset the pass');
    assert.deepEqual(c.waits, [10_000, 20_000, 30_000]);
  });

  it('ignores checks of another head and reports the failing checks of its own', async () => {
    const { ci } = scripted([
      open([check('Tests', 'fail')], 'b'.repeat(40)),
      open([check('Tests', 'fail', 'https://x/actions/runs/1/job/2'), check('Lint', 'pass')]),
    ]);
    const seen = await watchCi({ url: URL, round }, { ci, timeoutMs: 3_600_000, ...clock() });
    assert.deepEqual(seen, { outcome: 'fail', failing: [{ name: 'Tests', url: 'https://x/actions/runs/1/job/2' }], checks: 2 });
  });

  it('treats a gh error as one more pending poll', async () => {
    const { ci, polls } = scripted([new Error('gh: network down'), open([check('T', 'pass')])]);
    const seen = await watchCi({ url: URL, round }, { ci, timeoutMs: 3_600_000, ...clock() });
    assert.equal(seen.outcome, 'pass');
    assert.equal(polls.length, 3);
  });

  it('stops on a PR merged or closed outside AgentForge', async () => {
    for (const state of ['MERGED', 'CLOSED']) {
      const { ci } = scripted([{ state, head: HEAD, checks: [] }]);
      const seen = await watchCi({ url: URL, round }, { ci, timeoutMs: 3_600_000, ...clock() });
      assert.equal(seen.outcome, state.toLowerCase());
    }
  });

  it('passes a head with no checks after five minutes, and times out a head whose checks never finish', async () => {
    const none = await watchCi({ url: URL, round }, { ci: scripted([open([])]).ci, timeoutMs: 3_600_000, ...clock() });
    assert.deepEqual(none, { outcome: 'pass', failing: [], checks: 0 });

    const stuck = await watchCi({ url: URL, round }, { ci: scripted([open([check('T', 'pending')])]).ci, timeoutMs: 600_000, ...clock() });
    assert.deepEqual(stuck, { outcome: 'timeout' });
  });

  it('measures the timeout from when the round started, so a resumed watch keeps its deadline', async () => {
    const c = clock(1_000 + 3_600_000);
    const { ci, polls } = scripted([open([check('T', 'pending')])]);
    assert.deepEqual(await watchCi({ url: URL, round }, { ci, timeoutMs: 3_600_000, ...c }), { outcome: 'timeout' });
    assert.equal(polls.length, 1);
  });

  it('returns aborted when the signal fires during a wait', async () => {
    const controller = new AbortController();
    const { ci } = scripted([open([check('T', 'pending')])]);
    const wait = (ms, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort('shutdown');
    });
    const seen = await watchCi({ url: URL, round }, { ci, timeoutMs: 3_600_000, signal: controller.signal, wait, now: () => 1_000 });
    assert.deepEqual(seen, { outcome: 'aborted' });
  });
});

describe('startRound', () => {
  it('starts a babysit at round 0 and appends each fix round', () => {
    const first = startRound(null, { n: 0, head: HEAD, dir: '/c', branch: 'agentforge/t1-x', maxRounds: 2 }, 5);
    assert.deepEqual(first, {
      branch: 'agentforge/t1-x', dir: '/c', max_rounds: 2, verdict: null,
      rounds: [{ n: 0, head: HEAD, ci: 'pending', failing: [], started_at: 5, finished_at: null }],
    });
    const second = startRound(first, { n: 1, head: 'b'.repeat(40), dir: '/c', branch: 'agentforge/t1-x', maxRounds: 2 }, 9);
    assert.deepEqual(second.rounds.map((r) => [r.n, r.started_at]), [[0, 5], [1, 9]]);
  });
});

describe('fixInstruction', () => {
  it('carries the original task, the failing checks with their logs, and the trail', () => {
    const task = { issue: 42, instruction: 'Fix the parser', pr_url: URL };
    const state = {
      branch: 'agentforge/t1-x', dir: '/c', max_rounds: 2, verdict: null,
      rounds: [{ n: 0, head: HEAD, ci: 'fail', failing: [{ name: 'Tests', url: 'u' }], started_at: 1, finished_at: 2 }],
    };
    const text = fixInstruction(task, {
      n: 1, state,
      failing: [{ name: 'Tests', url: 'u', log: 'AssertionError ```boom```' }, { name: 'Lint', url: null, log: null }],
      trail: [
        { kind: 'step', summary: 'step 1: Reproduce' },
        { kind: 'gate', summary: 'pass tests after last edit: `npm test` passed' },
        { kind: 'gate', summary: 'fail ci round 0: Tests failed at aaaaaaa' },
      ],
    });

    assert.match(text, /^Fix round 1 of 2 for https:\/\/github.com\/acme\/app\/pull\/7\. The PR's CI failed on aaaaaaa, the head of `agentforge\/t1-x`/);
    assert.match(text, /Original task \(issue #42\): Fix the parser/);
    assert.match(text, /### Tests \(u\)\n```\nAssertionError '''boom'''\n```/);
    assert.match(text, /### Lint\nNo log available\./);
    assert.match(text, /- gate: pass tests after last edit/);
    assert.match(text, /- gate: fail ci round 0: Tests failed/);
    assert.doesNotMatch(text, /step 1/);
  });
});
