# AgentForge Roadmap

Strategy: **vertical slices**. Each milestone delivers something runnable end-to-end, not layers in isolation. Ship fast, iterate.

---

## v0.1 — "One Agent Works" (MVP)

**Goal:** A single agent can receive a task, route it to the right model, execute it, track cost and quota, and pause/resume automatically.

**This is the foundation. Nothing else matters until this works.**

### Issues

#### Core Engine
- [ ] `#1` **TaskQueue** — Priority queue with FIFO fallback. Tasks have: id, type, priority, agent_id, status, context_tokens_estimate. Statuses: queued → assigned → executing → completed/failed/waiting_quota.
- [ ] `#2` **Orchestrator** — Main loop. Pulls from queue, calls router, dispatches to execution layer, handles results. Single-threaded event loop (Node.js native).
- [ ] `#3` **EventBus** — Simple pub/sub. Events: task.queued, task.assigned, task.completed, task.failed, quota.exhausted, quota.reset, agent.paused, agent.resumed. Use EventEmitter, nothing fancy.

#### Router
- [ ] `#4` **RuleEngine** — Evaluate rules from config. Input: task metadata. Output: { model, provider, tier }. Rules are ordered, first match wins.
- [ ] `#5` **TierResolver** — Map task.type → tier. Configurable mapping with sensible defaults.
- [ ] `#6` **ModelSelector** — Given a tier and constraints, pick the cheapest available model. Filter by: provider enabled, quota available, context window sufficient.
- [ ] `#7` **FallbackChain** — When selected model is unavailable (quota), try next in chain. Chain is: same-tier-other-provider → tier-downgrade-if-allowed → local → queue-and-wait.

#### Quota Management
- [ ] `#8` **QuotaTracker** — Per-provider sliding window. Track requests/min and tokens/min. Methods: canExecute(estimated_tokens), recordUsage(tokens_in, tokens_out), getState(). States: available, throttled, exhausted.
- [ ] `#9` **QuotaWatcher** — Timer that prunes sliding window every second. When exhausted provider becomes available → emit quota.reset → resume paused agents.
- [ ] `#10` **AutoPause/Resume** — On quota.exhausted: find all agents using that provider → set status to waiting_quota → return tasks to queue. On quota.reset: reverse the process.

#### Provider Adapters
- [ ] `#11` **ProviderInterface** — Unified interface: `execute(model, messages, tools, options) → { content, tokens_in, tokens_out, cost }`. All providers implement this.
- [ ] `#12` **AnthropicProvider** — Messages API. Handle streaming. Map errors to standard format.
- [ ] `#13` **GoogleProvider** — Gemini API. Handle the different request format.
- [ ] `#14` **OllamaProvider** — Local. HTTP to localhost:11434. No auth, no quota.
- [ ] `#15` **DeepSeekProvider** — OpenAI-compatible API with DeepSeek endpoint.

#### Execution
- [ ] `#16` **ContextBuilder** — Build the full prompt: system_prompt + knowledge files + task description + conversation history. Estimate token count before sending.
- [ ] `#17` **CostTracker** — After each execution, calculate cost from tokens × model pricing. Update project budget. Emit alerts.
- [ ] `#18` **OutputCollector** — Parse model response. Extract code blocks, file operations, tool calls. Store result.

#### Config
- [ ] `#19` **ConfigLoader** — Parse agentforge.yml. Validate schema. Resolve env vars (${VAR} syntax). Watch for changes.
- [ ] `#20` **CLI entry point** — `agentforge start` loads config, initializes all components, starts orchestrator loop. `agentforge task add "Write tests"` adds a task.

### Definition of Done for v0.1
```
$ agentforge task add --type=implement --agent=developer "Create a hello world Express server"
→ Router selects claude-sonnet-4 (T2)
→ QuotaTracker checks: OK
→ ContextBuilder builds prompt
→ Provider executes call
→ CostTracker logs: 1,234 tokens, $0.02
→ Output saved to tasks/t001/output.md

# If Anthropic quota exhausted:
→ AutoPause triggers
→ FallbackChain tries deepseek-r1
→ Or waits and auto-resumes when window resets
```

---

## v0.2 — "Team Works"

**Goal:** Multiple agents collaborate. Task dependencies. Inter-agent communication. Review workflow.

### Issues

- [ ] `#21` **AgentLifecycle** — State machine: idle → assigned → executing → reviewing → idle. Track per-agent state.
- [ ] `#22` **DependencyGraph** — DAG of tasks. Task t5 depends on t3 and t4. Topological sort for execution order. Parallelize independent tasks.
- [ ] `#23` **InterAgentComm** — `ask_agent(target, question)` tool. Creates micro-task for target agent, blocks caller until response. Orchestrator manages the round-trip.
- [ ] `#24` **ReviewWorkflow** — When agent.require_review = true, completed task goes to reviewer agent before marking as done. Reviewer can approve or request changes (re-queue).
- [ ] `#25` **ParallelExecution** — Multiple agents execute simultaneously. Respect per-provider concurrency limits. Orchestrator manages execution slots.
- [ ] `#26` **TaskDecomposition** — T1 agent can break a high-level task into subtasks. Orchestrator adds them to queue with dependencies.

### Definition of Done for v0.2
```
$ agentforge project run
→ Architect (T1) decomposes "Build API" into 4 subtasks
→ Developer (T2) and Tester (T3) work in parallel
→ Developer asks Architect a question via ask_agent
→ Completed code goes to Architect for review
→ Architect approves → task marked done
```

---

## v0.3 — "Git Works"

**Goal:** Agents interact with a real git repo. Branches, commits, PRs, CI integration.

### Issues

- [ ] `#27` **GitManager** — Wrapper around git CLI or isomorphic-git. Init, branch, commit, push, PR.
- [ ] `#28` **BranchStrategy** — Auto-create branch per agent+task: `agent/{name}/{task_id}`. Configurable pattern.
- [ ] `#29` **AutoCommit** — When agent uses file_write tool, stage and commit with formatted message: `[T2] Implement token vault (#t3)`.
- [ ] `#30` **AutoPR** — On task completion, create PR from agent branch to target branch. Include task description and agent output as PR body.
- [ ] `#31` **ReviewGate** — PR requires approval from T1 agent or human before merge. Integrate with GitHub API review system.
- [ ] `#32` **GitHubIntegration** — Connect via PAT or GitHub App. List repos, create branches, create PRs, read CI status.

### Definition of Done for v0.3
```
→ Developer completes task
→ Code committed to agent/developer/t3
→ PR created to develop branch
→ Architect reviews via AgentForge (not GitHub UI)
→ CI runs, passes
→ PR merged (auto or manual)
```

---

## v0.4 — "Dashboard Works"

**Goal:** Web UI for managing everything. Real-time updates via WebSocket.

### Issues

- [ ] `#33` **REST API** — Express/Fastify. CRUD for projects, agents, tasks. Cost and quota endpoints.
- [ ] `#34` **WebSocket server** — Real-time events: task status changes, agent activity, quota updates, logs.
- [ ] `#35` **Dashboard UI** — React or Vue. KPIs, project overview, quota status, activity feed.
- [ ] `#36` **Kanban Board** — Drag-and-drop task management per project. Columns: backlog → todo → in_progress → review → done.
- [ ] `#37` **Agent Config UI** — Edit system prompts, assign models, configure tools. Visual team view.
- [ ] `#38` **Provider Config UI** — API keys, endpoints, quota settings. Connection testing. Real-time quota bars.
- [ ] `#39` **Cost Dashboard** — Budget tracking by project, model, tier. Transaction log. Alerts config.

---

## v0.5 — "Production Ready"

**Goal:** CLI polish, plugin system, documentation, stability.

### Issues

- [ ] `#40` **CLI complete** — `agentforge init`, `agentforge start`, `agentforge task`, `agentforge status`, `agentforge logs`.
- [ ] `#41` **Plugin system** — Custom providers, custom tools, custom routing rules. Load from npm packages or local files.
- [ ] `#42` **OpenRouter provider** — Single provider that proxies to any model. Useful as universal fallback.
- [ ] `#43` **Persistence** — SQLite for task history, cost logs, agent metrics. Optional PostgreSQL for multi-user.
- [ ] `#44` **Documentation** — Full docs site. Getting started, configuration reference, provider guides, architecture deep-dive.
- [ ] `#45` **Docker** — Dockerfile + docker-compose with Ollama included. One-command setup.
- [ ] `#46` **Tests** — Unit tests for router, quota tracker, cost calculator. Integration tests for provider adapters.

---

## Iteration Strategy

### Sprint structure (1-week sprints)

```
Week 1: #1-#3 (TaskQueue + Orchestrator + EventBus) + #19 (Config)
Week 2: #4-#7 (Router complete) + #11 (ProviderInterface)
Week 3: #8-#10 (Quota complete) + #12-#15 (All providers)
Week 4: #16-#18 (Execution) + #20 (CLI) → v0.1 RELEASE
Week 5-6: #21-#26 (Multi-agent) → v0.2
Week 7-8: #27-#32 (Git) → v0.3
Week 9-10: #33-#39 (Dashboard) → v0.4
Week 11-12: #40-#46 (Polish) → v0.5
```

### Principles

1. **Each issue = 1 PR.** Small, focused, reviewable.
2. **Tests with the code.** Not after. Each PR includes tests.
3. **Config-driven from day 1.** No hardcoded values. Everything in agentforge.yml.
4. **Run end-to-end ASAP.** v0.1 is ugly but works. Polish comes later.
5. **Local-first development.** Ollama adapter lets you develop without burning API credits.
