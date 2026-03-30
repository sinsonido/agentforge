import { test, expect } from './fixtures'

/**
 * Login UI — auth bypass tests.
 *
 * The E2E server runs with auth disabled (default config), so:
 * - /api/status returns 200 without a token
 * - The AuthProvider auto-authenticates and skips the login page
 * - All views remain accessible without any token in storage
 */

test.describe('Login — auth bypass when auth is disabled', () => {
  test('login page redirects to dashboard when auth is disabled', async ({ page }) => {
    await page.goto('/login')
    // With auth disabled, AuthProvider sets isAuthenticated = true automatically,
    // so LoginView redirects to /dashboard.
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 5000 })
  })

  test('navigating to / redirects to /dashboard without login', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('dashboard is accessible without a token when auth disabled', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('kanban is accessible without a token when auth disabled', async ({ page }) => {
    await page.goto('/kanban')
    await expect(page.getByRole('link', { name: 'Kanban' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('agents is accessible without a token when auth disabled', async ({ page }) => {
    await page.goto('/agents')
    await expect(page.getByRole('link', { name: 'Agents' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('providers is accessible without a token when auth disabled', async ({ page }) => {
    await page.goto('/providers')
    await expect(page.getByRole('link', { name: 'Providers' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('costs is accessible without a token when auth disabled', async ({ page }) => {
    await page.goto('/costs')
    await page.waitForLoadState('networkidle')
    const content = page.getByText('Total Spend').or(page.getByText('Cost tracking not available.'))
    await expect(content.first()).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })
})
