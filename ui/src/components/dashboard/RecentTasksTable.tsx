import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { Task } from '@/types/api'

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  executing: 'bg-blue-100 text-blue-800',
  queued: 'bg-gray-100 text-gray-800',
}

interface RecentTasksTableProps {
  tasks: Task[]
}

export function RecentTasksTable({ tasks }: RecentTasksTableProps) {
  if (!tasks.length) return <p className="text-sm text-muted-foreground">No tasks yet.</p>

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tasks.slice(0, 20).map((task) => (
          <TableRow key={task.id}>
            <TableCell className="max-w-[200px] truncate font-medium">{task.title}</TableCell>
            <TableCell>
              <Badge className={cn('text-xs', STATUS_STYLES[task.status] ?? 'bg-muted')}>
                {task.status}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">{task.agent_id ?? '—'}</TableCell>
            <TableCell className="text-right tabular-nums">
              {task.cost != null ? `$${task.cost.toFixed(4)}` : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
