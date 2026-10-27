# AgentForge — Claude Code Instructions

Multi-agent orchestration platform: routes tasks to AI models with cost control, quota
management, and SQLite persistence. Node.js ES modules only (no transpilation, **Node 24**).

> **Runtime:** Node 24 is the only supported version. Do not use 20 or 22.
> **GitHub:** Use `gh` CLI for all repository operations (PRs, issues, releases). Never raw `curl` the GitHub API.

---

## Architecture

What runs today: a task enters the queue, the router picks a model, the provider
makes one call, and the result text is stored. There is no tool use: `_resolveTools()`
in `orchestrator.js` returns `[]`, so agents never edit files, run commands, or use git.
See `ROADMAP.md` for the reorientation.

`src/` and `ui/` are siblings at the repository root. Modules marked
**not wired** exist in code, but nothing in `createAgentForge()` or the CLI imports them.
They are scheduled for removal in v0.9 (see #190).

```
agentforge/
├── src/
│   ├── cli.js                   # Commander.js CLI — entry point
│   ├── index.js                 # createAgentForge() — boots all subsystems
│   ├── config/loader.js         # Loads agentforge.yml, resolves ${ENV_VAR} refs
│   ├── core/
│   │   ├── event-bus.js         # EventEmitter singleton (import as default)
│   │   ├── task-queue.js        # In-memory priority queue, honours depends_on
│   │   ├── orchestrator.js      # Main tick loop — consumes queue, calls providers
│   │   ├── quota-tracker.js     # Sliding-window rate limiter (QuotaManager)
│   │   ├── cost-tracker.js      # Budget enforcement (CostTracker, created by Orchestrator)
│   │   ├── agent-lifecycle.js   # AgentLifecycle + AgentPool (agents registered, transitions never driven)
│   │   └── dependency-graph.js  # Task DAG with topological sort (tested, not wired)
│   ├── execution/
│   │   ├── context-builder.js   # Assembles provider messages from tasks
│   │   ├── output-collector.js  # Parses and normalises provider responses
│   │   ├── inter-agent-comm.js  # not wired
│   │   ├── parallel-execution.js # not wired
│   │   ├── review-workflow.js   # not wired
│   │   └── task-decomposition.js # not wired
│   ├── providers/
│   │   ├── interface.js         # BaseProvider, OllamaProvider, ProviderRegistry
│   │   └── anthropic.js / google.js / deepseek.js / openrouter.js
│   ├── routing/router.js        # Model selection: rules → tier → fallback chain
│   ├── git/                     # not wired: GitManager, BranchStrategy, AutoCommit, AutoPR, ReviewGate, GitHubIntegration
│   ├── plugins/                 # not wired: PluginManager is never instantiated
│   ├── persistence/db.js        # AgentForgeDB — better-sqlite3 (WAL mode)
│   ├── auth/auth.js             # Optional Bearer-token middleware (server.auth)
│   ├── api/server.js            # Express REST API (port 4242)
│   ├── api/ws.js                # WebSocket server on /ws
│   └── ui/                      # Vanilla JS dashboard (served only if ui/dist is absent)
├── ui/                          # React 19 SPA (Vite 6, Tailwind v4, shadcn/ui new-york)
│   └── src/
│       ├── index.css            # Tailwind v4 entry and @theme tokens
│       ├── types/api.ts         # Shared types: Task, AgentStatus, CostData, etc.
│       ├── lib/api.ts           # Typed fetch client against /api/*
│       ├── lib/ws.ts            # WebSocketManager (wss:// auto-detection)
│       ├── contexts/            # AuthContext, WebSocketContext
│       ├── hooks/               # useApi, useWebSocket
│       ├── views/               # Dashboard, Kanban, Agents, Providers, Costs, Login
│       └── components/{dashboard,kanban,agents,providers,costs,layout,ui}/
└── tests/                       # Node.js built-in runner (core, execution, routing, persistence, api)
```

### `createAgentForge()` returns

```js
{ orchestrator, taskQueue, router, quotaManager, providerRegistry,
  agentPool, db, eventBus, config, agents, models }
```

---

## Key contracts

**Providers** — every adapter must return:
```js
{ content, tokens_in, tokens_out, tool_calls, finish_reason }
```

Providers receive `tools` as `undefined` or `[]` today, so `tool_calls` is always empty in practice.

**EventBus events emitted by wired code** (use `eventBus.emit / .on / .once`):
```
task.queued | task.executing | task.completed | task.failed   → { task, ... }
task.status_changed | agent.config_updated     (from the REST API)
agent.paused | agent.resumed                   (from the orchestrator on quota events)
quota.throttled | quota.exhausted | quota.reset
budget.warning | budget.exceeded               → { projectId, spent, budget, spent_pct }
cost.recorded    → { projectId, agentId, model, tokensIn, tokensOut, cost }  (Orchestrator only)
review.approved | review.rejected              (from the REST API; nothing listens)
```
`git.*` and `review.pending` come only from the unwired `src/git/` modules.

**AgentLifecycle states** (defined in `agent-lifecycle.js`; the orchestrator never calls
the transitions, so registered agents stay `idle`):
```
idle → assigned → executing → reviewing → completed → idle
                            ↘ failed → idle
            executing → paused → idle
```

**Config env vars:** `${VAR_NAME}` syntax in `agentforge.yml`.

---

## GitHub tooling

Always use `gh` (GitHub CLI) for repository operations. Never use raw `curl` against the GitHub API or construct URLs manually.

**Before creating any issue, check for duplicates:**
```bash
gh issue list --state all --search "keyword"   # search by keyword
gh issue list --state open                     # scan all open issues
```
If a matching issue exists (open or closed), comment on it or reopen it instead of creating a new one. Wave-style planning often produces overlapping issues (e.g. "Dashboard UI" and "React Dashboard view" describe the same feature).

```bash
# Issues
gh issue create --title "..." --body "..." --label feat
gh issue list --state open
gh issue list --state all --search "keyword"
gh issue view 42
gh issue close 42

# Pull Requests
gh pr create --title "..." --body "..."   # from current branch
gh pr list
gh pr view 17
gh pr merge 17 --squash

# Releases
gh release create v1.2.0 --generate-notes

# CI / Actions
gh run list
gh run view <id> --log
```

---

## Dev commands

```bash
# Tests (Node 24 required)
npm test                                  # all tests (Node built-in runner)
node --test tests/persistence/db.test.js  # single file
node --test --test-reporter=spec          # verbose output
node --test --experimental-test-coverage  # coverage report

# Backend
node src/cli.js start                     # 127.0.0.1:4242 (reads agentforge.yml)
node src/cli.js start --port 3000 --host 0.0.0.0
# --port and --host always win: server.port and server.host in the YAML are ignored by `start`

# React frontend (two-terminal dev)
npm run ui:install     # first time only
npm run ui:dev         # http://localhost:5173 — proxies /api + /ws to :4242

# Production build
npm run ui:build       # → ui/dist/ (Express auto-detects and serves it)

# Docker
docker build -t agentforge .
docker run -p 4242:4242 -v $(pwd)/agentforge.yml:/app/agentforge.yml agentforge \
  node src/cli.js start --host 0.0.0.0
# The image's default CMD binds 127.0.0.1 inside the container, which the host cannot reach.
```

---

## Conventions

- **ES modules only** — `import/export`, never `require()`.
- **No external test framework** — `node:test` + `node:assert/strict`.
- **One file per provider** — implement `BaseProvider`, register it in `createAgentForge()` (`src/index.js`).
- **Events over direct calls** — subsystems communicate via `eventBus`, not imports.
- **DB through `AgentForgeDB`** — never query SQLite directly in other modules.
- **React: `@/` imports** — alias points to `ui/src/`. Never use relative paths crossing feature boundaries.
- **Tailwind v4** — config is in `ui/src/index.css` (`@theme`), not `tailwind.config.*`.
- **shadcn components** — run `npx shadcn@latest add <name>` from the `ui/` directory.

---

## What NOT to do

- Do not add `require()` or CommonJS syntax anywhere.
- Do not add Jest, Mocha, or any test framework — the built-in runner is intentional.
- Do not import `db.js` directly from `orchestrator.js` or `api/server.js` — use the `forge.db` reference injected at startup.
- Do not touch `src/ui/` (vanilla dashboard) unless the React SPA is explicitly unavailable.
- Do not commit `agentforge.yml` (contains secrets) — only `agentforge.example.yml`.
- Do not use `git add -A` or `git add .` — stage specific files to avoid committing `.agentforge/` data.
- Do not push to `master` without tests passing (`npm test`).
- **Do not use Node 20 or Node 22.** The project targets Node 24 exclusively. Do not write code that only runs on older versions or add compat shims.
- **Do not use raw `curl` / `fetch` against the GitHub API.** Use `gh` CLI instead — it handles auth, pagination, and error formatting automatically.

---

## File ownership quick-reference

| Area | Primary files | Notes |
|------|-------------|-------|
| Orchestration | `src/core/orchestrator.js`, `src/index.js` | Touch carefully — used by all agents |
| Routing | `src/routing/router.js` | Rules in `agentforge.yml`, not hardcoded |
| Providers | `src/providers/<name>.js` | One file per provider, never cross-import |
| Persistence | `src/persistence/db.js` | Schema changes need migration strategy |
| API | `src/api/server.js` | REST + WS; add routes to the Express router |
| React views | `ui/src/views/*.tsx` | Each view is standalone, no shared state |
| React components | `ui/src/components/<feature>/` | Colocate with their view |

---

## Test writing guide

```js
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('MyModule', () => {
  let subject;

  beforeEach(() => { subject = new MyModule(); });

  it('does the thing', () => {
    assert.equal(subject.thing(), 'expected');
  });

  it('rejects bad input', () => {
    assert.throws(() => subject.thing(null), /invalid/);
  });
});
```

For DB tests, use a `/tmp/` path and clean up in `after()`. For HTTP tests, use `startServer(forge, 0)` (port 0 = OS-assigned) and close in `after()`.
