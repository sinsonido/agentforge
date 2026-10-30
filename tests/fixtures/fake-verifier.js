/**
 * A verifier for runner tests: GitHub reports `head()` as the open PR's head, and
 * each verification run is read-only and sees `npm test` pass (or fail with `pass: false`).
 * `runs` lists the SHAs it verified.
 */
export function fakeVerifier({ head, pass = true, lanes = ['tests'], cost = 0.05 }) {
  const runs = [];
  return {
    runs,
    lanes,
    pr: async () => ({ state: 'OPEN', head: head() }),
    run: async (task, { sha }) => {
      runs.push(sha);
      return {
        outcome: 'stopped', cancelReason: null, error: null, costUsd: cost, usage: { input_tokens: 5, output_tokens: 2 },
        commits: [], head: sha, uncommitted: false, dir: null, lastEditSeq: -1,
        observedTestRuns: [{ seq: 3, command: task.test_command, passed: pass, counts: { pass: pass ? 12 : 11, fail: pass ? 0 : 1 } }],
      };
    },
  };
}
