import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

interface OrchestratorBarProps {
  running: boolean
  onRefresh: () => void
}

export function OrchestratorBar({ running, onRefresh }: OrchestratorBarProps) {
  const [loading, setLoading] = useState(false)

  async function toggle() {
    setLoading(true)
    try {
      running ? await api.controlStop() : await api.controlStart()
      onRefresh()
    } catch {}
    setLoading(false)
  }

  return (
    <div className="flex items-center justify-between rounded-lg border bg-card p-3">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Orchestrator</span>
        <Badge variant={running ? 'default' : 'secondary'}>
          {running ? 'Running' : 'Stopped'}
        </Badge>
      </div>
      <Button
        size="sm"
        variant={running ? 'destructive' : 'default'}
        disabled={loading}
        onClick={toggle}
      >
        {loading ? '…' : running ? 'Stop' : 'Start'}
      </Button>
    </div>
  )
}
