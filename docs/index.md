# AgentForge Documentation

Multi-agent orchestration platform with cost control, quota management, and intelligent model routing.

---

## Guides

| Guide | Description |
|---|---|
| [Getting Started](getting-started.md) | Install, configure, and run your first agent in 5 minutes |
| [Configuration Reference](configuration.md) | Every field in `agentforge.yml`, with defaults and examples |
| [Provider Setup](providers.md) | API keys, endpoints, and quota settings for each provider |
| [API Reference](api-reference.md) | REST endpoints and WebSocket event catalogue |
| [Plugin System](plugins.md) | Status of the unwired plugin code |
| [Deployment](deployment.md) | Docker, production hardening, environment variables |
| [Architecture](architecture.md) | System design, data model, component internals |

---

## What AgentForge Does

```
You define:       providers, models, agents, budget, routing rules
Router:           picks a model for each task
Provider:         answers one prompt per task with text
System records:   tokens, cost, quota usage, events
```

AgentForge is being reoriented toward a control panel for coding agents.
See [ROADMAP.md](../ROADMAP.md) and the
[AgentForge Roadmap project](https://github.com/users/sinsonido/projects/4).

### Key features

- **Deterministic routing** — rules in YAML, not prompts. First match wins.
- **Cost budgets** — per-project USD limit. Queued tasks pause at 95% of the budget.
- **Quota management** — sliding-window rate limiter per provider. Tasks wait while no model is available and return to the queue on `quota.reset`.
- **Fallback chains** — if a model is unavailable, the router tries its fallbacks, then the cheapest model in the tier, then lower tiers.
- **Web dashboard** — Kanban, quota bars, cost charts, agent list.

### Not wired today

Agents have no tools: they cannot read or write files, run commands, or commit.
The git integration (`src/git/`), the plugin system (`src/plugins/`), and the
inter-agent, parallel, review, and decomposition modules in `src/execution/` exist
in code, but nothing starts them. They are scheduled for removal in v0.9 (see
[#190](https://github.com/sinsonido/agentforge/issues/190)).

---

## Quick navigation

```
Getting started fast?  →  getting-started.md
Configuring providers? →  providers.md
Understanding internals? → architecture.md
```
