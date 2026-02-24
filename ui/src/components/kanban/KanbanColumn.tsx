import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { KanbanCard } from './KanbanCard'
import { cn } from '@/lib/utils'
import type { Task } from '@/types/api'

const COLUMN_STYLES: Record<string, string> = {
  queued: 'border-t-gray-400',
  executing: 'border-t-blue-500',
  completed: 'border-t-green-500',
  failed: 'border-t-red-500',
}

interface KanbanColumnProps {
  id: string
  title: string
  tasks: Task[]
}

export function KanbanColumn({ id, title, tasks }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-col rounded-xl border-t-2 bg-muted/30 p-3 min-h-[200px]',
        COLUMN_STYLES[id] ?? 'border-t-muted',
        isOver && 'ring-2 ring-primary/50'
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold capitalize">{title}</span>
        <Badge variant="secondary" className="text-xs">{tasks.length}</Badge>
      </div>

      <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
        <ScrollArea className="flex-1">
          <div className="space-y-2 pr-1">
            {tasks.map(task => (
              <KanbanCard key={task.id} task={task} />
            ))}
            {tasks.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">Drop here</p>
            )}
          </div>
        </ScrollArea>
      </SortableContext>
    </div>
  )
}
