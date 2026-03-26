import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { setUnauthorizedHandler } from '@/lib/api'
import { setWsUnauthorizedHandler } from '@/lib/ws'

interface AuthContextValue {
  token: string | null
  isAuthenticated: boolean
  login: (token: string, remember: boolean) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue>({
  token: null,
  isAuthenticated: false,
  login: async () => {},
  logout: () => {},
})

// Module-level token storage for use outside React tree (e.g. in api.ts)
let _token: string | null = null

export function getToken(): string | null {
  return _token
}

function readStoredToken(): string | null {
  return localStorage.getItem('agentforge_token') ?? sessionStorage.getItem('agentforge_token')
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    const stored = readStoredToken()
    _token = stored
    return stored
  })
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [checking, setChecking] = useState(true)

  const logout = useCallback(() => {
    _token = null
    setToken(null)
    setIsAuthenticated(false)
    localStorage.removeItem('agentforge_token')
    sessionStorage.removeItem('agentforge_token')
    window.location.href = '/login'
  }, [])

  // Register the 401 handler so api.ts can call logout
  useEffect(() => {
    setUnauthorizedHandler(logout)
    setWsUnauthorizedHandler(logout)
  }, [logout])

  // On mount: check if auth is even required (auth_enabled bypass),
  // or restore token from storage.
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch('/api/status')
        if (res.ok) {
          const data = await res.json() as { auth_enabled?: boolean }
          if (data.auth_enabled === false || !Object.prototype.hasOwnProperty.call(data, 'auth_enabled')) {
            // Auth disabled or status returned 200 without a token — bypass login
            _token = token ?? ''
            setIsAuthenticated(true)
            setChecking(false)
            return
          }
        }
      } catch {
        // Network error — fall through to token-based check
      }

      // Auth is enabled; check stored token
      if (token) {
        try {
          const res = await fetch('/api/status', {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (res.ok) {
            _token = token
            setIsAuthenticated(true)
          } else {
            // Stored token is no longer valid
            _token = null
            setToken(null)
            setIsAuthenticated(false)
            localStorage.removeItem('agentforge_token')
            sessionStorage.removeItem('agentforge_token')
          }
        } catch {
          // Network error — keep token, assume authenticated for now
          _token = token
          setIsAuthenticated(true)
        }
      }
      setChecking(false)
    }

    void checkAuth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const login = useCallback(async (newToken: string, remember: boolean) => {
    const res = await fetch('/api/status', {
      headers: newToken ? { Authorization: `Bearer ${newToken}` } : {},
    })
    if (!res.ok) {
      throw new Error('Invalid token')
    }
    _token = newToken
    setToken(newToken)
    setIsAuthenticated(true)
    if (remember) {
      localStorage.setItem('agentforge_token', newToken)
    } else {
      sessionStorage.setItem('agentforge_token', newToken)
    }
  }, [])

  // While we're checking auth state, render nothing (avoids flash of login page)
  if (checking) {
    return null
  }

  return (
    <AuthContext.Provider value={{ token, isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
