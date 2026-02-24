import { useCallback } from 'react'
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
} from '@dnd-kit/core'
import { Skeleton } from '@/components/ui/skeleton'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { AddTaskDialog } from '@/components/kanban/AddTaskDialog'
import { useApi } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { api } from '@/lib/api'
import type { Task } from '@/types/api'

const COLUMNS: { id: Task['status']; title: string }[] = [
  { id: 'queued', title: 'Queued' },
  { id: 'executing', title: 'Executing' },
  { id: 'completed', title: 'Completed' },
  { id: 'failed', title: 'Failed' },
]

export default function KanbanView() {
  const { data, loading, refresh } = useApi(() => api.tasks(), [])
  const tasks = data?.tasks ?? []

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  useWebSocket(
    () => { void refresh() },
    (msg) => msg.event.startsWith('task.')
  )

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const newStatus = over.id as Task['status']
    const task = tasks.find(t => t.id === active.id)
    if (!task || task.status === newStatus) return
    try {
      await api.updateTaskStatus(String(active.id), newStatus)
      void refresh()
    } catch {}
  }, [tasks, refresh])

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {COLUMNS.map(c => <Skeleton key={c.id} className="h-64 w-full" />)}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">{tasks.length} tasks total</h2>
        <AddTaskDialog onCreated={refresh} />
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {COLUMNS.map(col => (
            <KanbanColumn
              key={col.id}
              id={col.id}
              title={col.title}
              tasks={tasks.filter(t => t.status === col.id)}
            />
          ))}
        </div>
      </DndContext>
    </div>
  )
}
