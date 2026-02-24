import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface KpiCardProps {
  label: string
  value: string | number | undefined
  sublabel?: string
  loading?: boolean
  className?: string
}

export function KpiCard({ label, value, sublabel, loading, className }: KpiCardProps) {
  return (
    <Card className={cn('p-4', className)}>
      <CardContent className="p-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
        {loading ? (
          <Skeleton className="mt-1 h-8 w-24" />
        ) : (
          <p className="mt-1 text-2xl font-bold tabular-nums">{value ?? '—'}</p>
        )}
        {sublabel && <p className="mt-0.5 text-xs text-muted-foreground">{sublabel}</p>}
      </CardContent>
    </Card>
  )
}
