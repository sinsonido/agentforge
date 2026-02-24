import { createContext, useContext, useEffect, useState } from 'react'
import { wsManager, type WsMessage } from '@/lib/ws'

type WsStatus = 'connecting' | 'connected' | 'disconnected'

interface WebSocketContextValue {
  status: WsStatus
  subscribe: (fn: (msg: WsMessage) => void) => () => void
}

const WebSocketContext = createContext<WebSocketContextValue>({
  status: 'disconnected',
  subscribe: () => () => {},
})

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<WsStatus>(wsManager.status)

  useEffect(() => {
    wsManager.connect()
    const unsub = wsManager.onStatusChange(setStatus)
    return () => {
      unsub()
      wsManager.disconnect()
    }
  }, [])

  return (
    <WebSocketContext.Provider value={{ status, subscribe: wsManager.subscribe.bind(wsManager) }}>
      {children}
    </WebSocketContext.Provider>
  )
}

export const useWebSocketContext = () => useContext(WebSocketContext)
