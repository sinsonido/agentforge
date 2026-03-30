import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Pencil } from 'lucide-react'
import { api } from '@/lib/api'
import type { AdminUser } from '@/types/api'

interface EditUserDialogProps {
  user: AdminUser
  onUpdated: () => void
}

const ROLES = ['admin', 'operator', 'viewer'] as const

export function EditUserDialog({ user, onUpdated }: EditUserDialogProps) {
  const [open, setOpen] = useState(false)
  const [displayName, setDisplayName] = useState(user.displayName ?? '')
  const [role, setRole] = useState<typeof ROLES[number]>(user.role)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function syncFromUser() {
    setDisplayName(user.displayName ?? '')
    setRole(user.role)
    setError(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await api.adminUpdateUser(user.id, {
        displayName: displayName || undefined,
        role,
      })
      setOpen(false)
      onUpdated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user')
    }
    setLoading(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) syncFromUser() }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit user">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit User: {user.username}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div>
            <label className="text-sm font-medium">Display Name</label>
            <input
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Full name"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Role</label>
            <select
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={role}
              onChange={e => setRole(e.target.value as typeof ROLES[number])}
            >
              {ROLES.map(r => (
                <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
