import type { TaskEvent } from '@/types/api'

/**
 * A task's agent transcript as the browser holds it.
 *
 * `events` is sorted by seq with no duplicates. `cursor` is the highest seq up to
 * which the browser has everything the server still stores, so a replay asks for
 * `after=cursor` and nothing before it is ever fetched twice.
 */
export interface Transcript {
  events: TaskEvent[]
  cursor: number
}

export const EMPTY_TRANSCRIPT: Transcript = { events: [], cursor: 0 }

function merge(events: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  for (const e of incoming) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function advance(events: TaskEvent[], cursor: number): number {
  const seqs = new Set(events.map((e) => e.seq))
  while (seqs.has(cursor + 1)) cursor += 1
  return cursor
}

/**
 * A live event from the WebSocket. `gap` says events between the cursor and this
 * one are missing, so the caller should replay after the cursor.
 */
export function receive(t: Transcript, event: TaskEvent): { transcript: Transcript; gap: boolean } {
  if (event.seq <= t.cursor) return { transcript: t, gap: false }
  const events = merge(t.events, [event])
  const cursor = advance(events, t.cursor)
  return { transcript: { events, cursor }, gap: cursor < event.seq }
}

/**
 * A replay page fetched with `after=t.cursor`. The server has nothing between the
 * cursor and the page's last seq that the page lacks (older events may have been
 * pruned), so the cursor moves to at least that seq.
 */
export function applyPage(t: Transcript, page: TaskEvent[]): Transcript {
  const events = merge(t.events, page)
  const last = page.length ? page[page.length - 1].seq : t.cursor
  return { events, cursor: advance(events, Math.max(t.cursor, last)) }
}
