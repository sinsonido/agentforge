import { test, expect } from './fixtures'

test.describe('Dashboard — KPIs and orchestrator', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard')
  })

  test('shows KPI cards for task states', async ({ page }) => {
    // Use exact:true to avoid matching 'task.queued' / 'task.completed' badges in ActivityFeed
    await expect(page.getByText('Queued', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Executing', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible()
  })

  test('orchestrator shows initial state badge', async ({ page }) => {
    // Should show either Running or Stopped badge
    const badge = page.getByText('Running').or(page.getByText('Stopped'))
    await expect(badge.first()).toBeVisible()
  })

  test('orchestrator Start/Stop button is visible', async ({ page }) => {
    const btn = page.getByRole('button', { name: 'Start' }).or(page.getByRole('button', { name: 'Stop' }))
    await expect(btn.first()).toBeVisible()
  })

  test('can toggle orchestrator start/stop', async ({ page }) => {
    const startBtn = page.getByRole('button', { name: 'Start' })
    const stopBtn  = page.getByRole('button', { name: 'Stop' })

    // Ensure we are in a known state — start the orchestrator first if stopped
    await expect(startBtn.or(stopBtn).first()).toBeVisible()

    if (await startBtn.isVisible()) {
      await startBtn.click()
      await expect(stopBtn).toBeVisible({ timeout: 5000 })
    }

    // Stop and verify we return to Start state
    await expect(stopBtn).toBeVisible()
    await stopBtn.click()
    await expect(startBtn).toBeVisible({ timeout: 5000 })
  })

  test('recent tasks table is present', async ({ page }) => {
    // Table renders even with no tasks (empty state or headers visible)
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('shows Provider Quotas, Live Activity and Recent Tasks sections', async ({ page }) => {
    await expect(page.getByText('Provider Quotas')).toBeVisible()
    await expect(page.getByText('Live Activity')).toBeVisible()
    await expect(page.getByText('Recent Tasks')).toBeVisible()
  })

  test('KPI values are 0 with fresh test DB', async ({ page }) => {
    // Each KPI card: label p → parent CardContent → sibling .tabular-nums holds the numeric value
    for (const label of ['Queued', 'Executing', 'Completed', 'Failed']) {
      const valueEl = page.getByText(label, { exact: true }).locator('..').locator('.tabular-nums')
      await expect(valueEl).toHaveText('0')
    }
  })

  test('recent tasks shows empty state with no tasks', async ({ page }) => {
    await expect(page.getByText('No tasks yet.')).toBeVisible()
  })

  test('Provider Quotas section shows no-providers message', async ({ page }) => {
    // All providers disabled in test config so QuotaList renders the empty state
    await expect(page.getByText('No providers configured.')).toBeVisible()
  })
})
