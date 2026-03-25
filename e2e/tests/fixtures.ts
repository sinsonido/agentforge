import { test as base, expect } from '@playwright/test'
import Database from 'better-sqlite3'

const SERVER_URL = 'http://127.0.0.1:4243'

/**
 * Reset all test state before every test:
 * 1. Clear the SQLite DB tables (tasks, cost_records, events, agent_activity).
 * 2. Call POST /api/test/reset to drain the in-memory task queue and stop the orchestrator.
 *
 * auto: true — runs for every test regardless of which fixtures the test uses,
 * so API-only tests (using only `request`) also get a clean slate.
 */
export function resetTestDb() {
  const dbPath = process.env.E2E_DB_PATH
  if (!dbPath) return
  let db: InstanceType<typeof Database> | undefined
  try {
    db = new Database(dbPath)
    db.pragma('busy_timeout = 5000')
    db.exec('BEGIN; DELETE FROM tasks; DELETE FROM cost_records; DELETE FROM events; DELETE FROM agent_activity; COMMIT;')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') throw err
  } finally {
    db?.close()
  }
}

async function resetServerState() {
  let res: Response
  try {
    res = await fetch(`${SERVER_URL}/api/test/reset`, { method: 'POST' })
  } catch {
    // Server might not be up yet on the very first test — tolerate network errors
    return
  }
  if (!res.ok) {
    throw new Error(`Failed to reset server state: ${res.status} ${res.statusText}`.trim())
  }
}

export const test = base.extend<{ _resetDb: void }>({
  _resetDb: [async ({}, use) => {
    resetTestDb()
    await resetServerState()
    await use()
  }, { auto: true }],
})

export { expect }
