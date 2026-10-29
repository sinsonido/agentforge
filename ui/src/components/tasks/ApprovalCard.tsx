import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { decideTask, type Approval, type ApprovalChoice } from '@/lib/api'

const ACTION_TITLE: Record<Approval['action'], string> = {
  publish: 'Publish needs your approval',
  merge: 'Merge needs your approval',
}

const since = (at: number) =>
  new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** The pending host action of a task in needs-approval, with Approve and Reject. */
export function ApprovalCard({ taskId, approval, onDecided }: {
  taskId: string
  approval: Approval
  onDecided: () => void | Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<ApprovalChoice | null>(null)
  const [error, setError] = useState<string | null>(null)

  const decide = async (choice: ApprovalChoice) => {
    setBusy(choice)
    setError(null)
    try {
      await decideTask(taskId, choice, reason.trim() || undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      await onDecided()
    }
  }

  return (
    <section data-testid="approval-card" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold">{ACTION_TITLE[approval.action]}</h3>
          <p className="text-sm break-words">{approval.summary}</p>
          <p className="text-xs opacity-75">Waiting since {since(approval.requested_at)}</p>
        </div>
      </div>
      {approval.error && (
        <p data-testid="approval-error" className="text-xs text-red-700 break-words">
          Last attempt failed: {approval.error}
        </p>
      )}
      <Input
        aria-label="Reason (optional)"
        placeholder="Reason (optional)"
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        className="h-11 bg-white"
      />
      <div className="grid grid-cols-2 gap-2">
        <Button variant="destructive" className="h-11" disabled={busy != null} onClick={() => decide('reject')}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </Button>
        <Button className="h-11" disabled={busy != null} onClick={() => decide('approve')}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </Button>
      </div>
      {error && !(approval.error && error.endsWith(approval.error)) && (
        <p className="text-xs text-red-700 break-words">{error}</p>
      )}
    </section>
  )
}
