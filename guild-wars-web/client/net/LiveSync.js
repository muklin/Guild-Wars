import config from '../config.js'

// Live sync over WebSocket: connects to the server's /ws endpoint, identifies this
// seat, and calls onSync() whenever the server broadcasts a state change. The
// broadcast is a content-free nudge — onSync refetches the per-seat state. Auto-
// reconnects so a dropped host/network heals without a reload.
export default class LiveSync {
  constructor(onSync) {
    this.onSync = onSync
    this.ws = null
    this.closed = false
    this._timer = null
  }

  _wsUrl() {
    // Electron: apiBase is http(s)://host:port. Browser dev: '' → page origin
    // (Vite proxies /ws → :3001).
    const base = config.apiBase || (typeof location !== 'undefined' ? location.origin : 'http://localhost:3001')
    const u = new URL('/ws', base)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return u.toString()
  }

  connect() {
    this.closed = false
    this._open()
  }

  // Re-point the socket at the current apiBase (e.g. after joining a remote server).
  reconnect() {
    clearTimeout(this._timer)
    try { this.ws?.close() } catch { /* noop */ }
    this.closed = false
    this._open()
  }

  _open() {
    let ws
    try {
      ws = new WebSocket(this._wsUrl())
    } catch {
      this._scheduleReconnect()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      if (config.seatKey) ws.send(JSON.stringify({ type: 'hello', seatKey: config.seatKey }))
    })
    ws.addEventListener('message', (ev) => {
      // Discard messages from a socket that has since been superseded by reconnect().
      if (ws !== this.ws) return
      try {
        const m = JSON.parse(ev.data)
        if (m.type === 'sync') this.onSync?.(m.event ?? null)
      } catch { /* ignore malformed frames */ }
    })
    ws.addEventListener('close', () => { if (!this.closed && ws === this.ws) this._scheduleReconnect() })
    ws.addEventListener('error', () => { try { ws.close() } catch { /* noop */ } })
  }

  // Re-send hello (e.g. after a join changes the seat key).
  identify() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && config.seatKey) {
      this.ws.send(JSON.stringify({ type: 'hello', seatKey: config.seatKey }))
    }
  }

  _scheduleReconnect() {
    if (this.closed) return
    clearTimeout(this._timer)
    this._timer = setTimeout(() => this._open(), 1500)
  }

  close() {
    this.closed = true
    clearTimeout(this._timer)
    try { this.ws?.close() } catch { /* noop */ }
  }
}
