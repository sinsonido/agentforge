import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { QuotaStatus } from '@/types/api'

const STATE_STYLES: Record<string, string> = {
  available: 'bg-green-100 text-green-800 border-green-200',
  throttled: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  exhausted: 'bg-red-100 text-red-800 border-red-200',
}

interface ProviderCardProps {
  id: string
  quota: QuotaStatus
}

export function ProviderCard({ id, quota }: ProviderCardProps) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  const tokenPct = Math.round((quota.tokens.pct ?? 0) * 100)

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.testProvider(id)
      setTestResult({ ok: r.ok, message: r.ok ? 'Reachable' : (r.error ?? 'Failed') })
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Error' })
    }
    setTesting(false)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <CardTitle className="text-sm font-semibold capitalize">{id}</CardTitle>
          <Badge className={cn('text-xs', STATE_STYLES[quota.state] ?? 'bg-muted')}>
            {quota.state}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Tokens</span>
            <span>{tokenPct}%</span>
          </div>
          <Progress
            value={tokenPct}
            className={cn(
              'h-1.5',
              tokenPct > 80 && '[&>div]:bg-red-500',
              tokenPct > 60 && tokenPct <= 80 && '[&>div]:bg-yellow-500'
            )}
          />
        </div>

        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Requests</span>
          <span className="tabular-nums">
            {quota.requests.used} / {quota.requests.max === Infinity ? '∞' : quota.requests.max}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={testing} onClick={handleTest} className="flex-1">
            {testing ? 'Testing…' : 'Test Connection'}
          </Button>
          {testResult && (
            <span className={cn('text-xs font-medium', testResult.ok ? 'text-green-600' : 'text-red-600')}>
              {testResult.message}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
