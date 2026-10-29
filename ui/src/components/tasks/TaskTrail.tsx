import { Badge } from '@/components/ui/badge'
import { useApi } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { taskTrail, type TrailEntry, type TrailKind } from '@/lib/api'
import { cn } from '@/lib/utils'

const KIND_STYLES: Record<TrailKind, string> = {
  status: 'bg-gray-100 text-gray-800',
  step: 'bg-blue-100 text-blue-800',
  gate: 'bg-amber-100 text-amber-800',
  decision: 'bg-purple-100 text-purple-800',
  evidence: 'bg-green-100 text-green-800',
}

const DECISION_FIELDS = ['why', 'evidence', 'result'] as const

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function Detail({ entry }: { entry: TrailEntry }) {
  const e = entry.evidence ?? {}
  if (entry.kind === 'decision') {
    const rows = DECISION_FIELDS.filter((k) => typeof e[k] === 'string')
    if (!rows.length && typeof e.phase !== 'string') return null
    return (
      <dl className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {typeof e.phase === 'string' && <div>phase: {e.phase}</div>}
        {rows.map((k) => (
          <div key={k} className="break-words">
            <span className="font-medium">{k}:</span> {String(e[k])}
          </div>
        ))}
      </dl>
    )
  }
  if (entry.kind === 'evidence' && typeof e.url === 'string') {
    return (
      <a href={e.url} target="_blank" rel="noreferrer" className="mt-1 block break-all text-xs text-primary underline">
        {e.url}
      </a>
    )
  }
  return null
}

function Gates({ gates }: { gates: TrailEntry[] }) {
  return (
    <ul className="space-y-1">
      {gates.map((g) => {
        const pass = g.evidence?.pass === true
        return (
          <li key={g.seq} className="flex items-start gap-2 text-sm">
            <Badge className={cn('shrink-0 text-xs', pass ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800')}>
              {pass ? 'pass' : 'fail'}
            </Badge>
            <span className="min-w-0 break-words">{g.summary.replace(/^(pass|fail) /, '')}</span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The decision trail of one task: the evidence gate's checks on top, then every
 * entry in order. Refreshes when the task changes status over the WebSocket.
 */
export function TaskTrail({ taskId }: { taskId: string }) {
  const { data, loading, error, refresh } = useApi(() => taskTrail(taskId), [taskId])

  useWebSocket(
    () => { void refresh() },
    (msg) => msg.event.startsWith('task.') && (msg.data as { task?: { id?: string } } | null)?.task?.id === taskId,
  )

  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading trail…</p>
  if (error) return <p className="text-sm text-destructive">Could not load the trail: {error}</p>

  const trail = data?.trail ?? []
  if (!trail.length) return <p className="text-sm text-muted-foreground">No trail yet.</p>
  const gates = trail.filter((e) => e.kind === 'gate')

  return (
    <section aria-label="Decision trail" className="space-y-4">
      {gates.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Evidence gate</h3>
          <Gates gates={gates} />
        </div>
      )}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Trail</h3>
        <ol className="space-y-2">
          {trail.map((entry) => (
            <li key={entry.seq} data-kind={entry.kind} className="rounded-md border p-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="tabular-nums text-muted-foreground">{time(entry.at)}</span>
                <span className={cn('rounded px-1.5 py-0.5 font-medium', KIND_STYLES[entry.kind])}>{entry.kind}</span>
              </div>
              <p className="mt-1 break-words text-sm">{entry.summary}</p>
              <Detail entry={entry} />
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
