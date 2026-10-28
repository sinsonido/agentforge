import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Playbooks are data read from the pinned pstack copy, not code.
 *
 * @typedef {{ n: number, title: string, text: string }} Step
 * @typedef {{ name: string, title: string, steps: Step[] }} Playbook
 */

const STEP_LINE = /^(\d+)\.\s+(.*)$/;
const CONTINUATION = /^\s+\S/;
const COMMIT_STEP = /\bcommits?\b/i;
const HARNESS_STEP_SUBJECT = /^step\s+(\d+)\b/i;

function stepTitle(text) {
  const plain = text.replace(/\*\*|`/g, '');
  return plain.split(/(?<=\.)\s/)[0];
}

/**
 * Parse the top-level numbered list of a playbook. Indented lines (sub-bullets,
 * nested lists) belong to the step above them.
 * @returns {Playbook}
 */
export function parsePlaybook(name, markdown) {
  const lines = markdown.split('\n');
  const title = (lines.find((l) => l.startsWith('#')) ?? name).replace(/^#+\s*/, '');
  const steps = [];
  for (const line of lines) {
    const m = STEP_LINE.exec(line);
    if (m) {
      steps.push({ n: Number(m[1]), title: stepTitle(m[2]), text: m[2] });
    } else if (steps.length && CONTINUATION.test(line)) {
      steps.at(-1).text += `\n${line.trim()}`;
    }
  }
  if (!steps.length) throw new Error(`playbook ${name} has no numbered steps`);
  return { name, title, steps };
}

/** @returns {Promise<Playbook>} */
export async function readPlaybook(pstackDir, name) {
  const file = join(pstackDir, 'skills', 'poteto-mode', 'playbooks', `${name}.md`);
  return parsePlaybook(name, await readFile(file, 'utf8'));
}

/**
 * The evidence gate between a stopped harness run and a pushed branch.
 *
 * Passes only when the run was not cancelled, the clone has at least one commit
 * ahead of base and no uncommitted tracked changes, and a test run passed after
 * the last edit. Given a clean tree, that test ran against the last commit's tree.
 *
 * @param {{ commits: Array<{ sha: string, subject: string }>,
 *   observedTestRuns: Array<{ seq: number, command: string, passed: boolean }>,
 *   lastEditSeq: number, uncommitted: boolean, cancelled: boolean }} evidence
 * @returns {{ pass: boolean, cancelled: boolean, commits: Array<{ sha: string, subject: string }>,
 *   testRun: { command: string, sha: string } | null, reasons: string[] }}
 */
export function verdict({ commits, observedTestRuns, lastEditSeq, uncommitted, cancelled }) {
  const fresh = observedTestRuns.filter((r) => r.passed && r.seq > lastEditSeq).at(-1);
  const head = commits.at(-1);
  const reasons = [
    cancelled && 'the run was cancelled',
    !commits.length && 'no commit ahead of base',
    uncommitted && 'uncommitted changes in the clone',
    !fresh && 'no test run passed after the last edit',
  ].filter(Boolean);
  return {
    pass: reasons.length === 0,
    cancelled,
    commits,
    testRun: fresh && head ? { command: fresh.command, sha: head.sha } : null,
    reasons,
  };
}

/**
 * Follows which playbook step the harness is on. The harness's own
 * TaskUpdate(in_progress) is a hint. A commit raises the step to the first
 * step that names commits, because the harness batches its updates at the end.
 */
export function createStepTracker(playbook) {
  const commitStep = playbook.steps.find((s) => COMMIT_STEP.test(s.text))?.n ?? null;
  const harnessTasks = new Map();
  let hinted = null;
  let floor = null;
  let step = null;

  return {
    get step() {
      return step;
    },
    /** @returns {boolean} whether the step changed */
    push(event) {
      if (event.type === 'harness_task' && event.op === 'create') {
        const m = HARNESS_STEP_SUBJECT.exec(event.subject ?? '');
        if (m) harnessTasks.set(event.taskId, Number(m[1]));
      } else if (event.type === 'harness_task' && event.status === 'in_progress' && harnessTasks.has(event.taskId)) {
        hinted = harnessTasks.get(event.taskId);
      } else if (event.type === 'tool_result' && event.evidence?.committed && commitStep != null) {
        floor = commitStep;
      }
      const next = Math.max(hinted ?? 0, floor ?? 0) || null;
      const changed = next !== step;
      step = next;
      return changed;
    },
  };
}
