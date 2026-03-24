import { test as base, expect } from '@playwright/test'
import Database from 'better-sqlite3'

const TEST_DB_PATH = '/tmp/agentforge-e2e-test.db'

/**
 * Extended test fixture that resets the test DB before every test by
 * connecting directly to the SQLite file — no server endpoint needed.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    try {
      const db = new Database(TEST_DB_PATH)
      db.exec('DELETE FROM tasks; DELETE FROM cost_records; DELETE FROM events; DELETE FROM agent_activity;')
      db.close()
    } catch {
      // DB may not exist yet on first run — that's fine
    }
    await use(page)
  },
})

export { expect }
