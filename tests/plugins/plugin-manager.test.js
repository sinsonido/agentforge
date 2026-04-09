/**
 * @file tests/plugins/plugin-manager.test.js
 * @description Unit tests for src/plugins/plugin-manager.js
 *
 * Covers:
 *  - PluginManager.load(): valid plugin, non-importable path, non-function
 *    export, factory returning non-object, missing name, duplicate load,
 *    init() called, plugin.loaded event emitted
 *  - PluginManager.loadAll(): empty array, sequential load, re-throws on failure
 *  - PluginManager.get() / list(): not-found, manifest data
 *  - PluginManager.unload(): destroy() called, removed from registry,
 *    plugin.unloaded event, unknown plugin throws
 *  - BasePlugin: registerProvider, on, emit helpers
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginManager, BasePlugin } from '../../src/plugins/plugin-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal event-bus stub */
function makeEventBus() {
  const events = [];
  return {
    events,
    emit(event, data) { events.push({ event, data }); },
    on() {},
  };
}

/** Minimal forge stub */
function makeForge(eventBus = makeEventBus()) {
  const providers = new Map();
  return {
    eventBus,
    providerRegistry: {
      register(p) { providers.set(p.id, p); },
      providers,
    },
  };
}

/**
 * Write a temporary ES module plugin file and return its file:// URL.
 * The factory receives forge and returns an object with { name, version, init?, destroy? }.
 */
const TMP_DIR = join(tmpdir(), 'agentforge-plugin-tests');
mkdirSync(TMP_DIR, { recursive: true });

let _fileCounter = 0;
function writeTmpPlugin(body) {
  const file = join(TMP_DIR, `plugin-${_fileCounter++}.mjs`);
  writeFileSync(file, body, 'utf-8');
  return pathToFileURL(file).href;
}

// ---------------------------------------------------------------------------
// PluginManager.load()
// ---------------------------------------------------------------------------

describe('PluginManager.load()', () => {
  let forge, manager;

  beforeEach(() => {
    forge = makeForge();
    manager = new PluginManager({ forge });
  });

  it('loads a valid plugin and returns its manifest', async () => {
    const url = writeTmpPlugin(`
export default function(forge) {
  return { name: 'my-plugin', version: '1.2.3' };
}
`);
    const manifest = await manager.load(url);
    assert.equal(manifest.name, 'my-plugin');
    assert.equal(manifest.version, '1.2.3');
  });

  it('plugin is retrievable via get() after load', async () => {
    const url = writeTmpPlugin(`
export default function() {
  return { name: 'get-test', version: '0.1.0' };
}
`);
    await manager.load(url);
    const entry = manager.get('get-test');
    assert.ok(entry, 'entry should exist');
    assert.equal(entry.manifest.name, 'get-test');
    assert.equal(entry.manifest.version, '0.1.0');
  });

  it('calls init() on the plugin instance after instantiation', async () => {
    let initCalled = false;
    const url = writeTmpPlugin(`
export default function() {
  return {
    name: 'init-test',
    version: '1.0.0',
    async init() { globalThis._initCalled_${_fileCounter} = true; },
  };
}
`);
    // Use a synchronous init tracker via shared state
    let initWasCalled = false;
    const url2 = writeTmpPlugin(`
export default function() {
  return {
    name: 'init-tracker',
    version: '1.0.0',
    init() { this._ran = true; },
    _ran: false,
  };
}
`);
    await manager.load(url2);
    const entry = manager.get('init-tracker');
    assert.equal(entry.instance._ran, true);
  });

  it('emits plugin.loaded event with name and version', async () => {
    const url = writeTmpPlugin(`
export default function() { return { name: 'event-test', version: '2.0.0' }; }
`);
    await manager.load(url);
    const evt = forge.eventBus.events.find((e) => e.event === 'plugin.loaded');
    assert.ok(evt, 'plugin.loaded event not emitted');
    assert.equal(evt.data.name, 'event-test');
    assert.equal(evt.data.version, '2.0.0');
  });

  it('uses version "0.0.0" when plugin omits version', async () => {
    const url = writeTmpPlugin(`
export default function() { return { name: 'no-version' }; }
`);
    const manifest = await manager.load(url);
    assert.equal(manifest.version, '0.0.0');
  });

  it('throws when the module path cannot be imported', async () => {
    await assert.rejects(
      () => manager.load('/nonexistent/path/plugin.mjs'),
      /Cannot import plugin/,
    );
  });

  it('throws when the default export is not a function', async () => {
    const url = writeTmpPlugin(`export default { name: 'not-a-function' };`);
    await assert.rejects(
      () => manager.load(url),
      /must export a default function/,
    );
  });

  it('throws when the factory returns a non-object', async () => {
    const url = writeTmpPlugin(`export default function() { return null; }`);
    await assert.rejects(
      () => manager.load(url),
      /must return an object/,
    );
  });

  it('throws when the plugin has no name', async () => {
    const url = writeTmpPlugin(`export default function() { return { version: '1.0.0' }; }`);
    await assert.rejects(
      () => manager.load(url),
      /must have a non-empty string "name"/,
    );
  });

  it('throws when the same plugin name is loaded twice', async () => {
    const url = writeTmpPlugin(`export default function() { return { name: 'dupe', version: '1.0.0' }; }`);
    await manager.load(url);
    // write a second file with the same plugin name
    const url2 = writeTmpPlugin(`export default function() { return { name: 'dupe', version: '2.0.0' }; }`);
    await assert.rejects(
      () => manager.load(url2),
      /already loaded/,
    );
  });
});

// ---------------------------------------------------------------------------
// PluginManager.loadAll()
// ---------------------------------------------------------------------------

describe('PluginManager.loadAll()', () => {
  let forge, manager;

  beforeEach(() => {
    forge = makeForge();
    manager = new PluginManager({ forge });
  });

  it('returns empty array for an empty plugin list', async () => {
    const result = await manager.loadAll([]);
    assert.deepEqual(result, []);
  });

  it('returns empty array for a non-array argument', async () => {
    const result = await manager.loadAll(null);
    assert.deepEqual(result, []);
  });

  it('loads multiple plugins and returns their manifests', async () => {
    const url1 = writeTmpPlugin(`export default function() { return { name: 'all-a', version: '1.0.0' }; }`);
    const url2 = writeTmpPlugin(`export default function() { return { name: 'all-b', version: '2.0.0' }; }`);
    const manifests = await manager.loadAll([url1, url2]);
    assert.equal(manifests.length, 2);
    assert.equal(manifests[0].name, 'all-a');
    assert.equal(manifests[1].name, 'all-b');
  });

  it('re-throws when any plugin fails to load', async () => {
    const url1 = writeTmpPlugin(`export default function() { return { name: 'ok-plugin', version: '1.0.0' }; }`);
    await assert.rejects(
      () => manager.loadAll([url1, '/nonexistent/bad-plugin.mjs']),
      /Cannot import plugin/,
    );
  });
});

// ---------------------------------------------------------------------------
// PluginManager.get() / list()
// ---------------------------------------------------------------------------

describe('PluginManager.get() and list()', () => {
  let manager;

  beforeEach(() => {
    manager = new PluginManager({ forge: makeForge() });
  });

  it('get() returns undefined for unknown plugin', () => {
    assert.equal(manager.get('missing'), undefined);
  });

  it('list() returns empty array when no plugins loaded', () => {
    assert.deepEqual(manager.list(), []);
  });

  it('list() returns manifests of all loaded plugins', async () => {
    const url1 = writeTmpPlugin(`export default function() { return { name: 'list-a', version: '1.0.0' }; }`);
    const url2 = writeTmpPlugin(`export default function() { return { name: 'list-b', version: '3.0.0' }; }`);
    await manager.load(url1);
    await manager.load(url2);
    const list = manager.list();
    assert.equal(list.length, 2);
    assert.ok(list.some((p) => p.name === 'list-a'));
    assert.ok(list.some((p) => p.name === 'list-b' && p.version === '3.0.0'));
  });
});

// ---------------------------------------------------------------------------
// PluginManager.unload()
// ---------------------------------------------------------------------------

describe('PluginManager.unload()', () => {
  let forge, manager;

  beforeEach(() => {
    forge = makeForge();
    manager = new PluginManager({ forge });
  });

  it('throws when the plugin name is not loaded', async () => {
    await assert.rejects(
      () => manager.unload('not-loaded'),
      /is not loaded/,
    );
  });

  it('removes the plugin from the registry after unload', async () => {
    const url = writeTmpPlugin(`export default function() { return { name: 'removable', version: '1.0.0' }; }`);
    await manager.load(url);
    assert.ok(manager.get('removable'));
    await manager.unload('removable');
    assert.equal(manager.get('removable'), undefined);
  });

  it('calls destroy() on the plugin instance if defined', async () => {
    const url = writeTmpPlugin(`
export default function() {
  return {
    name: 'destroyable',
    version: '1.0.0',
    destroy() { this._destroyed = true; },
    _destroyed: false,
  };
}
`);
    await manager.load(url);
    const entry = manager.get('destroyable');
    await manager.unload('destroyable');
    assert.equal(entry.instance._destroyed, true);
  });

  it('emits plugin.unloaded event with name and version', async () => {
    const url = writeTmpPlugin(`export default function() { return { name: 'unload-evt', version: '4.0.0' }; }`);
    await manager.load(url);
    forge.eventBus.events.length = 0; // clear prior events
    await manager.unload('unload-evt');
    const evt = forge.eventBus.events.find((e) => e.event === 'plugin.unloaded');
    assert.ok(evt, 'plugin.unloaded event not emitted');
    assert.equal(evt.data.name, 'unload-evt');
    assert.equal(evt.data.version, '4.0.0');
  });

  it('removes plugin from list() after unload', async () => {
    const url = writeTmpPlugin(`export default function() { return { name: 'list-gone', version: '1.0.0' }; }`);
    await manager.load(url);
    assert.equal(manager.list().length, 1);
    await manager.unload('list-gone');
    assert.equal(manager.list().length, 0);
  });
});

// ---------------------------------------------------------------------------
// BasePlugin helpers
// ---------------------------------------------------------------------------

describe('BasePlugin', () => {
  it('registerProvider() throws when forge has no providerRegistry', () => {
    const plugin = new BasePlugin({ eventBus: makeEventBus() }); // no providerRegistry
    assert.throws(() => plugin.registerProvider({ id: 'x' }), /providerRegistry is not available/);
  });

  it('registerProvider() calls forge.providerRegistry.register()', () => {
    const forge = makeForge();
    const plugin = new BasePlugin(forge);
    const provider = { id: 'custom', execute: async () => {} };
    plugin.registerProvider(provider);
    assert.equal(forge.providerRegistry.providers.get('custom'), provider);
  });

  it('on() throws when forge has no eventBus', () => {
    const plugin = new BasePlugin({});
    assert.throws(() => plugin.on('task.queued', () => {}), /eventBus is not available/);
  });

  it('on() registers a listener on the forge eventBus', () => {
    const listeners = [];
    const forge = {
      eventBus: { on: (evt, h) => listeners.push({ evt, h }), emit() {} },
      providerRegistry: null,
    };
    const plugin = new BasePlugin(forge);
    const handler = () => {};
    plugin.on('task.completed', handler);
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].evt, 'task.completed');
    assert.equal(listeners[0].h, handler);
  });

  it('emit() throws when forge has no eventBus', () => {
    const plugin = new BasePlugin({});
    assert.throws(() => plugin.emit('test.event', {}), /eventBus is not available/);
  });

  it('emit() sends event on the forge eventBus', () => {
    const forge = makeForge();
    const plugin = new BasePlugin(forge);
    plugin.emit('custom.event', { x: 1 });
    const evt = forge.eventBus.events.find((e) => e.event === 'custom.event');
    assert.ok(evt);
    assert.deepEqual(evt.data, { x: 1 });
  });

  it('default name is "unnamed-plugin" and version is "0.0.0"', () => {
    const plugin = new BasePlugin({});
    assert.equal(plugin.name, 'unnamed-plugin');
    assert.equal(plugin.version, '0.0.0');
  });
});
