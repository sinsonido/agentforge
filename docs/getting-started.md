# Getting Started

This guide takes you from zero to a running AgentForge instance in about 5 minutes.

---

## Prerequisites

- Node.js ≥ 20
- An API key for at least one provider (Anthropic, Google, DeepSeek, or a local Ollama install)
- Git (for the git integration features; optional for basic use)

---

## Installation

### Option A — npm global install

```bash
npm install -g agentforge
```

### Option B — clone and run locally

```bash
git clone https://github.com/sinsonido/agentforge.git
cd agentforge
npm install
```

### Option C — Docker (recommended for production)

```bash
git clone https://github.com/sinsonido/agentforge.git
cd agentforge
docker-compose up
```

See [Deployment](deployment.md) for Docker details.

---

## 1. Create your config

```bash
cp agentforge.example.yml agentforge.yml
```

Open `agentforge.yml` and fill in at minimum:

```yaml
project:
  name: "My Project"
  budget: 10.00          # Max spend in USD

providers:
  anthropic:
    enabled: true
    api_key: ${ANTHROPIC_API_KEY}   # or paste key directly (not recommended)
```

Then export your key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Config supports `${ENV_VAR}` substitution throughout. See [Configuration Reference](configuration.md) for all options.

---

## 2. Start the platform

```bash
agentforge start
# or: node src/cli.js start

# Dashboard opens at http://localhost:4242
# API at         http://localhost:4242/api
# WebSocket at   ws://localhost:4242/ws
```

Port is controlled by `server.port` in `agentforge.yml` (default `4242`).

---

## 3. Add your first task

```bash
# Via CLI
agentforge task add "Write unit tests for the auth module" --type test --priority high

# Via REST API
curl -X POST http://localhost:4242/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Write unit tests for the auth module","type":"test","priority":"high"}'

# Via the dashboard
# Open http://localhost:4242 → Kanban → + New task
```

---

## 4. Watch it run

The orchestrator picks up queued tasks automatically. Follow progress in:

- **Dashboard** → live KPI cards, activity feed
- **Kanban** → tasks moving through columns
- **CLI** → `agentforge status`
- **Logs** → `agentforge logs --follow`

---

## 5. Define your team

The real power comes from a multi-agent team. Edit `agentforge.yml`:

```yaml
team:
  - name: Architect
    role: Lead Architect
    model: claude-opus-4-6           # T1: strategic thinking
    tools: [file_read, ask_agent]
    require_review: false

  - name: Developer
    role: Backend Developer
    model: claude-sonnet-4-6         # T2: implementation
    fallback_models: [deepseek-r1]
    tools: [file_read, file_write, git_commit, run_tests, ask_agent]
    require_review: true
    reviewer: Architect              # All Developer output reviewed by Architect
    max_cost_per_task: 5.00

  - name: Tester
    role: QA Engineer
    model: deepseek-v3               # T3: cheaper model for test writing
    fallback_models: [codestral:22b] # Local fallback
    tools: [file_read, file_write, run_tests]
    allow_tier_downgrade: true
```

Restart (`agentforge start`) and the orchestrator will assign tasks to agents based on task type and routing rules.

---

## Next steps

| What you want | Where to look |
|---|---|
| Configure more providers | [Provider Setup](providers.md) |
| Understand routing rules | [Configuration Reference → routing](configuration.md#routing) |
| Connect to GitHub | [Configuration Reference → git](configuration.md#git) |
| Build a plugin | [Plugin System](plugins.md) |
| Run in production | [Deployment](deployment.md) |

---

## Common first-run issues

### "Cannot find agentforge.yml"

Run `agentforge start` from the directory that contains `agentforge.yml`, or pass the path explicitly:

```bash
agentforge start --config /path/to/agentforge.yml
```

### "Provider anthropic is not enabled"

Check that `providers.anthropic.enabled: true` is set in your config and the `ANTHROPIC_API_KEY` env var is exported.

### Orchestrator starts but no tasks move

Tasks stay in `queued` until the orchestrator loop picks them up. Verify with `agentforge status` that the orchestrator is running. If tasks remain stuck, check quota limits — a provider at 100% usage will block all tasks routed to it.

### Dashboard shows "Reconnecting…"

The WebSocket connection failed. Confirm the server started on the expected port and there's no firewall blocking `ws://localhost:4242/ws`.
