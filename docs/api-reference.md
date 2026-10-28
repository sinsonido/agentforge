# API Reference

AgentForge exposes a REST API and a WebSocket endpoint on the same port
(default `4242`). Both are served by the Express server in `src/api/`.

Base URL: `http://localhost:4242`

---

## REST API

All endpoints return JSON. Success responses include `"ok": true`. Error
responses include `"ok": false` and an `"error"` string.

### Authentication

Authentication is off by default. To turn it on, set `server.auth.enabled: true`
and `server.auth.secret` in `agentforge.yml`. Then every `/api/*` request except
`GET /api/status` needs this header:

```
Authorization: Bearer <secret>
```

A missing or wrong token returns `401 { "ok": false, "error": "Unauthorized" }`.
Auth is skipped when `NODE_ENV=test`.

### Security headers

The server uses [Helmet](https://helmetjs.github.io/) for automatic HTTP
security headers on every response:

| Header | Value |
|---|---|
| `X-Frame-Options` | `SAMEORIGIN` |
| `X-Content-Type-Options` | `nosniff` |
| `Strict-Transport-Security` | `max-age=15552000` |
| `Content-Security-Policy` | restrictive default |
| `Cross-Origin-*` | safe defaults |

### Rate limiting

All responses include `RateLimit-*` headers (RFC-compliant, no legacy headers).

| Scope | Limit |
|---|---|
| All routes | 200 requests / minute per IP |
| `POST /api/*` | 30 requests / minute per IP |

Exceeding the limit returns `429 Too Many Requests`. Rate limits are off when `NODE_ENV=test`.

---

### System

#### `GET /api/status`

System overview: orchestrator state, task stats from the in-memory queue, quota states, and agents.

**Response**

```json
{
  "ok": true,
  "orchestrator": { "running": true },
  "tasks": {
    "total": 24,
    "queued": 3,
    "executing": 2,
    "completed": 18,
    "failed": 1,
    "waiting": 0
  },
  "quotas": {
    "anthropic": {
      "provider": "anthropic",
      "state": "available",
      "requests": { "used": 8, "max": 100, "pct": 0.08 },
      "tokens": { "used": 12000, "max": 400000, "pct": 0.03 },
      "estimatedResetMs": 0
    }
  },
  "agents": {
    "developer": { "id": "developer", "name": "Developer", "state": "idle", "currentTaskId": null, "historyLength": 0 }
  }
}
```

Agent `state` is always `idle` today. The orchestrator never drives the agent lifecycle transitions.

---

#### `POST /api/control/start`

Start the orchestrator main loop.

**Response `200`**
```json
{ "ok": true, "message": "Orchestrator started" }
```

**Response `409`** — already running
```json
{ "ok": false, "error": "Orchestrator is already running" }
```

---

#### `POST /api/control/stop`

Stop the orchestrator.

**Response `200`**
```json
{ "ok": true, "message": "Orchestrator stopped" }
```

---

### Tasks

#### `GET /api/tasks`

List tasks. The response merges the in-memory queue with up to 500 tasks from SQLite
history. Filter by status with `?status=<status>`. Task statuses are `queued`,
`assigned`, `executing`, `completed`, `failed`, `waiting_quota`, and `paused_budget`.

```bash
curl http://localhost:4242/api/tasks
curl http://localhost:4242/api/tasks?status=executing
```

**Response**
```json
{
  "ok": true,
  "count": 3,
  "tasks": [
    {
      "id": "t3",
      "title": "Write unit tests for auth module",
      "type": "test",
      "priority": "high",
      "status": "queued",
      "agent_id": "tester",
      "created_at": 1740000000000
    }
  ]
}
```

---

#### `POST /api/tasks`

Add a new task to the queue. A task has a `kind`:

- `text` (default): one provider call that stores the result text.
- `coding`: a poteto-mode playbook run against a repository.

**Text task body**
```json
{
  "title": "Implement OAuth login",
  "type": "implement",
  "priority": "high",
  "agent_id": "Developer"
}
```

| Field | Required | Description |
|---|---|---|
| `kind` | no | `text` (default) or `coding` |
| `title` | yes for `text` | Task description. A coding task without one takes the first line of `instruction` |
| `type` | no | `architecture`, `implement`, `test`, `refactor`, `review`, etc. |
| `priority` | no | `critical`, `high`, `medium` (default), `low` |
| `agent_id` | no | Agent ID: the agent's name in lowercase with spaces replaced by `-` |

**Coding task body**
```json
{
  "kind": "coding",
  "repo": "sinsonido/agentforge",
  "base": "master",
  "instruction": "Add task model v2",
  "issue": 195,
  "playbook": "feature",
  "budget": 5
}
```

| Field | Required | Description |
|---|---|---|
| `repo` | yes | `owner/name` |
| `base` | yes | Branch the work starts from |
| `instruction` | yes | What the agent must do |
| `playbook` | yes | `bug-fix`, `feature`, `refactoring`, `investigation`, or `perf-issue` |
| `issue` | no | GitHub issue number (positive integer) |
| `budget` | no | Spend cap in USD (positive number) |

A coding task also carries `step`, the playbook step it is on. It starts as `null`.

The endpoint ignores other fields. Task IDs are `t1`, `t2`, and so on. The counter continues after a restart, so new IDs never reuse a stored task.

At most one coding task per `repo`, `issue`, and `playbook` is live (not `completed` or `failed`). A POST that matches a live task returns that task with `200` and `"created": false` and adds nothing. Coding tasks without an `issue` are never matched.

**Response `201`**
```json
{ "ok": true, "created": true, "task": { "id": "t4", "kind": "text", "title": "...", "status": "queued" } }
```

**Response `200`** (duplicate coding task)
```json
{ "ok": true, "created": false, "task": { "id": "t2", "kind": "coding", "...": "..." } }
```

**Response `400`**
```json
{ "ok": false, "error": "a coding task requires `base`, `instruction`, `playbook`" }
```

---

#### `GET /api/tasks/:id`

Get a single task by ID from the in-memory queue. Tasks that exist only in SQLite history return `404`.

**Response `200`**
```json
{ "ok": true, "task": { ... } }
```

**Response `404`**
```json
{ "ok": false, "error": "Task 't_xyz' not found" }
```

---

#### `POST /api/tasks/:id/status`

Update a task's status (used by the Kanban drag-and-drop).

**Body**
```json
{ "status": "completed" }
```

Valid values: `queued`, `executing`, `completed`, `failed`

The endpoint emits `task.status_changed` on the event bus. The WebSocket server does not forward that event.

**Response `200`**
```json
{ "ok": true, "taskId": "t_xyz", "status": "completed" }
```

---

### Agents

#### `GET /api/agents`

List all agents from `team` and their lifecycle state.

**Response**
```json
{
  "ok": true,
  "count": 3,
  "agents": [
    {
      "id": "developer",
      "name": "Developer",
      "state": "idle",
      "currentTaskId": null,
      "historyLength": 0
    }
  ]
}
```

The orchestrator never drives the agent lifecycle, so `state` stays `idle`.

---

#### `POST /api/agents/:id`

Store a new model or system prompt on the agent's entry in the agent pool.
The router and the orchestrator read agent settings from the config, not from the
pool, so the change does not affect routing or prompts. It lasts until restart.

**Body**
```json
{
  "model": "claude-haiku-5-5",
  "systemPrompt": "You are a concise QA engineer."
}
```

**Response `200`**
```json
{ "ok": true, "agentId": "developer", "model": "claude-haiku-5-5", "systemPrompt": "You are a concise QA engineer." }
```

**Response `404`** — agent not registered
```json
{ "ok": false, "error": "Agent 'developer' not found" }
```

---

### Quotas

#### `GET /api/quotas`

Quota state of every provider that has a `quota` block.

**Response**
```json
{
  "ok": true,
  "quotas": {
    "anthropic": {
      "provider": "anthropic",
      "state": "available",
      "requests": { "used": 8, "max": 100, "pct": 0.08 },
      "tokens": { "used": 12000, "max": 400000, "pct": 0.03 },
      "estimatedResetMs": 0
    }
  }
}
```

`tokens` counts input tokens only. `estimatedResetMs` is non-zero only while the provider is `exhausted`.

Quota `state` values: `"available"`, `"throttled"`, `"exhausted"`

---

### Costs

#### `GET /api/costs`

Cost stats: budgets, spend by agent, spend by model, transaction log.

**Response**
```json
{
  "ok": true,
  "available": true,
  "costs": {
    "totalCostUSD": 3.42,
    "budgets": {
      "My Project": {
        "budget": 50, "spent": 3.42, "remaining": 46.58,
        "remaining_pct": 0.93, "spent_pct": 0.07, "warning": false, "exceeded": false
      }
    },
    "byAgent": { "developer": 3.42 },
    "byModel": { "claude-sonnet-5-5": 3.42 },
    "transactions": [
      {
        "projectId": "My Project",
        "agentId": "developer",
        "model": "claude-sonnet-5-5",
        "tokensIn": 1200,
        "tokensOut": 480,
        "cost": 0.0072
      }
    ]
  }
}
```

`budgets` and `byModel` come from the in-memory cost tracker and reset on restart.
`byAgent` and `totalCostUSD` come from SQLite for the current project, so they
survive a restart while `budgets` does not. `transactions` lists the
`cost.recorded` events among the last 200 logged events.

---

### Events

#### `GET /api/events`

Recent events from the SQLite event log. Pass `?limit=N` (default 50, max 1000).
The log holds `task.queued`, `task.executing`, `task.completed`, `task.failed`,
`cost.recorded`, `quota.exhausted`, `quota.reset`, `budget.warning`, and
`budget.exceeded`. Other events are not logged.

```bash
curl http://localhost:4242/api/events?limit=10
```

**Response**
```json
{
  "ok": true,
  "count": 10,
  "events": [
    { "event": "task.completed", "data": { "taskId": "t_abc" }, "timestamp": 1740000000000 }
  ]
}
```

---

### Providers

#### `POST /api/providers/test`

Check that a provider is registered. No adapter implements a `test()` method, so
the server makes no network call. Every registered provider reports `reachable`.
An unknown provider returns `404`.

**Body**
```json
{ "provider": "anthropic" }
```

**Response `200` (success)**
```json
{ "ok": true, "provider": "anthropic", "status": "reachable" }
```

---

### Reviews

These two endpoints only emit `review.approved` or `review.rejected` on the event
bus and forward them to WebSocket clients. Nothing acts on them: the `ReviewGate`
in `src/git/review-gate.js` is present but not wired, and is scheduled for removal
in v0.9 (see [#190](https://github.com/sinsonido/agentforge/issues/190)).

#### `POST /api/review/:prNumber/approve`

Emit `review.approved` for a PR number.

```bash
curl -X POST http://localhost:4242/api/review/42/approve
```

**Response `200`**
```json
{ "ok": true, "prNumber": 42, "action": "approved" }
```

---

#### `POST /api/review/:prNumber/reject`

Emit `review.rejected` for a PR number. Requires a reason.

**Body**
```json
{ "reason": "Missing error handling in the payment flow." }
```

**Response `200`**
```json
{ "ok": true, "prNumber": 42, "action": "rejected", "reason": "Missing error handling..." }
```

---

### Test support

#### `POST /api/test/reset`

Mounted only when `NODE_ENV=test`. Clears the in-memory task queue, stops the
orchestrator, and clears the event bus replay buffer. The E2E fixture uses it.

---

## WebSocket

Connect to `ws://localhost:4242/ws` to receive real-time events. When
`server.auth.enabled` is `true`, add the secret as a query parameter:
`ws://localhost:4242/ws?token=<secret>`. The server closes a connection with a
missing or wrong token with code `4401`.

### Behaviour

- On connect, the server replays the last **20 events** from the event bus. The replay can include any event type, not only the ones in the catalogue below.
- After that, the server broadcasts each event in the catalogue as it fires.
- A server-initiated **ping** is sent every 30 seconds. The connection is
  closed if no pong is received before the next ping cycle.

### Message format

All messages are JSON:

```json
{
  "event": "task.completed",
  "data": { "task": { "id": "t3", "status": "completed" }, "cost": 0.0108 },
  "timestamp": 1740000000000
}
```

### Event catalogue

The server forwards these events. Events marked **never emitted** come only from
modules that are present but not wired (`src/git/`), so clients never see them today.

| Event | Data |
|---|---|
| `task.queued` | `{ task }` |
| `task.assigned` | never emitted |
| `task.executing` | `{ task, route }` |
| `task.completed` | `{ task, cost, route, output }` |
| `task.failed` | `{ task, error }` |
| `quota.throttled` | `{ provider, pct }` |
| `quota.exhausted` | `{ provider }` |
| `quota.reset` | `{ provider }` |
| `agent.paused` | `{ agent, reason }` |
| `agent.resumed` | `{ agent }` |
| `budget.warning` | `{ projectId, spent, budget, spent_pct }` |
| `budget.exceeded` | `{ projectId, spent, budget, spent_pct }` |
| `git.committed` | never emitted |
| `git.pr_created` | never emitted |
| `cost.recorded` | `{ projectId, agentId, model, tokensIn, tokensOut, cost }` |
| `review.pending` | never emitted |
| `review.approved` | `{ prNumber, approvedAt }` |
| `review.rejected` | `{ prNumber, reason, rejectedAt }` |

`task.status_changed` and `agent.config_updated` are emitted by the REST API but
are not forwarded.

### Example client (Node.js)

```js
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:4242/ws');

ws.on('message', data => {
  const { event, data: payload, timestamp } = JSON.parse(data);
  console.log(event, payload);
});

ws.on('close', () => console.log('disconnected'));
```

### Example client (browser)

```js
const ws = new WebSocket(`ws://${location.host}/ws`);
ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  console.log(msg.event, msg.data);
};
```
