# Configuration Reference

All AgentForge behaviour is controlled by a single YAML file, `agentforge.yml`.
Copy `agentforge.example.yml` to get started.

The loader replaces every `${MY_VAR}` with the value of `MY_VAR` before it parses the YAML. An unset variable becomes an empty string. There is no default syntax, and an unset variable causes no startup error.

If the file does not exist, the loader prints a warning and uses built-in defaults. The only validation is `validateModelReferences()`. Startup fails if a model has no provider, if a model names a provider missing from `providers`, or if `team` or a routing rule names a model missing from `models`. Unknown keys are kept and ignored.

This page marks keys that the loader accepts but that no running code reads as **not read**.

---

## Top-level structure

```yaml
project:   ...   # Project identity and global budget
providers: ...   # AI provider credentials and quotas
models:    ...   # Model registry with tier and pricing
routing:   ...   # Rules for automatic model selection
team:      ...   # Agent definitions
git:       ...   # Not read (git integration is not wired)
alerts:    ...   # Budget alert thresholds
server:    ...   # HTTP/WebSocket server settings and auth
database:  ...   # SQLite file location
```

---

## `project`

```yaml
project:
  name: "My Project"       # Display name in UI and logs
  budget: 50.00            # Total spend in USD. Queued tasks pause at
                           # alerts.budget_pause_pct of this amount.
  currency: USD            # Not read
```

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | `AgentForge Project` | Project display name and the ID that costs are recorded under |
| `budget` | number | `100` | USD limit for the project |
| `currency` | string | `USD` | Not read |

Spend lives in memory and starts at zero on every restart. The cost records in SQLite are not read back into the budget.

---

## `providers`

`createAgentForge()` registers five provider IDs: `anthropic`, `google`, `deepseek`, `openrouter`, and `ollama`. Any other key under `providers` is ignored. Each provider block follows the same shape:

```yaml
providers:
  <provider_id>:
    enabled: true | false        # false skips the provider
    api_key: ${ENV_VAR}          # or literal string
    endpoint: https://...        # Override base URL (not read by google)
    quota:
      max_requests_per_minute: N # Requests per window
      max_tokens_per_minute: N   # Input tokens per window
      window_minutes: 1          # Window length in minutes (default 1)
      auto_pause: true           # false turns quota tracking off for this provider
```

A provider other than `ollama` registers only when `api_key` is not empty. Ollama registers unless `enabled: false`, and startup runs a health check against it.

Quota tracking applies only to providers with a `quota` block. Above 70% of either limit the provider is `throttled`. Above 95% it is `exhausted`, and the router skips its models until usage drops to 95% or below.

### `providers.anthropic`

```yaml
providers:
  anthropic:
    enabled: true
    api_key: ${ANTHROPIC_API_KEY}
    endpoint: https://api.anthropic.com    # Default; omit to use default
    quota:
      max_requests_per_minute: 100
      max_tokens_per_minute: 400000
      auto_pause: true
```

### `providers.google`

```yaml
providers:
  google:
    enabled: true
    api_key: ${GOOGLE_AI_KEY}
    quota:
      max_requests_per_minute: 60
      auto_pause: true
```

The Google adapter ignores `endpoint` and does not pass tools to the model.

### `providers.deepseek`

```yaml
providers:
  deepseek:
    enabled: true
    api_key: ${DEEPSEEK_API_KEY}
    endpoint: https://api.deepseek.com
    quota:
      max_requests_per_minute: 120
```

### `providers.openrouter`

```yaml
providers:
  openrouter:
    enabled: false
    api_key: ${OPENROUTER_API_KEY}
    endpoint: https://openrouter.ai/api/v1   # Default
    site_name: AgentForge                    # Sent as X-Title
    site_url: https://agentforge.dev         # Sent as HTTP-Referer
```

### `providers.ollama`

```yaml
providers:
  ollama:
    enabled: true
    endpoint: http://localhost:11434
    # No api_key needed.
```

---

## `models`

Register every model you want to use. Models reference a provider and carry
tier, pricing, and context window metadata used by the router.

```yaml
models:
  <model_id>:
    provider: <provider_id>   # Must match a key in providers:
    tier: 1 | 2 | 3           # 1 = strategy, 2 = development, 3 = execution
    cost_in: N.NN             # USD per 1M input tokens
    cost_out: N.NN            # USD per 1M output tokens
    context: N                # Max context window in tokens
```

**Tier meanings:**

| Tier | Purpose | Typical models |
|---|---|---|
| 1 | Architecture, planning, security audits | Opus, Gemini 4 Argon |
| 2 | Implementation, code review, debugging | Sonnet, Gemini Flash, DeepSeek V4 Pro |
| 3 | Tests, scripts, bulk tasks | Haiku, DeepSeek Flash, local Ollama |

**Example:**

```yaml
models:
  claude-opus-5-5:
    provider: anthropic
    tier: 1
    cost_in: 4.00
    cost_out: 20.00
    context: 1000000

  claude-sonnet-5-5:
    provider: anthropic
    tier: 2
    cost_in: 2.00
    cost_out: 10.00
    context: 1000000

  claude-haiku-5-5:
    provider: anthropic
    tier: 3
    cost_in: 0.10
    cost_out: 0.50
    context: 1000000

  gemini-4-argon:
    provider: google
    tier: 1
    cost_in: 2.00
    cost_out: 10.00
    context: 1000000

  deepseek-flash:
    provider: deepseek
    tier: 3
    cost_in: 0.30
    cost_out: 1.20
    context: 1000000

  codestral:22b:          # Ollama local model
    provider: ollama
    tier: 3
    cost_in: 0
    cost_out: 0
    context: 32000
```

---

## `routing`

The router evaluates rules in order. The first matching rule that yields an available model wins. A matching rule that finds no available model does not stop the search: the router moves on to the next rule.

```yaml
routing:
  rules:
    - match: { <matcher>: <value> }
      <action>: <value>

  fallback_strategy: same_tier_then_downgrade   # Not read
  cost_optimization: true                       # Not read
```

The router always behaves as `same_tier_then_downgrade`. It ignores `fallback_strategy` and `cost_optimization`.

### Matchers

All matchers in a rule must hold.

| Matcher | Type | Description |
|---|---|---|
| `type` | string or array | Match task type exactly |
| `context_tokens_gt` | number | Match when the task's `context_tokens_estimate` exceeds N tokens |
| `budget_remaining_lt` | number | Match when the remaining budget fraction is below N (`0.10` means 10%) |

The orchestrator sets `context_tokens_estimate` only after it routes a task, and neither the API nor the CLI accepts it. So `context_tokens_gt` does not match on a task's first dispatch.

### Actions

The router tries the actions in this order: `force`, then `prefer`, then each `fallback`, then any model in `tier`.

| Action | Type | Description |
|---|---|---|
| `force` | string | Use only this model ID. If it is unavailable, the rule yields nothing |
| `prefer` | string | Try this model ID first |
| `fallback` | array | Ordered list of model IDs to try next |
| `tier` | number | Try every model in this tier, local (cost 0) first, then cheapest |

A model is available when it is listed under `models`, its `context` fits the estimate, and its provider's quota allows the call.

### Default routing

When no rule yields a model, the router maps the task type to a tier:

| Tier | Task types |
|---|---|
| 1 | `architecture`, `planning`, `review`, `security_audit` |
| 2 | `implement`, `refactor`, `code_review`, `debug`, and any unknown type |
| 3 | `test`, `script`, `bulk`, `migration`, `format` |

It tries every model in that tier, then every model in each lower tier. If nothing is available, the task waits in `waiting_quota`.

### Example rules

```yaml
routing:
  rules:
    # Large contexts need Gemini's 1M window
    - match: { context_tokens_gt: 200000 }
      force: gemini-4-argon

    # When nearly out of budget, use the execution tier
    - match: { budget_remaining_lt: 0.10 }
      tier: 3

    # Strategy tasks → Tier 1
    - match: { type: [architecture, planning, review, security_audit] }
      tier: 1
      prefer: claude-opus-5-5
      fallback: [gemini-4-argon]

    # Development tasks → Tier 2
    - match: { type: [implement, refactor, code_review, debug] }
      tier: 2
      prefer: claude-sonnet-5-5
      fallback: [deepseek-v4-pro]

    # Execution tasks → Tier 3 (prefer local/cheap)
    - match: { type: [test, script, bulk, migration, format] }
      tier: 3
      prefer: codestral:22b
      fallback: [deepseek-flash, claude-haiku-5-5]
```

---

## `team`

Agent definitions. An agent is configuration, not a process. A task names its agent with `agent_id`, which is the agent's name in lowercase with spaces replaced by `-`.

```yaml
team:
  - name: <display name>
    role: <role description>
    model: <model_id>                       # Tried before any routing rule
    fallback_models: [<model_id>, ...]      # Tried in order if model is unavailable

    # Prompt
    system_prompt: "You are a..."           # Inline prompt
    system_prompt_file: prompts/agent.md    # Or load from file (replaces system_prompt)

    max_tokens_per_task: 4096               # max_tokens for each call (default 4096)

    # Accepted by the loader, not read by any running code:
    allow_tier_downgrade: true | false
    tools: [...]
    max_cost_per_task: 5.00
    require_review: true | false
    reviewer: <agent name>
```

If an agent has no `system_prompt`, the context builder writes one from `name` and `role`.

Agents have no tools. The orchestrator resolves every `tools` list to an empty list, so the model never receives tool definitions. Names such as `file_read`, `file_write`, `git_commit`, `run_tests`, `shell_exec`, and `ask_agent` do nothing. The review settings and the per-task cost limit are not enforced either. The loader also drops `knowledge`.

---

## `git`

Not read. The git integration in `src/git/` (`GitManager`, `BranchStrategy`, `AutoCommit`, `AutoPR`, `ReviewGate`, `GitHubIntegration`) is present but not wired. Nothing in `createAgentForge()` or the CLI starts it, so no branch, commit, or pull request is ever created. It is scheduled for removal in v0.9 (see [#190](https://github.com/sinsonido/agentforge/issues/190)). The example config still contains a `git` block, and the server ignores it.

---

## `alerts`

```yaml
alerts:
  budget_warning_pct: 0.80    # Emit budget.warning when spend reaches 80%
  budget_pause_pct: 0.95      # Emit budget.exceeded and pause queued tasks at 95%
```

At `budget_pause_pct` the orchestrator moves every queued task of the project to `paused_budget`. Nothing moves them back automatically. Tasks that are already running finish.

---

## `server`

```yaml
server:
  port: 4242         # Not read by `start` (use --port)
  host: localhost    # Not read by `start` (use --host)
  auth:
    enabled: false   # true requires a Bearer token on /api/*
    secret: ${AGENTFORGE_SECRET}
```

The `start` command has CLI defaults of `--port 4242` and `--host 127.0.0.1`, and those defaults always take precedence over `server.port` and `server.host`.

When `auth.enabled` is `true`:

- Every `/api/*` request needs `Authorization: Bearer <secret>`, except `GET /api/status`.
- A WebSocket client must connect with `?token=<secret>`. The server closes other connections with code `4401`.
- A missing or wrong token gets `401 { "ok": false, "error": "Unauthorized" }`.

Auth is skipped when `NODE_ENV=test`.

---

## `database`

```yaml
database:
  path: .agentforge/data.db   # Default, relative to the working directory
```

---

## Environment variable reference

The config file names these variables. You can use any name inside `${...}`.

| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | `providers.anthropic.api_key` |
| `GOOGLE_AI_KEY` | `providers.google.api_key` |
| `DEEPSEEK_API_KEY` | `providers.deepseek.api_key` |
| `OPENROUTER_API_KEY` | `providers.openrouter.api_key` |
| `AGENTFORGE_SECRET` | `server.auth.secret` |
| `NODE_ENV` | `test` turns off auth and rate limits and mounts `POST /api/test/reset` |
