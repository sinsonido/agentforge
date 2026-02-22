# Configuration Reference

All AgentForge behaviour is controlled by a single YAML file, `agentforge.yml`.
Copy `agentforge.example.yml` to get started.

Environment variable substitution is supported everywhere: `${MY_VAR}` is replaced with the value of `MY_VAR` at startup. Variables that are unset cause a startup error unless a default is provided.

---

## Top-level structure

```yaml
project:   ...   # Project identity and global budget
providers: ...   # AI provider credentials and quotas
models:    ...   # Model registry with tier and pricing
routing:   ...   # Rules for automatic model selection
team:      ...   # Agent definitions
git:       ...   # Git and GitHub integration
alerts:    ...   # Budget and quota alert thresholds
server:    ...   # HTTP/WebSocket server settings
```

---

## `project`

```yaml
project:
  name: "My Project"       # Display name in UI and logs
  budget: 50.00            # Maximum total spend in USD. Orchestrator pauses
                           # when this is reached.
  currency: USD            # Reserved for future multi-currency support
```

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | Project display name |
| `budget` | number | required | USD hard limit |
| `currency` | string | `USD` | Currency code (informational) |

---

## `providers`

Each provider block follows the same shape:

```yaml
providers:
  <provider_id>:
    enabled: true | false
    api_key: ${ENV_VAR}          # or literal string
    endpoint: https://...        # Override base URL (proxies, self-hosted)
    quota:
      max_requests_per_minute: N
      max_tokens_per_minute: N
      max_spend_per_day: N.NN    # Dollar limit (OpenRouter only)
      auto_pause: true           # Pause agents when quota hits limit
      auto_resume: true          # Resume when quota window resets
```

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
      auto_resume: true
```

### `providers.google`

```yaml
providers:
  google:
    enabled: true
    api_key: ${GOOGLE_AI_KEY}
    endpoint: https://generativelanguage.googleapis.com
    quota:
      max_requests_per_minute: 60
      auto_pause: true
      auto_resume: true
```

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
    endpoint: https://openrouter.ai/api
    quota:
      max_spend_per_day: 10.00   # Hard dollar cap
```

### `providers.ollama`

```yaml
providers:
  ollama:
    enabled: true
    endpoint: http://localhost:11434
    # No api_key needed. No quota — local is unlimited.
```

### `providers.openai`

```yaml
providers:
  openai:
    enabled: false
    api_key: ${OPENAI_API_KEY}
    quota:
      max_requests_per_minute: 500
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
| 1 | Architecture, planning, security audits | Opus, Gemini Pro |
| 2 | Implementation, code review, debugging | Sonnet, GPT-4o, DeepSeek-R1 |
| 3 | Tests, scripts, bulk tasks | Haiku, DeepSeek-V3, local Ollama |

**Example:**

```yaml
models:
  claude-opus-4-6:
    provider: anthropic
    tier: 1
    cost_in: 15.00
    cost_out: 75.00
    context: 200000

  claude-sonnet-4-6:
    provider: anthropic
    tier: 2
    cost_in: 3.00
    cost_out: 15.00
    context: 200000

  claude-haiku-4-5-20251001:
    provider: anthropic
    tier: 3
    cost_in: 0.25
    cost_out: 1.25
    context: 200000

  gemini-2.5-pro:
    provider: google
    tier: 1
    cost_in: 1.25
    cost_out: 10.00
    context: 1000000

  deepseek-v3:
    provider: deepseek
    tier: 3
    cost_in: 0.27
    cost_out: 1.10
    context: 128000

  codestral:22b:          # Ollama local model
    provider: ollama
    tier: 3
    cost_in: 0
    cost_out: 0
    context: 32000
```

---

## `routing`

Rules evaluated in order. First match wins.

```yaml
routing:
  rules:
    - match: { <matcher>: <value> }
      <action>: <value>

  fallback_strategy: same_tier_then_downgrade | downgrade_immediately | local_only
  cost_optimization: true | false
```

### Matchers

| Matcher | Type | Description |
|---|---|---|
| `type` | string or array | Match task type exactly |
| `context_tokens_gt` | number | Trigger when estimated context exceeds N tokens |
| `budget_remaining_lt` | number | Trigger when project budget remaining < N USD |

### Actions

| Action | Type | Description |
|---|---|---|
| `tier` | number | Route to this tier |
| `force` | string | Force a specific model ID |
| `force_tier` | number | Force a tier (ignore type-based rules) |
| `prefer` | string | Preferred model (fallback if unavailable) |
| `prefer_local` | bool | Prefer local (Ollama) models in the selected tier |
| `fallback` | array | Ordered list of fallback model IDs |

### Example rules

```yaml
routing:
  rules:
    # Large contexts need Gemini's 1M window
    - match: { context_tokens_gt: 200000 }
      force: gemini-2.5-pro

    # When nearly out of budget, use free local models only
    - match: { budget_remaining_lt: 0.10 }
      force_tier: 3
      prefer_local: true

    # Strategy tasks → Tier 1
    - match: { type: [architecture, planning, review, security_audit] }
      tier: 1
      prefer: claude-opus-4-6
      fallback: [gemini-2.5-pro]

    # Development tasks → Tier 2
    - match: { type: [implement, refactor, code_review, debug] }
      tier: 2
      prefer: claude-sonnet-4-6
      fallback: [deepseek-r1]

    # Execution tasks → Tier 3 (prefer local/cheap)
    - match: { type: [test, script, bulk, migration, format] }
      tier: 3
      prefer: codestral:22b
      fallback: [deepseek-v3, claude-haiku-4-5-20251001]

  fallback_strategy: same_tier_then_downgrade
  cost_optimization: true
```

---

## `team`

Agent definitions. Each agent is stateless configuration — the orchestrator
instantiates agents dynamically per task.

```yaml
team:
  - name: <display name>
    role: <role description>
    model: <model_id>
    fallback_models: [<model_id>, ...]
    allow_tier_downgrade: true | false

    # Prompt
    system_prompt: "You are a..."           # Inline prompt
    system_prompt_file: prompts/agent.md    # Or load from file
    knowledge: [docs/spec.md, src/api.js]  # Files injected into every request

    # Tools available to this agent
    tools: [file_read, file_write, git_commit, run_tests, shell_exec, ask_agent]

    # Cost limits
    max_tokens_per_task: 50000
    max_cost_per_task: 5.00

    # Review gate
    require_review: true | false
    reviewer: <agent name>          # Which agent reviews completed tasks
```

### Available tools

| Tool | Description |
|---|---|
| `file_read` | Read files from the project repository |
| `file_write` | Create or overwrite files |
| `git_commit` | Stage and commit changes |
| `run_tests` | Execute the test suite |
| `shell_exec` | Run shell commands (sandboxed) |
| `ask_agent` | Query another agent synchronously via the orchestrator |

---

## `git`

```yaml
git:
  enabled: true
  remote: origin
  base_branch: develop             # PRs target this branch
  branch_pattern: "agent/{agent_name}/{task_id}"
  commit_format: "[T{tier}] {task_title} (#{task_id})"
  auto_branch: true                # Create branch automatically per task
  auto_commit: true                # Commit on every file_write
  auto_pr: true                    # Open PR on task completion
  require_review_before_merge: true
  auto_merge_on_ci_pass: false     # Merge PR automatically if CI is green
```

### GitHub authentication

Set `GITHUB_TOKEN` in your environment (classic PAT with `repo` scope, or a GitHub App installation token):

```bash
export GITHUB_TOKEN=ghp_...
```

---

## `alerts`

```yaml
alerts:
  budget_warning_pct: 0.80    # Emit budget.warning when spend reaches 80%
  budget_pause_pct: 0.95      # Pause all agents at 95%
  # slack_webhook: ${SLACK_WEBHOOK}
  # email: you@example.com
```

---

## `server`

```yaml
server:
  port: 4242         # HTTP/WebSocket port
  host: localhost    # Bind address (use 0.0.0.0 for Docker/production)
```

---

## Environment variable reference

| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | `providers.anthropic.api_key` |
| `GOOGLE_AI_KEY` | `providers.google.api_key` |
| `DEEPSEEK_API_KEY` | `providers.deepseek.api_key` |
| `OPENAI_API_KEY` | `providers.openai.api_key` |
| `OPENROUTER_API_KEY` | `providers.openrouter.api_key` |
| `MOONSHOT_API_KEY` | `providers.moonshot.api_key` |
| `GITHUB_TOKEN` | Git integration |
| `SLACK_WEBHOOK` | Alert webhooks |
