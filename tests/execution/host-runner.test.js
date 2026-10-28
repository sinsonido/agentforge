import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostRunner } from '../../src/execution/host-runner.js';

describe('hostRunner', () => {
  it('returns the trimmed stdout of the command', async () => {
    assert.match(await hostRunner('git', ['--version']), /^git version \S+$/);
  });

  it('runs in cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'host-runner-'));
    try {
      await hostRunner('git', ['init', '-q'], { cwd: dir });
      assert.equal(await hostRunner('git', ['rev-parse', '--git-dir'], { cwd: dir }), '.git');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the command and its first two arguments when it fails', async () => {
    await assert.rejects(hostRunner('git', ['no-such-cmd', 'x', 'y']), /^Error: git no-such-cmd x failed: /);
  });
});
