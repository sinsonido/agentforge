export type WsMessage = {
  event: string
  data: unknown
  timestamp: number
}

export type WsListener = (msg: WsMessage) => void

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

class WebSocketManager {
  private ws: WebSocket | null = null
  private listeners = new Set<WsListener>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _status: 'connecting' | 'connected' | 'disconnected' = 'disconnected'
  private statusListeners = new Set<(s: typeof this._status) => void>()

  get status() { return this._status }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return
    this._setStatus('connecting')
    this.ws = new WebSocket(WS_URL)
    this.ws.onopen = () => this._setStatus('connected')
    this.ws.onclose = () => {
      this._setStatus('disconnected')
      this.reconnectTimer = setTimeout(() => this.connect(), 3000)
    }
    this.ws.onerror = () => this.ws?.close()
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WsMessage
        for (const l of this.listeners) l(msg)
      } catch {}
    }
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  subscribe(fn: WsListener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onStatusChange(fn: (s: typeof this._status) => void) {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  private _setStatus(s: typeof this._status) {
    this._status = s
    for (const l of this.statusListeners) l(s)
  }
}

export const wsManager = new WebSocketManager()
