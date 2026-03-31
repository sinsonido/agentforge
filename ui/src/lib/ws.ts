import { getToken } from '@/contexts/AuthContext'

export type WsMessage = {
  event: string
  data: unknown
  timestamp: number
}

export type WsListener = (msg: WsMessage) => void

// Module-level callback invoked on 4401 close code (unauthorized)
let onUnauthorized: (() => void) | null = null

export function setWsUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

class WebSocketManager {
  private ws: WebSocket | null = null
  private listeners = new Set<WsListener>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _status: 'connecting' | 'connected' | 'disconnected' = 'disconnected'
  private statusListeners = new Set<(s: typeof this._status) => void>()

  get status() { return this._status }

  private _buildUrl(): string {
    const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    const token = getToken()
    return token ? `${base}?token=${encodeURIComponent(token)}` : base
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return
    this._setStatus('connecting')
    this.ws = new WebSocket(this._buildUrl())
    this.ws.onopen = () => this._setStatus('connected')
    this.ws.onclose = (evt) => {
      if (evt.code === 4401) {
        this._setStatus('disconnected')
        onUnauthorized?.()
        return
      }
      this._setStatus('disconnected')
      this.reconnectTimer = setTimeout(() => this.connect(), 3000)
    }
    this.ws.onerror = () => this.ws?.close()
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WsMessage
        for (const l of this.listeners) l(msg)
      } catch (err) {
        console.warn('[ws] failed to parse message', err)
      }
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
