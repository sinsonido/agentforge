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

## Releases

- Every merge to `master` updates one open release PR from release-please. It bumps `package.json` and writes the next `CHANGELOG.md` section from the Conventional Commit titles.
- Before 1.0, `fix:` and `feat:` bump the patch version and a breaking change bumps the minor version. `docs:`, `chore:`, `ci:`, `test:` and `refactor:` stay out of the changelog.
- To cut a minor release such as 0.8.0, merge a commit with a `Release-As: 0.8.0` footer.
- Merging the release PR creates the `vX.Y.Z` tag and the GitHub Release. `release.yml` then tests that tag and attaches `agentforge-vX.Y.Z.tgz`.
- Do not push version tags or edit the version by hand.
