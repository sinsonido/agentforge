import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { UserPlus } from 'lucide-react'
import { api } from '@/lib/api'

interface NewUserDialogProps {
  onCreated: () => void
}

const ROLES = ['admin', 'operator', 'viewer'] as const

export function NewUserDialog({ onCreated }: NewUserDialogProps) {
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<typeof ROLES[number]>('viewer')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setUsername('')
    setDisplayName('')
    setEmail('')
    setRole('viewer')
    setPassword('')
    setError(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await api.adminCreateUser({
        username,
        email: email || undefined,
        displayName: displayName || undefined,
        role,
        password,
      })
      setOpen(false)
      reset()
      onCreated()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create user'
      setError(msg)
    }
    setLoading(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset() }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <UserPlus className="h-4 w-4" />
          New User
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New User</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div>
            <label className="text-sm font-medium">Username <span className="text-destructive">*</span></label>
            <input
              required
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="e.g. jdoe"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Display Name</label>
            <input
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Jane Doe"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Email</label>
            <input
              type="email"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="jane@example.com"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Role <span className="text-destructive">*</span></label>
            <select
              required
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={role}
              onChange={e => setRole(e.target.value as typeof ROLES[number])}
            >
              {ROLES.map(r => (
                <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Password <span className="text-destructive">*</span></label>
            <input
              required
              type="password"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create User'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
