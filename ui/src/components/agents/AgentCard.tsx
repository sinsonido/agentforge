import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EditAgentDialog } from './EditAgentDialog'
import type { AgentStatus } from '@/types/api'

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
      <CardContent>
        <div>
          <span className="text-xs text-muted-foreground">Model: </span>
          <span className="text-xs font-mono">{agent.model ?? 'routed'}</span>
        </div>
      </CardContent>
    </Card>
  )
}
