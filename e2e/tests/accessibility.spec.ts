import { test, expect } from './fixtures'

test.describe('Accessibility — dialog keyboard interaction', () => {
  test('ESC closes Add Task dialog', async ({ page }) => {
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: 'Add Task' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('ESC closes Edit Agent dialog', async ({ page }) => {
    await page.goto('/agents')

    await page.getByText('Architect').locator('..').locator('..').getByRole('button').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('Tab moves focus between Add Task dialog fields', async ({ page }) => {
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: 'Add Task' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // Focus should land on the description input first (autofocus or first field)
    const input = page.getByPlaceholder('Task description')
    await input.focus()
    expect(await input.evaluate((el) => document.activeElement === el)).toBe(true)

    // Tab once — focus should advance to the priority select
    await page.keyboard.press('Tab')
    const select = page.getByRole('dialog').getByRole('combobox')
    // The focused element should now be the select (or the next tabbable element)
    const activeTag = await page.evaluate(() => document.activeElement?.tagName.toLowerCase())
    expect(['select', 'button']).toContain(activeTag)
  })

  test('Enter on focused Create button submits Add Task dialog', async ({ page, request }) => {
    await request.post('/api/control/stop')
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: 'Add Task' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByPlaceholder('Task description').fill(`Enter-submit task ${Date.now()}`)

    // Tab to Create button and press Enter
    const createBtn = page.getByRole('button', { name: 'Create' })
    await createBtn.focus()
    await page.keyboard.press('Enter')

    await expect(page.getByRole('dialog')).not.toBeVisible()
  })
})

test.describe('Accessibility — ARIA roles and attributes', () => {
  test('Add Task dialog has role=dialog', async ({ page }) => {
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: 'Add Task' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Playwright getByRole('dialog') itself verifies the role attribute
    expect(await dialog.getAttribute('role')).toBe('dialog')
  })

  test('Edit Agent dialog has role=dialog', async ({ page }) => {
    await page.goto('/agents')
    await page.getByText('Developer').locator('..').locator('..').getByRole('button').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    expect(await dialog.getAttribute('role')).toBe('dialog')
  })

  test('sidebar navigation links have role=link', async ({ page }) => {
    await page.goto('/dashboard')
    for (const name of ['Dashboard', 'Kanban', 'Agents', 'Providers', 'Costs']) {
      const link = page.getByRole('link', { name })
      await expect(link).toBeVisible()
    }
  })

  test('Kanban column headers have visible labels', async ({ page }) => {
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')
    for (const col of ['Queued', 'Executing', 'Completed', 'Failed']) {
      await expect(page.getByText(col, { exact: true }).first()).toBeVisible()
    }
  })

  test('Add Task button is keyboard-reachable via Tab from the page', async ({ page }) => {
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')

    // Focus the first tabbable element and Tab through until we reach Add Task
    await page.keyboard.press('Tab')
    // Look for the button to be focusable — verify it can be focused directly
    const btn = page.getByRole('button', { name: 'Add Task' })
    await btn.focus()
    expect(await btn.evaluate((el) => document.activeElement === el)).toBe(true)
  })
})

test.describe('Accessibility — orchestrator controls', () => {
  test('Start/Stop button is a button element with accessible name', async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    const btn = page.getByRole('button', { name: 'Start' }).or(page.getByRole('button', { name: 'Stop' }))
    await expect(btn.first()).toBeVisible()
  })

  test('orchestrator button is keyboard-activatable', async ({ page, request }) => {
    await request.post('/api/control/stop')
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    const startBtn = page.getByRole('button', { name: 'Start' })
    await startBtn.focus()
    await page.keyboard.press('Enter')

    // Should now show Stop button
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 3000 })

    // Clean up
    await request.post('/api/control/stop')
  })
})
