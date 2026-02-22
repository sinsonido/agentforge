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
| [Plugin System](plugins.md) | Custom providers, tools, and routing rules |
| [Deployment](deployment.md) | Docker, production hardening, environment variables |
| [Architecture](architecture.md) | System design, data model, component internals |

---

## What AgentForge Does

```
You define:       projects, agent teams, budgets, routing rules
Orchestrator:     decides which model, when, how much
Agents execute:   code, reviews, tests, commits
System manages:   quotas, costs, git branches, auto-PRs
```

### Key features

- **Deterministic routing** — rules in YAML, not prompts. First match wins.
- **Cost budgets** — per-project USD limits. Auto-pause when budget runs out.
- **Quota management** — sliding-window rate limiter per provider. Auto-pause/resume.
- **Fallback chains** — quota exhausted? Try next model in tier. All tiers exhausted? Local Ollama.
- **Git integration** — agents commit to branches, open PRs, wait for review before merge.
- **Web dashboard** — live Kanban, quota bars, cost charts, agent status.
- **Plugin system** — add providers, tools, or routing rules without forking.

---

## Quick navigation

```
Getting started fast?  →  getting-started.md
Configuring providers? →  providers.md
Building a plugin?     →  plugins.md
Understanding internals? → architecture.md
```
