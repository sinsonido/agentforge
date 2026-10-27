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
      'database:',
      `  path: ${join(dir, 'data.db')}`,
    ].join('\n'));
    forge = await createAgentForge(configPath);
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
});
