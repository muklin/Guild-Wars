import GameAPI from '../api/GameAPI.js'
import config, { setApiBase, setSeatKey, isElectron } from '../config.js'
import Settings from '../settings.js'

// Connect screen + lobby + turn banner for networked play. Renders its own overlay
// layer above the game. In solo play (no seat joined) it stays out of the way.
//
// The connect modal doubles as the in-game system menu (recalled with Escape):
//   – Before joining: shows server address, name, Join/Solo (not dismissable).
//   – After joining:  shows player name, New Game, Settings (dismissable via × or Escape).
export default class MultiplayerUI {
  constructor(app) {
    this.app = app           // needs: refreshFromServer(), startSolo(), liveSync, eventBus
    this.root = null
    this.mp = null
    this.setupStep = null
    this._joined = false
  }

  async mount() {
    this.root = document.createElement('div')
    this.root.id = 'mp-layer'
    // z-index 100 keeps this layer above phase splash (80), ViewStack windows (50+),
    // tutorial window (60), and all other UI.
    this.root.style.cssText = 'position:fixed;inset:0;z-index:100;pointer-events:none;font-family:Arial,sans-serif'
    document.body.appendChild(this.root)

    // Escape: toggle in-game menu when joined; do nothing when on connect screen.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (!this._joined) return
      if (this._modalOpen()) {
        this._clearModal()
      } else {
        this._showIngameMenu()
      }
    })

    if (await this._tryResume()) return
    this._showConnect()
  }

  async _tryResume() {
    if (!config.seatKey) return false
    try {
      const state = await GameAPI.getState()
      if (state?.multiplayer?.meSeatId != null) {
        this._joined = true
        this.app.liveSync?.reconnect()
        await this.app.refreshFromServer()
        return true
      }
    } catch { /* server unreachable — fall through */ }
    return false
  }

  // ── Connect modal ─────────────────────────────────────────────────────────────
  _showConnect() {
    const box = this._modal(false)
    box.innerHTML = `
      <h2 style="margin:0 0 16px 0">Guild Wars</h2>
      <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px">Server address${isElectron ? '' : ' <span style="color:#777">(blank = this machine)</span>'}</label>
      <input id="mp-addr" placeholder="${isElectron ? 'http://host:3001 (required)' : 'http://host:3001'}"
        style="width:100%;padding:8px;margin-bottom:12px;background:#111;border:1px solid #555;color:#fff;border-radius:3px;box-sizing:border-box">
      <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px">Your name</label>
      <input id="mp-name" placeholder="e.g. Alice"
        style="width:100%;padding:8px;margin-bottom:12px;background:#111;border:1px solid #555;color:#fff;border-radius:3px;box-sizing:border-box">
      <div id="mp-err" style="color:#f77;font-size:12px;min-height:16px;margin-bottom:8px"></div>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        <button id="mp-join" style="flex:1;padding:10px;background:#1a6b1a;border:1px solid #4c4;color:#fff;border-radius:3px;cursor:pointer">Join Game</button>
        ${isElectron ? '' : '<button id="mp-solo" style="flex:1;padding:10px;background:#333;border:1px solid #666;color:#fff;border-radius:3px;cursor:pointer">Play Solo</button>'}
      </div>`
    this._appendSettings(box)

    const addr = box.querySelector('#mp-addr')
    const name = box.querySelector('#mp-name')
    const err  = box.querySelector('#mp-err')
    if (config.apiBase) addr.value = config.apiBase
    box.querySelector('#mp-solo')?.addEventListener('click', () => this._playSolo())
    box.querySelector('#mp-join').addEventListener('click', () => this._join(addr.value, name.value, err))
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._join(addr.value, name.value, err) })
    setTimeout(() => name.focus(), 0)
  }

  // In-game system menu — recalled by Escape after joining.
  _showIngameMenu() {
    const box = this._modal(true)
    const playerName = this.app.uiManager?._playerName || ''

    const title = document.createElement('h2')
    title.textContent = 'Guild Wars'
    title.style.cssText = 'margin:0 0 16px 0'
    box.appendChild(title)

    if (playerName) {
      const nameRow = document.createElement('div')
      nameRow.style.cssText = 'margin-bottom:16px;font-size:13px;color:#aaa'
      nameRow.innerHTML = `Player: <strong style="color:#fff">${this._esc(playerName)}</strong>`
      box.appendChild(nameRow)
    }

    const newGameBtn = document.createElement('button')
    newGameBtn.textContent = 'New Game'
    newGameBtn.style.cssText = 'display:block;width:100%;padding:10px;margin-bottom:10px;background:#2a2a2a;color:#e55;border:1px solid #633;border-radius:4px;cursor:pointer;font-size:13px;text-align:left;box-sizing:border-box'
    newGameBtn.addEventListener('click', () => {
      if (confirm('Start a new game? All current progress will be discarded.')) {
        this._clearModal()
        this.app.eventBus.emit('NEW_GAME')
      }
    })
    box.appendChild(newGameBtn)

    this._appendSettings(box)
  }

  // Shared Settings section appended to both connect and in-game menus.
  _appendSettings(box) {
    const sep = document.createElement('div')
    sep.style.cssText = 'border-top:1px solid #333;margin:12px 0 10px'
    box.appendChild(sep)

    const heading = document.createElement('div')
    heading.textContent = 'Settings'
    heading.style.cssText = 'font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px'
    box.appendChild(heading)

    const tutRow = document.createElement('label')
    tutRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;color:#ccc;cursor:pointer'
    const tutCheck = document.createElement('input')
    tutCheck.type = 'checkbox'
    tutCheck.checked = Settings.showTutorials
    tutCheck.style.cursor = 'pointer'
    tutCheck.addEventListener('change', () => { Settings.showTutorials = tutCheck.checked })
    tutRow.appendChild(tutCheck)
    tutRow.appendChild(document.createTextNode('Show tutorials'))
    box.appendChild(tutRow)
  }

  async _join(address, name, err) {
    if (!name.trim()) { err.textContent = 'Enter a name to join.'; return }
    if (isElectron && !address.trim()) { err.textContent = 'Enter the host server address.'; return }
    err.textContent = 'Joining…'
    setApiBase(address.trim())
    try {
      const res = await GameAPI.join(name.trim())
      if (!res.ok) { err.textContent = res.error || 'Join failed.'; return }
      setSeatKey(res.seatKey)
      this._joined = true
      this.app.liveSync?.reconnect()
      this._clearModal()
      await this.app.refreshFromServer()
    } catch (e) {
      err.textContent = 'Could not reach server.'
    }
  }

  async _playSolo() {
    const name = document.getElementById('mp-name')?.value.trim() || 'Player'
    const addr = document.getElementById('mp-addr')?.value.trim() || ''
    const err  = this.root?.querySelector('#mp-err')
    if (err) err.textContent = 'Starting…'
    setApiBase(addr)
    try {
      const res = await GameAPI.join(name)
      if (!res.ok) { if (err) err.textContent = res.error || 'Join failed.'; return }
      setSeatKey(res.seatKey)
      this._joined = true
      this.app.liveSync?.reconnect()
      this._clearModal()
      await this.app.refreshFromServer()
    } catch (e) {
      if (err) err.textContent = 'Could not reach server.'
    }
  }

  // ── Initiative roll dialog ────────────────────────────────────────────────────
  showInitiativeRoll(mpState) {
    return new Promise(resolve => {
      const back = document.createElement('div')
      back.id = 'mp-initiative'
      back.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;pointer-events:auto;z-index:50'

      // Block all map interactions and game input while initiative roll is open.
      back.addEventListener('click',     (e) => e.stopPropagation())
      back.addEventListener('mousedown', (e) => e.stopPropagation())
      back.addEventListener('mousemove', (e) => e.stopPropagation())
      this.app.renderer?.cameraController?.setEnabled(false)

      const panel = document.createElement('div')
      panel.style.cssText = 'background:#1a1a12;border:2px solid #7a6a52;border-radius:8px;padding:32px 40px;width:380px;color:#e8dcc8;font-family:Arial,sans-serif;text-align:center'

      const title = document.createElement('div')
      title.style.cssText = 'font-size:22px;font-weight:bold;color:#d4c49a;letter-spacing:1px;margin-bottom:6px'
      title.textContent = 'Initiative Roll'
      panel.appendChild(title)

      const sub = document.createElement('div')
      sub.style.cssText = 'font-size:12px;color:#888;margin-bottom:24px'
      sub.textContent = 'Determines turn order for Terrain and District setup'
      panel.appendChild(sub)

      const seatList = document.createElement('div')
      seatList.style.cssText = 'margin-bottom:24px;text-align:left'
      const seats = mpState?.seats || []
      const renderSeats = (rolls) => {
        seatList.innerHTML = ''
        for (const s of seats) {
          const row = document.createElement('div')
          row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-bottom:1px solid #333;font-size:13px'
          const nameEl = document.createElement('span')
          nameEl.textContent = s.name + (s.isMe ? ' (you)' : '')
          nameEl.style.color = s.isMe ? '#d4c49a' : '#aaa'
          const rollEl = document.createElement('span')
          const r = rolls[s.seatId ?? s.id]
          rollEl.style.cssText = `font-weight:bold;font-size:16px;color:${r != null ? '#4ade80' : '#555'}`
          rollEl.textContent = r != null ? `🎲 ${r}` : '—'
          row.appendChild(nameEl); row.appendChild(rollEl)
          seatList.appendChild(row)
        }
      }
      const currentRolls = {}
      for (const s of seats) if (s.initiativeRoll != null) currentRolls[s.seatId ?? s.id] = s.initiativeRoll
      renderSeats(currentRolls)
      panel.appendChild(seatList)

      const d20wrap = document.createElement('div')
      d20wrap.style.cssText = 'margin-bottom:16px;display:flex;justify-content:center;user-select:none'
      const d20container = document.createElement('div')
      d20container.style.cssText = 'position:relative;width:90px;height:90px'
      const d20svg = document.createElement('img')
      d20svg.src = '/resources/d20.svg'
      d20svg.width = 90; d20svg.height = 90
      d20svg.style.cssText = 'display:block;transition:transform 0.08s'
      const d20num = document.createElement('div')
      d20num.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:bold;font-family:Arial,sans-serif;color:#d4c49a;pointer-events:none'
      d20num.textContent = ''
      d20container.appendChild(d20svg); d20container.appendChild(d20num)
      d20wrap.appendChild(d20container); panel.appendChild(d20wrap)

      const myId = mpState?.meSeatId
      let myRoll = currentRolls[myId] ?? null
      let rolling = false

      const rollBtn = document.createElement('button')
      rollBtn.style.cssText = 'width:100%;padding:12px;margin-bottom:12px;font-size:15px;font-weight:bold;background:#4a3010;border:2px solid #a07030;color:#e8dcc8;border-radius:4px;cursor:pointer;letter-spacing:0.5px'
      rollBtn.textContent = myRoll != null ? `You rolled ${myRoll}` : 'Roll d20'
      if (myRoll != null) { rollBtn.disabled = true; d20num.textContent = myRoll; d20num.style.color = '#4ade80' }
      rollBtn.addEventListener('click', async () => {
        if (rolling || myRoll != null) return
        rolling = true; rollBtn.disabled = true
        let angle = 0
        const anim = setInterval(() => {
          angle += 18; d20svg.style.transform = `rotate(${angle}deg)`
          d20num.textContent = String(1 + Math.floor(Math.random() * 20))
        }, 80)
        try {
          const res = await GameAPI.request('/lobby/roll-initiative', 'POST')
          clearInterval(anim); d20svg.style.transform = ''
          if (res?.order) {
            for (const entry of res.order) currentRolls[entry.seatId] = entry.roll
            myRoll = currentRolls[myId]
            renderSeats(currentRolls)
            d20num.textContent = myRoll ?? '20'; d20num.style.color = '#4ade80'
            rollBtn.textContent = `You rolled ${myRoll}`
            beginBtn.disabled = false
            beginBtn.style.background = '#1a6b1a'; beginBtn.style.borderColor = '#4c4'; beginBtn.style.cursor = 'pointer'
          }
        } catch {
          clearInterval(anim); d20svg.style.transform = ''
          rollBtn.disabled = false; rolling = false
        }
      })
      panel.appendChild(rollBtn)

      const beginBtn = document.createElement('button')
      const canBegin = myRoll != null
      beginBtn.disabled = !canBegin
      beginBtn.style.cssText = `width:100%;padding:12px;font-size:15px;font-weight:bold;background:${canBegin ? '#1a6b1a' : '#1a1a1a'};border:2px solid ${canBegin ? '#4c4' : '#333'};color:#fff;border-radius:4px;cursor:${canBegin ? 'pointer' : 'not-allowed'}`
      beginBtn.textContent = 'Begin Terrain Setup'
      beginBtn.addEventListener('click', async () => {
        if (beginBtn.disabled) return
        beginBtn.disabled = true; beginBtn.textContent = 'Starting…'
        try { await GameAPI.request('/lobby/start', 'POST') } catch { /* already started */ }
        back.remove()
        this.app.renderer?.cameraController?.setEnabled(true)
        resolve()
      })
      panel.appendChild(beginBtn)

      back.appendChild(panel)
      this.root.appendChild(back)
    })
  }

  // ── Lobby + turn banner ───────────────────────────────────────────────────────
  update(mp, setupStep) {
    this.mp = mp; this.setupStep = setupStep
    const joined = !!(mp && mp.meSeatId)
    if (!joined) { this._clearLobby(); this._clearBanner(); return }
    if (this.root?.querySelector('#mp-initiative')) { this._clearLobby(); this._clearBanner(); return }
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
    banner.querySelector('#mp-pass')?.addEventListener('click', async () => {
      await GameAPI.request('/turn/pass', 'POST'); await this.app.refreshFromServer()
    })
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────────
  _modalOpen() { return !!this.root?.querySelector('#mp-modal') }

  _modal(dismissable = false) {
    this._clearModal()
    const back = document.createElement('div')
    back.id = 'mp-modal'
    back.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;pointer-events:auto'

    // Block all map interactions and game input while the modal is open.
    back.addEventListener('click',     (e) => e.stopPropagation())
    back.addEventListener('mousedown', (e) => e.stopPropagation())
    back.addEventListener('mousemove', (e) => e.stopPropagation())
    this.app.renderer?.cameraController?.setEnabled(false)

    const box = document.createElement('div')
    box.style.cssText = 'width:360px;background:#1a1a1a;border:1px solid #555;border-radius:6px;padding:22px;color:#fff;position:relative;box-sizing:border-box'

    if (dismissable) {
      const closeBtn = document.createElement('button')
      closeBtn.textContent = '×'
      closeBtn.style.cssText = 'position:absolute;top:10px;right:14px;background:none;border:none;color:#aaa;font-size:22px;cursor:pointer;padding:0;line-height:1'
      closeBtn.addEventListener('click', () => this._clearModal())
      box.appendChild(closeBtn)
    }

    back.appendChild(box)
    this.root.appendChild(back)
    return box
  }
  _clearModal() {
    const had = !!this.root?.querySelector('#mp-modal')
    this.root?.querySelector('#mp-modal')?.remove()
    if (had) this.app.renderer?.cameraController?.setEnabled(true)
  }

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
      el.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);padding:8px 16px;border:1px solid #666;border-radius:20px;color:#fff;pointer-events:auto;display:flex;align-items:center'
      this.root.appendChild(el)
    }
    return el
  }
  _clearBanner() { this.root?.querySelector('#mp-banner')?.remove() }

  _esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }
}
