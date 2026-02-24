import { useEffect, useRef, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useWebSocket } from '@/hooks/useWebSocket'
import type { ApiEvent } from '@/types/api'

const EVENT_COLORS: Record<string, string> = {
  'task.completed': 'bg-green-100 text-green-800',
  'task.failed': 'bg-red-100 text-red-800',
  'task.executing': 'bg-blue-100 text-blue-800',
  'task.queued': 'bg-gray-100 text-gray-800',
  'cost.recorded': 'bg-purple-100 text-purple-800',
  'agent.assigned': 'bg-yellow-100 text-yellow-800',
}

interface ActivityFeedProps {
  initialEvents?: ApiEvent[]
}

export function ActivityFeed({ initialEvents = [] }: ActivityFeedProps) {
  const [events, setEvents] = useState<ApiEvent[]>(initialEvents.slice(0, 50))
  const bottomRef = useRef<HTMLDivElement>(null)

  useWebSocket((msg) => {
    setEvents(prev => [
      { id: Date.now(), event: msg.event, data: msg.data, timestamp: msg.timestamp },
      ...prev.slice(0, 49),
    ])
  })

  useEffect(() => {
    setEvents(initialEvents.slice(0, 50))
  }, [initialEvents])

  return (
    <ScrollArea className="h-64">
      <div className="space-y-1 pr-2">
        {events.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">Waiting for events…</p>
        )}
        {events.map((e, i) => (
          <div key={e.id ?? i} className="flex items-start gap-2 py-1 text-xs">
            <span className="shrink-0 text-muted-foreground w-[75px]">
              {new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${EVENT_COLORS[e.event] ?? 'bg-muted text-muted-foreground'}`}>
              {e.event}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
