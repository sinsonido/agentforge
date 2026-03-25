/**
 * Extended fixture for costs tests.
 * Inherits the base DB-reset fixture and additionally seeds cost_records
 * and cost.recorded events so the Costs view renders with real data.
 */
import { test as base, expect, resetTestDb } from './fixtures'
import Database from 'better-sqlite3'

export { expect }

export interface CostSeed {
  projectId: string
  agentId: string
  model: string
  tokensIn: number
  tokensOut: number
  cost: number
}

const DEFAULT_SEEDS: CostSeed[] = [
  { projectId: 'AgentForge E2E Test', agentId: 'architect', model: 'claude-sonnet-4', tokensIn: 1000, tokensOut: 500, cost: 0.01050 },
  { projectId: 'AgentForge E2E Test', agentId: 'developer', model: 'claude-sonnet-4', tokensIn: 2000, tokensOut: 800, cost: 0.01800 },
  { projectId: 'AgentForge E2E Test', agentId: 'tester',    model: 'gemini-2.5-flash', tokensIn: 500,  tokensOut: 200, cost: 0.00020 },
]

export const test = base.extend<{ seedCosts: CostSeed[] }>({
  // Depend on `_resetDb` so the auto DB reset always runs before seeding
  seedCosts: async ({ _resetDb: _ }, use) => {
    // Reset is already done by the auto fixture; seed on top of it
    const dbPath = process.env.E2E_DB_PATH
    if (dbPath) {
      let db: InstanceType<typeof Database> | undefined
      try {
        db = new Database(dbPath)
        db.pragma('busy_timeout = 5000')

        const insertCost = db.prepare(
          'INSERT INTO cost_records (project_id, agent_id, model, tokens_in, tokens_out, cost) VALUES (?, ?, ?, ?, ?, ?)',
        )
        const insertEvent = db.prepare(
          'INSERT INTO events (event, data) VALUES (?, ?)',
        )

        for (const seed of DEFAULT_SEEDS) {
          insertCost.run(seed.projectId, seed.agentId, seed.model, seed.tokensIn, seed.tokensOut, seed.cost)
          insertEvent.run(
            'cost.recorded',
            JSON.stringify({
              projectId: seed.projectId,
              agentId:   seed.agentId,
              model:     seed.model,
              tokensIn:  seed.tokensIn,
              tokensOut: seed.tokensOut,
              cost:      seed.cost,
            }),
          )
        }
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT') throw err
      } finally {
        db?.close()
      }
    }

    await use(DEFAULT_SEEDS)
  },
})
