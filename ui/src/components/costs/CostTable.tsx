import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

interface CostTableProps {
  byAgent: Record<string, number>
  byModel: Record<string, number>
}

export function CostTable({ byAgent, byModel }: CostTableProps) {
  const agentRows = Object.entries(byAgent).sort((a, b) => b[1] - a[1])
  const modelRows = Object.entries(byModel).sort((a, b) => b[1] - a[1])

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">By Agent</h3>
        {agentRows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">Cost (USD)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agentRows.map(([id, cost]) => (
                <TableRow key={id}>
                  <TableCell className="font-medium">{id}</TableCell>
                  <TableCell className="text-right tabular-nums">${cost.toFixed(4)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No data.</p>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">By Model</h3>
        {modelRows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Cost (USD)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {modelRows.map(([id, cost]) => (
                <TableRow key={id}>
                  <TableCell className="font-medium text-xs">{id}</TableCell>
                  <TableCell className="text-right tabular-nums">${cost.toFixed(4)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No data.</p>
        )}
      </div>
    </div>
  )
}
