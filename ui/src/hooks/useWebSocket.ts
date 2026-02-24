import { useEffect } from 'react'
import { useWebSocketContext } from '@/contexts/WebSocketContext'
import type { WsMessage } from '@/lib/ws'

export function useWebSocket(
  handler: (msg: WsMessage) => void,
  filter?: (msg: WsMessage) => boolean,
) {
  const { subscribe } = useWebSocketContext()

  useEffect(() => {
    return subscribe((msg) => {
      if (!filter || filter(msg)) handler(msg)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe])
}
