import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Task } from '@/types/api'

const PRIORITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-400',
}

interface KanbanCardProps {
  task: Task
}

export function KanbanCard({ task }: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'rounded-lg border bg-card p-3 shadow-sm cursor-grab active:cursor-grabbing',
        isDragging && 'ring-2 ring-primary'
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-1 h-2 w-2 shrink-0 rounded-full',
            PRIORITY_DOT[task.priority ?? 'medium'] ?? 'bg-muted'
          )}
        />
        <p className="flex-1 text-sm font-medium leading-tight line-clamp-2">{task.title}</p>
      </div>
      {(task.agent_id || task.model_used) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.agent_id && (
            <Badge variant="secondary" className="text-xs py-0">{task.agent_id}</Badge>
          )}
          {task.model_used && (
            <Badge variant="outline" className="text-xs py-0">{task.model_used}</Badge>
          )}
        </div>
      )}
    </div>
  )
}
