import GameAPI from '../api/GameAPI.js'
import config, { setApiBase, setSeatKey, isElectron } from '../config.js'

// Connect screen + lobby + turn banner for networked play. Renders its own overlay
// layer above the game. In solo play (no seat joined) it stays out of the way.
//
// Flow: connect modal → Join (address+name) or Play Solo. After Join, the lobby
// lists seats and exposes Roll Initiative + Start Game. Once started, a banner shows
// whose turn it is and a Pass button when it is yours.
export default class MultiplayerUI {
  constructor(app) {
    this.app = app           // needs: refreshFromServer(), startSolo(), liveSync
    this.root = null
    this.mp = null
    this.setupStep = null
  }

  async mount() {
    this.root = document.createElement('div')
    this.root.id = 'mp-layer'
    this.root.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;font-family:Arial,sans-serif'
    document.body.appendChild(this.root)
    // Resume an in-progress session after an F5 reload: if the stored seat key still
    // resolves to a seat on the (stored) server, skip the connect modal and rejoin.
    if (await this._tryResume()) return
    this._showConnect()
  }

  async _tryResume() {
    if (!config.seatKey) return false
    try {
      const state = await GameAPI.getState()   // sends the stored X-Seat-Key + apiBase
      if (state?.multiplayer?.meSeatId != null) {
        this.app.liveSync?.reconnect()
        await this.app.refreshFromServer()
        return true
      }
    } catch { /* server unreachable — fall through to the connect screen */ }
    return false
  }

  // ── Connect modal ─────────────────────────────────────────────────────────────
  _showConnect() {
    const overlay = this._modal()
    overlay.innerHTML = `
      <h2 style="margin-bottom:14px">Guild Wars</h2>
      <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px">Server address${isElectron ? '' : ' <span style="color:#777">(blank = this machine)</span>'}</label>
      <input id="mp-addr" placeholder="${isElectron ? 'http://host:3001 (required)' : 'http://host:3001'}"
        style="width:100%;padding:8px;margin-bottom:12px;background:#111;border:1px solid #555;color:#fff;border-radius:3px">
      <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px">Your name</label>
      <input id="mp-name" placeholder="e.g. Alice"
        style="width:100%;padding:8px;margin-bottom:16px;background:#111;border:1px solid #555;color:#fff;border-radius:3px">
      <div id="mp-err" style="color:#f77;font-size:12px;min-height:16px;margin-bottom:8px"></div>
      <div style="display:flex;gap:10px">
        <button id="mp-join" style="flex:1;padding:10px;background:#1a6b1a;border:1px solid #4c4;color:#fff;border-radius:3px;cursor:pointer">Join Game</button>
        ${isElectron ? '' : '<button id="mp-solo" style="flex:1;padding:10px;background:#333;border:1px solid #666;color:#fff;border-radius:3px;cursor:pointer">Play Solo</button>'}
      </div>`
    const addr = overlay.querySelector('#mp-addr')
    const name = overlay.querySelector('#mp-name')
    const err  = overlay.querySelector('#mp-err')
    if (config.apiBase) addr.value = config.apiBase
    overlay.querySelector('#mp-solo')?.addEventListener('click', () => this._playSolo())
    overlay.querySelector('#mp-join').addEventListener('click', () => this._join(addr.value, name.value, err))
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._join(addr.value, name.value, err) })
    setTimeout(() => name.focus(), 0)
  }

  async _join(address, name, err) {
    if (!name.trim()) { err.textContent = 'Enter a name to join.'; return }
    if (isElectron && !address.trim()) { err.textContent = 'Enter the host server address.'; return }
    err.textContent = 'Joining…'
    setApiBase(address.trim())          // '' stays same-origin
    try {
      const res = await GameAPI.join(name.trim())
      if (!res.ok) { err.textContent = res.error || 'Join failed.'; return }
      setSeatKey(res.seatKey)
      this.app.liveSync?.reconnect()   // re-point ws at the (possibly remote) apiBase + re-hello
      this._clearModal()
      await this.app.refreshFromServer()
    } catch (e) {
      err.textContent = 'Could not reach server.'
    }
  }

  async _playSolo() {
    const name = document.getElementById('mp-name')?.value.trim() || 'Player'
    const addr = document.getElementById('mp-addr')?.value.trim() || ''
    const err  = this._modal()?.querySelector('#mp-err')
    if (err) err.textContent = 'Starting…'
    setApiBase(addr)
    try {
      const res = await GameAPI.join(name)
      if (!res.ok) { if (err) err.textContent = res.error || 'Join failed.'; return }
      setSeatKey(res.seatKey)
      await GameAPI.request('/lobby/roll-initiative', 'POST')
      await GameAPI.request('/lobby/start', 'POST')
      this.app.liveSync?.reconnect()
      this._clearModal()
      await this.app.refreshFromServer()
    } catch (e) {
      if (err) err.textContent = 'Could not reach server.'
    }
  }

  // ── Lobby + turn banner (driven by update()) ─────────────────────────────────
  update(mp, setupStep) {
    this.mp = mp
    this.setupStep = setupStep
    const joined = !!(mp && mp.meSeatId)
    if (!joined) { this._clearLobby(); this._clearBanner(); return }
    if (!mp.started) { this._clearBanner(); this._renderLobby(mp) }
    else { this._clearLobby(); this._renderBanner(mp, setupStep) }
  }

  _renderLobby(mp) {
    const overlay = this._lobby()
    const seats = mp.seats.map(s =>
      `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #333">
        <span>${this._esc(s.name)}${s.isMe ? ' <span style="color:#4c4">(you)</span>' : ''}${s.connected ? '' : ' <span style="color:#888">·offline</span>'}</span>
        <span style="color:#ccc">${s.initiativeRoll != null ? 'd20: ' + s.initiativeRoll : '—'}</span>
      </div>`).join('')
    const rolled = mp.initiativeOrder.length > 0
    overlay.innerHTML = `
      <h3 style="margin-bottom:10px">Lobby</h3>
      <div style="margin-bottom:12px">${seats}</div>
      <div style="display:flex;gap:10px">
        <button id="mp-roll" style="flex:1;padding:9px;background:#444;border:1px solid #777;color:#fff;border-radius:3px;cursor:pointer">Roll Initiative</button>
        <button id="mp-start" ${rolled ? '' : 'disabled'} style="flex:1;padding:9px;background:${rolled ? '#1a6b1a' : '#222'};border:1px solid ${rolled ? '#4c4' : '#444'};color:#fff;border-radius:3px;cursor:${rolled ? 'pointer' : 'not-allowed'}">Start Game</button>
      </div>
      <div style="font-size:11px;color:#888;margin-top:8px">Any player can roll or start. District Setup runs in reversed initiative.</div>`
    overlay.querySelector('#mp-roll').addEventListener('click', async () => {
      await GameAPI.request('/lobby/roll-initiative', 'POST'); await this.app.refreshFromServer()
    })
    overlay.querySelector('#mp-start').addEventListener('click', async () => {
      await GameAPI.request('/lobby/start', 'POST'); await this.app.refreshFromServer()
    })
  }

  _renderBanner(mp, setupStep) {
    const activeId = mp.activeSeatByStep?.[setupStep] ?? null
    const active = mp.seats.find(s => s.seatId === activeId)
    const mine = activeId != null && activeId === mp.meSeatId
    const banner = this._banner()
    banner.style.background = mine ? '#1a6b1a' : '#333'
    banner.innerHTML = `
      <span style="font-size:13px">${mine ? 'Your turn' : 'Waiting for ' + this._esc(active?.name || '…')}</span>
      ${mine ? '<button id="mp-pass" style="margin-left:12px;padding:5px 12px;background:#000;border:1px solid #4c4;color:#fff;border-radius:3px;cursor:pointer">Pass / End turn</button>' : ''}`
    const passBtn = banner.querySelector('#mp-pass')
    if (passBtn) passBtn.addEventListener('click', async () => {
      await GameAPI.request('/turn/pass', 'POST'); await this.app.refreshFromServer()
    })
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────────
  _modal() {
    this._clearModal()
    const back = document.createElement('div')
    back.id = 'mp-modal'
    back.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;pointer-events:auto'
    const box = document.createElement('div')
    box.style.cssText = 'width:360px;background:#1a1a1a;border:1px solid #555;border-radius:6px;padding:22px;color:#fff'
    back.appendChild(box)
    this.root.appendChild(back)
    return box
  }
  _clearModal() { this.root?.querySelector('#mp-modal')?.remove() }

  _lobby() {
    let el = this.root.querySelector('#mp-lobby')
    if (!el) {
      el = document.createElement('div')
      el.id = 'mp-lobby'
      el.style.cssText = 'position:absolute;right:16px;bottom:16px;width:280px;background:#1a1a1a;border:1px solid #555;border-radius:6px;padding:16px;color:#fff;pointer-events:auto'
      this.root.appendChild(el)
    }
    return el
  }
  _clearLobby() { this.root?.querySelector('#mp-lobby')?.remove() }

  _banner() {
    let el = this.root.querySelector('#mp-banner')
    if (!el) {
      el = document.createElement('div')
      el.id = 'mp-banner'
      el.style.cssText = 'position:absolute;top:90px;left:50%;transform:translateX(-50%);padding:8px 16px;border:1px solid #666;border-radius:20px;color:#fff;pointer-events:auto;display:flex;align-items:center'
      this.root.appendChild(el)
    }
    return el
  }
  _clearBanner() { this.root?.querySelector('#mp-banner')?.remove() }

  _esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }
}
