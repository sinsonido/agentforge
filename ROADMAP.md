# AgentForge Roadmap

Strategy: **vertical slices**. Each milestone delivers something runnable end-to-end, not layers in isolation. Ship fast, iterate.

---

## v0.1 — "One Agent Works" (MVP) ✅

**Goal:** A single agent can receive a task, route it to the right model, execute it, track cost and quota, and pause/resume automatically.

### Issues

#### Core Engine
- [x] `#1` **TaskQueue** — Priority queue with FIFO fallback. Tasks have: id, type, priority, agent_id, status, context_tokens_estimate. Statuses: queued → assigned → executing → completed/failed/waiting_quota.
- [x] `#2` **Orchestrator** — Main loop. Pulls from queue, calls router, dispatches to execution layer, handles results. Single-threaded event loop (Node.js native).
- [x] `#3` **EventBus** — Simple pub/sub. Events: task.queued, task.assigned, task.completed, task.failed, quota.exhausted, quota.reset, agent.paused, agent.resumed. Use EventEmitter, nothing fancy.

#### Router
- [x] `#4` **RuleEngine** — Evaluate rules from config. Input: task metadata. Output: { model, provider, tier }. Rules are ordered, first match wins.
- [x] `#5` **TierResolver** — Map task.type → tier. Configurable mapping with sensible defaults.
- [x] `#6` **ModelSelector** — Given a tier and constraints, pick the cheapest available model. Filter by: provider enabled, quota available, context window sufficient.
- [x] `#7` **FallbackChain** — When selected model is unavailable (quota), try next in chain. Chain is: same-tier-other-provider → tier-downgrade-if-allowed → local → queue-and-wait.

#### Quota Management
- [x] `#8` **QuotaTracker** — Per-provider sliding window. Track requests/min and tokens/min. Methods: canExecute(estimated_tokens), recordUsage(tokens_in, tokens_out), getState(). States: available, throttled, exhausted.
- [x] `#9` **QuotaWatcher** — Timer that prunes sliding window every second. When exhausted provider becomes available → emit quota.reset → resume paused agents.
- [x] `#10` **AutoPause/Resume** — On quota.exhausted: find all agents using that provider → set status to waiting_quota → return tasks to queue. On quota.reset: reverse the process.

#### Provider Adapters
- [x] `#11` **ProviderInterface** — Unified interface: `execute(model, messages, tools, options) → { content, tokens_in, tokens_out, cost }`. All providers implement this.
- [x] `#12` **AnthropicProvider** — Messages API. Handle streaming. Map errors to standard format.
- [x] `#13` **GoogleProvider** — Gemini API. Handle the different request format.
- [x] `#14` **OllamaProvider** — Local. HTTP to localhost:11434. No auth, no quota.
- [x] `#15` **DeepSeekProvider** — OpenAI-compatible API with DeepSeek endpoint.

#### Execution
- [x] `#16` **ContextBuilder** — Build the full prompt: system_prompt + knowledge files + task description + conversation history. Estimate token count before sending.
- [x] `#17` **CostTracker** — After each execution, calculate cost from tokens × model pricing. Update project budget. Emit alerts.
- [x] `#18` **OutputCollector** — Parse model response. Extract code blocks, file operations, tool calls. Store result.

#### Config
- [x] `#19` **ConfigLoader** — Parse agentforge.yml. Validate schema. Resolve env vars (${VAR} syntax). Watch for changes.
- [x] `#20` **CLI entry point** — `agentforge start` loads config, initializes all components, starts orchestrator loop. `agentforge task add "Write tests"` adds a task.

---

## v0.2 — "Team Works" ✅

**Goal:** Multiple agents collaborate. Task dependencies. Inter-agent communication. Review workflow.

### Issues

- [x] `#21` **AgentLifecycle** — State machine: idle → assigned → executing → reviewing → idle. Track per-agent state.
- [x] `#22` **DependencyGraph** — DAG of tasks. Task t5 depends on t3 and t4. Topological sort for execution order. Parallelize independent tasks.
- [x] `#23` **InterAgentComm** — `ask_agent(target, question)` tool. Creates micro-task for target agent, blocks caller until response. Orchestrator manages the round-trip.
- [x] `#24` **ReviewWorkflow** — When agent.require_review = true, completed task goes to reviewer agent before marking as done. Reviewer can approve or request changes (re-queue).
- [x] `#25` **ParallelExecution** — Multiple agents execute simultaneously. Respect per-provider concurrency limits. Orchestrator manages execution slots.
- [x] `#26` **TaskDecomposition** — T1 agent can break a high-level task into subtasks. Orchestrator adds them to queue with dependencies.

---

## v0.3 — "Git Works" ✅

**Goal:** Agents interact with a real git repo. Branches, commits, PRs, CI integration.

### Issues

- [x] `#27` **GitManager** — Wrapper around git CLI. Init, branch, commit, push, PR.
- [x] `#28` **BranchStrategy** — Auto-create branch per agent+task: `agent/{name}/{task_id}`. Configurable pattern.
- [x] `#29` **AutoCommit** — When agent uses file_write tool, stage and commit with formatted message: `[T2] Implement token vault (#t3)`.
- [x] `#30` **AutoPR** — On task completion, create PR from agent branch to target branch. Include task description and agent output as PR body.
- [x] `#31` **ReviewGate** — PR requires approval from T1 agent or human before merge. Integrate with GitHub API review system.
- [x] `#32` **GitHubIntegration** — Connect via PAT or GitHub App. List repos, create branches, create PRs, read CI status.

---

## v0.4 — "API & Real-time" ✅

**Goal:** REST API and WebSocket server backing the future dashboard. Parallel execution.

### Issues

- [x] `#33` **REST API** — Express server with 12 routes (tasks, agents, quotas, costs, events, control start/stop, review approve/reject).
- [x] `#34` **WebSocket server** — Real-time event streaming, ping/pong liveness, replay last 20 events on connect, broadcasts 18 event types.

---

## v0.5 — "Production Ready" ✅

**Goal:** CLI polish, plugin system, Docker, tests, OpenRouter.

### Issues

- [x] `#40` **CLI complete** — `agentforge init`, `agentforge start`, `agentforge task`, `agentforge status`, `agentforge logs`.
- [x] `#41` **Plugin system** — Custom providers, custom tools, custom routing rules. Load from npm packages or local files.
- [x] `#42` **OpenRouter provider** — Single provider that proxies to any model. Useful as universal fallback.
- [x] `#43` **Persistence** — SQLite for task history, cost logs, agent metrics (WAL mode).
- [ ] `#44` **Documentation** — Full docs site. Getting started, configuration reference, provider guides, architecture deep-dive.
- [x] `#45` **Docker** — Multi-stage Dockerfile + docker-compose with Ollama profile. One-command setup.
- [x] `#46` **Tests** — 257 tests across 78 suites. Unit: core, routing, execution. All passing.

---

## v0.6 — "Dashboard Works" 🔨

**Goal:** Web UI for managing everything. Real-time updates via WebSocket (server already built in v0.4).

### Issues

- [ ] `#35` **Dashboard UI** — KPIs, project overview, quota status, activity feed.
- [ ] `#36` **Kanban Board** — Drag-and-drop task management per project. Columns: backlog → todo → in_progress → review → done.
- [ ] `#37` **Agent Config UI** — Edit system prompts, assign models, configure tools. Visual team view.
- [ ] `#38` **Provider Config UI** — API keys, endpoints, quota settings. Connection testing. Real-time quota bars.
- [ ] `#39` **Cost Dashboard** — Budget tracking by project, model, tier. Transaction log. Alerts config.

---

## Principles

1. **Each issue = 1 PR.** Small, focused, reviewable.
2. **Tests with the code.** Not after. Each PR includes tests.
3. **Config-driven from day 1.** No hardcoded values. Everything in agentforge.yml.
4. **Run end-to-end ASAP.** v0.1 is ugly but works. Polish comes later.
5. **Local-first development.** Ollama adapter lets you develop without burning API credits.
