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
        // Wait up to 5 s if the server holds a write lock rather than
        // failing immediately with SQLITE_BUSY.
        db.pragma('busy_timeout = 5000')
        db.exec('DELETE FROM tasks; DELETE FROM cost_records; DELETE FROM events; DELETE FROM agent_activity;')
      } catch (err: unknown) {
        // Tolerate ENOENT — the DB file doesn't exist yet on the very
        // first run; the server creates it on startup.
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT') throw err
      } finally {
        db?.close()
      }
    }
    await use(page)
  },
})

export { expect }
