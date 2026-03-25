import { test, expect } from './fixtures-costs'

/**
 * Costs view tests with seeded DB data.
 * The `seedCosts` fixture inserts 3 cost_records + 3 cost.recorded events
 * before each test, so the Costs view always has real data to render.
 */

test.describe('Costs — TransactionLog with data', () => {
  test.beforeEach(async ({ page, seedCosts: _ }) => {
    await page.goto('/costs')
    await page.waitForLoadState('networkidle')
  })

  test('Transaction Log shows rows instead of empty state', async ({ page }) => {
    await expect(page.getByText('No transactions recorded.')).not.toBeVisible()
  })

  test('Transaction Log shows one row per seeded transaction', async ({ page }) => {
    // Each row has a cost value formatted as $x.xxxxx
    const rows = page.locator('[class*="tabular-nums"]').filter({ hasText: /\$\d+\.\d{5}/ })
    await expect(rows).toHaveCount(3)
  })

  test('Transaction Log shows agent ids', async ({ page }) => {
    for (const agentId of ['architect', 'developer', 'tester']) {
      await expect(page.getByText(agentId).first()).toBeVisible()
    }
  })

  test('Transaction Log shows model names', async ({ page }) => {
    await expect(page.getByText('claude-sonnet-4').first()).toBeVisible()
    await expect(page.getByText('gemini-2.5-flash').first()).toBeVisible()
  })

  test('Transaction Log shows token counts (↑↓ notation)', async ({ page }) => {
    // At least one row should show token counts in "Nin↑ Nout↓" format
    await expect(page.getByText(/\d+↑ \d+↓/).first()).toBeVisible()
  })
})

test.describe('Costs — By Agent breakdown with data', () => {
  test.beforeEach(async ({ page, seedCosts: _ }) => {
    await page.goto('/costs')
    await page.waitForLoadState('networkidle')
  })

  test('By Agent shows each seeded agent', async ({ page }) => {
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    // 'By Agent' is an h3; its direct parent div is the By Agent section container
    const breakdown = page.getByText('By Agent').locator('..')
    for (const agentId of ['architect', 'developer', 'tester']) {
      await expect(breakdown.getByText(agentId)).toBeVisible()
    }
  })

  test('By Agent does not show "No data." with seeded records', async ({ page }) => {
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    // Get the By Agent section and check no-data message is absent
    const byAgent = page.getByText('By Agent').locator('..')
    await expect(byAgent.getByText('No data.')).not.toBeVisible()
  })
})

test.describe('Costs — Total Spend with data', () => {
  test.beforeEach(async ({ page, seedCosts: _ }) => {
    await page.goto('/costs')
    await page.waitForLoadState('networkidle')
  })

  test('Total Spend is non-zero with seeded records', async ({ page }) => {
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    // The Total Spend section: <p>Total Spend</p><p class="tabular-nums">$X.XXXX</p>
    // byAgent is populated from cost_records — the value should be > $0
    const totalSpendEl = page.getByText('Total Spend').locator('..').locator('p.tabular-nums')
    const totalText = await totalSpendEl.textContent()
    // The value should NOT be $0.0000 — it should reflect the seeded $0.0290
    expect(totalText).not.toBe('$0.0000')
  })

  test('Budget Usage bar shows AgentForge E2E Test project', async ({ page }) => {
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    await expect(page.getByText('AgentForge E2E Test')).toBeVisible()
  })

  test('Budget bar shows spend / budget text', async ({ page }) => {
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    // Format: $X.XXXX / $999.00
    await expect(page.getByText(/\$\d+\.\d+ \/ \$999\.00/)).toBeVisible()
  })

  test('Budget bar shows percentage used', async ({ page }) => {
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    await expect(page.getByText(/\d+% used/)).toBeVisible()
  })
})

test.describe('Costs — SpendChart renders with data', () => {
  test.beforeEach(async ({ page, seedCosts: _ }) => {
    await page.goto('/costs')
    await page.waitForLoadState('networkidle')
  })

  test('Cumulative Spend section is visible', async ({ page }) => {
    const notAvailable = page.getByText('Cost tracking not available.')
    if (await notAvailable.isVisible()) { test.skip(); return }

    await expect(page.getByText('Cumulative Spend')).toBeVisible()
  })

  test('page does not crash with seeded cost data', async ({ page }) => {
    await expect(page.locator('body')).not.toContainText('Something went wrong')
  })
})

test.describe('Costs — API /api/costs response with seeded data', () => {
  test('totalCostUSD is the sum of all seeded costs', async ({ page, request, seedCosts }) => {
    const expectedTotal = seedCosts.reduce((sum, s) => sum + s.cost, 0)

    const body = await (await request.get('/api/costs')).json()
    if (!body.available) { test.skip(); return }

    // Allow small floating-point tolerance
    expect(Math.abs(body.costs.totalCostUSD - expectedTotal)).toBeLessThan(0.0001)
  })

  test('byAgent contains each seeded agent', async ({ request, seedCosts: _ }) => {
    const body = await (await request.get('/api/costs')).json()
    if (!body.available) return

    expect(body.costs.byAgent).toHaveProperty('architect')
    expect(body.costs.byAgent).toHaveProperty('developer')
    expect(body.costs.byAgent).toHaveProperty('tester')
  })

  test('transactions array has 3 entries matching seeded events', async ({ request, seedCosts: _ }) => {
    const body = await (await request.get('/api/costs')).json()
    if (!body.available) return

    expect(body.costs.transactions.length).toBe(3)
  })
})
