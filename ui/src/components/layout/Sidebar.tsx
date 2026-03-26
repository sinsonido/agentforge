import { NavLink } from 'react-router-dom'
import { X, LayoutDashboard, Columns2, Bot, Zap, DollarSign, Mail } from 'lucide-react'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { to: '/kanban', label: 'Kanban', Icon: Columns2 },
  { to: '/agents', label: 'Agents', Icon: Bot },
  { to: '/providers', label: 'Providers', Icon: Zap },
  { to: '/costs', label: 'Costs', Icon: DollarSign },
]

const ADMIN_ITEMS = [
  { to: '/admin/invitations', label: 'Invitations', Icon: Mail },
]

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <aside
      className={cn(
        'fixed z-30 flex h-full w-56 flex-col border-r bg-card transition-transform duration-200 lg:relative lg:translate-x-0 lg:transition-none',
        open ? 'translate-x-0' : '-translate-x-full'
      )}
    >
      <div className="flex h-14 items-center justify-between border-b px-4">
        <span className="font-semibold text-sm tracking-wide">AgentForge</span>
        <button
          className="rounded p-1 hover:bg-accent lg:hidden"
          onClick={onClose}
          aria-label="Close sidebar"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}

        <div className="mt-4 px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Admin
        </div>
        {ADMIN_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
