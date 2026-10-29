import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentForgeDB } from '../src/persistence/db.js';
import { TaskQueue } from '../src/core/task-queue.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests', 'fixtures');

async function waitFor(predicate, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const git = (args, cwd) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' });

describe('agentforge start shutdown', () => {
  let tmp;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'agentforge-shutdown-'));
    const upstream = join(tmp, 'upstream');
    mkdirSync(upstream);
    git(['init', '-q', '-b', 'master'], upstream);
    writeFileSync(join(upstream, 'README.md'), 'app\n');
    git(['add', 'README.md'], upstream);
    git(['commit', '-q', '-m', 'init'], upstream);
    mkdirSync(join(tmp, 'state', 'mirrors'), { recursive: true });
    git(['clone', '-q', '--mirror', upstream, join(tmp, 'state', 'mirrors', 'acme__app.git')]);
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  for (const signal of ['SIGINT', 'SIGTERM']) {
    it(`${signal} stops the running task container and the task ends cancelled`, async () => {
      const dir = join(tmp, signal);
      mkdirSync(dir);
      const docker = join(dir, 'docker');
      copyFileSync(join(fixtures, 'fake-docker.mjs'), docker);
      chmodSync(docker, 0o755);
      writeFileSync(join(dir, 'fake-docker.json'), JSON.stringify({
        mode: 'hang', stream: join(fixtures, 'agent-streams', 'cancelled.jsonl'), linesBeforeHang: 3,
      }));
      const dbPath = join(dir, 'agentforge.db');
      const configPath = join(dir, 'agentforge.yml');
      writeFileSync(configPath, [
        'providers:',
        '  ollama:',
        '    enabled: false',
        'database:',
        `  path: ${dbPath}`,
        'intake:',
        '  interval_seconds: 3600',
        '  repos:',
        '    - repo: acme/app',
        '      base: master',
        'executor:',
        `  state_dir: ${join(tmp, 'state')}`,
        `  pstack_dir: ${join(fixtures, 'pstack')}`,
        `  docker_bin: ${docker}`,
        '  claude_bin: /bin/claude',
        '  oauth_token: tok',
      ].join('\n'));

      const seed = new AgentForgeDB(dbPath);
      const task = new TaskQueue({ store: seed }).add({
        title: 'Fix it', kind: 'coding', repo: 'acme/app', base: 'master', instruction: 'Fix it', playbook: 'bug-fix', issue: 1,
      });
      seed.close();

      const child = spawn(process.execPath, [join(root, 'src', 'cli.js'), '--config', configPath, 'start', '--no-dashboard'], {
        cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
      let output = '';
      child.stdout.on('data', (d) => { output += d; });
      child.stderr.on('data', (d) => { output += d; });
      const exited = new Promise((r) => child.on('exit', (code) => r(code)));
      const calls = () => (existsSync(join(dir, 'calls.jsonl'))
        ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : []);

      try {
        await waitFor(() => output.includes(`[coding] ${task.id}`));
        child.kill(signal);
        assert.equal(await exited, 0, output);
      } finally {
        child.kill('SIGKILL');
      }

      assert.ok(calls().some((c) => c.args?.join(' ') === `stop -t 10 af-task-${task.handle}`), 'the task container was stopped');
      const db = new AgentForgeDB(dbPath);
      const row = db.getTask(task.id);
      db.close();
      assert.equal(row.status, 'cancelled', output);
      assert.equal(row.pr_url ?? null, null);
    });
  }
});
