import { test, expect } from './fixtures'

test.describe('Kanban — board structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')
  })

  test('shows all four columns', async ({ page }) => {
    for (const col of ['Queued', 'Executing', 'Completed', 'Failed']) {
      await expect(page.getByText(col, { exact: true }).first()).toBeVisible()
    }
  })

  test('shows task count header', async ({ page }) => {
    // Header shows "N tasks total" even when 0
    await expect(page.getByText(/\d+ tasks total/)).toBeVisible()
  })

  test('Add Task button is visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Add Task' })).toBeVisible()
  })

  test('task count header updates after creating a task', async ({ page, request }) => {
    await request.post('/api/control/stop')

    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(`Counter test ${Date.now()}`)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()

    // The header should reflect the new total (at least 1 task)
    await expect(page.getByText(/[1-9]\d* tasks total/)).toBeVisible()
  })
})

test.describe('Kanban — board structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')
  })

  test('shows all four columns', async ({ page }) => {
    for (const col of ['Queued', 'Executing', 'Completed', 'Failed']) {
      await expect(page.getByText(col, { exact: true }).first()).toBeVisible()
    }
  })

  test('shows task count header', async ({ page }) => {
    // Header shows "N tasks total" even when 0
    await expect(page.getByText(/\d+ tasks total/)).toBeVisible()
  })

  test('Add Task button is visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Add Task' })).toBeVisible()
  })

  test('task count header updates after creating a task', async ({ page, request }) => {
    await request.post('/api/control/stop')

    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(`Counter test ${Date.now()}`)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()

    // The header should reflect the new total (at least 1 task)
    await expect(page.getByText(/[1-9]\d* tasks total/)).toBeVisible()
  })
})

test.describe('Tasks — create and verify in Kanban', () => {
  test.beforeEach(async ({ page, request }) => {
    // Stop orchestrator so created tasks stay in Queued state (not picked up for execution)
    await request.post('/api/control/stop')
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')
  })

  test('Add Task button opens dialog', async ({ page }) => {
    await page.getByRole('button', { name: 'Add Task' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByPlaceholder('Task description')).toBeVisible()
  })

  test('can create a task and it appears in Queued column', async ({ page }) => {
    const taskTitle = `E2E test task ${Date.now()}`
    const queuedColumn = page.locator('div').filter({ hasText: /^Queued/ }).first()

    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(taskTitle)
    await page.getByRole('button', { name: 'Create' }).click()

    // Dialog closes after creation
    await expect(page.getByRole('dialog')).not.toBeVisible()

    // Task appears scoped to the Queued column
    await expect(queuedColumn.getByText(taskTitle)).toBeVisible()
  })

  test('can set priority when creating a task', async ({ page }) => {
    const taskTitle = `E2E priority task ${Date.now()}`
    const queuedColumn = page.locator('div').filter({ hasText: /^Queued/ }).first()

    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(taskTitle)
    await page.getByRole('dialog').getByRole('combobox').selectOption('high')
    await page.getByRole('button', { name: 'Create' }).click()

    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(queuedColumn.getByText(taskTitle)).toBeVisible()
  })

  test('Cancel closes dialog without creating task', async ({ page }) => {
    const taskTitle = `E2E cancelled task ${Date.now()}`

    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(taskTitle)
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(page.getByText(taskTitle)).not.toBeVisible()
  })

  test('cannot create a task with empty title', async ({ page }) => {
    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByRole('button', { name: 'Create' }).click()

    // Dialog should remain open (HTML5 required validation)
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('created task persists after page reload', async ({ page }) => {
    const taskTitle = `E2E persist task ${Date.now()}`
    const queuedColumn = page.locator('div').filter({ hasText: /^Queued/ }).first()

    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(taskTitle)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()

    // Reload and verify the task is still in the Queued column
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(queuedColumn.getByText(taskTitle)).toBeVisible()
  })

  test('multiple tasks appear in Queued column', async ({ page }) => {
    const titles = [
      `E2E task A ${Date.now()}`,
      `E2E task B ${Date.now()}`,
    ]
    const queuedColumn = page.locator('div').filter({ hasText: /^Queued/ }).first()

    for (const title of titles) {
      await page.getByRole('button', { name: 'Add Task' }).click()
      await page.getByPlaceholder('Task description').fill(title)
      await page.getByRole('button', { name: 'Create' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
    }

    for (const title of titles) {
      await expect(queuedColumn.getByText(title)).toBeVisible()
    }
  })
})
