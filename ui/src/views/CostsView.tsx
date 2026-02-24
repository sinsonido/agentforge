import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { BudgetBars } from '@/components/costs/BudgetBars'
import { CostTable } from '@/components/costs/CostTable'
import { TransactionLog } from '@/components/costs/TransactionLog'
import { SpendChart } from '@/components/costs/SpendChart'
import { useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'

export default function CostsView() {
  const { data, loading } = useApi(() => api.costs(), [])
  const costs = data?.costs

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (!data?.available || !costs) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed">
        <p className="text-sm text-muted-foreground">Cost tracking not available.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Spend</p>
        <p className="mt-1 text-3xl font-bold tabular-nums">${costs.totalCostUSD.toFixed(4)}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Budget Usage</CardTitle>
          </CardHeader>
          <CardContent>
            <BudgetBars budgets={costs.budgets} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Cumulative Spend</CardTitle>
          </CardHeader>
          <CardContent>
            <SpendChart transactions={costs.transactions} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <CostTable byAgent={costs.byAgent} byModel={costs.byModel} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Transaction Log</CardTitle>
        </CardHeader>
        <CardContent>
          <TransactionLog transactions={costs.transactions} />
        </CardContent>
      </Card>
    </div>
  )
}
