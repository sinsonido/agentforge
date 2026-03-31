/**
 * TeamsView — Admin view for managing teams and their members/projects.
 *
 * Shows all teams in a list. Admin users see create/edit/delete actions.
 * Clicking a team expands it to reveal members (with role) and projects.
 *
 * GitHub issue #100: Teams & multi-project support.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight, Plus, Pencil, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'
import type { Team, TeamMember } from '@/types/api'

// ─── Dialogs ─────────────────────────────────────────────────────────────────

interface NewTeamDialogProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
}

function NewTeamDialog({ open, onClose, onCreated }: NewTeamDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await api.createTeam({ name: name.trim(), description: description.trim() })
      setName('')
      setDescription('')
      onCreated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create team</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="new-team-name">Name</label>
            <input
              id="new-team-name"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Platform Team"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="new-team-desc">Description</label>
            <input
              id="new-team-desc"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface EditTeamDialogProps {
  team: Team
  open: boolean
  onClose: () => void
  onUpdated: () => void
}

function EditTeamDialog({ team, open, onClose, onUpdated }: EditTeamDialogProps) {
  const [name, setName] = useState(team.name)
  const [description, setDescription] = useState(team.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await api.updateTeam(team.id, { name: name.trim(), description: description.trim() })
      onUpdated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit team</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="edit-team-name">Name</label>
            <input
              id="edit-team-name"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="edit-team-desc">Description</label>
            <input
              id="edit-team-desc"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Team row ─────────────────────────────────────────────────────────────────

interface TeamRowProps {
  team: Team
  isAdmin?: boolean
  onRefresh: () => void
}

function TeamRow({ team, isAdmin, onRefresh }: TeamRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Lazy-load full team detail (members + projects) when expanded
  const { data: detail, loading: detailLoading, refresh: refreshDetail } = useApi<{ ok: boolean; team: Team } | null>(
    () => expanded ? api.getTeam(team.id) : Promise.resolve(null),
    [expanded, team.id]
  )

  const members: TeamMember[] = detail?.team?.members ?? []
  const projects: string[] = detail?.team?.projects ?? []

  async function handleDelete() {
    if (!confirm(`Delete team "${team.name}"? This cannot be undone.`)) return
    setDeleting(true)
    try {
      await api.deleteTeam(team.id)
      onRefresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-accent/30">
        <button
          className="shrink-0 text-muted-foreground"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse team' : 'Expand team'}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{team.name}</span>
            <Badge variant="secondary" className="shrink-0">
              <Users className="mr-1 h-3 w-3" />
              {team.member_count ?? 0}
            </Badge>
          </div>
          {team.description && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{team.description}</p>
          )}
        </div>

        {isAdmin && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => setEditOpen(true)}
              aria-label="Edit team"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={handleDelete}
              disabled={deleting}
              aria-label="Delete team"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="ml-7 mt-1 mb-2 rounded-lg border bg-muted/30 p-4 space-y-4">
          {detailLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <>
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Members</h4>
                {members.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No members yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {members.map((m) => (
                      <li key={m.userId} className="flex items-center gap-2 text-sm">
                        <span className="font-mono text-xs text-muted-foreground">{m.userId}</span>
                        <Badge variant={m.role === 'owner' ? 'default' : 'outline'} className="text-xs">
                          {m.role}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Projects</h4>
                {projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No projects assigned.</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {projects.map((p) => (
                      <li key={p}>
                        <Badge variant="outline" className="text-xs font-mono">{p}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {editOpen && (
        <EditTeamDialog
          team={team}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onUpdated={() => { onRefresh(); refreshDetail() }}
        />
      )}
    </>
  )
}

// ─── Admin status helper ─────────────────────────────────────────────────────

/** Derive admin status from session storage. Falls back to false when
 *  localStorage is unavailable (SSR/worker contexts) or no value is set. */
function getIsAdminFromSession(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    const explicitFlag = window.localStorage.getItem('isAdmin')
    if (explicitFlag != null) return explicitFlag === 'true'
    const role = window.localStorage.getItem('userRole')
    return role === 'admin'
  } catch {
    return false
  }
}

// ─── Main view ────────────────────────────────────────────────────────────────

export default function TeamsView() {
  const { data, loading, refresh } = useApi(() => api.listTeams(), [])
  const teams = data?.teams ?? []
  const [newOpen, setNewOpen] = useState(false)

  const isAdmin = getIsAdminFromSession()

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Teams</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage teams and their project access.
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New team
          </Button>
        )}
      </div>

      {teams.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-muted-foreground">No teams yet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Create a team to group users and manage project access.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1">
          {teams.map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              isAdmin={isAdmin}
              onRefresh={refresh}
            />
          ))}
        </div>
      )}

      {newOpen && (
        <NewTeamDialog
          open={newOpen}
          onClose={() => setNewOpen(false)}
          onCreated={refresh}
        />
      )}
    </div>
  )
}
