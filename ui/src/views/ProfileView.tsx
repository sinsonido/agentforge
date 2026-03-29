import { useState, FormEvent, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function ProfileView() {
  const { user } = useAuth()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError, setPwError] = useState<string | null>(null)
  const [pwSuccess, setPwSuccess] = useState(false)

  // Scroll to password section if hash is #password
  useEffect(() => {
    if (window.location.hash === '#password') {
      const el = document.getElementById('password-section')
      el?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [])

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault()
    setPwError(null)
    setPwSuccess(false)

    if (newPassword !== confirmPassword) {
      setPwError('New passwords do not match')
      return
    }
    if (newPassword.length < 8) {
      setPwError('New password must be at least 8 characters')
      return
    }

    setPwLoading(true)
    try {
      await api.changePassword({ currentPassword, newPassword })
      setPwSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Failed to change password')
    } finally {
      setPwLoading(false)
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      {/* Profile info */}
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your account information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="profile-username">Username</Label>
            <Input
              id="profile-username"
              value={user?.username ?? ''}
              disabled
              readOnly
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-display-name">
              Display name
            </Label>
            <Input
              id="profile-display-name"
              value={user?.displayName ?? ''}
              disabled
              readOnly
              placeholder="Not set"
            />
            <p className="text-xs text-muted-foreground">Display name editing coming soon.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-role">Role</Label>
            <Input
              id="profile-role"
              value={user?.role ?? ''}
              disabled
              readOnly
            />
          </div>
        </CardContent>
      </Card>

      {/* Change password */}
      <Card id="password-section">
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>Update your account password</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                placeholder="••••••••"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={pwLoading}
                autoComplete="current-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                placeholder="••••••••"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={pwLoading}
                autoComplete="new-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-new-password">Confirm new password</Label>
              <Input
                id="confirm-new-password"
                type="password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={pwLoading}
                autoComplete="new-password"
              />
            </div>

            {pwError && (
              <p className="text-sm text-destructive">{pwError}</p>
            )}

            {pwSuccess && (
              <p className="text-sm text-green-600 dark:text-green-400">Password changed successfully.</p>
            )}

            <Button
              type="submit"
              disabled={pwLoading || !currentPassword || !newPassword || !confirmPassword}
            >
              {pwLoading ? 'Updating…' : 'Update password'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
