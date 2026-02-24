import { Skeleton } from '@/components/ui/skeleton'
import { AgentCard } from '@/components/agents/AgentCard'
import { useApi } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { api } from '@/lib/api'

export default function AgentsView() {
  const { data, loading, refresh } = useApi(() => api.agents(), [])
  const agents = data?.agents ?? []

  useWebSocket(
    () => { void refresh() },
    (msg) => msg.event.startsWith('agent.')
  )

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
    )
  }

  if (!agents.length) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed">
        <p className="text-sm text-muted-foreground">No agents registered. Check your agentforge.yml.</p>
      </div>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map(agent => (
        <AgentCard key={agent.id} agent={agent} onUpdated={refresh} />
      ))}
    </div>
  )
}
