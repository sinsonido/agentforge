import { useState } from 'react'
import { Copy, Trash2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'
import type { Invitation } from '@/types/api'

const STATUS_VARIANTS: Record<Invitation['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'default',
  accepted: 'secondary',
  expired: 'outline',
  revoked: 'destructive',
}

function formatDate(unix: number) {
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function InviteLink({ token }: { token: string }) {
  const [copied, setCopied] = useState(false)
  const link = `${window.location.origin}/accept-invite?token=${token}`

  function handleCopy() {
    void navigator.clipboard.writeText(link).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleCopy} title="Copy invite link">
      <Copy className="h-3.5 w-3.5" />
      <span className="ml-1 text-xs">{copied ? 'Copied!' : 'Copy link'}</span>
    </Button>
  )
}

interface CreateDialogProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
}

function CreateInviteDialog({ open, onClose, onCreated }: CreateDialogProps) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('viewer')
  const [teamId, setTeamId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await api.createInvitation({ email, role, teamId: teamId || undefined })
      setEmail('')
      setRole('viewer')
      setTeamId('')
      onCreated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invitation')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite User</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">Viewer</SelectItem>
                <SelectItem value="operator">Operator</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="invite-team">Team ID (optional)</Label>
            <Input
              id="invite-team"
              placeholder="team-uuid"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !email}>
              {loading ? 'Sending…' : 'Send Invitation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function InvitationsView() {
  const { data, loading, refresh } = useApi(() => api.listInvitations(), [])
  const invitations = data?.invitations ?? []
  const [showCreate, setShowCreate] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  async function handleRevoke(id: string) {
    setRevoking(id)
    try {
      await api.revokeInvitation(id)
      await refresh()
    } catch (_) {
      // ignore
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Invitations</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Invite User
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : invitations.length === 0 ? (
        <div className="flex h-48 items-center justify-center rounded-xl border border-dashed">
          <p className="text-sm text-muted-foreground">No invitations yet. Click &quot;Invite User&quot; to get started.</p>
        </div>
      ) : (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left font-medium">Email</th>
                <th className="px-4 py-2 text-left font-medium">Role</th>
                <th className="px-4 py-2 text-left font-medium">Team</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Expires</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2">{inv.email}</td>
                  <td className="px-4 py-2 capitalize">{inv.role}</td>
                  <td className="px-4 py-2 text-muted-foreground">{inv.teamId ?? '—'}</td>
                  <td className="px-4 py-2">
                    <Badge variant={STATUS_VARIANTS[inv.status]}>{inv.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{formatDate(inv.expiresAt)}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {inv.status === 'pending' && (
                        <>
                          <InviteLink token={inv.token} />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRevoke(inv.id)}
                            disabled={revoking === inv.id}
                            title="Revoke invitation"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateInviteDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={refresh}
      />
    </div>
  )
}
