# Contributing to AgentForge

## Quick Start

```bash
git clone https://github.com/sinsonido/agentforge.git
cd agentforge
npm install
cp agentforge.example.yml agentforge.yml
# Edit agentforge.yml with at least one provider (Ollama for local dev)
npm run dev
```

## Development with Ollama (free, no API keys)

For development, use Ollama so you don't burn API credits:

```bash
# Install Ollama: https://ollama.com
ollama pull codestral:22b    # Fast coding model
ollama pull deepseek-r1:32b  # Reasoning model

# In agentforge.yml, set ollama as primary
# All routing will go to local models
```

## Project Structure

- `src/core/` — Orchestrator, queue, quota, events. **Start here.**
- `src/routing/` — Router, rules, fallback. The decision engine.
- `src/providers/` — One file per AI provider. Unified interface.
- `src/execution/` — `context-builder.js` builds prompts, `output-collector.js` parses replies.
- `src/persistence/` — SQLite storage for tasks, costs, and events.
- `src/api/` — REST API and WebSocket server for the dashboard.
- `src/config/` — YAML loading and `${ENV_VAR}` substitution.
- `ui/` — React dashboard (separate package).
- `tests/` — Tests for `src/core`, `src/execution`, `src/routing`, `src/persistence`, and the API.

There is no `src/tools/`. Agents have no tools today: the orchestrator sends one prompt per task and stores the reply.
`src/git/`, `src/plugins/`, and four modules in `src/execution/` are present but not wired, and are scheduled for removal in v0.9 (see #190). Do not build on them.

## Conventions

- **One PR per issue.** Keep changes focused.
- **Tests included.** Use Node.js built-in test runner (`node --test`).
- **No transpilation.** Native ES modules, Node 24 (only supported version).
- **Error messages over comments.** Code should explain itself; errors should help the user.

## Issue Labels

- `core` — Orchestrator, queue, events
- `routing` — Router, rules, fallback
- `provider` — Provider adapters
- `quota` — Quota tracking and auto-pause
- `git` — GitHub integration
- `ui` — Web dashboard
- `cli` — Command line interface
- `docs` — Documentation

## Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```
