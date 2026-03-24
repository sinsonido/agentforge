import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Single source of truth for the test DB path.
// Propagated to the server process via webServer.env and to the test
// process via process.env so fixtures can read it without hardcoding.
const E2E_DB_PATH = process.env.E2E_DB_PATH ?? '/tmp/agentforge-e2e-test.db'
process.env.E2E_DB_PATH = E2E_DB_PATH

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],

  use: {
    baseURL: 'http://127.0.0.1:4243',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'node ../src/cli.js start --config fixtures/agentforge.test.yml --port 4243',
    url: 'http://127.0.0.1:4243/api/status',
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
    env: {
      NODE_ENV: 'test',
      E2E_DB_PATH,
    },
  },
})
