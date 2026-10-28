import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentForge } from '../src/index.js';

describe('createAgentForge() persistence wiring', () => {
  let dir;
  let forge;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentforge-wiring-'));
    const configPath = join(dir, 'agentforge.yml');
    writeFileSync(configPath, [
      'project:',
      '  name: wiring',
      'providers:',
      '  ollama:',
      '    enabled: false',
      '  fake:',
      '    enabled: false',
      'models:',
      '  fake-model:',
      '    provider: fake',
      '    tier: 1',
      '    cost_in: 3',
      '    cost_out: 15',
      'database:',
      `  path: ${join(dir, 'data.db')}`,
    ].join('\n'));
    forge = await createAgentForge(configPath);
    forge.providerRegistry.register({
      id: 'fake',
      execute: async () => ({
        content: 'done', tokens_in: 1000, tokens_out: 500, tool_calls: [], finish_reason: 'stop',
      }),
    });
  });

  after(() => {
    forge.eventBus.removeAllListeners();
    forge.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a newly added task in queued status', () => {
    const task = forge.taskQueue.add({ title: 'Persist me' });

    const row = forge.db.getTask(task.id);
    assert.ok(row, 'queued task should be in the DB');
    assert.equal(row.status, 'queued');
    assert.equal(row.title, 'Persist me');
  });

  it('records exactly one cost row per execution', async () => {
    const done = new Promise((resolve) => {
      forge.eventBus.once('task.completed', resolve);
      forge.eventBus.once('task.failed', ({ error }) => resolve(assert.fail(error)));
    });
    forge.taskQueue.add({ title: 'Cost me', agent_id: 'dev', force_model: 'fake-model' });
    forge.orchestrator.start(10);
    await done;
    forge.orchestrator.stop();

    const rows = forge.db.db.prepare('SELECT agent_id, model, tokens_in, tokens_out, cost FROM cost_records').all();
    assert.equal(rows.length, 1, 'one execution should write one cost row');
    const { cost, ...row } = rows[0];
    assert.deepEqual({ ...row }, { agent_id: 'dev', model: 'fake-model', tokens_in: 1000, tokens_out: 500 });
    assert.ok(Math.abs(cost - 0.0105) < 1e-12, `cost ${cost} should be 0.0105`);
  });
});

describe('createAgentForge() restart', () => {
  let dir;
  let configPath;
  let forge;
  let executed;

  async function boot() {
    forge = await createAgentForge(configPath);
    forge.providerRegistry.register({
      id: 'fake',
      execute: async ({ messages }) => {
        executed.push(messages.at(-1).content);
        return { content: 'done', tokens_in: 1, tokens_out: 1, tool_calls: [], finish_reason: 'stop' };
      },
    });
    return forge;
  }

  function stopProcess() {
    forge.orchestrator.stop();
    forge.eventBus.removeAllListeners();
    forge.db.close();
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentforge-restart-'));
    configPath = join(dir, 'agentforge.yml');
    writeFileSync(configPath, [
      'project:',
      '  name: restart',
      'providers:',
      '  ollama:',
      '    enabled: false',
      '  fake:',
      '    enabled: false',
      'models:',
      '  fake-model:',
      '    provider: fake',
      '    tier: 1',
      'database:',
      `  path: ${join(dir, 'data.db')}`,
    ].join('\n'));
    executed = [];

    const q = (await boot()).taskQueue;
    q.add({ id: 'done', title: 'finished before restart', force_model: 'fake-model' });
    q.updateStatus('done', 'completed', { result: 'ok' });
    q.add({ title: 'low', priority: 'low', force_model: 'fake-model' });
    q.add({ title: 'critical', priority: 'critical', force_model: 'fake-model', depends_on: ['done'] });
    q.add({ title: 'high', priority: 'high', force_model: 'fake-model' });
    q.add({ id: 'mid-run', title: 'running at shutdown', force_model: 'fake-model' });
    q.updateStatus('mid-run', 'executing', { model_used: 'fake-model' });
    stopProcess();
  });

  after(() => {
    stopProcess();
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores queued tasks in priority order and fails the interrupted one', async () => {
    const q = (await boot()).taskQueue;

    assert.deepEqual(q.getByStatus('queued').map(t => t.title).sort(), ['critical', 'high', 'low']);
    assert.equal(q.next().title, 'critical', 'a dependency on a completed task stays met');

    const interrupted = forge.db.getTask('mid-run');
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.result, 'interrupted');
    assert.equal(q.get('mid-run').status, 'failed');

    const fresh = q.add({ title: 'after restart', force_model: 'fake-model' });
    assert.equal(fresh.id, 't4', 'generated ids continue after the last persisted one');
    assert.equal(forge.db.getTask('done').status, 'completed');
    stopProcess();
  });

  it('a second boot changes nothing and runs each queued task once', async () => {
    const failedAt = (await boot()).db.getTask('mid-run').completed_at;
    const rowsBefore = forge.db.getTaskHistory(100).length;
    stopProcess();

    await boot();
    assert.equal(forge.db.getTask('mid-run').completed_at, failedAt, 'interrupted task is handled once');
    assert.equal(forge.db.getTaskHistory(100).length, rowsBefore, 'no duplicate rows');

    const drained = new Promise((resolve) => {
      forge.eventBus.on('task.completed', () => {
        if (forge.taskQueue.getByStatus('queued').length === 0) resolve();
      });
    });
    forge.orchestrator.start(5);
    await drained;
    forge.orchestrator.stop();

    assert.equal(executed.length, 4, `ran ${JSON.stringify(executed)}`);
    assert.ok(!executed.some(c => c.includes('running at shutdown')), 'interrupted task never re-runs');
    assert.equal(new Set(executed).size, executed.length, 'no task runs twice');
  });
});
