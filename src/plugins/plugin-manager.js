/**
 * PluginManager — loads and manages custom plugins.
 * Plugins can add new providers, tools, or event handlers.
 * Implements GitHub issue #41.
 */
export class PluginManager {
  /**
   * @param {{ forge: object }} options
   * @param {object} options.forge - The forge instance (orchestrator, providerRegistry, eventBus, …)
   */
  constructor({ forge }) {
    this.forge = forge;
    /** @type {Map<string, { manifest: { name: string, version: string }, instance: BasePlugin }>} */
    this.plugins = new Map(); // name → { manifest, instance }
  }

  /**
   * Load a plugin from a file path or package name.
   *
   * The plugin module must export a default factory function with the signature:
   *   (forge) => BasePlugin  (or a plain object with { name, version, init, destroy? })
   *
   * Example plugin module:
   *   export default function myPlugin(forge) {
   *     return new class extends BasePlugin {
   *       constructor() { super(forge); this.name = 'my-plugin'; this.version = '1.0.0'; }
   *       async init() { /* setup * / }
   *     }();
   *   }
   *
   * @param {string} pluginPath - Absolute/relative file path or npm package name.
   * @returns {Promise<{ name: string, version: string }>} Manifest of the loaded plugin.
   * @throws {Error} If the module cannot be resolved, the factory is missing, or init() throws.
   */
  async load(pluginPath) {
    let factory;
    try {
      const mod = await import(pluginPath);
      factory = mod.default;
    } catch (err) {
      throw new Error(`[PluginManager] Cannot import plugin "${pluginPath}": ${err.message}`);
    }

    if (typeof factory !== 'function') {
      throw new Error(
        `[PluginManager] Plugin "${pluginPath}" must export a default function, got ${typeof factory}`,
      );
    }

    const instance = factory(this.forge);

    if (!instance || typeof instance !== 'object') {
      throw new Error(
        `[PluginManager] Plugin factory "${pluginPath}" must return an object, got ${typeof instance}`,
      );
    }

    const name = instance.name;
    const version = instance.version ?? '0.0.0';

    if (!name || typeof name !== 'string') {
      throw new Error(
        `[PluginManager] Plugin "${pluginPath}" must have a non-empty string "name" property`,
      );
    }

    if (this.plugins.has(name)) {
      throw new Error(
        `[PluginManager] Plugin "${name}" is already loaded. Unload it first before reloading.`,
      );
    }

    if (typeof instance.init === 'function') {
      await instance.init();
    }

    const manifest = { name, version };
    this.plugins.set(name, { manifest, instance });

    this.forge.eventBus?.emit('plugin.loaded', { name, version });
    console.log(`[PluginManager] Loaded plugin: ${name}@${version}`);

    return manifest;
  }

  /**
   * Load all plugins listed in the config.plugins array.
   * Plugins are loaded sequentially so that earlier plugins can register
   * providers that later plugins may depend on.
   *
   * @param {string[]} pluginPaths - Array of file paths or package names.
   * @returns {Promise<Array<{ name: string, version: string }>>} Manifests of successfully loaded plugins.
   */
  async loadAll(pluginPaths) {
    if (!Array.isArray(pluginPaths) || pluginPaths.length === 0) {
      return [];
    }

    const manifests = [];
    for (const pluginPath of pluginPaths) {
      try {
        const manifest = await this.load(pluginPath);
        manifests.push(manifest);
      } catch (err) {
        console.error(`[PluginManager] Failed to load plugin "${pluginPath}": ${err.message}`);
        // Re-throw so the caller can decide whether to abort startup.
        throw err;
      }
    }
    return manifests;
  }

  /**
   * Retrieve a loaded plugin entry by name.
   * @param {string} name
   * @returns {{ manifest: { name: string, version: string }, instance: BasePlugin } | undefined}
   */
  get(name) {
    return this.plugins.get(name);
  }

  /**
   * List all currently loaded plugins.
   * @returns {Array<{ name: string, version: string }>}
   */
  list() {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.manifest.name,
      version: p.manifest.version,
    }));
  }

  /**
   * Unload a plugin by name.
   * Calls plugin.destroy() if the method is defined, then removes it from the registry.
   *
   * @param {string} name - The plugin name as declared in plugin.name.
   * @returns {Promise<void>}
   * @throws {Error} If no plugin with that name is loaded.
   */
  async unload(name) {
    const entry = this.plugins.get(name);
    if (!entry) {
      throw new Error(`[PluginManager] Plugin "${name}" is not loaded.`);
    }

    const { manifest, instance } = entry;

    if (typeof instance.destroy === 'function') {
      try {
        await instance.destroy();
      } catch (err) {
        console.error(
          `[PluginManager] Plugin "${name}" destroy() threw an error: ${err.message}`,
        );
        // Still remove from registry even if destroy() failed.
      }
    }

    this.plugins.delete(name);
    this.forge.eventBus?.emit('plugin.unloaded', { name, version: manifest.version });
    console.log(`[PluginManager] Unloaded plugin: ${name}`);
  }
}

/**
 * Base class for AgentForge plugins.
 *
 * Custom plugins should extend this class and override init() / destroy().
 * The plugin factory default export should instantiate the subclass:
 *
 * @example
 * // my-plugin.js
 * import { BasePlugin } from 'agentforge/plugins';
 *
 * export default function myPlugin(forge) {
 *   return new class MyPlugin extends BasePlugin {
 *     constructor() {
 *       super(forge);
 *       this.name    = 'my-plugin';
 *       this.version = '1.2.3';
 *     }
 *
 *     async init() {
 *       this.registerProvider(new MyCustomProvider());
 *       this.on('task.completed', (data) => console.log('Task done:', data));
 *     }
 *
 *     async destroy() {
 *       // clean up open handles, timers, etc.
 *     }
 *   }();
 * }
 */
export class BasePlugin {
  /**
   * @param {object} forge - The forge instance passed by PluginManager.load().
   */
  constructor(forge) {
    this.forge = forge;
    /** Override in subclass to give the plugin a unique, stable identifier. */
    this.name = 'unnamed-plugin';
    /** Semver string; override in subclass. */
    this.version = '0.0.0';
  }

  /**
   * Called by PluginManager immediately after the plugin is instantiated.
   * Override to register providers, subscribe to events, add CLI commands, etc.
   * @returns {Promise<void>}
   */
  async init() {}

  /**
   * Called by PluginManager.unload().
   * Override to close connections, remove event listeners, flush state, etc.
   * @returns {Promise<void>}
   */
  async destroy() {}

  /**
   * Register a custom provider with the forge ProviderRegistry.
   * The provider must extend BaseProvider from src/providers/interface.js.
   * @param {import('../providers/interface.js').BaseProvider} provider
   */
  registerProvider(provider) {
    if (!this.forge.providerRegistry) {
      throw new Error(
        '[BasePlugin] forge.providerRegistry is not available. ' +
        'Ensure the plugin is loaded after createAgentForge() initialises the registry.',
      );
    }
    this.forge.providerRegistry.register(provider);
  }

  /**
   * Subscribe to an AgentForge event on the central event bus.
   * @param {string} event - Event name (e.g. 'task.completed', 'quota.exhausted').
   * @param {Function} handler - Callback receiving the event data payload.
   */
  on(event, handler) {
    if (!this.forge.eventBus) {
      throw new Error('[BasePlugin] forge.eventBus is not available.');
    }
    this.forge.eventBus.on(event, handler);
  }

  /**
   * Emit an event on the central event bus.
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    if (!this.forge.eventBus) {
      throw new Error('[BasePlugin] forge.eventBus is not available.');
    }
    this.forge.eventBus.emit(event, data);
  }
}
