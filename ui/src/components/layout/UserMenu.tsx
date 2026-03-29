import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { cn } from '@/lib/utils'

function initials(user: { username: string; displayName?: string }): string {
  const name = user.displayName ?? user.username
  return name
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .slice(0, 2)
    .join('')
}

export function UserMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside or pressing Escape
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  // Bypass mode — user is the local sentinel with no real identity
  if (!user || user.id === 'local') {
    return (
      <span className="text-xs text-muted-foreground px-2">Local</span>
    )
  }

  async function handleLogout() {
    setOpen(false)
    await logout()
    // logout() redirects via window.location.href
  }

  return (
    <div ref={ref} className="relative">
      <button
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold',
          'hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        onClick={() => setOpen((v) => !v)}
        aria-label="User menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {initials(user)}
      </button>

      {open && (
        <div
          className="absolute right-0 top-10 z-50 w-48 rounded-md border bg-popover shadow-md"
          role="menu"
          aria-label="User menu"
        >
          <div className="px-3 py-2 border-b">
            <p className="text-sm font-medium truncate">{user.displayName ?? user.username}</p>
            <p className="text-xs text-muted-foreground truncate">@{user.username}</p>
          </div>
          <div className="py-1">
            <Link
              to="/profile"
              role="menuitem"
              className="flex w-full items-center px-3 py-1.5 text-sm hover:bg-accent rounded-sm"
              onClick={() => setOpen(false)}
            >
              Profile
            </Link>
            <Link
              to="/profile#password"
              role="menuitem"
              className="flex w-full items-center px-3 py-1.5 text-sm hover:bg-accent rounded-sm"
              onClick={() => setOpen(false)}
            >
              Change password
            </Link>
          </div>
          <div className="border-t py-1">
            <button
              role="menuitem"
              className="flex w-full items-center px-3 py-1.5 text-sm text-destructive hover:bg-accent rounded-sm"
              onClick={handleLogout}
            >
              Logout
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
