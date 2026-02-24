import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { OrchestratorBar } from '@/components/dashboard/OrchestratorBar'
import { QuotaList } from '@/components/dashboard/QuotaList'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { RecentTasksTable } from '@/components/dashboard/RecentTasksTable'
import { useApi } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { api } from '@/lib/api'

export default function DashboardView() {
  const { data: statusData, loading: statusLoading, refresh: refreshStatus } = useApi(() => api.status(), [])
  const { data: tasksData, loading: tasksLoading, refresh: refreshTasks } = useApi(() => api.tasks(), [])
  const { data: eventsData } = useApi(() => api.events(50), [])

  useWebSocket(
    () => { void refreshStatus(); void refreshTasks() },
    (msg) => ['task.completed', 'task.failed', 'task.executing', 'task.queued'].includes(msg.event)
  )

  const status = statusData
  const tasks = tasksData?.tasks ?? []
  const events = eventsData?.events ?? []

  return (
    <div className="space-y-6">
      {statusLoading ? (
        <Skeleton className="h-14 w-full" />
      ) : (
        <OrchestratorBar
          running={status?.orchestrator?.running ?? false}
          onRefresh={refreshStatus}
        />
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Queued" value={status?.tasks?.queued} loading={statusLoading} />
        <KpiCard label="Executing" value={status?.tasks?.executing} loading={statusLoading} />
        <KpiCard label="Completed" value={status?.tasks?.completed} loading={statusLoading} />
        <KpiCard label="Failed" value={status?.tasks?.failed} loading={statusLoading} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Provider Quotas</CardTitle>
          </CardHeader>
          <CardContent>
            {statusLoading ? <Skeleton className="h-24 w-full" /> : (
              <QuotaList quotas={status?.quotas ?? {}} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Live Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityFeed initialEvents={events} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Recent Tasks</CardTitle>
        </CardHeader>
        <CardContent>
          {tasksLoading ? <Skeleton className="h-32 w-full" /> : (
            <RecentTasksTable tasks={tasks} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
