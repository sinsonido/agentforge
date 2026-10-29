import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The decision trail of one task: an append-only list of what happened to it
 * and why, kept so a reviewer can trust the PR without replaying the run.
 *
 * Each kind has one source:
 * - status: every TaskQueue transition, with the reason when it ended badly.
 * - step: the playbook step tracker.
 * - gate: each check of the evidence gate, pass or fail and why.
 * - decision: rows of the agent's show-me-your-work log in the clone, and
 *   playbook steps the agent skipped.
 * - evidence: commits, the accepted test run, the PR.
 *
 * @typedef {'status'|'step'|'gate'|'decision'|'evidence'} TrailKind
 * @typedef {{ kind: TrailKind, summary: string, evidence: object|null }} TrailInput
 * @typedef {TrailInput & { seq: number, at: number }} TrailEntry
 */

export const TRAIL_KINDS = Object.freeze(['status', 'step', 'gate', 'decision', 'evidence']);

const SUMMARY_MAX = 300;
const VALUE_MAX = 500;
const DECISION_ROWS_MAX = 100;
const KEY_DECISIONS = 10;

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Bound one entry before it is stored: short summary, short string values. */
export function boundEntry({ kind, summary, evidence = null }) {
  if (!TRAIL_KINDS.includes(kind)) throw new Error(`unknown trail kind: ${kind}`);
  const bounded = evidence && Object.fromEntries(
    Object.entries(evidence).map(([k, v]) => [k, typeof v === 'string' ? clip(v, VALUE_MAX) : v]),
  );
  return { kind, summary: clip(String(summary).replace(/\s+/g, ' ').trim(), SUMMARY_MAX), evidence: bounded };
}

/** @returns {TrailInput} */
export function statusEntry(from, to, reason = null) {
  return {
    kind: 'status',
    summary: from ? `${from} → ${to}${reason ? `: ${reason}` : ''}` : to,
    evidence: { from, to, ...(reason && { reason }) },
  };
}

/** @returns {TrailInput[]} one entry per evidence-gate check */
export function gateEntries(verdict) {
  return verdict.checks.map(({ gate, pass, why }) => ({
    kind: 'gate',
    summary: `${pass ? 'pass' : 'fail'} ${gate}: ${why}`,
    evidence: { gate, pass },
  }));
}

/** @returns {TrailInput[]} the commits and the test run a passing gate accepted */
export function verdictEvidence(verdict) {
  const commits = verdict.commits.map(({ sha, subject }) => ({
    kind: 'evidence',
    summary: `commit ${sha.slice(0, 7)} ${subject}`,
    evidence: { sha },
  }));
  const { testRun } = verdict;
  const tests = testRun ? [{
    kind: 'evidence',
    summary: `\`${testRun.command}\` passed at ${testRun.sha.slice(0, 7)}`,
    evidence: { command: testRun.command, sha: testRun.sha, ...(testRun.counts && { counts: testRun.counts }) },
  }] : [];
  return [...commits, ...tests];
}

/** @returns {TrailInput} */
export const prEntry = (url) => ({ kind: 'evidence', summary: `PR ${url}`, evidence: { url } });

/**
 * Follows the agent stream for trail entries: step changes, named with the
 * subject the agent gave the step's harness task, and steps it deleted, which
 * poteto-mode means as skipped with a reason.
 */
export function createStreamTrail() {
  const subjects = new Map();
  const stepOf = new Map();

  return {
    /** @returns {TrailInput[]} */
    push(event) {
      if (event.type === 'harness_task' && event.op === 'create' && event.subject) {
        subjects.set(event.taskId, event.subject);
        const m = /^step\s+(\d+)\b/i.exec(event.subject);
        if (m) stepOf.set(Number(m[1]), event.subject);
        return [];
      }
      if (event.type === 'tool_use' && event.name === 'TaskUpdate' && event.input?.status === 'deleted') {
        const subject = subjects.get(String(event.input.taskId)) ?? `harness task ${event.input.taskId}`;
        const why = event.input.description ?? event.input.activeForm ?? null;
        return [{
          kind: 'decision',
          summary: `skipped ${subject}${why ? `: ${why}` : ''}`,
          evidence: { source: 'stream', ...(why && { why }) },
        }];
      }
      return [];
    },
    /** @returns {TrailInput} */
    step(n) {
      return { kind: 'step', summary: stepOf.get(n) ?? `step ${n}`, evidence: { step: n } };
    },
  };
}

/**
 * Parse a show-me-your-work decision log (TSV with a header row naming the
 * columns ts, phase, decision, why, evidence, result) into decision entries.
 * @returns {TrailInput[]}
 */
export function parseDecisionLog(text, source) {
  const [header, ...rows] = text.split('\n').filter((l) => l.trim());
  const columns = (header ?? '').split('\t').map((c) => c.trim().toLowerCase());
  if (!columns.includes('decision')) return [];
  return rows.slice(0, DECISION_ROWS_MAX).flatMap((line) => {
    const cell = Object.fromEntries(line.split('\t').map((v, i) => [columns[i], v.trim()]));
    if (!cell.decision) return [];
    const evidence = { source, ...['ts', 'phase', 'why', 'evidence', 'result'].reduce((o, k) => (cell[k] ? { ...o, [k]: cell[k] } : o), {}) };
    return [{ kind: 'decision', summary: cell.decision, evidence }];
  });
}

/**
 * Read the decision logs the agent left in its clone, where show-me-your-work
 * keeps them: `decisions.tsv` at the root, or `.audit/<slug>.tsv`.
 * @returns {Promise<TrailInput[]>}
 */
export async function readDecisionLogs(dir) {
  const audit = await readdir(join(dir, '.audit')).catch(() => []);
  const files = ['decisions.tsv', ...audit.filter((f) => f.endsWith('.tsv')).sort().map((f) => join('.audit', f))];
  const logs = await Promise.all(files.map(async (f) => {
    const text = await readFile(join(dir, f), 'utf8').catch(() => null);
    return text == null ? [] : parseDecisionLog(text, f);
  }));
  return logs.flat().slice(0, DECISION_ROWS_MAX);
}

/** Agent-written text in a PR body: no HTML, no @mentions, no table breaks. */
const inert = (s) => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/</g, '&lt;')
  .replace(/@(?=\w)/g, '@&#8203;')
  .replace(/\|/g, '\\|');

function decisionLine({ summary, evidence }) {
  const e = evidence ?? {};
  const parts = [
    `${e.phase ? `**${inert(e.phase)}** ` : ''}${inert(summary)}.`,
    e.why && `Why: ${inert(e.why)}.`,
    e.evidence && `Evidence: ${inert(e.evidence)}.`,
    e.result && `Result: ${inert(e.result)}.`,
  ];
  return `- ${parts.filter(Boolean).join(' ')}`;
}

const utc = (at) => new Date(at).toISOString().slice(11, 19);

/**
 * The trail as a PR description section: gates and key decisions in the open,
 * everything else collapsed.
 * @param {TrailEntry[]} entries
 */
export function renderTrail(entries) {
  if (!entries.length) return '';
  const of = (kind) => entries.filter((e) => e.kind === kind);
  const gates = of('gate');
  const decisions = of('decision');
  const lines = ['## Decision trail', ''];

  if (gates.length) {
    lines.push('**Evidence gate**', '', ...gates.map((g) => `- ${g.evidence?.pass ? 'pass' : '**fail**'} ${inert(g.summary.replace(/^(pass|fail) /, ''))}`), '');
  }
  lines.push('**Decisions**', '');
  if (!decisions.length) lines.push('The agent left no decision log.');
  lines.push(...decisions.slice(0, KEY_DECISIONS).map(decisionLine), '');
  if (decisions.length > KEY_DECISIONS) {
    lines.push(`<details><summary>${decisions.length - KEY_DECISIONS} more decisions</summary>`, '',
      ...decisions.slice(KEY_DECISIONS).map(decisionLine), '', '</details>', '');
  }
  lines.push(`<details><summary>Full trail (${entries.length} entries)</summary>`, '',
    '| # | UTC | kind | summary |', '|---|---|---|---|',
    ...entries.map((e) => `| ${e.seq} | ${utc(e.at)} | ${e.kind} | ${inert(e.summary)} |`),
    '', '</details>');
  return lines.join('\n');
}
