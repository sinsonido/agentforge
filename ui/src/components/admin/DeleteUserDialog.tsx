import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { AdminUser } from '@/types/api'

interface DeleteUserDialogProps {
  user: AdminUser
  onDeleted: () => void
  onDelete: (user: AdminUser) => Promise<void>
}

export function DeleteUserDialog({ user, onDeleted, onDelete }: DeleteUserDialogProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleConfirm() {
    setLoading(true)
    try {
      await onDelete(user)
      setOpen(false)
      onDeleted()
    } catch (err) {
      console.error('Failed to delete user:', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        Delete
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          role="alertdialog"
          aria-labelledby="delete-user-title"
          aria-describedby="delete-user-desc"
        >
          <DialogHeader>
            <DialogTitle id="delete-user-title">Delete user "{user.username}"?</DialogTitle>
            <DialogDescription id="delete-user-desc">
              This action cannot be undone. The user will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirm} disabled={loading}>
              {loading ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
