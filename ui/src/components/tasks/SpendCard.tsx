import { Progress } from '@/components/ui/progress'
import { useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { SpendLimit, SpendPhase } from '@/types/api'

const PHASES: Array<{ phase: SpendPhase; label: string }> = [
  { phase: 'build', label: 'Build' },
  { phase: 'verify', label: 'Verify' },
]

const usd = (n: number) => `$${n.toFixed(2)}`

function LimitBar({ limit }: { limit: SpendLimit }) {
  const pct = limit.limit > 0 ? Math.min(Math.round((limit.spent / limit.limit) * 100), 100) : 100
  return (
    <div className="space-y-1" data-testid={`spend-limit-${limit.phase}-${limit.scope}`}>
      <div className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span>{limit.scope === 'task' ? 'Task limit' : 'Repo window'}</span>
        <span className="tabular-nums">{usd(limit.spent)} of {usd(limit.limit)}</span>
      </div>
      <Progress value={pct} className={cn('h-1.5', pct >= 90 && '[&>div]:bg-red-500', pct >= 70 && pct < 90 && '[&>div]:bg-yellow-500')} />
    </div>
  )
}

/**
 * A coding task's build and verification spend, each against the limits that
 * apply to it. `version` changes whenever the task does, so the card refetches.
 */
export function SpendCard({ taskId, version }: { taskId: string; version: string }) {
  const { data, error } = useApi(() => api.taskSpend(taskId), [taskId, version])
  const spend = data?.spend
  if (error) return <p className="text-xs text-red-600">Spend unavailable: {error}</p>
  if (!spend) return null
  return (
    <section data-testid="spend-card" className="space-y-3 rounded-lg border p-3">
      <h3 className="text-sm font-semibold">Spend</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {PHASES.map(({ phase, label }) => (
          <div key={phase} className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm">{label}</span>
              <span data-testid={`spend-${phase}`} className="text-sm font-medium tabular-nums">{usd(spend[phase].spent)}</span>
            </div>
            {spend[phase].limits.length === 0
              ? <p className="text-xs text-muted-foreground">No limit</p>
              : spend[phase].limits.map((l) => <LimitBar key={l.scope} limit={l} />)}
          </div>
        ))}
      </div>
    </section>
  )
}
