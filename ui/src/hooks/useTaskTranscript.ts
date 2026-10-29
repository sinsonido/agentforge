import { useCallback, useEffect, useRef, useState } from 'react'
import { useWebSocketContext } from '@/contexts/WebSocketContext'
import { api } from '@/lib/api'
import { EMPTY_TRANSCRIPT, applyPage, receive, type Transcript } from '@/lib/transcript'
import type { TaskEvent } from '@/types/api'

/**
 * The live transcript of one task. Replays from the server on mount, on every
 * WebSocket (re)connect and whenever a live event shows a gap; live events in
 * between are merged by seq, so nothing shows twice and nothing is skipped.
 * Mount it under a `key` of the task id: it does not reset when `taskId` changes.
 */
export function useTaskTranscript(taskId: string) {
  const { status, subscribe } = useWebSocketContext()
  const ref = useRef<Transcript>(EMPTY_TRANSCRIPT)
  const [transcript, setTranscript] = useState<Transcript>(EMPTY_TRANSCRIPT)
  const [error, setError] = useState<string | null>(null)
  const replay = useRef({ running: false, again: false })

  const update = useCallback((next: Transcript) => {
    ref.current = next
    setTranscript(next)
  }, [])

  const catchUp = useCallback(async () => {
    if (replay.current.running) {
      replay.current.again = true
      return
    }
    replay.current.running = true
    try {
      do {
        replay.current.again = false
        let more = true
        while (more) {
          const page = await api.taskEvents(taskId, ref.current.cursor)
          update(applyPage(ref.current, page.events))
          more = page.more
        }
      } while (replay.current.again)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      replay.current.running = false
    }
  }, [taskId, update])

  useEffect(() => {
    if (status === 'connected') void catchUp()
  }, [status, catchUp])

  useEffect(() => {
    void catchUp()
    return subscribe((msg) => {
      if (msg.event !== 'task.agent_event') return
      const { taskId: id, ...entry } = msg.data as TaskEvent & { taskId: string }
      if (id !== taskId || typeof entry.seq !== 'number') return
      const { transcript: next, gap } = receive(ref.current, entry)
      update(next)
      if (gap) void catchUp()
    })
  }, [taskId, subscribe, catchUp, update])

  return { events: transcript.events, error }
}
