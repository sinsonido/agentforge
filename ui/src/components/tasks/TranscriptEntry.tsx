import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { AgentEvent, TaskEvent } from '@/types/api'

type Of<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>

function toolSummary(input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.subject ?? input.url
  return typeof pick === 'string' ? pick : ''
}

function Details({ label, children }: { label: string; children: string }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-muted-foreground">{label}</summary>
      <pre className="mt-1 max-h-80 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">{children}</pre>
    </details>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground break-words">{children}</p>
}

const RENDER: { [K in AgentEvent['type']]: (e: Of<K>) => ReactNode } = {
  init: (e) => <Muted>session started · {e.model}</Muted>,
  text: (e) => <p className="text-sm whitespace-pre-wrap break-words">{e.text}</p>,
  tool_use: (e) => (
    <div>
      <p className="text-sm break-all">
        <span className="font-semibold">{e.name}</span>{' '}
        <code className="text-xs text-muted-foreground">{toolSummary(e.input)}</code>
      </p>
      <Details label="input">{JSON.stringify(e.input, null, 2)}</Details>
    </div>
  ),
  tool_result: (e) => (
    <div>
      <p className="text-xs text-muted-foreground">
        {e.name ?? 'tool'} result{' '}
        {e.isError && <Badge variant="destructive" className="py-0 text-[10px]">error</Badge>}
      </p>
      {e.output && <Details label={`output · ${e.output.split('\n').length} lines`}>{e.output}</Details>}
    </div>
  ),
  harness_task: (e) => <Muted>todo {e.op === 'create' ? `added: ${e.subject ?? e.taskId}` : `${e.taskId} → ${e.status}`}</Muted>,
  rate_limit: (e) => <Muted>rate limit: {e.status}</Muted>,
  result: (e) => (
    <div className={cn('rounded border p-2 text-sm', e.isError ? 'border-red-300' : 'border-green-300')}>
      <p className="font-semibold">Run ended: {e.subtype}</p>
      <Muted>
        {e.numTurns} turns · {e.costUsd != null ? `$${e.costUsd.toFixed(2)}` : 'cost unknown'} · {Math.round(e.durationMs / 1000)}s
      </Muted>
    </div>
  ),
}

export function TranscriptEntry({ entry }: { entry: TaskEvent }) {
  const render = RENDER[entry.event.type] as ((e: AgentEvent) => ReactNode) | undefined
  return (
    <li data-seq={entry.seq} data-type={entry.event.type} className="min-w-0 border-l-2 border-muted pl-3">
      {render ? render(entry.event) : <Muted>{entry.event.type}</Muted>}
    </li>
  )
}
