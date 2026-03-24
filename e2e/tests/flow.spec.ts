import { test, expect } from './fixtures'

test.describe('Cross-view flows', () => {
  test('task created in Kanban appears in Dashboard Recent Tasks', async ({ page, request }) => {
    // Stop orchestrator so the task stays queued and doesn't get picked up
    await request.post('/api/control/stop')

    const taskTitle = `Flow test task ${Date.now()}`

    // Create task via Kanban
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(taskTitle)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()

    // Navigate to Dashboard and verify the task appears in Recent Tasks
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(taskTitle)).toBeVisible()
  })

  test('task created in Kanban increments Dashboard Queued KPI', async ({ page, request }) => {
    await request.post('/api/control/stop')

    // Read current Queued count from Dashboard
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    const queuedEl = page.getByText('Queued', { exact: true }).locator('..').locator('.tabular-nums')
    const before = parseInt(await queuedEl.textContent() ?? '0', 10)

    // Create a task via Kanban
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(`KPI increment test ${Date.now()}`)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()

    // Return to Dashboard and verify Queued went up by 1
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    await expect(queuedEl).toHaveText(String(before + 1))
  })
})
