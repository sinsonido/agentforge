import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntake, playbookFor, MARKER } from '../../src/core/intake.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { AgentForgeDB } from '../../src/persistence/db.js';

const INTAKE = {
  repos: [{ repo: 'acme/app', base: 'master' }],
  label: 'agentforge',
  interval_seconds: 60,
  default_playbook: 'feature',
};

const labels = (...names) => names.map((name) => ({ name }));

function fakeGitHub(issuesByRepo) {
  const calls = [];
  const state = { issuesByRepo, failComments: 0, failList: new Set() };
  const run = async (cmd, args) => {
    calls.push(args);
    const repo = args[args.indexOf('--repo') + 1];
    if (args[1] === 'list') {
      if (state.failList.has(repo)) throw new Error('gh: HTTP 502');
      return JSON.stringify(state.issuesByRepo[repo] ?? []);
    }
    if (args[1] === 'comment') {
      if (state.failComments > 0) {
        state.failComments--;
        throw new Error('gh: HTTP 502');
      }
      const issue = state.issuesByRepo[repo].find((i) => i.number === Number(args[2]));
      issue.comments.push({ body: args[args.indexOf('--body') + 1] });
      return `https://github.com/${repo}/issues/${args[2]}#issuecomment-1`;
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const comments = () => calls.filter((a) => a[1] === 'comment');
  return { run, calls, state, comments };
}

const issue = (number, title, labelNames, comments = []) =>
  ({ number, title, body: `Body of ${number}`, labels: labels('agentforge', ...labelNames), comments });

const quiet = { warn() {} };

describe('playbookFor', () => {
  it('maps labels through the table and falls back to the default', () => {
    assert.equal(playbookFor(labels('bug'), 'feature'), 'bug-fix');
    assert.equal(playbookFor(labels('enhancement'), 'bug-fix'), 'feature');
    assert.equal(playbookFor(labels('refactor'), 'feature'), 'refactoring');
    assert.equal(playbookFor(labels('docs'), 'investigation'), 'investigation');
    assert.equal(playbookFor(labels('enhancement', 'bug'), 'feature'), 'bug-fix');
  });
});

describe('intake', () => {
  let dir;
  let db;
  let gh;

  const boot = () => {
    db = new AgentForgeDB(join(dir, 'data.db'));
    const queue = new TaskQueue({ store: db });
    return { queue, intake: createIntake({ intake: INTAKE, queue, run: gh.run, log: quiet }) };
  };

  beforeEach(() => {
    db = null;
    dir = mkdtempSync(join(tmpdir(), 'agentforge-intake-'));
    gh = fakeGitHub({ 'acme/app': [issue(7, 'Crash on save', ['bug']), issue(8, 'Dark mode', [])] });
  });

  afterEach(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('admits one coding task per labelled issue and comments its id once', async () => {
    const { queue, intake } = boot();
    await intake.pollOnce();

    const list = gh.calls.find((a) => a[1] === 'list');
    assert.deepEqual(list.slice(0, 9), ['issue', 'list', '--repo', 'acme/app', '--label', 'agentforge', '--state', 'open', '--limit']);

    const tasks = queue.getAll();
    assert.deepEqual(tasks.map((t) => [t.kind, t.repo, t.base, t.issue, t.playbook]), [
      ['coding', 'acme/app', 'master', 7, 'bug-fix'],
      ['coding', 'acme/app', 'master', 8, 'feature'],
    ]);
    assert.equal(tasks[0].title, '#7 Crash on save');
    assert.equal(tasks[0].instruction, 'Crash on save\n\nBody of 7');
    assert.deepEqual([tasks[0].setup_command, tasks[0].test_command], ['npm ci', 'npm test']);

    const comments = gh.comments();
    assert.equal(comments.length, 2);
    assert.equal(comments[0][2], '7');
    assert.match(comments[0].at(-1), new RegExp(`task \`${tasks[0].id}\``));
    assert.ok(comments[0].at(-1).includes(MARKER));
  });

  it('adds no task and no comment on a second poll', async () => {
    const { queue, intake } = boot();
    await intake.pollOnce();
    await intake.pollOnce();
    assert.equal(queue.getAll().length, 2);
    assert.equal(gh.comments().length, 2);
  });

  it('adds no task and no comment after a restart', async () => {
    await boot().intake.pollOnce();
    db.close();

    const { queue, intake } = boot();
    await intake.pollOnce();
    assert.equal(queue.getAll().length, 2, 'tasks restored from SQLite, none added');
    assert.equal(gh.comments().length, 2);
  });

  it('posts the missing comment once, on the same task, after a failed comment and a restart', async () => {
    gh.state.failComments = 1;
    const first = boot();
    await first.intake.pollOnce();
    const id7 = first.queue.getAll().find((t) => t.issue === 7).id;
    assert.equal(gh.comments().length, 2, 'one failed, one posted');
    db.close();

    const { queue, intake } = boot();
    await intake.pollOnce();
    await intake.pollOnce();
    assert.equal(queue.getAll().length, 2);
    const posted = gh.state.issuesByRepo['acme/app'].find((i) => i.number === 7).comments;
    assert.equal(posted.length, 1);
    assert.match(posted[0].body, new RegExp(`task \`${id7}\``));
  });

  it('does not take an issue again after its task ends or its labels change', async () => {
    const { queue, intake } = boot();
    await intake.pollOnce();
    for (const t of queue.getAll()) queue.updateStatus(t.id, 'completed');
    gh.state.issuesByRepo['acme/app'][0].labels = labels('agentforge', 'enhancement');

    await intake.pollOnce();
    assert.equal(queue.getAll().length, 2);
    assert.equal(gh.comments().length, 2);
  });

  it('keeps polling other repos when one fails', async () => {
    gh.state.issuesByRepo['acme/lib'] = [issue(3, 'Typo', [])];
    gh.state.failList.add('acme/app');
    const queue = new TaskQueue();
    const intake = createIntake({
      intake: { ...INTAKE, repos: [...INTAKE.repos, { repo: 'acme/lib', base: 'main' }] },
      queue, run: gh.run, log: quiet,
    });
    await intake.pollOnce();
    assert.deepEqual(queue.getAll().map((t) => [t.repo, t.issue]), [['acme/lib', 3]]);
  });

  it('carries each repo\'s configured setup and test commands onto its tasks', async () => {
    gh.state.issuesByRepo['acme/lib'] = [issue(3, 'Typo', [])];
    const queue = new TaskQueue();
    const intake = createIntake({
      intake: { ...INTAKE, repos: [...INTAKE.repos, { repo: 'acme/lib', base: 'main', setup_command: 'make deps', test_command: 'make check' }] },
      queue, run: gh.run, log: quiet,
    });
    await intake.pollOnce();
    const lib = queue.getAll().find((t) => t.repo === 'acme/lib');
    assert.deepEqual([lib.setup_command, lib.test_command], ['make deps', 'make check']);
  });

  it('polls on start, again after the interval, and not after stop', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const queue = new TaskQueue();
    const intake = createIntake({ intake: INTAKE, queue, run: gh.run, log: quiet });
    const lists = () => gh.calls.filter((a) => a[1] === 'list').length;
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    intake.start();
    await settle();
    assert.equal(lists(), 1);

    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(lists(), 2);

    intake.stop();
    t.mock.timers.tick(120_000);
    await settle();
    assert.equal(lists(), 2);
  });
});
