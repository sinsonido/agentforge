import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'

interface InviteDetails {
  email: string
  role: string
  teamId: string | null
}

export default function AcceptInviteView() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') ?? ''

  const [invite, setInvite] = useState<InviteDetails | null>(null)
  const [validating, setValidating] = useState(true)
  const [validationError, setValidationError] = useState<string | null>(null)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Validate token on mount
  useEffect(() => {
    // Reset state when token changes
    setInvite(null)
    setValidationError(null)
    setValidating(true)

    if (!token) {
      setValidationError('No invitation token provided.')
      setValidating(false)
      return
    }
    api.validateInvitation(token)
      .then((res) => {
        setInvite(res.invitation)
      })
      .catch((err) => {
        setValidationError(err instanceof Error ? err.message : 'Invalid or expired invitation.')
      })
      .finally(() => setValidating(false))
  }, [token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)

    if (password !== confirm) {
      setSubmitError('Passwords do not match.')
      return
    }
    if (password.length < 8) {
      setSubmitError('Password must be at least 8 characters.')
      return
    }

    setSubmitting(true)
    try {
      await api.acceptInvitation({ token, username, password })
      navigate('/login', { replace: true })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create account.')
    } finally {
      setSubmitting(false)
    }
  }

  if (validating) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Validating invitation…</p>
      </div>
    )
  }

  if (validationError) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-sm space-y-4 text-center">
          <p className="text-sm text-destructive">{validationError}</p>
          <Button variant="outline" onClick={() => navigate('/')}>Back to home</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-8 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Accept Invitation</h1>
          <p className="text-sm text-muted-foreground">
            You&apos;ve been invited to join AgentForge as <span className="font-medium capitalize">{invite?.role}</span>.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="accept-email">Email</Label>
            <Input
              id="accept-email"
              type="email"
              value={invite?.email ?? ''}
              readOnly
              className="bg-muted cursor-not-allowed"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="accept-username">Username</Label>
            <Input
              id="accept-username"
              type="text"
              placeholder="Choose a username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              autoComplete="username"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="accept-password">Password</Label>
            <Input
              id="accept-password"
              type="password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="accept-confirm">Confirm Password</Label>
            <Input
              id="accept-confirm"
              type="password"
              placeholder="Re-enter your password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>

          {submitError && <p className="text-sm text-destructive">{submitError}</p>}

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !username || !password || !confirm}
          >
            {submitting ? 'Creating account…' : 'Create Account'}
          </Button>
        </form>
      </div>
    </div>
  )
}
