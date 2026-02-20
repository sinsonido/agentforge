# Architecture

## Design Principles

1. **Deterministic routing** — No AI decides which AI to use. Rules are explicit, auditable, configurable.
2. **Fail gracefully** — Quota exhausted? Fallback. Budget exceeded? Pause. Provider down? Next in chain.
3. **Config as code** — `agentforge.yml` is the source of truth. The UI reads/writes it. The repo travels with the config.
4. **Agents are stateless** — An agent is a configuration, not a process. No persistent memory between tasks.
5. **Everything is an event** — Components communicate via EventBus. Easy to log, debug, extend.

## System Overview

```
                    ┌─────────────────┐
                    │   CLI / API /   │
                    │    Web UI       │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Config Loader  │ ← agentforge.yml
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  ORCHESTRATOR   │ ← Main loop
                    │                 │
                    │  ┌───────────┐  │
                    │  │ TaskQueue │  │ ← Priority queue
                    │  └─────┬─────┘  │
                    │        │        │
                    │  ┌─────▼─────┐  │
                    │  │  Router   │  │ ← Rule evaluation
                    │  └─────┬─────┘  │
                    │        │        │
                    │  ┌─────▼─────┐  │
                    │  │ Executor  │  │ ← Context + call + collect
                    │  └───────────┘  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼──────┐ ┌────▼────┐ ┌───────▼──────┐
     │ QuotaTracker  │ │ CostDB  │ │  Git Manager │
     │ (per-provider)│ │ (SQLite)│ │  (branches,  │
     │               │ │         │ │   PRs)       │
     └───────────────┘ └─────────┘ └──────────────┘
              │
     ┌────────▼────────────────────────────┐
     │         Provider Adapters           │
     │  ┌──────┐ ┌──────┐ ┌──────┐ ┌────┐ │
     │  │Anthr.│ │Google│ │DeepSk│ │Olla│ │
     │  └──────┘ └──────┘ └──────┘ └────┘ │
     └─────────────────────────────────────┘
```

## Component Details

### Orchestrator (`src/core/orchestrator.js`)

The main loop. Runs continuously, pulling tasks and dispatching them.

```
loop:
  task = taskQueue.next()          // Get highest priority ready task
  if (!task) → sleep(100ms)

  route = router.resolve(task)     // Determine model + provider
  if (route.action === "wait")     // No model available
    task.status = "waiting_quota"
    continue

  result = executor.run(task, route)
  costTracker.record(result)
  quotaTracker.record(route.provider, result.usage)

  if (task.require_review)
    taskQueue.add(createReviewTask(task, result))
  else
    task.status = "completed"
    gitManager.commitIfNeeded(task, result)

  eventBus.emit("task.completed", task)
```

### Router (`src/routing/router.js`)

Deterministic decision engine. No randomness, no AI.

**Input:** Task metadata (type, priority, context_tokens, agent, project)
**Output:** { model, provider, tier, fallback_chain }

**Evaluation order:**
1. User override (task.force_model or agent.model)
2. Context rules (>200K → Gemini)
3. Budget rules (<10% → local only)
4. Tier rules (type → tier → model pool)
5. Cost optimization (cheapest in pool)
6. Quota check (is provider available?)
7. Fallback chain (if not → next option)

### QuotaTracker (`src/core/quota-tracker.js`)

Per-provider sliding window rate limiter.

```
QuotaTracker {
  windows: Map<provider_id, SlidingWindow>

  canExecute(provider, estimated_tokens): boolean
  recordUsage(provider, tokens_in, tokens_out): void
  getState(provider): "available" | "throttled" | "exhausted"
  getResetEstimate(provider): seconds
}

SlidingWindow {
  entries: Array<{ timestamp, value }>
  window_size: Duration
  max_value: number

  add(value): void
  prune(): void        // Remove entries older than window
  sum(): number
  count(): number
  usage_pct(): number  // sum / max_value
}
```

**Auto-pause flow:**
1. `recordUsage()` updates window
2. If `usage_pct > 0.95` → state = EXHAUSTED
3. Emit `quota.exhausted` event
4. Orchestrator catches event → pauses all agents on that provider
5. QuotaWatcher prunes window every 1s
6. When usage drops below threshold → state = AVAILABLE
7. Emit `quota.reset` → orchestrator resumes agents

### Provider Adapters (`src/providers/`)

Unified interface, provider-specific implementation.

```typescript
interface Provider {
  id: string
  name: string

  execute(params: {
    model: string
    messages: Message[]
    tools?: Tool[]
    max_tokens?: number
    temperature?: number
    stream?: boolean
  }): Promise<{
    content: string
    tokens_in: number
    tokens_out: number
    tool_calls?: ToolCall[]
    raw_response?: any
  }>

  listModels(): Promise<string[]>
  healthCheck(): Promise<boolean>
}
```

### Agent Definition

Agents are pure configuration, not runtime objects.

```typescript
interface AgentConfig {
  id: string
  name: string
  role: string
  model: string                    // Default model
  fallback_models?: string[]       // If default unavailable
  allow_tier_downgrade?: boolean

  system_prompt: string
  system_prompt_file?: string      // Loaded from file
  knowledge?: string[]             // Files injected into context

  tools: string[]                  // Available tools
  max_tokens_per_task?: number
  max_cost_per_task?: number

  require_review?: boolean
  reviewer?: string                // Agent ID
}
```

### Tools (`src/tools/`)

Actions agents can perform. Each tool follows a standard interface.

```typescript
interface Tool {
  name: string
  description: string
  parameters: JSONSchema

  execute(params: any, context: TaskContext): Promise<ToolResult>
}
```

Built-in tools:
- `file_read` — Read files from the project repo
- `file_write` — Write/modify files
- `git_commit` — Stage and commit changes
- `run_tests` — Execute test suite
- `shell_exec` — Run shell commands (sandboxed)
- `ask_agent` — Query another agent (via orchestrator)

### Event Bus (`src/core/event-bus.js`)

Simple pub/sub for decoupled communication.

```
Events:
  task.queued        { task }
  task.assigned      { task, agent, model }
  task.executing     { task, agent }
  task.completed     { task, result, cost }
  task.failed        { task, error }
  quota.throttled    { provider, usage_pct }
  quota.exhausted    { provider }
  quota.reset        { provider }
  agent.paused       { agent, reason }
  agent.resumed      { agent }
  budget.warning     { project, pct }
  budget.exceeded    { project }
  git.committed      { task, branch, sha }
  git.pr_created     { task, pr_url }
```

## Data Model

```sql
-- Core tables (SQLite)
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_path TEXT,
  budget REAL,
  spent REAL DEFAULT 0,
  status TEXT DEFAULT 'active'
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  type TEXT,               -- architecture, implement, test, etc.
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'queued',
  agent_id TEXT,
  model_used TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  output TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  depends_on TEXT           -- JSON array of task IDs
);

CREATE TABLE quota_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  requests INTEGER DEFAULT 1,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0
);

CREATE TABLE cost_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  model TEXT,
  provider TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost REAL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## File Structure

```
agentforge/
├── agentforge.yml              # Project config (user creates this)
├── agentforge.example.yml      # Reference config
├── src/
│   ├── index.js                # Entry point
│   ├── core/
│   │   ├── orchestrator.js     # Main loop
│   │   ├── task-queue.js       # Priority queue
│   │   ├── quota-tracker.js    # Sliding window per provider
│   │   ├── cost-tracker.js     # Budget management
│   │   └── event-bus.js        # Pub/sub
│   ├── routing/
│   │   ├── router.js           # Decision engine
│   │   ├── rule-engine.js      # Rule evaluation
│   │   ├── tier-resolver.js    # type → tier mapping
│   │   ├── model-selector.js   # Pick cheapest valid model
│   │   └── fallback-chain.js   # Fallback strategy
│   ├── providers/
│   │   ├── interface.js        # Base interface
│   │   ├── anthropic.js        # Claude
│   │   ├── google.js           # Gemini
│   │   ├── deepseek.js         # DeepSeek
│   │   ├── ollama.js           # Local models
│   │   └── openrouter.js       # Universal proxy
│   ├── agents/
│   │   ├── lifecycle.js        # State machine
│   │   ├── context-builder.js  # Prompt assembly
│   │   └── output-collector.js # Parse results
│   ├── tools/
│   │   ├── file-read.js
│   │   ├── file-write.js
│   │   ├── git-commit.js
│   │   ├── run-tests.js
│   │   ├── shell-exec.js
│   │   └── ask-agent.js
│   ├── git/
│   │   └── git-manager.js      # Branch, commit, PR
│   ├── api/
│   │   ├── server.js           # REST + WebSocket
│   │   └── routes.js           # API endpoints
│   └── config/
│       ├── loader.js           # YAML parser + validation
│       ├── schema.js           # Config schema
│       └── defaults.js         # Default values
├── tests/
│   ├── core/
│   ├── routing/
│   ├── providers/
│   └── fixtures/
├── docs/
│   ├── architecture.md         # This file
│   ├── configuration.md        # Config reference
│   └── providers.md            # Provider setup guides
├── prompts/                    # System prompt templates
├── examples/                   # Example configs
└── package.json
```
