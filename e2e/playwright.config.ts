import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

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
    },
  },
})
