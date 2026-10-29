# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-10-29

AgentForge is now a self-hosted control plane for coding agents grounded on
poteto-mode (#212). This release covers the v0.7.1, v0.8.0 and v0.9.0
milestones. v0.7.1 and v0.8.0 were not tagged on their own.

### Added

- Coding tasks. An issue labelled `agentforge` becomes exactly one coding task
  (#251, #254). The harness runs `claude -p` with poteto-mode in a per-task
  container on a per-task clone (#250, #255). It never holds push or `gh`
  credentials.
- Evidence gate. A run is done only with commits ahead of base, the
  repository's configured test command seen passing after the last edit, and
  a clean tree (#256, #265). Cancelled runs never publish.
- AgentForge pushes and opens the PR from the host after the gate (#253). The
  loop is wired end to end (#259). AgentForge opened #258 on itself.
- `scripts/self-host.sh` runs the instance from immutable releases (#252) on
  its own scoped GitHub token (#264). See `docs/self-hosting.md`.
- The task queue is restored from SQLite on boot (#240).
- `POST /api/tasks/:id/cancel` (#270).
- Live task view at `/tasks/:id` with the agent's transcript, replay on
  reconnect, the PR link and a Cancel button (#273).
- Decision trail per task: status changes, playbook steps, gate checks,
  agent decisions and evidence. It shows in the task view and is attached to
  the PR description (#272).

### Changed

- Stopping the instance cancels running task containers. Tasks end
  `cancelled` instead of `failed (interrupted)` (#271).
- Current model IDs, and config validation of model references (#225).
- CI tests and packs on Node 24 only (#221).
- README, CLAUDE.md, AGENTS.md and `docs/` describe the code as it is (#242,
  #247).

### Removed

- The vanilla dashboard in `src/ui/`. The server serves only `ui/dist` (#266).
- Unwired modules, the `/api/review/*` routes and config keys nothing read
  (#267), `AgentPool` and `DependencyGraph` (#268, #269).

### Fixed

- A fully spent budget (0%) was routed as healthy (#258).
- `task.queued` payload, so queued tasks persist (#217).
- `cost.recorded` is emitted only by the orchestrator (#220).
- The E2E job no longer hangs on the Playwright install (#219).

### Security

- Production `npm audit` findings cleared in root and `ui/` (#223).
- path-to-regexp 8.4.0 (#112) and picomatch 4.0.4 in `ui/` (#107).

## [0.7.0] - 2026-03-30

The code for this release was complete when #103 merged on 2026-03-30.
The `v0.7.0` tag was cut retroactively on that merge commit.

### Added

- Static API-key authentication for the REST API and the WebSocket (#102).
  Set `server.auth.enabled` and `server.auth.secret`. Requests send
  `Authorization: Bearer <secret>`; WebSocket clients send `?token=<secret>`
  and an invalid token closes the socket with code 4401. `GET /api/status`
  stays open for health checks. Tokens are compared in constant time.
  The server prints a warning at startup when auth is off.
- Login page for the React dashboard (#103). It stores the token, sends it on
  every API and WebSocket call, redirects to `/login` on 401, and skips login
  when the server has auth disabled.
- React dashboard in `ui/` (React, Vite, Tailwind v4, shadcn/ui). Express
  serves its build, and the Dockerfile builds it in a separate stage. The
  vanilla dashboard in `src/ui/` is still present.
- `AgentPool` and `AgentForgeDB` are created by `createAgentForge()`. Events,
  tasks and costs are written to SQLite, and agent config can be edited over
  the API. Agent lifecycle states are not driven by the orchestrator yet.
- Server hardening: binds to `127.0.0.1` by default (`--host` to change it),
  security headers with helmet, and rate limits on the API.
- Security workflows: npm audit and CodeQL, dependency review on PRs, and
  OSSF Scorecard.
- `start.sh` to run the server behind a Cloudflare tunnel, and `seed.sh` to
  load demo data for UI work.
- Playwright end-to-end tests for the React dashboard, run against a real
  backend and a test database (#81, #83-#87, #91, #92).
- Configuration for qodo-ai/pr-agent (#65).
- `CLAUDE.md` and `AGENTS.md` with guidance for coding agents.

### Changed

- Node 24 is the required runtime (`engines`).
- The React build splits vendor code into separate chunks (#82).
- The npm audit gate in the Security workflow uses Node 24 and audits runtime
  dependencies only (#70).
- Dependency updates: express-rate-limit, minimatch, flatted, eslint, the
  production dependency group, and pinned GitHub Actions (#62, #66, #68, #71,
  #72, #75, #79, #88, #89, #90).

### Fixed

- The dashboard uses `wss://` when the page is served over HTTPS.
- `GitManager` escapes backslashes in commit messages.
- Scorecard workflow write permissions moved to the job level.

## [0.6.0] - 2026-02-22

### Added

- Vanilla JS dashboard in `src/ui/`: overview with KPIs and live activity
  feed, Kanban board, agent cards, provider quota bars and cost views
  (#35-#39).
- Documentation site under `docs/` (#44), with Mermaid diagrams.
- CI workflow for tests and lint, and a release workflow that runs on `v*`
  tags.
- ESLint configuration.
- `package-lock.json` for reproducible installs.

### Changed

- Dependencies upgraded to their latest major versions.

### Fixed

- 15 lint errors.
- CI test discovery on Node 20.

## [0.1.0 - 0.5.0] - 2026-02-20 to 2026-02-22

These versions were built in four waves of commits and never tagged. The
milestones in `ROADMAP.md` mark all of them as done. Some modules exist and
have unit tests but nothing in the running app calls them; those entries say
"not wired".

### Added

- Core loop: priority task queue, orchestrator, event bus, rule-based router
  with tiers and fallback chain, per-provider quota tracking with automatic
  pause and resume, and cost tracking with budget events.
- Providers: Anthropic, Google Gemini, DeepSeek, OpenRouter and Ollama.
  Responses are not streamed.
- Execution: `ContextBuilder` and `OutputCollector` are used by the
  orchestrator. Tool calls are not resolved; the orchestrator sends an empty
  tool list.
- `agentforge.yml` config loader with `${VAR}` expansion.
- CLI: `start`, `task add|list|show`, `status`, `config check`.
- REST API (Express) and WebSocket server with event replay.
- SQLite persistence in WAL mode.
- Multi-stage Dockerfile and docker-compose with an optional Ollama profile.
- Unit and API test suite.
- Git integration (`src/git`: `GitManager`, branch strategy, auto-commit,
  auto-PR, review gate, GitHub client). Added but not wired.
- Team features: `ask_agent` inter-agent calls, task decomposition, review
  workflow, parallel execution and the task dependency graph. Added but not
  wired.
- Agent lifecycle state machine (`AgentPool`). Added but not wired; 0.7.0
  creates the pool but does not drive its states.
- Plugin system (`src/plugins`). Added but not wired.

[Unreleased]: https://github.com/sinsonido/agentforge/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/sinsonido/agentforge/compare/v0.7.0...v0.9.0
[0.7.0]: https://github.com/sinsonido/agentforge/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/sinsonido/agentforge/compare/4cb358f...v0.6.0
[0.1.0 - 0.5.0]: https://github.com/sinsonido/agentforge/commits/4cb358f
