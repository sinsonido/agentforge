import { test, expect } from './fixtures'

// Helper — open a native WebSocket in the browser context and collect messages.
// Returns a function that resolves with the accumulated messages array.
async function collectWsMessages(
  page: import('@playwright/test').Page,
  durationMs: number,
): Promise<Array<{ event: string; data: unknown; timestamp: number }>> {
  return page.evaluate(
    ({ url, duration }) =>
      new Promise((resolve) => {
        const msgs: Array<{ event: string; data: unknown; timestamp: number }> = []
        const ws = new WebSocket(url)
        ws.onmessage = (e) => {
          try { msgs.push(JSON.parse(e.data)) } catch { /* ignore */ }
        }
        // Resolve after the given duration regardless of message count
        setTimeout(() => { ws.close(); resolve(msgs) }, duration)
      }),
    { url: 'ws://127.0.0.1:4243/ws', duration: durationMs },
  )
}

test.describe('WebSocket — connection and initial replay', () => {
  test('server accepts WS connection at /ws', async ({ page }) => {
    await page.goto('/dashboard')

    const connected = await page.evaluate(
      (url) =>
        new Promise<boolean>((resolve) => {
          const ws = new WebSocket(url)
          ws.onopen = () => { ws.close(); resolve(true) }
          ws.onerror = () => resolve(false)
          setTimeout(() => resolve(false), 3000)
        }),
      'ws://127.0.0.1:4243/ws',
    )

    expect(connected).toBe(true)
  })

  test('replays recent events on connect (array received within 500 ms)', async ({ page }) => {
    // Ensure there is at least one event by creating a task first
    await page.goto('/dashboard')
    await page.request.post('/api/control/stop')
    await page.request.post('/api/tasks', {
      data: { title: 'WS replay seed task' },
    })

    // Short wait for the event to be persisted
    await page.waitForTimeout(200)

    const msgs = await collectWsMessages(page, 500)
    // The server replays the last 20 events on connect — we should see at least one
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    // Every replayed message must have the required fields
    for (const msg of msgs) {
      expect(msg).toHaveProperty('event')
      expect(msg).toHaveProperty('timestamp')
    }
  })
})

test.describe('WebSocket — live event broadcast', () => {
  test('creating a task via API broadcasts task.queued over WS', async ({ page }) => {
    await page.goto('/dashboard')
    await page.request.post('/api/control/stop')

    // Start collecting WS messages before triggering the action
    const msgsPromise = page.evaluate(
      ({ url }) =>
        new Promise<Array<{ event: string }>>((resolve) => {
          const msgs: Array<{ event: string }> = []
          const ws = new WebSocket(url)
          ws.onmessage = (e) => {
            try {
              const parsed = JSON.parse(e.data)
              msgs.push(parsed)
              if (parsed.event === 'task.queued') {
                ws.close()
                resolve(msgs)
              }
            } catch { /* ignore */ }
          }
          // Timeout after 4 s in case the event never fires
          setTimeout(() => { ws.close(); resolve(msgs) }, 4000)
        }),
      { url: 'ws://127.0.0.1:4243/ws' },
    )

    // Small delay to ensure WS is connected before we fire the event
    await page.waitForTimeout(300)

    await page.request.post('/api/tasks', {
      data: { title: 'WS broadcast test task' },
    })

    const msgs = await msgsPromise
    expect(msgs.some((m) => m.event === 'task.queued')).toBe(true)
  })

  test('approving a review broadcasts review.approved event over WS', async ({ page }) => {
    await page.goto('/dashboard')

    const msgsPromise = page.evaluate(
      ({ url }) =>
        new Promise<Array<{ event: string }>>((resolve) => {
          const msgs: Array<{ event: string }> = []
          const ws = new WebSocket(url)
          // Wait for the connection to open before resolving readiness
          ws.onopen = () => {
            // Signal readiness by pushing a sentinel
            msgs.push({ event: '__ready__' })
          }
          ws.onmessage = (e) => {
            try {
              const parsed = JSON.parse(e.data)
              msgs.push(parsed)
              if (parsed.event === 'review.approved') {
                ws.close()
                resolve(msgs)
              }
            } catch { /* ignore */ }
          }
          // 5 s total timeout
          setTimeout(() => { ws.close(); resolve(msgs) }, 5000)
        }),
      { url: 'ws://127.0.0.1:4243/ws' },
    )

    // Wait for the WS open + connection handshake before firing the event
    await page.waitForTimeout(600)
    await page.request.post('/api/review/99/approve')

    const msgs = await msgsPromise
    expect(msgs.some((m) => m.event === 'review.approved')).toBe(true)
  })
})

test.describe('WebSocket — UI integration', () => {
  test('Live Activity Feed shows event badge after task creation', async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    await page.request.post('/api/control/stop')

    await page.request.post('/api/tasks', {
      data: { title: 'Activity feed WS test' },
    })

    // Wait for the WS push to reach the React component (allow up to 10 s)
    // Use .first() — multiple task.queued badges may exist from WS replay
    await expect(
      page.getByText('task.queued').first(),
    ).toBeVisible({ timeout: 10000 })
  })
})
