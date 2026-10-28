import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import defaultEventBus from '../core/event-bus.js';
import { createStepTracker, readPlaybook } from '../core/playbook.js';
import { createWorkspaceManager } from './workspace.js';

const execFileAsync = promisify(execFile);

export const EXECUTOR_DEFAULTS = Object.freeze({
  image: 'node:24',
  model: 'sonnet',
  effort: 'medium',
  budgetUsd: 2,
  timeoutMs: 30 * 60 * 1000,
  dockerBin: 'docker',
  gitAuthor: Object.freeze({ name: 'agentforge', email: 'agentforge@localhost' }),
});

const CONTAINER_HOME = '/home/agent';
const CONTAINER_PSTACK = '/opt/pstack';
const CONTAINER_CLAUDE = '/usr/local/bin/claude';
const OUTPUT_PREVIEW = 4000;
const STDERR_TAIL = 4000;

const DOCKER_CLIENT_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const TEST_COMMAND = /\b(?:npm(?:\s+run)?\s+test|npm\s+t\b|node\s+--test|npx\s+(?:vitest|jest|mocha)|pnpm\s+(?:run\s+)?test|yarn\s+test|pytest|go\s+test|cargo\s+test)/;

/** Test-runner summary lines. The last fail and pass counts printed decide the outcome. */
const TEST_SUMMARIES = [
  { pass: /^\s*ℹ pass (\d+)/gm, fail: /^\s*ℹ fail (\d+)/gm },
  { pass: /^# pass (\d+)/gm, fail: /^# fail (\d+)/gm },
];

/** Shell segments that cannot change tracked files. Anything else counts as an edit. */
const READ_ONLY_SEGMENTS = [
  /^(?:ls|cat|head|tail|grep|rg|wc|echo|printf|pwd|cd|true|which|tree|sort|uniq|cut|diff|stat|file|basename|dirname)\b/,
  /^sed\s+-n\b(?!.*\s-i)/,
  /^git\s+(?:log|status|diff|show|rev-parse|add|commit|branch|blame|ls-files|shortlog)\b/,
  /^npm\s+ci\b/,
  TEST_COMMAND,
];

const COMMIT_COMMAND = /\bgit\s+commit\b/;

function stripQuoted(command) {
  return command
    .replace(/"(?:[^"\\]|\\.)*"/gs, '""')
    .replace(/'[^']*'/g, "''");
}

function shellSegments(command) {
  return stripQuoted(command)
    .replace(/\d?>&\d/g, '')
    .replace(/\d?>\s*\/dev\/null/g, '')
    .replace(/\d?>\s*\/tmp\/\S*/g, '')
    .split(/&&|\|\||[;|\n()]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const isEditSegment = (s) => s.includes('>') || !READ_ONLY_SEGMENTS.some((re) => re.test(s));

function lastCount(output, key) {
  let last = null;
  for (const format of TEST_SUMMARIES) {
    for (const m of output.matchAll(format[key])) {
      if (!last || m.index > last.index) last = { index: m.index, n: Number(m[1]) };
    }
  }
  return last?.n ?? null;
}

function testOutcome(output) {
  const fail = lastCount(output, 'fail');
  const pass = lastCount(output, 'pass');
  return fail === 0 && pass > 0 ? 'passed' : 'failed';
}

/**
 * What a finished tool call proves about the working tree. One Bash call can
 * edit, test and commit in sequence, so `testedAfterEdit` says whether its last
 * test segment runs after its last editing segment.
 * @returns {{ edited: boolean, tested: null|'passed'|'failed', testedAfterEdit: boolean, committed: boolean }}
 */
export function classifyToolCall(name, input, { isError, output }) {
  const none = { edited: false, tested: null, testedAfterEdit: false, committed: false };
  if (EDIT_TOOLS.has(name)) return { ...none, edited: !isError };
  if (name !== 'Bash') return none;
  const command = String(input?.command ?? '');
  const segments = shellSegments(command);
  const lastEdit = segments.findLastIndex(isEditSegment);
  const lastTest = segments.findLastIndex((s) => TEST_COMMAND.test(s));
  return {
    edited: lastEdit >= 0,
    tested: lastTest >= 0 ? (isError ? 'failed' : testOutcome(output)) : null,
    testedAfterEdit: lastTest > lastEdit,
    committed: !isError && COMMIT_COMMAND.test(stripQuoted(command)),
  };
}

function toolOutput(raw, block) {
  const r = raw.tool_use_result;
  if (r && typeof r === 'object' && 'stdout' in r) return [r.stdout, r.stderr].filter(Boolean).join('\n');
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

/**
 * Turns `claude -p --output-format stream-json` lines into typed agent events
 * and keeps the run summary. `seq` is the line index, so it orders every event.
 *
 * AgentEvent:
 *   { seq, type: 'init', sessionId, model, cwd, version }
 *   { seq, type: 'text', text }
 *   { seq, type: 'tool_use', id, name, input }
 *   { seq, type: 'tool_result', id, name, isError, output, evidence: { edited, tested, committed } }
 *   { seq, type: 'harness_task', op: 'create'|'update', taskId, subject?, status? }
 *   { seq, type: 'rate_limit', status, windows: { five_hour?, seven_day? } }
 *   { seq, type: 'result', subtype, isError, sessionId, costUsd, usage, numTurns, durationMs, text }
 */
export function createStreamParser() {
  let seq = -1;
  const pending = new Map();
  const messageUsage = new Map();
  const summary = {
    sessionId: null,
    model: null,
    result: null,
    rateLimits: {},
    observedTestRuns: [],
    lastEditSeq: -1,
  };

  function onToolResult(raw, block) {
    const call = pending.get(block.tool_use_id);
    pending.delete(block.tool_use_id);
    const name = call?.name ?? null;
    const isError = block.is_error === true;
    const output = toolOutput(raw, block);
    const evidence = classifyToolCall(name, call?.input, { isError, output });
    if (evidence.edited) summary.lastEditSeq = seq;
    if (evidence.tested) {
      // Half steps order a test against an edit made by the same command.
      const testSeq = evidence.testedAfterEdit ? seq + 0.5 : seq - 0.5;
      summary.observedTestRuns.push({ seq: testSeq, command: call.input.command, passed: evidence.tested === 'passed' });
    }

    const events = [{ seq, type: 'tool_result', id: block.tool_use_id, name, isError, output: output.slice(0, OUTPUT_PREVIEW), evidence }];
    const r = raw.tool_use_result;
    if (name === 'TaskCreate' && r?.task?.id) {
      events.push({ seq, type: 'harness_task', op: 'create', taskId: String(r.task.id), subject: r.task.subject ?? call.input?.subject });
    } else if (name === 'TaskUpdate' && !isError && call.input?.taskId != null) {
      events.push({ seq, type: 'harness_task', op: 'update', taskId: String(call.input.taskId), status: call.input.status });
    }
    return events;
  }

  function onAssistant(raw) {
    const msg = raw.message ?? {};
    if (msg.id && msg.usage) messageUsage.set(msg.id, msg.usage);
    const events = [];
    for (const block of msg.content ?? []) {
      if (block.type === 'text') events.push({ seq, type: 'text', text: block.text });
      if (block.type === 'tool_use') {
        pending.set(block.id, { name: block.name, input: block.input });
        events.push({ seq, type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
    }
    return events;
  }

  const handlers = {
    system(raw) {
      if (raw.subtype !== 'init') return [];
      summary.sessionId = raw.session_id;
      summary.model = raw.model;
      return [{ seq, type: 'init', sessionId: raw.session_id, model: raw.model, cwd: raw.cwd, version: raw.claude_code_version }];
    },
    assistant: onAssistant,
    user(raw) {
      const content = raw.message?.content;
      if (!Array.isArray(content)) return [];
      return content.filter((b) => b.type === 'tool_result').flatMap((b) => onToolResult(raw, b));
    },
    rate_limit_event(raw) {
      const info = raw.rate_limit_info ?? {};
      const windows = {};
      for (const [key, w] of Object.entries(info.unifiedWindows ?? {})) {
        windows[key] = { utilization: w.utilization, resetsAt: w.resetsAt, status: w.status };
      }
      Object.assign(summary.rateLimits, windows);
      return [{ seq, type: 'rate_limit', status: info.status, windows }];
    },
    result(raw) {
      const event = {
        seq,
        type: 'result',
        subtype: raw.subtype,
        isError: raw.is_error === true,
        sessionId: raw.session_id,
        costUsd: raw.total_cost_usd ?? null,
        usage: raw.usage ?? null,
        numTurns: raw.num_turns ?? null,
        durationMs: raw.duration_ms ?? null,
        text: raw.result ?? null,
      };
      summary.result = event;
      summary.sessionId ??= raw.session_id;
      return [event];
    },
  };

  return {
    /** @returns {Array<object>} the agent events this line produced */
    push(line) {
      if (!line.trim()) return [];
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        return [];
      }
      seq += 1;
      return handlers[raw.type]?.(raw) ?? [];
    },
    /** Usage from the result event, or summed per message when the run never produced one. */
    summary() {
      const usage = summary.result?.usage ?? sumUsage([...messageUsage.values()]);
      return { ...summary, usage, costUsd: summary.result?.costUsd ?? null };
    },
  };
}

function sumUsage(usages) {
  const total = Object.fromEntries(USAGE_KEYS.map((k) => [k, 0]));
  for (const u of usages) for (const k of USAGE_KEYS) total[k] += u[k] ?? 0;
  return total;
}

function playbookTitle(playbook) {
  const words = playbook.replace(/-/g, ' ');
  return words[0].toUpperCase() + words.slice(1);
}

/** The harness prompt for a coding task. */
export function buildPrompt(task) {
  const title = playbookTitle(task.playbook);
  const issue = task.issue != null ? ` (issue #${task.issue})` : '';
  return [
    `/pstack:poteto-mode Work this task with the **${title}** playbook, fully autonomous.`,
    '',
    'Full-autonomy grant: you are running headless under AgentForge. No human will answer. Do not ask questions; decide, act, and report. "Run until done."',
    '',
    `Task${issue}: ${task.instruction}`,
    '',
    'Constraints for this run:',
    `- Work only in the current directory, a git clone on its own branch based on \`${task.base}\`.`,
    '- Node 24 and git are installed here.',
    '- Commit your work on the current branch.',
    '- Do NOT push, do NOT open a PR, do NOT call gh. Replace the "Opening a PR" step with: stop after the commits and report.',
    '- Run the test suite after your last change and before you stop.',
    '',
    `Step tracking (required by the AgentForge host): before any other work, create one task per ${title} playbook step with TaskCreate, subject \`step N: <first words of the step>\`. Mark each step in_progress when you start it and completed (or deleted with a skip reason) with TaskUpdate.`,
  ].join('\n');
}

/**
 * `docker run` arguments for one harness run. The container sees the task
 * clone at its host path, a per-task HOME, and read-only pstack and claude.
 */
export function buildDockerArgs({ task, dir, home, uid, gid, image, claudeBin, pstackDir, model, effort, budgetUsd, gitAuthor, withToken }) {
  const env = {
    HOME: CONTAINER_HOME,
    CLAUDE_CODE_TMPDIR: `${CONTAINER_HOME}/tmp`,
    CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    GIT_AUTHOR_NAME: gitAuthor.name,
    GIT_AUTHOR_EMAIL: gitAuthor.email,
    GIT_COMMITTER_NAME: gitAuthor.name,
    GIT_COMMITTER_EMAIL: gitAuthor.email,
  };
  return [
    'run', '--rm', '--name', containerName(task.id),
    '--user', `${uid}:${gid}`,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...(withToken ? ['-e', 'CLAUDE_CODE_OAUTH_TOKEN'] : []),
    '-v', `${home}:${CONTAINER_HOME}`,
    '-v', `${claudeBin}:${CONTAINER_CLAUDE}:ro`,
    '-v', `${pstackDir}:${CONTAINER_PSTACK}:ro`,
    '-v', `${dir}:${dir}`,
    '-w', dir,
    image,
    'claude', '-p', buildPrompt(task),
    '--output-format', 'stream-json', '--verbose',
    '--setting-sources', 'project,local',
    '--plugin-dir', CONTAINER_PSTACK,
    '--strict-mcp-config',
    '--model', model,
    '--effort', effort,
    '--max-budget-usd', String(budgetUsd),
    '--permission-mode', 'bypassPermissions',
  ];
}

export const containerName = (taskId) => `af-task-${taskId}`;

/**
 * Pick the harness credential. An OAuth token reaches the container by name
 * through the docker client env, so it never appears in argv. Otherwise the
 * credentials file is copied into the per-task HOME and removed after the run.
 */
async function stageCredentials(home, { oauthToken, credentialsFile }) {
  if (oauthToken) return { token: oauthToken, remove: async () => {} };
  const target = join(home, '.claude', '.credentials.json');
  await mkdir(join(home, '.claude'), { recursive: true, mode: 0o700 });
  try {
    await copyFile(credentialsFile, target);
  } catch (err) {
    throw new Error('no harness credentials: set CLAUDE_CODE_OAUTH_TOKEN or provide a credentials file', { cause: err });
  }
  return { token: null, remove: () => rm(target, { force: true }) };
}

function dockerClientEnv(token) {
  const env = Object.fromEntries(DOCKER_CLIENT_ENV.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

async function trackedChanges(dir) {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dir });
  return stdout.trim() !== '';
}

function runContainer({ dockerBin, args, env, name, timeoutMs, signal, onLine }) {
  return new Promise((resolve) => {
    const child = spawn(dockerBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let cancelReason = null;
    let stderr = '';
    let spawnError = null;
    let stopped = Promise.resolve();

    const stop = (reason) => {
      if (cancelReason) return;
      cancelReason = reason;
      child.kill('SIGTERM');
      stopped = new Promise((r) => execFile(dockerBin, ['stop', '-t', '10', name], { env }, () => r()));
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = () => stop('signal');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', onLine);
    child.on('error', (err) => { spawnError = err; });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stopped.then(() => resolve({ exitCode, cancelReason, stderr, spawnError }));
    });
  });
}

/**
 * Run the coding harness for one task in a per-task container.
 *
 * outcome 'stopped' only means the harness ended its turn. Whether the task is
 * done is decided from `commits` and `observedTestRuns` by the evidence gate.
 * A 'cancelled' run must never open a PR.
 *
 * @returns {Promise<{
 *   outcome: 'stopped'|'cancelled'|'error', cancelReason: null|'timeout'|'signal', error: string|null,
 *   exitCode: number|null, sessionId: string|null, usage: object, costUsd: number|null,
 *   rateLimits: object, commits: Array<{ sha: string, subject: string }>, uncommitted: boolean,
 *   observedTestRuns: Array<{ seq: number, command: string, passed: boolean }>, lastEditSeq: number,
 *   branch: string, dir: string }>}
 */
export async function run(task, opts = {}) {
  if (task?.kind !== 'coding') throw new Error('coding executor runs only coding tasks');
  if (!opts.stateDir) throw new Error('stateDir is required');
  if (!opts.pstackDir) throw new Error('pstackDir is required');
  const o = { ...EXECUTOR_DEFAULTS, ...opts };
  const eventBus = o.eventBus ?? defaultEventBus;
  const budgetUsd = task.budget ?? o.budgetUsd;

  const workspace = createWorkspaceManager({ stateDir: o.stateDir });
  const { dir, home, branch } = await workspace.prepare({
    taskId: task.id,
    repo: { slug: task.repo, ...(o.repoUrl && { url: o.repoUrl }) },
    base: task.base,
  });
  await mkdir(join(home, 'tmp'), { recursive: true });

  const parser = createStreamParser();
  const steps = createStepTracker(await readPlaybook(o.pstackDir, task.playbook));
  const name = containerName(task.id);
  const credentials = await stageCredentials(home, {
    oauthToken: o.oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN,
    credentialsFile: o.credentialsFile ?? join(homedir(), '.claude', '.credentials.json'),
  });
  const env = dockerClientEnv(credentials.token);

  let exit;
  try {
    if (o.signal?.aborted) {
      exit = { exitCode: null, cancelReason: 'signal', stderr: '', spawnError: null };
    } else {
      await new Promise((r) => execFile(o.dockerBin, ['rm', '-f', name], { env }, () => r()));
      const args = buildDockerArgs({
        task, dir, home,
        uid: o.uid ?? process.getuid(),
        gid: o.gid ?? process.getgid(),
        image: o.image,
        claudeBin: o.claudeBin ?? await realpath(join(homedir(), '.local', 'bin', 'claude')),
        pstackDir: o.pstackDir,
        model: o.model,
        effort: o.effort,
        budgetUsd,
        gitAuthor: o.gitAuthor,
        withToken: credentials.token != null,
      });
      exit = await runContainer({
        dockerBin: o.dockerBin, args, env, name, timeoutMs: o.timeoutMs, signal: o.signal,
        onLine: (line) => {
          for (const event of parser.push(line)) {
            eventBus.emit('task.agent_event', { taskId: task.id, event });
            if (steps.push(event)) {
              task.step = steps.step;
              eventBus.emit('task.step_changed', { taskId: task.id, step: steps.step });
            }
          }
        },
      });
    }
  } finally {
    await credentials.remove();
  }

  const summary = parser.summary();
  const commits = await workspace.evidence(dir, task.base);
  const uncommitted = await trackedChanges(dir);
  const { outcome, error } = decideOutcome(exit, summary.result);

  return {
    outcome,
    cancelReason: exit.cancelReason,
    error,
    exitCode: exit.exitCode,
    sessionId: summary.sessionId,
    usage: summary.usage,
    costUsd: summary.costUsd,
    rateLimits: summary.rateLimits,
    commits,
    uncommitted,
    observedTestRuns: summary.observedTestRuns,
    lastEditSeq: summary.lastEditSeq,
    step: steps.step,
    branch,
    dir,
  };
}

function decideOutcome(exit, result) {
  if (exit.cancelReason) return { outcome: 'cancelled', error: null };
  if (exit.spawnError) return { outcome: 'error', error: `could not start ${exit.spawnError.path}: ${exit.spawnError.code}` };
  if (!result) return { outcome: 'error', error: `harness exited ${exit.exitCode} without a result: ${exit.stderr.trim()}` };
  if (result.isError || result.subtype !== 'success') return { outcome: 'error', error: `harness result ${result.subtype}` };
  return { outcome: 'stopped', error: null };
}
