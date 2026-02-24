# AgentForge — Claude Code Instructions

Multi-agent orchestration platform: routes tasks to AI models with cost control, quota
management, and SQLite persistence. Node.js ES modules only (no transpilation, Node 20+).

---

## Architecture

```
src/
  cli.js                   # Commander.js CLI — entry point
  index.js                 # createAgentForge() — boots all subsystems
  config/loader.js         # Loads agentforge.yml, resolves ${ENV_VAR} refs
  core/
    event-bus.js           # EventEmitter singleton (import as default)
    task-queue.js          # Priority queue with status tracking
    orchestrator.js        # Main tick loop — consumes queue, calls providers
    quota-tracker.js       # Sliding-window rate limiter (QuotaManager)
    cost-tracker.js        # Budget enforcement (CostTracker)
    agent-lifecycle.js     # State machine AgentLifecycle + AgentPool
    dependency-graph.js    # Task DAG with topological sort
  execution/
    context-builder.js     # Assembles provider payloads from tasks
    output-collector.js    # Parses and normalises provider responses
  providers/
    interface.js           # BaseProvider abstract class + ProviderRegistry
    anthropic.js / google.js / deepseek.js / openrouter.js
  routing/router.js        # Model selection: tier rules → fallback chain
  git/                     # GitManager, BranchStrategy, AutoPR, ReviewGate, GitHub API
  persistence/db.js        # AgentForgeDB — better-sqlite3 (WAL mode)
  api/server.js            # Express REST + WebSocket (port 4242)
  ui/                      # Vanilla JS dashboard (fallback if ui/dist absent)
ui/                        # React 19 SPA (Vite 6, Tailwind v4, shadcn/ui new-york)
  src/
    types/api.ts           # Shared types: Task, AgentStatus, CostData, etc.
    lib/api.ts             # Typed fetch client against /api/*
    lib/ws.ts              # WebSocketManager (wss:// auto-detection)
    contexts/WebSocketContext.tsx
    views/                 # DashboardView KanbanView AgentsView ProvidersView CostsView
    components/{dashboard,kanban,agents,providers,costs,layout,ui}/
tests/                     # Mirrors src/ structure — Node.js built-in runner
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

**EventBus events** (use `eventBus.emit / .on / .once`):
```
task.queued | task.executing | task.completed | task.failed
agent.assigned | agent.executing | agent.completed | agent.failed | agent.paused
quota.exhausted | quota.resumed
budget.warning | budget.pause
cost.recorded   → { projectId, agentId, model, tokensIn, tokensOut, cost }
git.*
```

**AgentLifecycle states:**
```
idle → assigned → executing → reviewing → completed → idle
                            ↘ failed → idle
            executing → paused → idle
```

**Config env vars:** `${VAR_NAME}` syntax in `agentforge.yml`.

---

## Dev commands

```bash
# Tests
npm test                                  # all tests (Node built-in runner)
node --test tests/persistence/db.test.js  # single file
node --test --test-reporter=spec          # verbose output
node --test --experimental-test-coverage  # coverage report

# Backend
node src/cli.js start                     # port 4242 (reads agentforge.yml)
node src/cli.js start --port 3000

# React frontend (two-terminal dev)
npm run ui:install     # first time only
npm run ui:dev         # http://localhost:5173 — proxies /api + /ws to :4242

# Production build
npm run ui:build       # → ui/dist/ (Express auto-detects and serves it)

# Docker
docker build -t agentforge .
docker run -p 4242:4242 -v $(pwd)/agentforge.yml:/app/agentforge.yml agentforge
```

---

## Conventions

- **ES modules only** — `import/export`, never `require()`.
- **No external test framework** — `node:test` + `node:assert/strict`.
- **One file per provider** — implement `BaseProvider`, register in `ProviderRegistry`.
- **Events over direct calls** — subsystems communicate via `eventBus`, not imports.
- **DB through `AgentForgeDB`** — never query SQLite directly in other modules.
- **React: `@/` imports** — alias points to `ui/src/`. Never use relative paths crossing feature boundaries.
- **Tailwind v4** — config is in `ui/src/app.css` (`@theme`), not `tailwind.config.*`.
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
