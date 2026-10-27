# Plugin System

The plugin code is present but not wired. It is scheduled for removal in v0.9
(see [#190](https://github.com/sinsonido/agentforge/issues/190)).

`createAgentForge()` never creates a `PluginManager`, the config loader does not
read a `plugins` key, and the CLI has no plugin command. A plugin you write today
never loads.

---

## What the code contains

`src/plugins/plugin-manager.js` exports two classes. No test covers them.

- `PluginManager` takes `{ forge }`. Its methods are `load(path)`, `loadAll(paths)`, `get(name)`, `list()`, and `unload(name)`. `load()` calls `import(path)` and expects a default export that is a factory function. The factory receives `forge` and returns a plugin object, usually a `BasePlugin` subclass instance.
- `BasePlugin` takes the `forge` object. Subclasses override `init()` and `destroy()`. Helpers are `registerProvider(provider)`, `on(event, handler)`, and `emit(event, data)`.

---

## How to extend AgentForge today

Change the code directly:

- To add a provider, follow [Adding a new provider](../AGENTS.md#adding-a-new-provider) in `AGENTS.md`.
- To add a routing rule, add it to `routing.rules` in `agentforge.yml`. See [Configuration Reference → routing](configuration.md#routing).
- To react to events, subscribe to the event bus in `src/index.js`. See the event catalogue in [API Reference](api-reference.md#event-catalogue).

There is no tool system, so there are no custom tools to add.
