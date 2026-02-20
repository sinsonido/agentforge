# Contributing to AgentForge

## Quick Start

```bash
git clone https://github.com/your-user/agentforge.git
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
- `src/tools/` — Agent capabilities (file ops, git, shell).
- `src/config/` — YAML loading and validation.
- `tests/` — Mirror of src/ structure.

## Conventions

- **One PR per issue.** Keep changes focused.
- **Tests included.** Use Node.js built-in test runner (`node --test`).
- **No transpilation.** Native ES modules, Node 20+.
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
