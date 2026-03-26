import { useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { NewUserDialog } from '@/components/admin/NewUserDialog'
import { EditUserDialog } from '@/components/admin/EditUserDialog'
import { ResetPasswordDialog } from '@/components/admin/ResetPasswordDialog'
import { DeleteUserDialog } from '@/components/admin/DeleteUserDialog'
import type { AdminUser } from '@/types/api'

// ---------------------------------------------------------------------------
// Permission helper (simplified — no auth context yet, admin panel is always
// accessible for now; wired to real RBAC when auth context is added)
// ---------------------------------------------------------------------------

function hasPermission(_perm: string): boolean {
  // In the current build there is no client-side session; treat everyone as
  // having access so the page renders.  Replace with a real useAuth() hook
  // when client-side session management is implemented.
  return true
}

// ---------------------------------------------------------------------------
// Role badge colours
// ---------------------------------------------------------------------------

const ROLE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  admin: 'default',
  operator: 'secondary',
  viewer: 'outline',
}

function RoleBadge({ role }: { role: AdminUser['role'] }) {
  return (
    <Badge variant={ROLE_VARIANT[role] ?? 'outline'}>
      {role}
    </Badge>
  )
}

// ---------------------------------------------------------------------------
// Last login formatter
// ---------------------------------------------------------------------------

function formatDate(ts?: number): string {
  if (!ts) return 'Never'
  return new Date(ts).toLocaleString()
}

// ---------------------------------------------------------------------------
// Inner view — only rendered when permission check passes
// ---------------------------------------------------------------------------

function UsersTable() {
  const { data, loading, refresh } = useApi(() => api.adminListUsers(), [])
  const users = data?.users ?? []

  async function toggleActive(user: AdminUser) {
    try {
      await api.adminUpdateUser(user.id, { isActive: !user.isActive })
      void refresh()
    } catch (err) {
      console.error('Failed to toggle user active state:', err)
    }
  }

  async function deleteUser(user: AdminUser) {
    try {
      await api.adminDeleteUser(user.id)
      void refresh()
    } catch (err) {
      console.error('Failed to delete user:', err)
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">User Management</h2>
          <p className="text-sm text-muted-foreground">{users.length} user{users.length !== 1 ? 's' : ''}</p>
        </div>
        <NewUserDialog onCreated={() => void refresh()} />
      </div>

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Username</TableHead>
              <TableHead>Display Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last Login</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No users found.
                </TableCell>
              </TableRow>
            ) : (
              users.map(user => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.username}</TableCell>
                  <TableCell>{user.displayName ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell><RoleBadge role={user.role} /></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(user.lastLogin ?? undefined)}</TableCell>
                  <TableCell>
                    <Badge variant={user.isActive ? 'default' : 'outline'}>
                      {user.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <EditUserDialog user={user} onUpdated={() => void refresh()} />
                      <ResetPasswordDialog user={user} onReset={() => void refresh()} />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => { void toggleActive(user) }}
                      >
                        {user.isActive ? 'Deactivate' : 'Activate'}
                      </Button>
                      <DeleteUserDialog
                        user={user}
                        onDelete={deleteUser}
                        onDeleted={() => void refresh()}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// View (exported)
// ---------------------------------------------------------------------------

export default function UsersView() {
  if (!hasPermission('users:write')) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed">
        <p className="text-sm text-muted-foreground">403 — You do not have permission to manage users.</p>
      </div>
    )
  }

  return <UsersTable />
}
