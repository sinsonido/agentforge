import { Menu } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { useWebSocketContext } from '@/contexts/WebSocketContext'
import { cn } from '@/lib/utils'

const ROUTE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/kanban': 'Kanban',
  '/agents': 'Agents',
  '/providers': 'Providers',
  '/costs': 'Costs',
}

interface TopbarProps {
  onMenuClick: () => void
}

export function Topbar({ onMenuClick }: TopbarProps) {
  const location = useLocation()
  const { status } = useWebSocketContext()
  const title = ROUTE_TITLES[location.pathname] ?? 'AgentForge'

  return (
    <header className="flex h-14 items-center gap-4 border-b bg-card px-4">
      <button
        className="rounded p-1 hover:bg-accent lg:hidden"
        onClick={onMenuClick}
        aria-label="Open sidebar"
      >
        <Menu className="h-5 w-5" />
      </button>

      <h1 className="flex-1 text-sm font-semibold">{title}</h1>

      <div className="flex items-center gap-2">
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            status === 'connected' && 'bg-green-500',
            status === 'connecting' && 'bg-yellow-500 animate-pulse',
            status === 'disconnected' && 'bg-red-500'
          )}
        />
        <span className="text-xs text-muted-foreground capitalize">{status}</span>
      </div>
    </header>
  )
}
