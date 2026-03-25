import { test, expect } from './fixtures'

test.describe('Error states — unknown routes', () => {
  test('navigating to an unknown route does not show "Something went wrong"', async ({ page }) => {
    await page.goto('/not-a-real-route')
    // The SPA serves index.html for all routes; React Router renders whatever
    // fallback is configured. The app should not blow up.
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('unknown route renders a blank page (no sidebar — React Router v6 unmatched)', async ({ page }) => {
    // React Router v6: layout route element only renders when a child matches.
    // An unknown route renders nothing — the page is blank but doesn't crash.
    await page.goto('/unknown-path-xyz')
    await expect(page.locator('body')).not.toContainText('Something went wrong')
    // The blank page does NOT show any known view content
    await expect(page.getByText('Dashboard', { exact: true })).not.toBeVisible()
  })
})

test.describe('Error states — API bad input handling', () => {
  test('POST /api/tasks with no body returns 400 not 500', async ({ request }) => {
    const res = await request.post('/api/tasks', { data: {} })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  test('POST /api/tasks/:id/status with no status returns 400', async ({ request }) => {
    await request.post('/api/control/stop')
    const created = await (await request.post('/api/tasks', { data: { title: 'Error state task' } })).json()
    const id = created.task.id

    const res = await request.post(`/api/tasks/${id}/status`, { data: {} })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  test('POST /api/review/0/approve returns 400 for invalid PR number', async ({ request }) => {
    const res = await request.post('/api/review/0/approve')
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  test('POST /api/review/abc/approve returns 400 for non-numeric PR number', async ({ request }) => {
    const res = await request.post('/api/review/abc/approve')
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  test('POST /api/review/:id/reject without reason returns 400', async ({ request }) => {
    const res = await request.post('/api/review/1/reject', { data: {} })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/reason/)
  })

  test('GET /api/tasks/:id with unknown id returns 404 with ok:false', async ({ request }) => {
    const res = await request.get('/api/tasks/definitely-does-not-exist')
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBeTruthy()
  })

  test('POST /api/agents/:id with unknown agent returns 404', async ({ request }) => {
    const res = await request.post('/api/agents/phantom-agent', { data: { model: 'x' } })
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })
})

test.describe('Error states — duplicate orchestrator control', () => {
  test('starting already-running orchestrator returns error with ok:false', async ({ request }) => {
    await request.post('/api/control/start')
    const res = await request.post('/api/control/start')
    const body = await res.json()
    expect(res.status()).toBe(409)
    expect(body.ok).toBe(false)
    await request.post('/api/control/stop')
  })

  test('stopping already-stopped orchestrator returns error with ok:false', async ({ request }) => {
    await request.post('/api/control/stop')
    const res = await request.post('/api/control/stop')
    const body = await res.json()
    expect(res.status()).toBe(409)
    expect(body.ok).toBe(false)
  })
})

test.describe('Error states — UI resilience on view load', () => {
  const VIEWS = ['/dashboard', '/kanban', '/agents', '/providers', '/costs']

  for (const view of VIEWS) {
    test(`${view} does not crash after rapid back-and-forth navigation`, async ({ page }) => {
      await page.goto('/dashboard')
      await page.goto(view)
      await page.goto('/dashboard')
      await page.goto(view)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('body')).not.toContainText('Something went wrong')
    })
  }
})
