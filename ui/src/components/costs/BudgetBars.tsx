import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

interface BudgetEntry {
  budget: number
  spent: number
}

interface BudgetBarsProps {
  budgets: Record<string, BudgetEntry>
}

export function BudgetBars({ budgets }: BudgetBarsProps) {
  const entries = Object.entries(budgets)
  if (!entries.length) return <p className="text-sm text-muted-foreground">No budget configured.</p>

  return (
    <div className="space-y-4">
      {entries.map(([project, { budget, spent }]) => {
        const pct = budget > 0 ? Math.min(Math.round((spent / budget) * 100), 100) : 0
        return (
          <div key={project} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{project}</span>
              <span className="tabular-nums text-muted-foreground">
                ${spent.toFixed(4)} / ${budget.toFixed(2)}
              </span>
            </div>
            <Progress
              value={pct}
              className={cn(
                'h-2',
                pct > 90 && '[&>div]:bg-red-500',
                pct > 70 && pct <= 90 && '[&>div]:bg-yellow-500'
              )}
            />
            <p className="text-xs text-muted-foreground text-right">{pct}% used</p>
          </div>
        )
      })}
    </div>
  )
}
