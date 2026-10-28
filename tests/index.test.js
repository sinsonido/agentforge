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
      '    enabled: true',
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
