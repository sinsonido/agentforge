import { useState, useEffect, FormEvent } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'

export default function LoginView() {
  const { isAuthenticated, login } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const redirect = searchParams.get('redirect') ?? '/dashboard'
  const successMessage = searchParams.get('message')

  useEffect(() => {
    if (isAuthenticated) {
      navigate(redirect, { replace: true })
    }
  }, [isAuthenticated, navigate, redirect])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await login(username.trim(), password, remember)
      navigate(redirect, { replace: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign in failed'
      setError(msg === 'Invalid username or password' ? msg : 'Sign in failed — check your credentials')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl">AgentForge</CardTitle>
          <CardDescription>Sign in to your account</CardDescription>
        </CardHeader>
        <CardContent>
          {successMessage && (
            <p className="mb-4 text-sm text-green-600 dark:text-green-400">{successMessage}</p>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                type="text"
                placeholder="admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                autoFocus
                autoComplete="username"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                autoComplete="current-password"
              />
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <div className="flex items-center space-x-2">
              <Checkbox
                id="remember"
                checked={remember}
                onCheckedChange={setRemember}
                disabled={loading}
              />
              <Label htmlFor="remember" className="font-normal cursor-pointer">
                Remember me
              </Label>
            </div>

            <Button type="submit" className="w-full" disabled={loading || !username.trim() || !password}>
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            First time?{' '}
            <Link to="/setup" className="underline underline-offset-4 hover:text-foreground">
              Set up your account
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
