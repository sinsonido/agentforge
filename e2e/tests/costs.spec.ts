import { test, expect } from './fixtures'

test.describe('Costs — spend tracking', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/costs')
  })

  test('shows total spend at $0 with fresh test DB', async ({ page }) => {
    // With a fresh test DB and no real provider calls, spend should be $0
    const zeroSpend = page.getByText('$0.0000')
    const notAvailable = page.getByText('Cost tracking not available.')

    // Either the $0 spend view or the not-available state is shown
    await expect(zeroSpend.or(notAvailable).first()).toBeVisible()
  })

  test('renders without errors', async ({ page }) => {
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('if costs available, shows expected sections', async ({ page }) => {
    const notAvailable = page.getByText('Cost tracking not available.')

    if (await notAvailable.isVisible()) {
      test.skip()
      return
    }

    await expect(page.getByText('Total Spend')).toBeVisible()
    await expect(page.getByText('Budget Usage')).toBeVisible()
    await expect(page.getByText('Transaction Log')).toBeVisible()
  })

  test('shows Cumulative Spend and Breakdown sections', async ({ page }) => {
    await page.waitForLoadState('networkidle')
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    await expect(page.getByText('Cumulative Spend')).toBeVisible()
    await expect(page.getByText('Breakdown')).toBeVisible()
  })

  test('budget bar shows project name from config', async ({ page }) => {
    await page.waitForLoadState('networkidle')
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    await expect(page.getByText('AgentForge E2E Test')).toBeVisible()
  })

  test('transaction log shows no transactions with fresh DB', async ({ page }) => {
    await page.waitForLoadState('networkidle')
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    await expect(page.getByText('No transactions recorded.')).toBeVisible()
  })

  test('breakdown section shows By Agent and By Model sub-sections', async ({ page }) => {
    await page.waitForLoadState('networkidle')
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    await expect(page.getByText('By Agent')).toBeVisible()
    await expect(page.getByText('By Model')).toBeVisible()
  })

  test('breakdown sub-sections show empty state with no transactions', async ({ page }) => {
    await page.waitForLoadState('networkidle')
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    // Both By Agent and By Model show "No data." with a fresh DB
    const noData = page.getByText('No data.')
    await expect(noData.first()).toBeVisible()
    await expect(noData).toHaveCount(2)
  })
})
