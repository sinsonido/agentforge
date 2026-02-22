# API Reference

AgentForge exposes a REST API and a WebSocket endpoint on the same port
(default `4242`). Both are served by the Express server in `src/api/`.

Base URL: `http://localhost:4242`

---

## REST API

All endpoints return JSON. Success responses include `"ok": true`. Error
responses include `"ok": false` and an `"error"` string.

### Authentication

No authentication is required in the default configuration. When binding to
`0.0.0.0` for production, place the server behind a reverse proxy with
authentication (nginx, Caddy, etc.).

---

### System

#### `GET /api/status`

System overview: orchestrator state, task stats, quota states, agent count.

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
    "failed": 1
  },
  "quotas": {
    "anthropic": { "state": "available", "tokensUsed": 12000, "tokensLimit": 400000 }
  },
  "agents": {
    "Developer": { "agentId": "Developer", "status": "executing", "model": "claude-sonnet-4-6" }
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

List all tasks. Filter by status with `?status=queued|executing|completed|failed`.

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
      "id": "t_abc123",
      "title": "Write unit tests for auth module",
      "type": "test",
      "priority": "high",
      "status": "queued",
      "agent_id": "Tester",
      "created_at": 1740000000000
    }
  ]
}
```

---

#### `POST /api/tasks`

Add a new task to the queue.

**Body**
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
| `title` | yes | Task description |
| `type` | no | `architecture`, `implement`, `test`, `refactor`, `review`, etc. |
| `priority` | no | `high`, `medium` (default), `low` |
| `agent_id` | no | Assign to a specific agent |

**Response `201`**
```json
{ "ok": true, "task": { "id": "t_xyz", "title": "...", "status": "queued" } }
```

---

#### `GET /api/tasks/:id`

Get a single task by ID.

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

**Response `200`**
```json
{ "ok": true, "taskId": "t_xyz", "status": "completed" }
```

---

### Agents

#### `GET /api/agents`

List all agents and their current lifecycle state.

**Response**
```json
{
  "ok": true,
  "count": 3,
  "agents": [
    {
      "agentId": "Developer",
      "status": "executing",
      "model": "claude-sonnet-4-6",
      "tasksCompleted": 5,
      "tokensIn": 42000,
      "tokensOut": 18000,
      "currentTask": "t_abc123"
    }
  ]
}
```

---

#### `POST /api/agents/:id`

Update an agent's runtime configuration (model and/or system prompt).
Changes take effect on the next task dispatched to that agent.

**Body**
```json
{
  "model": "claude-haiku-4-5-20251001",
  "systemPrompt": "You are a concise QA engineer."
}
```

**Response `200`**
```json
{ "ok": true, "agentId": "Developer", "model": "claude-haiku-4-5-20251001" }
```

**Response `404`** — agent not registered
```json
{ "ok": false, "error": "Agent 'Developer' not found" }
```

---

### Quotas

#### `GET /api/quotas`

All provider quota states with usage windows.

**Response**
```json
{
  "ok": true,
  "quotas": {
    "anthropic": {
      "state": "available",
      "tokensUsed": 12000,
      "tokensLimit": 400000,
      "requestsUsed": 8,
      "requestsLimit": 100,
      "windowResetAt": 1740000060000
    }
  }
}
```

Quota `state` values: `"available"`, `"throttled"`, `"exhausted"`

---

### Costs

#### `GET /api/costs`

Cost stats: budgets, spend by agent, spend by model, transaction log.

**Response** (when cost tracking is active)
```json
{
  "ok": true,
  "available": true,
  "costs": {
    "totalCostUSD": 3.42,
    "totalTokensIn": 120000,
    "totalTokensOut": 48000,
    "budgets": {
      "default": { "spentUSD": 3.42, "limitUSD": 50.00 }
    },
    "byAgent": {
      "Developer": { "tokensIn": 80000, "tokensOut": 32000, "costUSD": 2.16 }
    },
    "byModel": {
      "claude-sonnet-4-6": { "tokensIn": 80000, "tokensOut": 32000, "costUSD": 2.16 }
    },
    "transactions": [
      {
        "agentId": "Developer",
        "model": "claude-sonnet-4-6",
        "tokensIn": 1200,
        "tokensOut": 480,
        "costUSD": 0.0108,
        "timestamp": 1740000000000
      }
    ]
  }
}
```

---

### Events

#### `GET /api/events`

Recent events from the event bus. Pass `?limit=N` (default 50, max 1000).

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

Test connectivity for a named provider.

**Body**
```json
{ "provider": "anthropic" }
```

**Response `200` (success)**
```json
{ "ok": true, "provider": "anthropic", "status": "reachable" }
```

**Response `200` (test failed)**
```json
{ "ok": false, "error": "connect ECONNREFUSED 127.0.0.1:11434" }
```

---

### Reviews

#### `POST /api/review/:prNumber/approve`

Approve a PR review gate.

```bash
curl -X POST http://localhost:4242/api/review/42/approve
```

**Response `200`**
```json
{ "ok": true, "prNumber": 42, "action": "approved" }
```

---

#### `POST /api/review/:prNumber/reject`

Reject a PR review gate. Requires a reason.

**Body**
```json
{ "reason": "Missing error handling in the payment flow." }
```

**Response `200`**
```json
{ "ok": true, "prNumber": 42, "action": "rejected", "reason": "Missing error handling..." }
```

---

## WebSocket

Connect to `ws://localhost:4242/ws` to receive real-time events.

### Behaviour

- On connect, the last **20 events** are replayed immediately.
- All subsequent events are broadcast as they fire.
- A server-initiated **ping** is sent every 30 seconds. The connection is
  closed if no pong is received before the next ping cycle.

### Message format

All messages are JSON:

```json
{
  "event": "task.completed",
  "data": { "taskId": "t_abc123", "result": "..." },
  "timestamp": 1740000000000
}
```

### Event catalogue

| Event | Data |
|---|---|
| `task.queued` | `{ task }` |
| `task.assigned` | `{ task, agent, model }` |
| `task.executing` | `{ task, agent }` |
| `task.completed` | `{ task, result, cost }` |
| `task.failed` | `{ task, error }` |
| `task.status_changed` | `{ taskId, status, changedAt }` |
| `quota.throttled` | `{ provider, usage_pct }` |
| `quota.exhausted` | `{ provider }` |
| `quota.reset` | `{ provider }` |
| `agent.paused` | `{ agent, reason }` |
| `agent.resumed` | `{ agent }` |
| `agent.config_updated` | `{ agentId, model, updatedAt }` |
| `budget.warning` | `{ project, pct }` |
| `budget.exceeded` | `{ project }` |
| `git.committed` | `{ task, branch, sha }` |
| `git.pr_created` | `{ task, pr_url }` |
| `cost.recorded` | `{ agentId, model, costUSD }` |
| `review.pending` | `{ prNumber }` |
| `review.approved` | `{ prNumber, approvedAt }` |
| `review.rejected` | `{ prNumber, reason, rejectedAt }` |

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
