import { test as base, expect } from '@playwright/test'
import Database from 'better-sqlite3'

/**
 * Extended test fixture that resets the test DB before every test by
 * connecting directly to the SQLite file — no server endpoint needed.
 *
 * The DB path is read from E2E_DB_PATH (set in playwright.config.ts),
 * which is also forwarded to the server via webServer.env so the YAML
 * config and this fixture always reference the same file.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const dbPath = process.env.E2E_DB_PATH
    if (dbPath) {
      let db: InstanceType<typeof Database> | undefined
      try {
        db = new Database(dbPath)
        db.exec('DELETE FROM tasks; DELETE FROM cost_records; DELETE FROM events; DELETE FROM agent_activity;')
      } catch {
        // DB may not exist yet on the first run — server creates it on startup
      } finally {
        db?.close()
      }
    }
    await use(page)
  },
})

export { expect }
