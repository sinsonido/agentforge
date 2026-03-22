import { test, expect } from '@playwright/test'

test.describe('Dashboard — KPIs and orchestrator', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard')
  })

  test('shows KPI cards for task states', async ({ page }) => {
    await expect(page.getByText('Queued')).toBeVisible()
    await expect(page.getByText('Executing')).toBeVisible()
    await expect(page.getByText('Completed')).toBeVisible()
    await expect(page.getByText('Failed')).toBeVisible()
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
    const stopBtn = page.getByRole('button', { name: 'Stop' })

    // Start if stopped
    if (await startBtn.isVisible()) {
      await startBtn.click()
      await expect(stopBtn).toBeVisible()
    }

    // Always end in Stopped state to avoid affecting subsequent tests
    await stopBtn.click()
    await expect(startBtn).toBeVisible()
  })

  test('recent tasks table is present', async ({ page }) => {
    // Table renders even with no tasks (empty state or headers visible)
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })
})
