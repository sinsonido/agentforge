import { test, expect } from '@playwright/test'

test.describe('Smoke — app loads and all views are accessible', () => {
  test('redirects / to /dashboard', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('Dashboard view renders', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible()
    // KPI cards area is present
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('Kanban view renders', async ({ page }) => {
    await page.goto('/kanban')
    await expect(page.getByRole('link', { name: 'Kanban' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('Agents view renders', async ({ page }) => {
    await page.goto('/agents')
    await expect(page.getByRole('link', { name: 'Agents' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('Providers view renders', async ({ page }) => {
    await page.goto('/providers')
    await expect(page.getByRole('link', { name: 'Providers' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })

  test('Costs view renders', async ({ page }) => {
    await page.goto('/costs')
    await expect(page.getByRole('link', { name: 'Costs' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })
})

test.describe('Smoke — sidebar navigation', () => {
  test('can navigate between views via sidebar', async ({ page }) => {
    await page.goto('/dashboard')

    await page.getByRole('link', { name: 'Kanban' }).click()
    await expect(page).toHaveURL(/\/kanban/)

    await page.getByRole('link', { name: 'Agents' }).click()
    await expect(page).toHaveURL(/\/agents/)

    await page.getByRole('link', { name: 'Providers' }).click()
    await expect(page).toHaveURL(/\/providers/)

    await page.getByRole('link', { name: 'Costs' }).click()
    await expect(page).toHaveURL(/\/costs/)

    await page.getByRole('link', { name: 'Dashboard' }).click()
    await expect(page).toHaveURL(/\/dashboard/)
  })
})
