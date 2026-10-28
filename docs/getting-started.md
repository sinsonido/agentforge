# Getting Started

This guide takes you from a fresh clone to a running AgentForge instance that answers a task.

AgentForge today sends one prompt per task to the model the router picks and stores the text reply. Agents have no tools, so they do not edit files, run tests, or commit. See [ROADMAP.md](../ROADMAP.md) for where the project is going.

---

## Prerequisites

- Node.js 24 (the only supported version)
- An API key for at least one provider (Anthropic, Google, DeepSeek, or OpenRouter), or a local Ollama install

---

## Installation

AgentForge is not published to npm. Run it from a clone.

### Option A — clone and run locally

```bash
git clone https://github.com/sinsonido/agentforge.git
cd agentforge
npm install

# Optional: build the React dashboard. Without it the server serves the older vanilla UI in src/ui/.
npm run ui:install
npm run ui:build
```

### Option B — Docker

The image's default command binds `127.0.0.1` inside the container, which the host cannot reach. [Deployment → Docker](deployment.md#docker) shows the `docker-compose.override.yml` that adds `--host 0.0.0.0`, and the full Docker setup.

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

Config supports `${ENV_VAR}` substitution throughout. An unset variable becomes an empty string. A provider other than Ollama with an empty `api_key` is not registered. See [Configuration Reference](configuration.md) for all options.

---

## 2. Start the platform

```bash
node src/cli.js start
# or: npm start

# Dashboard at   http://127.0.0.1:4242
# API at         http://127.0.0.1:4242/api
# WebSocket at   ws://127.0.0.1:4242/ws
```

The `start` command binds `127.0.0.1:4242` by default. Change it with `--port` and `--host`. The `start` command ignores `server.port` and `server.host` in `agentforge.yml`, because the CLI defaults for `--port` and `--host` always take precedence.

### Start script (`scripts/start.sh`)

The repo ships a self-contained start script with extra options:

```bash
bash scripts/start.sh                    # Same as node src/cli.js start
bash scripts/start.sh --tunnel           # Expose publicly via Cloudflare tunnel
bash scripts/start.sh --tunnel --verbose # Full logs + tunnel URL highlighted
bash scripts/start.sh --port 8080        # Custom port
bash scripts/start.sh --help
```

The `--tunnel` mode downloads `cloudflared` to `.cache/` on first run, so no system-level install is required. It prints **only the public URL** to stdout, so you can pipe it into other tools:

```bash
URL=$(bash scripts/start.sh --tunnel)
echo "Share this: $URL"
```

Authentication is off by default. Turn on `server.auth` before you open a tunnel. See [Configuration Reference → server](configuration.md#server).

npm shortcuts:

```bash
npm run start:tunnel
npm run start:tunnel:verbose
```

---

## 3. Add your first task

Add tasks to the running server through the REST API or the dashboard:

```bash
# Via REST API
curl -X POST http://127.0.0.1:4242/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Write unit tests for the auth module","type":"test","priority":"high"}'

# Via the dashboard
# Open http://127.0.0.1:4242 → Kanban → Add Task
```

The CLI also has `node src/cli.js task add`, `task list`, `task show`, and `status`. Each of these commands starts its own in-process instance with an empty in-memory queue. They do not talk to a running server, so a task added with `task add` never reaches the server's orchestrator.

---

## 4. Watch it run

The orchestrator polls the queue every 500 ms and starts at most one task per tick. Follow progress in:

- **Dashboard** → KPI cards and activity feed
- **Kanban** → tasks moving through columns
- **API** → `curl http://127.0.0.1:4242/api/status`
- **Server logs** → the terminal where `start` runs prints one line per completed or failed task, and a status line every 30 seconds

When a task completes, its `result` field holds the model's text reply.

---

## 5. Define your agents

An agent is a named configuration that a task can reference with `agent_id`. The agent's `model` and `fallback_models` take priority over routing rules, and its system prompt goes into every request. Edit `agentforge.yml`:

```yaml
team:
  - name: Architect
    role: Lead Architect
    model: claude-opus-5-5           # T1: strategic thinking

  - name: Developer
    role: Backend Developer
    model: claude-sonnet-5-5         # T2: implementation
    fallback_models: [deepseek-v4-pro]
    system_prompt_file: prompts/developer.md

  - name: Tester
    role: QA Engineer
    model: deepseek-flash            # T3: cheaper model for test writing
    fallback_models: [codestral:22b] # Local fallback
```

The agent ID is the lowercased name with spaces replaced by `-`, for example `architect`. Restart the server after you edit the file.

The loader also accepts `tools`, `require_review`, `reviewer`, `max_cost_per_task`, and `allow_tier_downgrade` on an agent. Nothing acts on them today. See [Configuration Reference → team](configuration.md#team).

---

## 6. Develop against the dashboard

When you work on the UI or build integrations, you need data in the system without running real LLM tasks. The seed script populates test data through the REST API:

```bash
# One-shot: creates tasks across all statuses + PR review events
bash scripts/seed.sh

# Continuous: keeps emitting task lifecycle events every few seconds
bash scripts/seed.sh --watch

# Reset + re-seed in one go
bash scripts/seed.sh --reset

# Custom port
bash scripts/seed.sh --port 8080
```

The seed targets **localhost only**. Use it with a local server, not with the tunnel. It respects the server's 30 POST/min rate limit.

---

## Next steps

| What you want | Where to look |
|---|---|
| Configure more providers | [Provider Setup](providers.md) |
| Understand routing rules | [Configuration Reference → routing](configuration.md#routing) |
| Run in production | [Deployment](deployment.md) |

---

## Common first-run issues

### "agentforge.yml not found. Using defaults."

The loader looks for `agentforge.yml` in the current directory. Run the server from the directory that contains it, or pass the path explicitly:

```bash
node src/cli.js --config /path/to/agentforge.yml start
```

### A provider does not appear in the startup log

A provider other than Ollama registers only when it has a non-empty `api_key` and is not `enabled: false`. Check that the environment variable named in `${...}` is exported in the shell that starts the server.

### Orchestrator starts but no tasks move

Check `GET /api/status`: `orchestrator.running` must be `true`. A task waits in `waiting_quota` when the router finds no available model. That happens when every candidate model's provider is exhausted, or when the model IDs in your rules and agents are missing from `models`. A task whose `depends_on` lists unfinished tasks also stays queued.

### Dashboard shows "Reconnecting…"

The WebSocket connection failed. Confirm the server started on the expected port and that nothing blocks `ws://127.0.0.1:4242/ws`. If `server.auth` is on, the WebSocket needs the token as `?token=<secret>`.
