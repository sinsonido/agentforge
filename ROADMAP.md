# AgentForge Roadmap

AgentForge is a self-hosted control plane, for one operator, that runs coding agents on real repositories and can be driven from a phone.

The core loop:

```
issue or task → isolated worktree → coding harness runs → pull request
  → CI watched → fix round if red → operator approves → merge → cleanup
```

## Foundation: poteto-mode

How AgentForge works a task is inherited from poteto-mode, the methodology in [pstack](https://github.com/cursor/plugins) (MIT, Lauren Tan): playbooks, principles and gates. The two split the work this way:

- Inside the worktree, the coding harness runs with pstack loaded at a pinned version and follows a poteto-mode playbook (bug fix, feature, refactoring, investigation and so on).
- Around it, AgentForge enforces as code what poteto-mode states as text. A task's state is its playbook step, and a step closes only on evidence. Merge needs a verification verdict at the exact head SHA. The Autonomy policy decides what proceeds and what waits for the operator. Every task keeps a decision trail.

Playbooks are read from pstack as data, not rewritten in code. This follows poteto-mode's own rule, Encode Lessons in Structure: text an agent can skip becomes a check it cannot.

Tracking lives on GitHub. Each version is a milestone, each issue is one PR, and the [AgentForge Roadmap project](https://github.com/users/sinsonido/projects/4) shows the board.

## Why the direction changed

Through v0.7 the design assumed that an agent's work is one model call: pick the cheapest model, send a prompt, store the text. That path works today, with quotas and budgets enforced.

Everything that would have made agents do real work was never wired. There is no tool loop (`_resolveTools` returns `[]`), and nothing in `createAgentForge()` uses `src/git`, task decomposition, `ask_agent`, review workflow or plugins. Earlier versions of this file marked those as done.

In 2026 code is written by coding harnesses (Claude Code, the Agent SDK and others) that read the repo, edit, run tests and commit. Rebuilding one is the whole product, and it already exists. AgentForge keeps what is useful around such a harness: the queue, events, live UI, cost and quota control, git and CI plumbing, and approvals.

Multi-user accounts, RBAC and teams are out of scope.

## Versions

### v0.7.1. Honest baseline

The repo says what the code does, CI is green and trustworthy, dependencies are safe, and releases are automated. This covers the retroactive v0.7.0 release, the changelog, release-please, the queued-task and duplicate cost-event bugs, E2E and Node 24 in CI, the npm audit findings, test-PR triage, model IDs and prices, and docs that match the code.

### v0.8.0. Self-hosting MVP

The first goal is that AgentForge develops itself. An issue on this repository labelled `agentforge` becomes exactly one task. A coding harness with pstack loaded works it in an isolated worktree, following a poteto-mode playbook, and a PR is opened. The operator still merges by hand.

It starts with a spike that measures two things: which executor to use (the Agent SDK or `claude -p --output-format stream-json`), and whether poteto-mode completes a playbook headless. If it cannot, the direction is reconsidered here. Then come a restart-safe queue, task model v2 with a playbook and step, a worktree per task, the executor, the final evidence gate, a PR on success, idempotent intake from issues, and a runner that never runs from the tree it edits.

### v0.9.0. Subtract and observe

Delete the unwired modules and the duplicate vanilla UI. Then make task work visible with a live transcript and a decision trail per task.

### v0.10.0. Gates

poteto-mode's gates enforced as code. Babysit watches CI and runs fix rounds. Merge needs a verification verdict at the exact head SHA (Shipping). The Autonomy policy is the approval gate. Budgets cover build and verification separately.

### v0.11.0. Phone first

An installable PWA, push notifications, one-tap approve, reject and retry, and auth required when the server is tunneled.

### v1.0.0. Stable

Subscription usage windows, a versioned config schema, pstack pinned and upgraded behind a compatibility check, and a getting-started guide on a real repo.

### Later

More executors, such as the Codex CLI.

## Stop rule

If after v0.10.0 the operator does not use AgentForge weekly on their own repositories in place of their current agent workflow, the project is archived. The measure is tasks merged through AgentForge per month.

## History

v0.1 to v0.7 delivered the queue, router, quota and cost tracking, the provider adapters, the REST and WebSocket API, SQLite persistence, the React dashboard, E2E tests and API-key auth. See `CHANGELOG.md` once #177 lands, and the closed milestones.

## Principles

1. Each issue is one PR, with tests in the same PR.
2. Never mark something done unless master runs it.
3. Subtract before adding.
4. Config-driven. Anything an operator would tune lives in `agentforge.yml`.
5. Intake is idempotent. The same issue never yields two tasks or two PRs.
6. When poteto-mode states a rule that code can check, AgentForge checks it.
