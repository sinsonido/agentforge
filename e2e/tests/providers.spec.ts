import { test, expect } from '@playwright/test'

test.describe('Providers — quota display', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/providers')
  })

  test('shows empty state when no providers have quota configured', async ({ page }) => {
    // All providers are disabled in test config so no quota entries exist
    await expect(page.getByText('No providers with quota configured.')).toBeVisible()
  })

  test('empty state is within the providers view (not an error)', async ({ page }) => {
    await expect(page.locator('body')).not.toContainText('Something went wrong')
    await expect(page.getByText('No providers with quota configured.')).toBeVisible()
  })
})
