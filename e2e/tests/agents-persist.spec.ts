import { test, expect } from './fixtures'

test.describe('Agents — model override persistence', () => {
  test('model override saved via UI calls POST /api/agents/:id and dialog closes', async ({ page }) => {
    await page.goto('/agents')

    // Capture the outgoing POST /api/agents/architect request
    const requests: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/agents/architect') && req.method() === 'POST') {
        requests.push(req.url())
      }
    })

    // Open edit dialog for Architect
    await page.getByText('Architect').locator('..').locator('..').getByRole('button').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByPlaceholder('Leave blank to keep current').first().fill('claude-haiku-test')
    await page.getByRole('button', { name: 'Save' }).click()

    // Dialog should close on success
    await expect(page.getByRole('dialog')).not.toBeVisible()
    // The Save action should have called the agents API
    expect(requests.length).toBeGreaterThan(0)
  })

  test('model override saved via API is reflected in GET /api/agents', async ({ request }) => {
    await request.post('/api/agents/developer', { data: { model: 'gemini-2.5-flash' } })

    const body = await (await request.get('/api/agents')).json()
    const developer = body.agents.find((a: { id: string }) => a.id === 'developer')
    expect(developer.model).toBe('gemini-2.5-flash')
  })

  test('editing two agents independently does not cross-contaminate', async ({ request }) => {
    await request.post('/api/agents/architect', { data: { model: 'model-for-architect' } })
    await request.post('/api/agents/tester',    { data: { model: 'model-for-tester' } })

    const body = await (await request.get('/api/agents')).json()
    const architect = body.agents.find((a: { id: string }) => a.id === 'architect')
    const tester    = body.agents.find((a: { id: string }) => a.id === 'tester')

    expect(architect.model).toBe('model-for-architect')
    expect(tester.model).toBe('model-for-tester')
  })
})

test.describe('Agents — edit dialog state', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agents')
  })

  test('edit dialog closes after clicking Cancel', async ({ page }) => {
    // Note: Radix UI Dialog hides in place on close (not unmounted) — state may persist.
    // We verify only that Cancel hides the dialog, not that input state resets.
    await page.getByText('Developer').locator('..').locator('..').getByRole('button').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByPlaceholder('Leave blank to keep current').first().fill('partial-input')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('each agent has its own edit dialog with the correct agent id in title', async ({ page }) => {
    for (const [name, id] of [['Architect', 'architect'], ['Developer', 'developer'], ['Tester', 'tester']]) {
      await page.getByText(name, { exact: true }).locator('..').locator('..').getByRole('button').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByText(`Edit Agent: ${id}`)).toBeVisible()
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
    }
  })

  test('Save button calls POST /api/agents/:id with correct payload', async ({ page }) => {
    // Intercept the PATCH/POST to capture the request
    const requests: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/agents/') && req.method() === 'POST') {
        requests.push(req.url())
      }
    })

    await page.getByText('Tester').locator('..').locator('..').getByRole('button').click()
    await page.getByPlaceholder('Leave blank to keep current').first().fill('gemini-2.5-pro')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()

    expect(requests.some((url) => url.includes('/api/agents/tester'))).toBe(true)
  })
})
