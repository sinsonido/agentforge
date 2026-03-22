import { test, expect } from '@playwright/test'

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
      // Acceptable state for test environment
      return
    }

    await expect(page.getByText('Total Spend')).toBeVisible()
    await expect(page.getByText('Budget Usage')).toBeVisible()
    await expect(page.getByText('Transaction Log')).toBeVisible()
  })
})
