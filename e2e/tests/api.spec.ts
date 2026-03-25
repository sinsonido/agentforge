import { test, expect } from './fixtures'

// ─── GET /api/status ────────────────────────────────────────────────────────

test.describe('API — GET /api/status', () => {
  test('returns ok:true with expected shape', async ({ request }) => {
    const res = await request.get('/api/status')
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body).toHaveProperty('orchestrator')
    expect(body).toHaveProperty('tasks')
    expect(body).toHaveProperty('quotas')
    expect(body).toHaveProperty('agents')
  })

  test('orchestrator.running is a boolean', async ({ request }) => {
    const body = await (await request.get('/api/status')).json()
    expect(typeof body.orchestrator.running).toBe('boolean')
  })

  test('tasks shape has queued / executing / completed / failed counts', async ({ request }) => {
    const body = await (await request.get('/api/status')).json()
    for (const key of ['queued', 'executing', 'completed', 'failed']) {
      expect(typeof body.tasks[key]).toBe('number')
    }
  })
})

// ─── GET /api/tasks ─────────────────────────────────────────────────────────

test.describe('API — GET /api/tasks', () => {
  test('returns ok:true with tasks array', async ({ request }) => {
    const body = await (await request.get('/api/tasks')).json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.tasks)).toBe(true)
    expect(typeof body.count).toBe('number')
  })

  test('empty tasks list with fresh DB', async ({ request }) => {
    const body = await (await request.get('/api/tasks')).json()
    expect(body.count).toBe(0)
    expect(body.tasks).toHaveLength(0)
  })

  test('?status filter returns only matching tasks', async ({ request }) => {
    // Create a task first
    await request.post('/api/control/stop')
    await request.post('/api/tasks', { data: { title: 'Filter test task' } })

    const body = await (await request.get('/api/tasks?status=queued')).json()
    expect(body.ok).toBe(true)
    expect(body.tasks.every((t: { status: string }) => t.status === 'queued')).toBe(true)
  })
})

// ─── POST /api/tasks ────────────────────────────────────────────────────────

test.describe('API — POST /api/tasks', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/api/control/stop')
  })

  test('creates a task and returns 201 with task object', async ({ request }) => {
    const res = await request.post('/api/tasks', {
      data: { title: 'API created task', priority: 'high' },
    })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.task).toHaveProperty('id')
    expect(body.task.title).toBe('API created task')
    expect(body.task.priority).toBe('high')
    expect(body.task.status).toBe('queued')
  })

  test('returns 400 when title is missing', async ({ request }) => {
    const res = await request.post('/api/tasks', { data: {} })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/title/)
  })

  test('created task appears in GET /api/tasks', async ({ request }) => {
    const title = `GET-after-POST ${Date.now()}`
    await request.post('/api/tasks', { data: { title } })
    const body = await (await request.get('/api/tasks')).json()
    expect(body.tasks.some((t: { title: string }) => t.title === title)).toBe(true)
  })
})

// ─── GET /api/tasks/:id ─────────────────────────────────────────────────────

test.describe('API — GET /api/tasks/:id', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/api/control/stop')
  })

  test('returns the task by id', async ({ request }) => {
    const created = await (await request.post('/api/tasks', { data: { title: 'Task by ID' } })).json()
    const id = created.task.id

    const body = await (await request.get(`/api/tasks/${id}`)).json()
    expect(body.ok).toBe(true)
    expect(body.task.id).toBe(id)
    expect(body.task.title).toBe('Task by ID')
  })

  test('returns 404 for unknown task id', async ({ request }) => {
    const res = await request.get('/api/tasks/nonexistent-id-xyz')
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })
})

// ─── POST /api/tasks/:id/status ─────────────────────────────────────────────

test.describe('API — POST /api/tasks/:id/status', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/api/control/stop')
  })

  test('updates task status to completed', async ({ request }) => {
    const created = await (await request.post('/api/tasks', { data: { title: 'Status update task' } })).json()
    const id = created.task.id

    const res = await request.post(`/api/tasks/${id}/status`, { data: { status: 'completed' } })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('completed')
    expect(body.taskId).toBe(id)
  })

  test('updates task status to failed', async ({ request }) => {
    const created = await (await request.post('/api/tasks', { data: { title: 'Fail me' } })).json()
    const id = created.task.id

    const res = await request.post(`/api/tasks/${id}/status`, { data: { status: 'failed' } })
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('failed')
  })

  test('returns 400 for invalid status value', async ({ request }) => {
    const created = await (await request.post('/api/tasks', { data: { title: 'Bad status' } })).json()
    const id = created.task.id

    const res = await request.post(`/api/tasks/${id}/status`, { data: { status: 'invalid' } })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  test('returns 404 for unknown task id', async ({ request }) => {
    const res = await request.post('/api/tasks/no-such-task/status', { data: { status: 'completed' } })
    expect(res.status()).toBe(404)
  })
})

// ─── GET /api/agents ────────────────────────────────────────────────────────

test.describe('API — GET /api/agents', () => {
  test('returns ok:true with agents array', async ({ request }) => {
    const body = await (await request.get('/api/agents')).json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.agents)).toBe(true)
    expect(typeof body.count).toBe('number')
  })

  test('returns all 3 configured test agents', async ({ request }) => {
    const body = await (await request.get('/api/agents')).json()
    expect(body.count).toBe(3)
    const ids = body.agents.map((a: { id: string }) => a.id)
    expect(ids).toContain('architect')
    expect(ids).toContain('developer')
    expect(ids).toContain('tester')
  })

  test('each agent has id, state, name fields', async ({ request }) => {
    const body = await (await request.get('/api/agents')).json()
    for (const agent of body.agents) {
      expect(agent).toHaveProperty('id')
      expect(agent).toHaveProperty('state')
      expect(agent).toHaveProperty('name')
    }
  })

  test('fresh agents start in idle state', async ({ request }) => {
    const body = await (await request.get('/api/agents')).json()
    expect(body.agents.every((a: { state: string }) => a.state === 'idle')).toBe(true)
  })
})

// ─── POST /api/agents/:id ───────────────────────────────────────────────────

test.describe('API — POST /api/agents/:id', () => {
  test('updates agent model override', async ({ request }) => {
    const res = await request.post('/api/agents/developer', {
      data: { model: 'claude-haiku-4' },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.agentId).toBe('developer')
    expect(body.model).toBe('claude-haiku-4')
  })

  test('returns 404 for unknown agent id', async ({ request }) => {
    const res = await request.post('/api/agents/ghost-agent', { data: { model: 'x' } })
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })
})

// ─── GET /api/quotas ────────────────────────────────────────────────────────

test.describe('API — GET /api/quotas', () => {
  test('returns ok:true with quotas object', async ({ request }) => {
    const body = await (await request.get('/api/quotas')).json()
    expect(body.ok).toBe(true)
    expect(body).toHaveProperty('quotas')
    expect(typeof body.quotas).toBe('object')
  })
})

// ─── GET /api/costs ─────────────────────────────────────────────────────────

test.describe('API — GET /api/costs', () => {
  test('returns ok:true', async ({ request }) => {
    const body = await (await request.get('/api/costs')).json()
    expect(body.ok).toBe(true)
  })

  test('when available, costs has expected shape', async ({ request }) => {
    const body = await (await request.get('/api/costs')).json()
    if (!body.available) return // tolerate unavailable
    const { costs } = body
    expect(typeof costs.totalCostUSD).toBe('number')
    expect(typeof costs.byAgent).toBe('object')
    expect(typeof costs.byModel).toBe('object')
    expect(Array.isArray(costs.transactions)).toBe(true)
    expect(typeof costs.budgets).toBe('object')
  })

  test('fresh DB has totalCostUSD of 0', async ({ request }) => {
    const body = await (await request.get('/api/costs')).json()
    if (!body.available) return
    expect(body.costs.totalCostUSD).toBe(0)
  })
})

// ─── GET /api/events ────────────────────────────────────────────────────────

test.describe('API — GET /api/events', () => {
  test('returns ok:true with events array', async ({ request }) => {
    const body = await (await request.get('/api/events')).json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.events)).toBe(true)
    expect(typeof body.count).toBe('number')
  })

  test('?limit param is respected', async ({ request }) => {
    const body = await (await request.get('/api/events?limit=5')).json()
    expect(body.events.length).toBeLessThanOrEqual(5)
  })

  test('creating a task adds an event', async ({ request }) => {
    await request.post('/api/control/stop')
    await request.post('/api/tasks', { data: { title: 'Event trigger task' } })

    const body = await (await request.get('/api/events')).json()
    // task.queued event should appear
    expect(body.events.some((e: { event: string }) => e.event === 'task.queued')).toBe(true)
  })
})

// ─── POST /api/control/start|stop ───────────────────────────────────────────

test.describe('API — POST /api/control/start|stop', () => {
  test('stop returns ok when running', async ({ request }) => {
    // ensure running first
    await request.post('/api/control/start')
    const res = await request.post('/api/control/stop')
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  test('start returns ok when stopped', async ({ request }) => {
    await request.post('/api/control/stop')
    const res = await request.post('/api/control/start')
    const body = await res.json()
    expect(body.ok).toBe(true)
    // Clean up
    await request.post('/api/control/stop')
  })

  test('stop when already stopped returns 409', async ({ request }) => {
    await request.post('/api/control/stop')
    // Second stop should conflict
    const res = await request.post('/api/control/stop')
    expect(res.status()).toBe(409)
  })

  test('start when already running returns 409', async ({ request }) => {
    await request.post('/api/control/start')
    const res = await request.post('/api/control/start')
    expect(res.status()).toBe(409)
    await request.post('/api/control/stop')
  })
})

// ─── POST /api/providers/test ───────────────────────────────────────────────

test.describe('API — POST /api/providers/test', () => {
  test('returns 400 when provider field is missing', async ({ request }) => {
    const res = await request.post('/api/providers/test', { data: {} })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/provider/)
  })

  test('returns 404 for unknown provider name', async ({ request }) => {
    const res = await request.post('/api/providers/test', { data: { provider: 'nonexistent' } })
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })
})

// ─── POST /api/review/:prNumber ─────────────────────────────────────────────

test.describe('API — POST /api/review/:prNumber', () => {
  test('approve emits review.approved event', async ({ request }) => {
    const res = await request.post('/api/review/42/approve')
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.prNumber).toBe(42)
    expect(body.action).toBe('approved')
  })

  test('reject with reason emits review.rejected event', async ({ request }) => {
    const res = await request.post('/api/review/42/reject', {
      data: { reason: 'Tests are failing' },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.action).toBe('rejected')
    expect(body.reason).toBe('Tests are failing')
  })

  test('reject without reason returns 400', async ({ request }) => {
    const res = await request.post('/api/review/42/reject', { data: {} })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/reason/)
  })

  test('approve with invalid pr number returns 400', async ({ request }) => {
    const res = await request.post('/api/review/0/approve')
    expect(res.status()).toBe(400)
  })
})
