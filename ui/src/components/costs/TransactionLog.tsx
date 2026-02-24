import { ScrollArea } from '@/components/ui/scroll-area'
import type { CostTransaction } from '@/types/api'

interface TransactionLogProps {
  transactions: CostTransaction[]
}

export function TransactionLog({ transactions }: TransactionLogProps) {
  if (!transactions.length) return <p className="text-sm text-muted-foreground">No transactions recorded.</p>

  return (
    <ScrollArea className="h-56">
      <div className="space-y-1 pr-2">
        {transactions.slice(0, 100).map((tx, i) => (
          <div key={i} className="flex items-center gap-2 py-1 text-xs border-b last:border-0">
            <span className="w-24 truncate font-medium">{tx.agentId ?? '—'}</span>
            <span className="flex-1 truncate text-muted-foreground">{tx.model ?? '—'}</span>
            <span className="tabular-nums">${(tx.cost ?? 0).toFixed(5)}</span>
            <span className="text-muted-foreground">{tx.tokensIn ?? 0}↑ {tx.tokensOut ?? 0}↓</span>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
