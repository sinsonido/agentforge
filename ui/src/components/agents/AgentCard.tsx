import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EditAgentDialog } from './EditAgentDialog'
import { cn } from '@/lib/utils'
import type { AgentStatus } from '@/types/api'

const STATE_STYLES: Record<string, string> = {
  idle: 'bg-gray-100 text-gray-700',
  assigned: 'bg-yellow-100 text-yellow-800',
  executing: 'bg-blue-100 text-blue-800',
  reviewing: 'bg-purple-100 text-purple-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  paused: 'bg-orange-100 text-orange-800',
}

interface AgentCardProps {
  agent: AgentStatus
  onUpdated: () => void
}

export function AgentCard({ agent, onUpdated }: AgentCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-semibold leading-tight">{agent.name ?? agent.id}</CardTitle>
          <EditAgentDialog agent={agent} onUpdated={onUpdated} />
        </div>
        <p className="text-xs text-muted-foreground font-mono">{agent.id}</p>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">State:</span>
          <Badge className={cn('text-xs', STATE_STYLES[agent.state] ?? 'bg-muted')}>
            {agent.state}
          </Badge>
        </div>
        {agent.currentTaskId && (
          <div>
            <span className="text-xs text-muted-foreground">Task: </span>
            <span className="text-xs font-mono">{agent.currentTaskId}</span>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{agent.historyLength} state transitions</p>
      </CardContent>
    </Card>
  )
}
