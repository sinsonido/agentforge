import { test, expect } from './fixtures'

test.describe('KanbanCard — title and priority dot', () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post('/api/control/stop')
    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')
  })

  test('card renders task title', async ({ page }) => {
    const title = `Card title test ${Date.now()}`
    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(title)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()

    await expect(page.getByText(title)).toBeVisible()
  })

  test('card for critical priority has red dot', async ({ page }) => {
    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(`Critical task ${Date.now()}`)
    await page.getByRole('dialog').getByRole('combobox').selectOption('critical')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()

    // The priority dot is a span with bg-red-500
    const dot = page.locator('.bg-red-500').first()
    await expect(dot).toBeVisible()
  })

  test('card for high priority has orange dot', async ({ page }) => {
    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(`High task ${Date.now()}`)
    await page.getByRole('dialog').getByRole('combobox').selectOption('high')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()

    const dot = page.locator('.bg-orange-500').first()
    await expect(dot).toBeVisible()
  })

  test('card for medium priority has yellow dot (default)', async ({ page }) => {
    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(`Medium task ${Date.now()}`)
    // medium is the default — do not change the select
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()

    const dot = page.locator('.bg-yellow-500').first()
    await expect(dot).toBeVisible()
  })

  test('card for low priority has blue dot', async ({ page }) => {
    await page.getByRole('button', { name: 'Add Task' }).click()
    await page.getByPlaceholder('Task description').fill(`Low task ${Date.now()}`)
    await page.getByRole('dialog').getByRole('combobox').selectOption('low')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()

    const dot = page.locator('.bg-blue-400').first()
    await expect(dot).toBeVisible()
  })
})

test.describe('KanbanCard — task created via API appears in board', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/api/control/stop')
  })

  test('task created via API appears in Queued column without UI interaction', async ({ page, request }) => {
    const title = `API task ${Date.now()}`
    await request.post('/api/tasks', { data: { title, priority: 'high' } })

    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')

    const queuedColumn = page.locator('div').filter({ hasText: /^Queued/ }).first()
    await expect(queuedColumn.getByText(title)).toBeVisible()
  })

  test('multiple tasks created via API all appear in Queued column', async ({ page, request }) => {
    const titles = [
      `API batch A ${Date.now()}`,
      `API batch B ${Date.now()}`,
      `API batch C ${Date.now()}`,
    ]
    for (const title of titles) {
      await request.post('/api/tasks', { data: { title } })
    }

    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')

    const queuedColumn = page.locator('div').filter({ hasText: /^Queued/ }).first()
    for (const title of titles) {
      await expect(queuedColumn.getByText(title)).toBeVisible()
    }
  })

  test('task with status=completed via API appears in Completed column', async ({ page, request }) => {
    const title = `Completed API task ${Date.now()}`
    const created = await (await request.post('/api/tasks', { data: { title } })).json()
    await request.post(`/api/tasks/${created.task.id}/status`, { data: { status: 'completed' } })

    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')

    const completedColumn = page.locator('div').filter({ hasText: /^Completed/ }).first()
    await expect(completedColumn.getByText(title)).toBeVisible()
  })

  test('task with status=failed via API appears in Failed column', async ({ page, request }) => {
    const title = `Failed API task ${Date.now()}`
    const created = await (await request.post('/api/tasks', { data: { title } })).json()
    await request.post(`/api/tasks/${created.task.id}/status`, { data: { status: 'failed' } })

    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')

    const failedColumn = page.locator('div').filter({ hasText: /^Failed/ }).first()
    await expect(failedColumn.getByText(title)).toBeVisible()
  })
})

test.describe('KanbanCard — agent badge', () => {
  test('task with agent_id shows agent badge on card', async ({ page, request }) => {
    await request.post('/api/control/stop')
    const title = `Agent badge task ${Date.now()}`
    await request.post('/api/tasks', { data: { title, agent_id: 'architect' } })

    await page.goto('/kanban')
    await page.waitForLoadState('networkidle')

    // The agent badge is rendered inside the card
    await expect(page.getByText('architect').first()).toBeVisible()
  })
})
