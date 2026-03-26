import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { setUnauthorizedHandler } from '@/lib/api'
import { setWsUnauthorizedHandler } from '@/lib/ws'

export interface User {
  id: string
  username: string
  displayName?: string
  role: 'admin' | 'operator' | 'viewer'
  permissions?: string[]
}

interface AuthContextValue {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  login: (username: string, password: string, remember: boolean) => Promise<void>
  logout: () => Promise<void>
  hasPermission: (permission: string) => boolean
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  isAuthenticated: false,
  login: async () => {},
  logout: async () => {},
  hasPermission: () => false,
})

// Module-level token storage for use outside React tree (e.g. in api.ts)
let _token: string | null = null

export function getToken(): string | null {
  return _token
}

function readStoredToken(): string | null {
  return localStorage.getItem('agentforge_token') ?? sessionStorage.getItem('agentforge_token')
}

const BYPASS_USER: User = {
  id: 'local',
  username: 'local',
  role: 'admin',
  permissions: ['*'],
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    const stored = readStoredToken()
    _token = stored
    return stored
  })
  const [user, setUser] = useState<User | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [checking, setChecking] = useState(true)

  const clearAuth = useCallback(() => {
    _token = null
    setToken(null)
    setUser(null)
    setIsAuthenticated(false)
    localStorage.removeItem('agentforge_token')
    sessionStorage.removeItem('agentforge_token')
  }, [])

  const logout = useCallback(async () => {
    // Best-effort call to the logout endpoint
    if (_token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${_token}` },
        })
      } catch {
        // ignore network errors on logout
      }
    }
    clearAuth()
    window.location.href = '/login'
  }, [clearAuth])

  // Register the 401 handler so api.ts can call logout
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearAuth()
      window.location.href = '/login'
    })
    setWsUnauthorizedHandler(() => {
      clearAuth()
      window.location.href = '/login'
    })
  }, [clearAuth])

  // On mount: detect auth bypass or restore + validate stored token
  useEffect(() => {
    async function checkAuth() {
      try {
        // First check /api/status without a token to detect bypass mode
        const statusRes = await fetch('/api/status')
        if (statusRes.ok) {
          const data = await statusRes.json() as { auth_enabled?: boolean }
          if (data.auth_enabled === false || !Object.prototype.hasOwnProperty.call(data, 'auth_enabled')) {
            // Auth disabled — bypass login with sentinel user
            _token = token ?? ''
            setIsAuthenticated(true)
            setUser(BYPASS_USER)
            setChecking(false)
            return
          }
        }
      } catch {
        // Network error — fall through to token-based check
      }

      // Auth is enabled; try to validate stored token via /api/auth/me
      if (token) {
        try {
          const meRes = await fetch('/api/auth/me', {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (meRes.ok) {
            const data = await meRes.json() as { ok: boolean; user: User }
            _token = token
            setUser(data.user)
            setIsAuthenticated(true)
          } else if (meRes.status === 401) {
            // Token expired or invalid
            _token = null
            setToken(null)
            localStorage.removeItem('agentforge_token')
            sessionStorage.removeItem('agentforge_token')
          } else {
            // Other error — keep token, assume authenticated for now
            _token = token
            setIsAuthenticated(true)
          }
        } catch {
          // Network error — keep token, assume authenticated
          _token = token
          setIsAuthenticated(true)
        }
      }
      setChecking(false)
    }

    void checkAuth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const login = useCallback(async (username: string, password: string, remember: boolean) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (res.status === 401) {
      throw new Error('Invalid username or password')
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error((err as { error?: string }).error ?? res.statusText)
    }
    const data = await res.json() as { ok: boolean; token: string; user: User }
    const newToken = data.token
    _token = newToken
    setToken(newToken)
    setUser(data.user)
    setIsAuthenticated(true)
    if (remember) {
      localStorage.setItem('agentforge_token', newToken)
    } else {
      sessionStorage.setItem('agentforge_token', newToken)
    }
  }, [])

  const hasPermission = useCallback((permission: string): boolean => {
    if (!user) return false
    const perms = user.permissions ?? []
    return perms.includes('*') || perms.includes(permission)
  }, [user])

  // While checking auth state, render nothing to avoid flash of login page
  if (checking) {
    return null
  }

  return (
    <AuthContext.Provider value={{ user, token, isAuthenticated, login, logout, hasPermission }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
