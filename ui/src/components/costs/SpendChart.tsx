import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { CostTransaction } from '@/types/api'

interface SpendChartProps {
  transactions: CostTransaction[]
}

export function SpendChart({ transactions }: SpendChartProps) {
  if (!transactions.length) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed">
        <p className="text-sm text-muted-foreground">No spend data yet.</p>
      </div>
    )
  }

  let cumulative = 0
  const data = transactions.slice(-50).map((tx, i) => {
    cumulative += tx.cost ?? 0
    return { i: i + 1, spend: parseFloat(cumulative.toFixed(5)) }
  })

  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="hsl(240 5.9% 10%)" stopOpacity={0.15} />
              <stop offset="95%" stopColor="hsl(240 5.9% 10%)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="i" hide />
          <YAxis
            tickFormatter={(v: number) => `$${v.toFixed(3)}`}
            tick={{ fontSize: 10 }}
            width={50}
          />
          <Tooltip
            formatter={(v: number) => [`$${v.toFixed(5)}`, 'Cumulative']}
            contentStyle={{ fontSize: 12 }}
          />
          <Area
            type="monotone"
            dataKey="spend"
            stroke="hsl(240 5.9% 10%)"
            strokeWidth={1.5}
            fill="url(#spendGrad)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
