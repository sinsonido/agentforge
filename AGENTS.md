# AgentForge — Multi-Agent Development Guide

Instructions for AI coding agents (Claude Code, Codex CLI, Gemini CLI, etc.) working on
this repository. Read `CLAUDE.md` first for architecture, conventions, and dev commands.

---

## Core rules

1. **Read before writing.** Always read the target file before editing it.
2. **Tests required.** Every non-trivial change needs a matching test in `tests/`.
3. **One concern per PR.** Do not bundle unrelated changes.
4. **Run tests before committing.** `npm test` must pass with 0 failures.
5. **Stage specific files.** Never `git add -A`; avoid committing `.agentforge/` or `agentforge.yml`.
6. **No force-push to master.** Use PRs for large changes; direct push only for small, green-tested patches.
7. **Node 24 only.** Do not target, test against, or add compatibility code for Node 20 or 22.
8. **Use `gh` for GitHub.** All issue/PR/release/CI operations go through `gh` CLI. Never construct raw GitHub API calls with `curl` or `fetch`.

---

## Parallel agent workflow

When multiple agents work simultaneously, use **git worktrees** to avoid conflicts:

```bash
# Create an isolated worktree per agent/feature
git worktree add .worktrees/<feature-name> -b feat/<feature-name>

# Agent works entirely inside its worktree directory
cd .worktrees/<feature-name>
# ... make changes, run tests, commit ...

# After PR merge, remove the worktree
git worktree remove .worktrees/<feature-name>
git branch -d feat/<feature-name>
```

### Naming convention

```
fix/<issue-slug>          # Bug fixes
feat/<issue-slug>         # New features
chore/<issue-slug>        # Config, deps, tooling
test/<issue-slug>         # Test-only changes
docs/<issue-slug>         # Documentation
refactor/<issue-slug>     # No behaviour change
```

---

## File ownership map

Files that multiple agents might need to touch simultaneously — coordinate carefully:

| File | Risk | Rule |
|------|------|------|
| `src/index.js` | HIGH | Only one agent touches it per wave. Merge simpler change first, then rebase. |
| `src/api/server.js` | HIGH | Add new Express routes to the bottom of the router block. Never reorganise existing routes. |
| `src/core/orchestrator.js` | HIGH | The main tick loop — changes cascade everywhere. Requires peer review. |
| `package.json` | MEDIUM | Coordinate `scripts` and `dependencies` additions. Use `npm install <pkg>` individually, not bulk edits. |
| `ui/src/App.tsx` | MEDIUM | Route additions only — each view agent adds its own `<Route>`. |
| `ui/src/types/api.ts` | MEDIUM | Additive only — never rename or remove existing types without updating all consumers. |
| `ui/src/lib/api.ts` | LOW | Add new typed methods; do not change the `fetchJSON` base helper. |

**Safe to work in parallel (no coordination needed):**
- `src/providers/<new-provider>.js` — independent files
- `ui/src/views/<ViewName>.tsx` — each view is isolated
- `ui/src/components/<feature>/` — isolated by feature folder
- `tests/<anything>.test.js` — independent test files
- `src/git/*.js` — each git module is independent

---

## Merge order for conflicting files

When two branches both modify `src/index.js` or `src/api/server.js`:

1. Merge the **simpler / smaller** change first.
2. The second agent rebases onto the updated master before merging:
   ```bash
   git fetch origin
   git rebase origin/master
   npm test   # verify still green
   ```
3. Resolve conflicts by keeping both changes (additive, not replacing).

---

## Commit format

```
<type>: <short description> (closes #<issue>)

- Bullet of what changed
- Bullet of why (if not obvious)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Types: `feat` `fix` `test` `chore` `docs` `refactor` `perf`

---

## Adding a new provider

1. Create `src/providers/<name>.js` — extend `BaseProvider` from `interface.js`.
2. Return `{ content, tokens_in, tokens_out, tool_calls, finish_reason }`.
3. Register in `src/providers/interface.js` → `ProviderRegistry.register()`.
4. Add provider block to `agentforge.example.yml`.
5. Add tests in `tests/providers/<name>.test.js` using a mocked HTTP layer.

## Adding a new REST endpoint

1. Add the route to `src/api/server.js` in the appropriate section (GET / POST / DELETE).
2. Add a test in `tests/api.test.js` using the `makeForge()` stub pattern.
3. Add the typed client method to `ui/src/lib/api.ts`.
4. Update `ui/src/types/api.ts` if new response shapes are introduced.

## Adding a new React view

1. Create `ui/src/views/<Name>View.tsx` and `ui/src/components/<name>/` folder.
2. Add the route to `ui/src/App.tsx`:
   ```tsx
   <Route path="/<name>" element={<NameView />} />
   ```
3. Add a `NavLink` entry to `ui/src/components/layout/Sidebar.tsx`.
4. Fetch data via `useApi(() => api.<method>(), [])` — never fetch in child components.
5. Show `<Skeleton>` while loading, empty state with dashed border when no data.

---

## Wave planning template

For coordinated multi-agent waves (like the Wave 2 completed on 2026-02-24):

```
Wave N
├── Phase 1 — parallel (no shared files)
│   ├── Agent A: feat/X  (owns: src/providers/x.js, tests/providers/x.test.js)
│   └── Agent B: feat/Y  (owns: ui/src/views/YView.tsx)
├── Phase 2 — sequential (shared file touched)
│   └── Agent C: feat/Z  (owns: src/index.js — merge last, rebase on Phase 1)
└── Merge order: A → B → C
```

Declare file ownership explicitly in the wave plan to avoid merge conflicts.

---

## Do not

- Do not spawn a subagent that needs to write files if it only has Bash tool access.
- Do not run `npm install` in the `ui/` directory from the repo root — `cd ui && npm install`.
- Do not import from `../../` across the `src/` ↔ `ui/` boundary — they are separate packages.
- Do not add `console.log` debug statements to committed code.
- Do not hardcode API keys, tokens, or secrets — use `${ENV_VAR}` in config.
