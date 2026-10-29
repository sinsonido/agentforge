import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ApprovalCard } from '@/components/tasks/ApprovalCard'
import { CiRounds, babysitOf } from '@/components/tasks/CiRounds'
import { TaskTrail } from '@/components/tasks/TaskTrail'
import { TranscriptEntry } from '@/components/tasks/TranscriptEntry'
import { useApi } from '@/hooks/useApi'
import { useTaskTranscript } from '@/hooks/useTaskTranscript'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useWebSocketContext } from '@/contexts/WebSocketContext'
import { api, pendingApproval } from '@/lib/api'
import { concernsTask } from '@/lib/ws'

const CANCELLABLE: string[] = ['queued', 'executing', 'ci-watch', 'fixing']

function TaskDetail({ id }: { id: string }) {
  const { data, error: taskError, loading, refresh } = useApi(() => api.task(id), [id])
  const { events, error: replayError } = useTaskTranscript(id)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const { status } = useWebSocketContext()

  useWebSocket(
    (msg) => { if (concernsTask(msg.data, id)) void refresh() },
    (msg) => msg.event.startsWith('task.') && msg.event !== 'task.agent_event',
  )

  useEffect(() => {
    if (status === 'connected') void refresh()
  }, [status, refresh])

  const loaded = data != null
  useEffect(() => {
    const el = bottom.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => { following.current = entry.isIntersecting })
    observer.observe(el)
    return () => observer.disconnect()
  }, [loaded])

  useEffect(() => {
    if (following.current) bottom.current?.scrollIntoView({ block: 'end' })
  }, [events.length])

  const waiting = data?.task ? pendingApproval(data.task) : null
  const waitingKey = waiting && `${waiting.action}@${waiting.requested_at}`
  const approvalBox = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!waitingKey) return
    following.current = false
    approvalBox.current?.scrollIntoView({ block: 'start' })
  }, [waitingKey])

  const task = data?.task
  if (loading && !task) return <Skeleton className="h-40 w-full" />
  if (!task) return <p className="text-sm text-red-600">{taskError ?? `Task ${id} not found`}</p>

  const coding = task.kind === 'coding' ? task : null
  const babysit = coding && babysitOf(coding)
  const cancel = async () => {
    setCancelling(true)
    setCancelError(null)
    try {
      await api.cancelTask(id)
      await refresh()
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err))
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link to="/kanban" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
        <ArrowLeft className="h-3 w-3" /> Tasks
      </Link>

      <header className="space-y-2">
        <h2 className="text-base font-semibold break-words">{task.title}</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge data-testid="task-status">{task.status}</Badge>
          {coding?.step != null && <Badge variant="outline" data-testid="task-step">step {coding.step}</Badge>}
          {coding && <span className="text-muted-foreground">{coding.repo} · {coding.playbook}{coding.issue != null && ` · #${coding.issue}`}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {coding?.pr_url && (
            <a href={coding.pr_url} target="_blank" rel="noreferrer" data-testid="task-pr"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
              Pull request <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {coding && CANCELLABLE.includes(task.status) && (
            <Button size="sm" variant="destructive" onClick={cancel} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </Button>
          )}
        </div>
        {cancelError && <p className="text-xs text-red-600">{cancelError}</p>}
        {task.result && task.status !== 'pr-opened' && !waiting && (
          <p className="text-xs text-muted-foreground break-words">{task.result}</p>
        )}
      </header>

      {babysit && <CiRounds babysit={babysit} fixing={(task.status as string) === 'fixing'} />}

      {coding && waiting && (
        <div ref={approvalBox} className="scroll-mt-4">
          <ApprovalCard key={waitingKey} taskId={id} approval={waiting} onDecided={refresh} />
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Decision trail</h3>
        <TaskTrail taskId={id} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Transcript</h3>
        {replayError && <p className="text-xs text-red-600">Replay failed: {replayError}</p>}
        {events.length === 0 && <p className="text-sm text-muted-foreground">No agent events yet.</p>}
        {events[0]?.seq > 1 && <p className="text-xs text-muted-foreground">Earlier events were trimmed.</p>}
        <ol data-testid="transcript" className="space-y-3">
          {events.map((e) => <TranscriptEntry key={e.seq} entry={e} />)}
        </ol>
        <div ref={bottom} />
      </section>
    </div>
  )
}

export default function TaskView() {
  const { id = '' } = useParams()
  return <TaskDetail key={id} id={id} />
}
