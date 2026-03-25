import { test, expect } from './fixtures'

test.describe('Cross-view — status changes update KPI counters', () => {
  test('completing a task moves count from Queued to Completed on Dashboard', async ({ page, request }) => {
    await request.post('/api/control/stop')

    // Seed a task
    const created = await (await request.post('/api/tasks', { data: { title: `KPI complete test ${Date.now()}` } })).json()
    const id = created.task.id

    // Read initial KPIs
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    const queuedEl = page.getByText('Queued', { exact: true }).locator('..').locator('.tabular-nums')
    const completedEl = page.getByText('Completed', { exact: true }).locator('..').locator('.tabular-nums')
    const queuedBefore = parseInt(await queuedEl.textContent() ?? '0', 10)
    const completedBefore = parseInt(await completedEl.textContent() ?? '0', 10)

    // Move task to completed via API
    await request.post(`/api/tasks/${id}/status`, { data: { status: 'completed' } })

    // Reload to pick up updated counts
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(queuedEl).toHaveText(String(queuedBefore - 1 < 0 ? 0 : queuedBefore - 1))
    await expect(completedEl).toHaveText(String(completedBefore + 1))
  })

  test('failing a task increments Failed KPI on Dashboard', async ({ page, request }) => {
    await request.post('/api/control/stop')

    const created = await (await request.post('/api/tasks', { data: { title: `KPI fail test ${Date.now()}` } })).json()
    const id = created.task.id

    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    const failedEl = page.getByText('Failed', { exact: true }).locator('..').locator('.tabular-nums')
    const failedBefore = parseInt(await failedEl.textContent() ?? '0', 10)

    await request.post(`/api/tasks/${id}/status`, { data: { status: 'failed' } })

    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(failedEl).toHaveText(String(failedBefore + 1))
  })
})

test.describe('Cross-view — Recent Tasks table reflects live data', () => {
  test('Recent Tasks table shows task title, status badge and cost column', async ({ page, request }) => {
    await request.post('/api/control/stop')
    const title = `Recent tasks table test ${Date.now()}`
    await request.post('/api/tasks', { data: { title } })

    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    // Table headers
    await expect(page.getByRole('columnheader', { name: 'Title' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Status' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Agent' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Cost' })).toBeVisible()

    // Task row
    await expect(page.getByRole('cell', { name: title })).toBeVisible()
  })

  test('task status badge shows queued for a newly created task', async ({ page, request }) => {
    await request.post('/api/control/stop')
    const title = `Status badge test ${Date.now()}`
    await request.post('/api/tasks', { data: { title } })

    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    // The row containing the task title should have a 'queued' badge nearby
    const row = page.getByRole('row', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    await expect(row.getByText('queued')).toBeVisible()
  })

  test('completed task shows completed badge in Recent Tasks', async ({ page, request }) => {
    await request.post('/api/control/stop')
    const title = `Completed badge test ${Date.now()}`
    const created = await (await request.post('/api/tasks', { data: { title } })).json()
    await request.post(`/api/tasks/${created.task.id}/status`, { data: { status: 'completed' } })

    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    // Use the Badge element inside the row — exact text avoids matching the title cell
    const row = page.getByRole('row', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    await expect(row.getByText('completed', { exact: true })).toBeVisible()
  })

  test('task with agent_id shows agent in the Agent column', async ({ page, request }) => {
    await request.post('/api/control/stop')
    const title = `Agent column test ${Date.now()}`
    await request.post('/api/tasks', { data: { title, agent_id: 'architect' } })

    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    const row = page.getByRole('row', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    await expect(row.getByText('architect')).toBeVisible()
  })
})

test.describe('Cross-view — Live Activity Feed via WebSocket', () => {
  test('Live Activity Feed section is visible on Dashboard', async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    // The feed shows either "Waiting for events…" (no history) or event badges (replayed from WS)
    await expect(page.getByText('Live Activity')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('Live Activity shows event badge after creating a task', async ({ page, request }) => {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    await request.post('/api/control/stop')

    await request.post('/api/tasks', { data: { title: `Activity test ${Date.now()}` } })

    // WS push should update ActivityFeed within a few seconds
    // Use .first() — many task.queued badges may already exist from WS replay
    await expect(page.getByText('task.queued').first()).toBeVisible({ timeout: 5000 })
  })
})

test.describe('Cross-view — Kanban status change reflected in Dashboard KPI', () => {
  test('task moved to completed in Kanban increments Completed KPI on Dashboard', async ({ page, request }) => {
    await request.post('/api/control/stop')
    const title = `Kanban→Dashboard flow ${Date.now()}`
    const created = await (await request.post('/api/tasks', { data: { title } })).json()
    const id = created.task.id

    // Record initial Dashboard KPI
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    const completedEl = page.getByText('Completed', { exact: true }).locator('..').locator('.tabular-nums')
    const before = parseInt(await completedEl.textContent() ?? '0', 10)

    // Change status via API (simulating drag-and-drop)
    await request.post(`/api/tasks/${id}/status`, { data: { status: 'completed' } })

    // Reload Dashboard
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(completedEl).toHaveText(String(before + 1))
  })
})
