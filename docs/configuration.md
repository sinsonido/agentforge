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
autonomy:  ...   # Which host actions run, wait for the operator, or never run
babysit:   ...   # How AgentForge watches a task PR's CI and fixes it when red
budget:    ...   # Spend limits per coding task and per repository, build and verify apart
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
```

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | `AgentForge Project` | Project display name and the ID that costs are recorded under |
| `budget` | number | `100` | USD limit for the project |

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
```

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
```

If an agent has no `system_prompt`, the context builder writes one from `name` and `role`.

Agents have no tools. The orchestrator sends no tool definitions, so the model only returns text. The loader drops any other key on an agent, such as `tools` or `knowledge`.

---

## `autonomy`

What AgentForge may do on the host after a coding task passes the evidence gate. This is poteto-mode's Autonomy section, enforced in code: reversible work proceeds, and merge waits for the operator. The agent never pushes, opens PRs or merges. It has no push or `gh` credentials. AgentForge performs these actions itself, in this order:

| Action | What it does | Rules | Default |
|---|---|---|---|
| `publish` | Push `agentforge/<task>` and open the PR | `allow`, `approve`, `deny` | `allow` |
| `push-fix` | Push a fix round's commits onto the PR branch (see `babysit`) | `allow`, `approve`, `deny` | `allow` |
| `merge` | Squash-merge the PR with `gh pr merge` | `approve`, `deny` | `approve` |

```yaml
autonomy:
  publish: allow
  push-fix: allow
  merge: approve
```

- `allow`: the action runs.
- `approve`: the task moves to `needs-approval` with a pending approval record. The task view shows an approval card with Approve and Reject. Approve runs the action. If the approved action fails, the task waits again with the error on the card, and Approve retries it.
- `deny`: the action never runs.

An action that does not run, denied by the policy or rejected by the operator, ends the task where the action before it left it. A denied or rejected `merge` leaves the task `pr-opened`. A denied `publish` fails the task, and a rejected `publish` cancels it. A denied or rejected `push-fix` fails the task with CI red. After an approved merge the task is `completed`.

A task in `needs-approval` keeps its issue: intake creates no second task for it. It survives a restart and waits for the operator. Every policy and operator decision goes to the task's decision trail. A missing action takes its default. An unknown action, or `merge: allow`, stops startup with an error.

---

## `babysit`

poteto-mode's Babysit playbook, run by the host. After `publish` or `push-fix` pushes a PR head, the task waits in `ci-watch` while AgentForge reads that head's checks with `gh pr checks` on the host. It polls every 10 to 60 seconds; nothing sleeps inside the agent.

- **Green.** Every check finished and none failed. The task goes on to `merge` under the `autonomy` policy, so by default it waits in `needs-approval`.
- **Red.** A check failed or was cancelled. With fix rounds left, the task moves to `fixing`: a fresh harness run on a fresh clone of the PR branch. Its instruction holds the original task, each failing check with the tail of its log, and the decision trail so far. The run passes the same evidence gate, `push-fix` pushes its commits onto the PR branch (fast-forward only), and the new head is watched again.
- **Over the cap.** Red after `max_rounds` fix rounds fails the task with the failing check names.

```yaml
babysit:
  max_rounds: 2        # fix rounds per task; 0 never fixes
  timeout_minutes: 60  # one head's CI must finish in this time, else the task fails
  checks: all          # all, or required: only the checks branch protection requires
```

A head with no checks after five minutes counts as green. The task stores its rounds as `babysit`: the branch, the cap, one record per pushed head (`n`, `head`, `ci`, `failing`), and the final `verdict` (`green`, `red`, `merged`, `closed`, `timeout` or `stopped`). Each CI result is a `gate` entry in the decision trail. The task view shows the rounds.

A task in `ci-watch` keeps its issue and survives a restart: the next process resumes the watch with the same deadline. A task that was `fixing` goes back to `ci-watch` on boot and runs the fix round again on a fresh clone. A PR merged outside AgentForge completes the task; a closed one fails it.

---

## `budget`

Spend limits for coding tasks. Every executor run is one tranche of spend, written to the cost ledger (`cost_records`) with its task, repository and `phase`:

- `build` is the task's first run and its fix rounds.
- `verify` is an independent verification run before merge.

Build and verification are budgeted apart, so a task that used its build budget can still be verified, and verification cannot eat the budget for fixes.

```yaml
budget:
  task:
    build: 5        # USD one task may spend on build runs over its whole life
    verify: 2       # USD one task may spend on verification
  repo:
    window: day     # rolling window: day (24 h), week (7 days) or month (30 days)
    build: 50       # USD all tasks of one repository may spend on build in the window
    verify: 20
  min_run_usd: 0.25 # a run starts only with at least this much left under every limit of its phase
```

Every limit is optional; a missing one is no limit. A task created with `budget` in `POST /api/tasks` uses it as its own build limit instead of `task.build`.

**Before each leg.** Before the orchestrator starts a leg that could spend, it checks the limits of every phase that leg could reach. A task with no PR yet runs a build. A task in `ci-watch` whose last round is red runs a fix round (build). A green round goes on to verification (verify). A pending round could do either, so both are checked. When a limit has less than `min_run_usd` left, the task moves to `paused_budget` and a `fail budget` gate entry in the decision trail names the limit and what it has spent. The task keeps its issue, survives a restart, and goes back to `queued` or `ci-watch` on its own once the limit has room again: the repository window rolled on, or the operator raised the limit and restarted. A `decision` entry records the resume. The task view's Cancel button ends a paused task.

**Each run.** The harness gets `--max-budget-usd` set to what is left under the tightest limit of the run's phase. Without any limit, `executor.budget_usd` applies as before.

**Why a rolling window.** A calendar day resets to a full budget at midnight, so a runaway loop could spend twice the limit across the boundary. A rolling window counts the last 24 hours (or 7 or 30 days) from the ledger at every check, so it needs no reset job and gives the same answer after a restart.

The task view shows build and verify spend against each limit. The Costs view lists each repository's spend in its window. `GET /api/tasks/:id/spend` and `GET /api/costs` (`byPhase`, `repos`) return the same numbers.

---

## `alerts`

```yaml
alerts:
  budget_warning_pct: 0.80    # Emit budget.warning when spend reaches 80%
  budget_pause_pct: 0.95      # Emit budget.exceeded and pause queued tasks at 95%
```

At `budget_pause_pct` the orchestrator moves every queued text task of the project to `paused_budget`. Nothing moves them back automatically. Tasks that are already running finish. Coding tasks answer to `budget` instead.

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
