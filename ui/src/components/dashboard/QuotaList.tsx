import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { QuotaStatus } from '@/types/api'

interface QuotaListProps {
  quotas: Record<string, QuotaStatus>
}

export function QuotaList({ quotas }: QuotaListProps) {
  const entries = Object.entries(quotas)
  if (!entries.length) return <p className="text-sm text-muted-foreground">No providers configured.</p>

  return (
    <div className="space-y-3">
      {entries.map(([id, q]) => {
        const pct = Math.round((q.tokens.pct ?? 0) * 100)
        return (
          <div key={id} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{id}</span>
              <Badge
                variant={q.state === 'available' ? 'secondary' : 'destructive'}
                className={cn(q.state === 'available' && 'bg-green-100 text-green-800 border-green-200')}
              >
                {q.state}
              </Badge>
            </div>
            <Progress
              value={pct}
              className={cn(
                'h-1.5',
                pct > 80 && '[&>div]:bg-red-500',
                pct > 60 && pct <= 80 && '[&>div]:bg-yellow-500'
              )}
            />
            <p className="text-xs text-muted-foreground">
              {q.requests.used}/{q.requests.max === Infinity ? '∞' : q.requests.max} req · {pct}% tokens
            </p>
          </div>
        )
      })}
    </div>
  )
}
