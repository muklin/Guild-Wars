import CharacterSheet from './CharacterSheet.js'

const TABS = ['Characters', 'Headquarters', 'Special', 'Resources', 'Diplomacy', 'Overview']

const inputCss  = 'width:100%;padding:6px;margin-bottom:8px;background:#111;border:1px solid #555;color:#fff;border-radius:3px;font-size:12px;box-sizing:border-box'
const labelCss  = 'display:block;font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:1px;margin:6px 0 2px'
const btnCss    = 'padding:8px 16px;border-radius:3px;cursor:pointer;font-size:12px;color:#fff'
const primaryBtn = btnCss + ';background:#1a6b1a;border:1px solid #4c4'

// Module-level z-counter shared with CharacterSheet.
export let _zTop = 50
export function bringToFront(el) { el.style.zIndex = ++_zTop }

export default class GuildPanel {
  constructor(eventBus) {
    this.eventBus = eventBus
    this.el = null
    this.guild = null
    this.factions = []
    this.districts = []
    this.hq = null
    this.tokens = { veto: 1, guild: 2, character: 2, round: 2 }
    this.tab = 'Characters'
    this.guildName = ''
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  render() {
    if (this.el) return  // already in DOM
    const el = document.createElement('div')
    el.style.cssText = [
      'position:fixed',
      'width:800px',
      'height:600px',
      'background:rgba(20,20,20,0.92)',
      'border:1px solid #555',
      'border-radius:6px',
      'z-index:50',
      'pointer-events:auto',
      'display:none',
      'flex-direction:column',
      'overflow:hidden',
      'font-family:Arial',
      'color:#fff',
      'left:calc(50% - 400px)',
      'top:calc(50% - 300px)',
    ].join(';')
    el.addEventListener('mousedown', () => bringToFront(el))
    this._makeDraggable(el)
    document.body.appendChild(el)
    this.el = el
    this._render()
  }

  show() {
    if (!this.el) this.render()
    this.el.style.display = 'flex'
    bringToFront(this.el)
  }

  hide() { if (this.el) this.el.style.display = 'none' }

  toggle() {
    if (!this.el) this.render()
    if (this.el.style.display === 'none' || !this.el.style.display) this.show()
    else this.hide()
  }

  reset() {
    this.guild = null
    this.hq = null
    this.guildName = ''
    this.tab = 'Characters'
    this.tokens = { veto: 1, guild: 2, character: 2, round: 2 }
    this.hide()
    if (this.el) this._render()
  }

  setData({ guild, factions, districts } = {}) {
    if (guild !== undefined) this.guild = guild
    if (factions) this.factions = factions
    if (districts) this.districts = districts
    if (this.el) this._render()
  }

  setHeadquarters(hq) {
    this.hq = hq
    if (this.el) this._render()
  }

  // ── Dragging ──────────────────────────────────────────────────────────────

  _makeDraggable(el) {
    let dragging = false, ox = 0, oy = 0
    const titleBar = () => el.querySelector('.guild-title-bar')
    el.addEventListener('mousedown', e => {
      const tb = titleBar()
      if (!tb || !tb.contains(e.target)) return
      dragging = true
      const r = el.getBoundingClientRect()
      ox = e.clientX - r.left
      oy = e.clientY - r.top
      e.preventDefault()
    })
    document.addEventListener('mousemove', e => {
      if (!dragging) return
      el.style.left = (e.clientX - ox) + 'px'
      el.style.top  = (e.clientY - oy) + 'px'
    })
    document.addEventListener('mouseup', () => { dragging = false })
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]))
  }

  _render() {
    const el = this.el
    el.innerHTML = ''

    // Title bar (drag handle + close)
    const titleBar = document.createElement('div')
    titleBar.className = 'guild-title-bar'
    titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(0,0,0,0.4);border-bottom:1px solid #444;cursor:move;flex-shrink:0'
    const title = document.createElement('span')
    title.textContent = this.guild?.name ? `Guild: ${this.guild.name}` : 'Guild Design'
    title.style.cssText = 'font-size:13px;font-weight:bold;user-select:none'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '×'
    closeBtn.style.cssText = 'background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;line-height:1;padding:0 4px'
    closeBtn.addEventListener('click', () => this.hide())
    titleBar.appendChild(title)
    titleBar.appendChild(closeBtn)
    el.appendChild(titleBar)

    // Tab bar
    const tabBar = document.createElement('div')
    tabBar.style.cssText = 'display:flex;gap:2px;padding:6px 8px 0;background:rgba(0,0,0,0.2);flex-shrink:0'
    for (const t of TABS) {
      const b = document.createElement('button')
      b.textContent = t
      const active = t === this.tab
      b.style.cssText = `padding:5px 10px;border-radius:3px 3px 0 0;cursor:pointer;font-size:11px;color:#fff;background:${active ? '#4a7c59' : '#2a2a2a'};border:1px solid ${active ? '#6a9c79' : '#444'};border-bottom:${active ? '1px solid #4a7c59' : '1px solid #333'}`
      b.addEventListener('click', () => { this.tab = t; this._render() })
      tabBar.appendChild(b)
    }
    el.appendChild(tabBar)

    // Body
    const body = document.createElement('div')
    body.style.cssText = 'flex:1;overflow-y:auto;padding:16px;font-size:12px'
    el.appendChild(body)

    const tabFns = {
      Overview:     () => this._tabOverview(body),
      Diplomacy:    () => this._tabDiplomacy(body),
      Characters:   () => this._tabCharacters(body),
      Resources:    () => this._tabResources(body),
      Headquarters: () => this._tabHeadquarters(body),
      Special:      () => this._tabSpecial(body),
    }
    ;(tabFns[this.tab] || tabFns.Characters)()
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  _tabOverview(body) {
    if (!this.guild) { body.innerHTML = '<div style="color:#666;font-style:italic">Loading…</div>'; return }

    // Visibility note
    const note = document.createElement('p')
    note.style.cssText = 'color:#aaa;font-size:11px;margin:0 0 16px;line-height:1.6'
    note.textContent = 'Your guild name will be visible to all players. Your Headquarters, Influence, and other details won\'t be revealed until the game begins.'
    body.appendChild(note)

    // Name row
    const nameRow = document.createElement('div')
    nameRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px'

    const swatch = document.createElement('div')
    swatch.style.cssText = `width:14px;height:14px;border-radius:3px;background:${this.guild.color || '#888'};flex-shrink:0`
    nameRow.appendChild(swatch)

    const locked = !!this.guild.nameLocked
    const nameInput = document.createElement('input')
    nameInput.value = this.guild.name
    nameInput.placeholder = 'Enter guild name…'
    nameInput.disabled = locked
    nameInput.style.cssText = `flex:1;padding:7px 10px;background:#1a1a1a;border:1px solid ${locked ? '#333' : '#555'};border-radius:4px;color:${locked ? '#888' : '#fff'};font-size:14px;outline:none`
    nameRow.appendChild(nameInput)

    if (!locked) {
      const saveBtn = document.createElement('button')
      saveBtn.textContent = 'Save'
      saveBtn.style.cssText = 'padding:7px 16px;background:#4a7c59;border:none;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;flex-shrink:0'
      const doSave = () => {
        const n = nameInput.value.trim()
        if (!n) { nameInput.style.borderColor = '#c44'; return }
        nameInput.style.borderColor = '#555'
        this.eventBus.emit('GUILD_RENAME', { name: n })
      }
      saveBtn.addEventListener('click', doSave)
      nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSave() })
      nameRow.appendChild(saveBtn)
      setTimeout(() => nameInput.focus(), 50)
    }
    body.appendChild(nameRow)

    const sub = document.createElement('div')
    sub.style.cssText = 'font-size:10px;color:#555;font-style:italic;margin-bottom:20px'
    sub.textContent = locked ? 'Guild name is set and cannot be changed.' : 'A name is not required until the end of Guild Design.'
    body.appendChild(sub)

    // Tokens
    const tokenHeader = document.createElement('div')
    tokenHeader.textContent = 'Tokens'
    tokenHeader.style.cssText = 'font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px'
    body.appendChild(tokenHeader)

    const tokenGrid = document.createElement('div')
    tokenGrid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;max-width:400px'
    const TOKEN_LABELS = { veto: 'Veto', guild: 'Guild', character: 'Character', round: 'Round' }
    for (const [key, label] of Object.entries(TOKEN_LABELS)) {
      const cell = document.createElement('div')
      cell.style.cssText = 'background:#1a2a1a;border:1px solid #3a5a3a;border-radius:4px;padding:8px;text-align:center'
      cell.innerHTML = `<div style="font-size:10px;color:#aaa;margin-bottom:4px">${label}</div><div style="font-size:20px;font-weight:bold;color:#7fd">${this.tokens[key] ?? 0}</div>`
      tokenGrid.appendChild(cell)
    }
    body.appendChild(tokenGrid)
  }

  _tabDiplomacy(body) {
    if (!this.guild) { body.innerHTML = '<div style="color:#666">No guild yet.</div>'; return }
    const inf = this.guild.influence || {}
    const head = document.createElement('div')
    head.style.cssText = 'display:flex;justify-content:space-between;color:#888;font-size:10px;padding:2px 0;border-bottom:1px solid #333;margin-bottom:4px'
    head.innerHTML = '<span>Faction</span><span>Influence · Health</span>'
    body.appendChild(head)
    for (const f of this.factions) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #222'
      const nm = f.subclass ? `${f.name}: ${f.subclass}` : f.name
      row.innerHTML = `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px">${this._esc(nm)}</span>`
        + `<span><b style="color:#7fd">${inf[f.id] ?? 50}</b> · <span style="color:#fc8">${f.health ?? 70}</span></span>`
      body.appendChild(row)
    }
  }

  _tabCharacters(body) {
    if (!this.guild) { body.innerHTML = '<div style="color:#666">No guild yet.</div>'; return }
    const chars = this.guild.characters || []

    // Role legend
    const legend = document.createElement('div')
    legend.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;font-size:10px;color:#888'
    legend.innerHTML = '<span>Guild Leader <b style="color:#aaa">max 1</b></span>'
      + '<span>Guild Second <b style="color:#aaa">max 2</b></span>'
      + '<span>Members <b style="color:#aaa">no max</b></span>'
      + '<span>Recruits <b style="color:#aaa">no max</b></span>'
    body.appendChild(legend)

    if (chars.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No characters yet.'
      empty.style.cssText = 'color:#555;font-style:italic'
      body.appendChild(empty)
      return
    }

    // Header
    const header = document.createElement('div')
    header.style.cssText = 'display:grid;grid-template-columns:1fr 100px 80px 50px;gap:4px;padding:4px 8px;background:#1a1a1a;border-radius:3px;font-size:10px;color:#888;margin-bottom:2px'
    header.innerHTML = '<span>Name</span><span>Role</span><span>Class</span><span>Lvl</span>'
    body.appendChild(header)

    const ROLE_COLORS = { 'guild-leader': '#fc8', 'guild-second': '#7fd', member: '#ccc', recruit: '#888' }
    const ROLE_LABELS = { 'guild-leader': 'Leader', 'guild-second': 'Second', member: 'Member', recruit: 'Recruit' }

    for (const ch of chars) {
      const row = document.createElement('div')
      row.style.cssText = 'display:grid;grid-template-columns:1fr 100px 80px 50px;gap:4px;padding:5px 8px;border-bottom:1px solid #222;cursor:pointer;border-radius:2px'
      row.innerHTML = `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this._esc(ch.name)}</span>`
        + `<span style="color:${ROLE_COLORS[ch.role] || '#aaa'}">${ROLE_LABELS[ch.role] || ch.role}</span>`
        + `<span style="color:#aaa">${ch.class ? this._esc(ch.class) : '—'}</span>`
        + `<span style="color:#aaa">${ch.level}</span>`
      row.addEventListener('mouseenter', () => { row.style.background = '#1e2e1e' })
      row.addEventListener('mouseleave', () => { row.style.background = '' })
      row.addEventListener('click', () => CharacterSheet.open(ch))
      body.appendChild(row)
    }
  }

  _tabResources(body) {
    if (!this.guild) { body.innerHTML = '<div style="color:#666">No guild yet.</div>'; return }
    const res = this.guild.resources || {}
    if (!Object.keys(res).length) { body.innerHTML = '<div style="color:#666">No resources</div>'; return }
    for (const [name, qty] of Object.entries(res)) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #222'
      row.innerHTML = `<span>${this._esc(name)}</span><span style="color:#fc8">${qty}</span>`
      body.appendChild(row)
    }
  }

  _tabHeadquarters(body) {
    const canPick = !this.guild || true  // HQ can always be changed via this tab

    if (!this.hq && !(this.guild?.headquarters)) {
      const info = document.createElement('div')
      info.textContent = 'No Headquarters chosen.'
      info.style.cssText = 'color:#666;margin-bottom:12px'
      body.appendChild(info)
    } else {
      const hq = this.hq || this.guild?.headquarters
      const label = hq.kind === 'plot' ? `Plot ${hq.refId}` : `Landmark ${hq.name || hq.refId}`
      const distName = this._districtFactionName(hq.districtId)
      const infoEl = document.createElement('div')
      infoEl.style.cssText = 'margin-bottom:12px'
      infoEl.innerHTML = `<div style="font-weight:bold;margin-bottom:4px">${this._esc(label)}</div>`
        + `<div style="color:#aaa;font-size:11px">District: ${this._esc(distName)}</div>`
        + `<div style="color:#7fd;font-size:11px;margin-top:2px">+20 Influence with district faction</div>`
      body.appendChild(infoEl)

      // Placeholder image
      const imgBox = document.createElement('div')
      imgBox.style.cssText = 'width:100%;max-width:300px;height:180px;background:#111;border:1px solid #333;border-radius:4px;display:flex;align-items:center;justify-content:center;margin-bottom:12px'
      imgBox.innerHTML = '<span style="color:#444;font-size:11px">Image — coming soon</span>'
      body.appendChild(imgBox)
    }

    const pickBtn = document.createElement('button')
    pickBtn.textContent = this.hq || this.guild?.headquarters ? 'Change Headquarters (click map)' : 'Choose Headquarters (click a plot or landmark)'
    pickBtn.style.cssText = btnCss + ';background:#444;border:1px solid #777'
    pickBtn.addEventListener('click', () => this.eventBus.emit('GUILD_HQ_PICK_START'))
    body.appendChild(pickBtn)
  }

  _tabSpecial(body) {
    body.innerHTML = '<div style="color:#888">Guild powers · Magic · Religion · Espionage · Combat · Marketing</div>'
      + '<div style="color:#666;font-style:italic;margin-top:8px">Not yet implemented</div>'
  }

  _districtFactionName(districtId) {
    const f = this.factions.find(x => x.districtId === districtId)
    return f ? (f.subclass ? `${f.name}: ${f.subclass}` : f.name) : `District ${districtId ?? '?'}`
  }
}
