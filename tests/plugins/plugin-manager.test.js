/**
 * @file tests/plugins/plugin-manager.test.js
 * @description Unit tests for src/plugins/plugin-manager.js —
 *   PluginManager and BasePlugin.
 *
 * Uses real temporary ES-module plugin files written to /tmp so that
 * import() can load them.  All temp files are cleaned up in after().
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PluginManager, BasePlugin } from '../../src/plugins/plugin-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

/** Write a temporary ES-module plugin file and return its file:// URL. */
function writeTmpPlugin(filename, content) {
  const filePath = join(tmpDir, filename);
  writeFileSync(filePath, content, 'utf-8');
  // import() requires an absolute path or a URL on all platforms
  return `file://${filePath}`;
}

/** Create a minimal forge stub with an eventBus. */
function makeForge() {
  const eventBus = new EventEmitter();
  eventBus.getRecentEvents = () => [];
  return {
    eventBus,
    providerRegistry: {
      _providers: new Map(),
      register(p) { this._providers.set(p.id, p); },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PluginManager', () => {
  before(() => {
    tmpDir = join(tmpdir(), `agentforge-plugin-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  let forge;
  let manager;

  beforeEach(() => {
    forge = makeForge();
    manager = new PluginManager({ forge });
  });

  // ── load() ─────────────────────────────────────────────────────────────

  describe('load()', () => {
    it('loads a valid plugin and returns its manifest', async () => {
      const url = writeTmpPlugin('valid-plugin.mjs', `
        export default function(forge) {
          return { name: 'my-plugin', version: '1.2.3', init: async () => {} };
        }
      `);
      const manifest = await manager.load(url);
      assert.equal(manifest.name, 'my-plugin');
      assert.equal(manifest.version, '1.2.3');
    });

    it('defaults version to 0.0.0 when not specified', async () => {
      const url = writeTmpPlugin('no-version.mjs', `
        export default function(forge) {
          return { name: 'no-version-plugin' };
        }
      `);
      const manifest = await manager.load(url);
      assert.equal(manifest.version, '0.0.0');
    });

    it('throws when module cannot be found', async () => {
      await assert.rejects(
        () => manager.load('file:///nonexistent/path/plugin.mjs'),
        /Cannot import plugin/,
      );
    });

    it('throws when module does not export a default function', async () => {
      const url = writeTmpPlugin('no-default.mjs', `
        export const notAFunction = 42;
      `);
      await assert.rejects(
        () => manager.load(url),
        /must export a default function/,
      );
    });

    it('throws when factory returns a non-object', async () => {
      const url = writeTmpPlugin('null-factory.mjs', `
        export default function(forge) { return null; }
      `);
      await assert.rejects(
        () => manager.load(url),
        /must return an object/,
      );
    });

    it('throws when plugin has no name property', async () => {
      const url = writeTmpPlugin('no-name.mjs', `
        export default function(forge) { return { version: '1.0.0' }; }
      `);
      await assert.rejects(
        () => manager.load(url),
        /must have a non-empty string "name"/,
      );
    });

    it('throws when plugin name is empty string', async () => {
      const url = writeTmpPlugin('empty-name.mjs', `
        export default function(forge) { return { name: '' }; }
      `);
      await assert.rejects(
        () => manager.load(url),
        /must have a non-empty string "name"/,
      );
    });

    it('throws when a plugin with the same name is already loaded', async () => {
      const content = `export default function(forge) { return { name: 'dup-plugin' }; }`;
      const url1 = writeTmpPlugin('dup1.mjs', content);
      const url2 = writeTmpPlugin('dup2.mjs', content);

      await manager.load(url1);
      await assert.rejects(
        () => manager.load(url2),
        /already loaded/,
      );
    });

    it('calls init() if defined on the plugin', async () => {
      let initCalled = false;
      const url = writeTmpPlugin('init-plugin.mjs', `
        export default function(forge) {
          return {
            name: 'init-plugin',
            async init() { globalThis.__initCalled = true; },
          };
        }
      `);
      await manager.load(url);
      // The init() sets globalThis.__initCalled
      assert.equal(globalThis.__initCalled, true);
      delete globalThis.__initCalled;
    });

    it('emits plugin.loaded event with name and version', async () => {
      let loadedEvent = null;
      forge.eventBus.once('plugin.loaded', (data) => { loadedEvent = data; });

      const url = writeTmpPlugin('event-plugin.mjs', `
        export default function(forge) {
          return { name: 'event-plugin', version: '2.0.0' };
        }
      `);
      await manager.load(url);

      assert.ok(loadedEvent, 'plugin.loaded should be emitted');
      assert.equal(loadedEvent.name, 'event-plugin');
      assert.equal(loadedEvent.version, '2.0.0');
    });

    it('stores the plugin so get() can retrieve it', async () => {
      const url = writeTmpPlugin('storable.mjs', `
        export default function(forge) { return { name: 'storable' }; }
      `);
      await manager.load(url);
      const entry = manager.get('storable');
      assert.ok(entry, 'entry should exist');
      assert.equal(entry.manifest.name, 'storable');
    });
  });

  // ── loadAll() ──────────────────────────────────────────────────────────

  describe('loadAll()', () => {
    it('returns an empty array for empty input', async () => {
      const result = await manager.loadAll([]);
      assert.deepEqual(result, []);
    });

    it('returns an empty array for non-array input', async () => {
      const result = await manager.loadAll(null);
      assert.deepEqual(result, []);
    });

    it('loads multiple plugins and returns all manifests', async () => {
      const urls = [
        writeTmpPlugin('multi-a.mjs', `export default () => ({ name: 'multi-a' })`),
        writeTmpPlugin('multi-b.mjs', `export default () => ({ name: 'multi-b', version: '3.0.0' })`),
      ];
      const manifests = await manager.loadAll(urls);
      assert.equal(manifests.length, 2);
      assert.equal(manifests[0].name, 'multi-a');
      assert.equal(manifests[1].name, 'multi-b');
    });

    it('re-throws on first failure so the caller can abort startup', async () => {
      const urls = [
        writeTmpPlugin('ok-plugin.mjs', `export default () => ({ name: 'ok-plugin' })`),
        'file:///does-not-exist.mjs',
      ];
      await assert.rejects(
        () => manager.loadAll(urls),
        /Cannot import plugin/,
      );
    });
  });

  // ── get() and list() ───────────────────────────────────────────────────

  describe('get()', () => {
    it('returns undefined for an unknown plugin name', () => {
      assert.equal(manager.get('nonexistent'), undefined);
    });
  });

  describe('list()', () => {
    it('returns an empty array when no plugins are loaded', () => {
      assert.deepEqual(manager.list(), []);
    });

    it('returns manifests for all loaded plugins', async () => {
      const urls = [
        writeTmpPlugin('list-a.mjs', `export default () => ({ name: 'list-a', version: '1.0.0' })`),
        writeTmpPlugin('list-b.mjs', `export default () => ({ name: 'list-b', version: '2.0.0' })`),
      ];
      await manager.loadAll(urls);

      const list = manager.list();
      assert.equal(list.length, 2);
      const names = list.map(p => p.name);
      assert.ok(names.includes('list-a'));
      assert.ok(names.includes('list-b'));
    });
  });

  // ── unload() ───────────────────────────────────────────────────────────

  describe('unload()', () => {
    it('throws when the plugin is not loaded', async () => {
      await assert.rejects(
        () => manager.unload('ghost'),
        /is not loaded/,
      );
    });

    it('removes the plugin from the registry', async () => {
      const url = writeTmpPlugin('to-unload.mjs', `export default () => ({ name: 'to-unload' })`);
      await manager.load(url);

      assert.ok(manager.get('to-unload'));
      await manager.unload('to-unload');
      assert.equal(manager.get('to-unload'), undefined);
    });

    it('calls destroy() on the plugin if defined', async () => {
      const url = writeTmpPlugin('destroy-plugin.mjs', `
        export default function() {
          return {
            name: 'destroy-plugin',
            async destroy() { globalThis.__destroyCalled = true; },
          };
        }
      `);
      await manager.load(url);
      await manager.unload('destroy-plugin');

      assert.equal(globalThis.__destroyCalled, true);
      delete globalThis.__destroyCalled;
    });

    it('emits plugin.unloaded event', async () => {
      let unloadedEvent = null;
      const url = writeTmpPlugin('unload-event.mjs', `
        export default () => ({ name: 'unload-event', version: '5.0.0' })
      `);
      await manager.load(url);

      forge.eventBus.once('plugin.unloaded', (data) => { unloadedEvent = data; });
      await manager.unload('unload-event');

      assert.ok(unloadedEvent, 'plugin.unloaded should be emitted');
      assert.equal(unloadedEvent.name, 'unload-event');
      assert.equal(unloadedEvent.version, '5.0.0');
    });

    it('still removes the plugin even if destroy() throws', async () => {
      const url = writeTmpPlugin('bad-destroy.mjs', `
        export default () => ({
          name: 'bad-destroy',
          async destroy() { throw new Error('destroy failed'); },
        })
      `);
      await manager.load(url);
      // Should not throw
      await assert.doesNotReject(() => manager.unload('bad-destroy'));
      assert.equal(manager.get('bad-destroy'), undefined);
    });

    it('allows reloading a plugin after it has been unloaded', async () => {
      const url = writeTmpPlugin('reload-me.mjs', `
        export default () => ({ name: 'reload-me' })
      `);
      await manager.load(url);
      await manager.unload('reload-me');
      // Second load should succeed
      const manifest = await manager.load(url);
      assert.equal(manifest.name, 'reload-me');
    });
  });
});

// ---------------------------------------------------------------------------

describe('BasePlugin', () => {
  let forge;

  beforeEach(() => {
    forge = makeForge();
  });

  it('has default name "unnamed-plugin"', () => {
    const p = new BasePlugin(forge);
    assert.equal(p.name, 'unnamed-plugin');
  });

  it('has default version "0.0.0"', () => {
    const p = new BasePlugin(forge);
    assert.equal(p.version, '0.0.0');
  });

  it('init() resolves without error by default', async () => {
    const p = new BasePlugin(forge);
    await assert.doesNotReject(() => p.init());
  });

  it('destroy() resolves without error by default', async () => {
    const p = new BasePlugin(forge);
    await assert.doesNotReject(() => p.destroy());
  });

  describe('registerProvider()', () => {
    it('registers a provider with forge.providerRegistry', () => {
      const p = new BasePlugin(forge);
      const fakeProvider = { id: 'test-provider' };
      p.registerProvider(fakeProvider);
      assert.equal(forge.providerRegistry._providers.get('test-provider'), fakeProvider);
    });

    it('throws when forge has no providerRegistry', () => {
      const p = new BasePlugin({});
      assert.throws(() => p.registerProvider({}), /forge.providerRegistry is not available/);
    });
  });

  describe('on()', () => {
    it('subscribes to events on the eventBus', (_, done) => {
      const p = new BasePlugin(forge);
      p.on('test.event', (data) => {
        assert.equal(data.value, 42);
        done();
      });
      forge.eventBus.emit('test.event', { value: 42 });
    });

    it('throws when forge has no eventBus', () => {
      const p = new BasePlugin({});
      assert.throws(() => p.on('x', () => {}), /forge.eventBus is not available/);
    });
  });

  describe('emit()', () => {
    it('emits an event on the eventBus', (_, done) => {
      const p = new BasePlugin(forge);
      forge.eventBus.once('custom.event', (data) => {
        assert.equal(data.ok, true);
        done();
      });
      p.emit('custom.event', { ok: true });
    });

    it('throws when forge has no eventBus', () => {
      const p = new BasePlugin({});
      assert.throws(() => p.emit('x', {}), /forge.eventBus is not available/);
    });
  });
});
