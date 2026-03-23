import { test, expect } from '@playwright/test'

// Agents defined in e2e/fixtures/agentforge.test.yml
const TEST_AGENTS = ['Architect', 'Developer', 'Tester']

test.describe('Agents — list and edit', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agents')
  })

  test('shows all configured agents', async ({ page }) => {
    for (const name of TEST_AGENTS) {
      await expect(page.getByText(name, { exact: true })).toBeVisible()
    }
  })

  test('each agent card shows its state badge', async ({ page }) => {
    const badges = page.getByText('idle')
    await expect(badges.first()).toBeVisible()
  })

  test('settings button opens edit dialog for an agent', async ({ page }) => {
    // Click the settings icon on the first agent card (Architect)
    await page.getByText('Architect').locator('..').locator('..').getByRole('button').click()

    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText('Edit Agent: architect')).toBeVisible()
    await expect(page.getByPlaceholder('Leave blank to keep current').first()).toBeVisible()
  })

  test('Cancel closes edit dialog without saving', async ({ page }) => {
    await page.getByText('Architect').locator('..').locator('..').getByRole('button').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('can update agent model override', async ({ page }) => {
    await page.getByText('Developer').locator('..').locator('..').getByRole('button').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByPlaceholder('Leave blank to keep current').first().fill('claude-haiku-4')
    await page.getByRole('button', { name: 'Save' }).click()

    // Dialog closes on success
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('each agent card shows its ID in mono below the name', async ({ page }) => {
    // AgentCard renders agent.id in a mono <p> below the name
    for (const id of ['architect', 'developer', 'tester']) {
      await expect(page.getByText(id, { exact: true })).toBeVisible()
    }
  })

  test('each agent card shows state transitions count', async ({ page }) => {
    // Fresh agents start with 0 state transitions
    const transitionText = page.getByText('0 state transitions')
    await expect(transitionText.first()).toBeVisible()
    await expect(transitionText).toHaveCount(TEST_AGENTS.length)
  })
})
