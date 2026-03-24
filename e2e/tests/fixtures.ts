import { test as base, expect } from '@playwright/test'

/**
 * Extended test fixture that resets the server DB before every test,
 * ensuring full hermetic isolation regardless of execution order.
 */
export const test = base.extend({
  // Override the default page fixture to inject the reset logic
  page: async ({ page, request }, use) => {
    await request.delete('/api/test/reset')
    await use(page)
  },
})

export { expect }
