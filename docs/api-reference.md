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
    "developer": { "id": "developer", "name": "Developer", "role": "Backend Developer", "model": "claude-sonnet-5-5" }
  }
}
```

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

#### `POST /api/tasks/:id/approve` and `POST /api/tasks/:id/reject`

The operator's decision on a coding task in `needs-approval`. The task's `approval` field holds the pending action (`publish`, `push-fix`, `verify` or `merge`), a `summary`, and `requested_at`. Both routes need the same Bearer token as other mutating routes. The decision, with `decided_by: "operator"` and the reason, goes to the task's `approval` and its decision trail.

**Body** (optional)
```json
{ "reason": "CI is green" }
```

`reason` is a string of at most 500 characters.

Approve runs the parked action and answers after it ran. Reject ends the task: `pr-opened` for a merge, `cancelled` for a publish.

**Response `200`**
```json
{ "ok": true, "status": "completed", "task": { ... } }
```

**Response `502`**: the approved action failed. The task waits again, with the error in `task.approval.error`.

**Response `409`**: the task has no pending approval. **`404`**: unknown task. **`503`**: no coding loop is configured.

---

### Agents

#### `GET /api/agents`

List all agents from `team`. `model` is `null` when the agent has none and routing rules pick the model.

**Response**
```json
{
  "ok": true,
  "count": 3,
  "agents": [
    {
      "id": "developer",
      "name": "Developer",
      "role": "Backend Developer",
      "model": "claude-sonnet-5-5"
    }
  ]
}
```

---

#### `POST /api/agents/:id`

Set the agent's model or system prompt. The next task routed to the agent uses
them. A field the body leaves out keeps its value. The change lasts until restart.

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
    "byPhase": { "build": 3.42, "verify": 0 },
    "repos": {
      "acme/app": { "window": "day", "since": 1793000000000, "build": { "spent": 0.8, "limit": 50 }, "verify": { "spent": 0, "limit": null } }
    },
    "transactions": [
      {
        "projectId": "My Project",
        "agentId": "developer",
        "model": "claude-sonnet-5-5",
        "tokensIn": 1200,
        "tokensOut": 480,
        "cost": 0.0072,
        "taskId": "t4",
        "repo": null,
        "phase": "build",
        "at": 1793000000000
      }
    ]
  }
}
```

Every number comes from the cost ledger (`cost_records`), which the cost tracker
reloads on boot, so all of them survive a restart. `totalCostUSD` is every record,
with or without an agent. `byPhase` splits it into build and verification spend.
`repos` has each repository's spend in its rolling budget window with its limits
(see `budget` in the configuration reference). `transactions` is the newest 200
records, oldest first.

#### `GET /api/tasks/:id/spend`

A coding task's spend per phase, each with the limits that apply: the task's own
and its repository's in the current window. 404 for an unknown task.

```json
{
  "ok": true,
  "spend": {
    "build": { "spent": 0.8, "limits": [{ "scope": "task", "phase": "build", "limit": 1, "spent": 0.8, "remaining": 0.2 }] },
    "verify": { "spent": 0, "limits": [] }
  }
}
```

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

The server forwards these events. Events marked **never emitted** have
no emitter, so clients never see them today.

| Event | Data |
|---|---|
| `task.queued` | `{ task }` |
| `task.assigned` | never emitted |
| `task.executing` | `{ task, route }` |
| `task.needs_approval` | `{ task, status }` |
| `task.completed` | `{ task, cost, route, output }` |
| `task.failed` | `{ task, error }` |
| `quota.throttled` | `{ provider, pct }` |
| `quota.exhausted` | `{ provider }` |
| `quota.reset` | `{ provider }` |
| `agent.paused` | `{ agent, reason }` |
| `agent.resumed` | `{ agent }` |
| `budget.warning` | `{ projectId, spent, budget, spent_pct }` |
| `budget.exceeded` | `{ projectId, spent, budget, spent_pct }` |
| `cost.recorded` | `{ projectId, agentId, model, tokensIn, tokensOut, cost, taskId, repo, phase, at }` |

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
