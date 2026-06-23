import CharacterSheet from './CharacterSheet.js'
import { GUILD_TRAITS, TRAIT_BY_ID } from '../../shared/guildTraits.js'
import { HQ_UPGRADES, UPGRADE_BY_ID } from '../../shared/hqUpgrades.js'
import GameAPI from '../api/GameAPI.js'
import { DISTRICT_COLORS } from '../rendering/DistrictRenderer.js'
import * as ViewStack from './ViewStack.js'

function _factionCssColor(faction) {
  let n
  if (faction.type === 'leadership') n = DISTRICT_COLORS.get(faction.subclass) ?? DISTRICT_COLORS.Leadership
  else if (faction.type === 'district') n = DISTRICT_COLORS.get(faction.subclass) ?? DISTRICT_COLORS.get(faction.name) ?? DISTRICT_COLORS.Residential
  else if (faction.type === 'terrain')  n = 0x6a9b5a
  else if (faction.type === 'trade')    n = 0xd4a017
  else n = DISTRICT_COLORS.Neutral
  return '#' + (n >>> 0).toString(16).padStart(6, '0')
}

const TABS = ['Overview', 'Headquarters', 'Guild Traits', 'Roster', 'Resources', 'Diplomacy']

const inputCss  = 'width:100%;padding:6px;margin-bottom:8px;background:#111;border:1px solid #555;color:#fff;border-radius:3px;font-size:12px;box-sizing:border-box'
const labelCss  = 'display:block;font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:1px;margin:6px 0 2px'
const btnCss    = 'padding:8px 16px;border-radius:3px;cursor:pointer;font-size:12px;color:#fff'
const primaryBtn = btnCss + ';background:#1a6b1a;border:1px solid #4c4'

const TRAIT_CAT_COLORS = { Combat: '#e07060', Economic: '#c8a040', Faction: '#7fd', Headquarters: '#a080d0', Member: '#60a0e0', Magical: '#c060c0' }
function _traitCatColor(cat) { return TRAIT_CAT_COLORS[cat] || '#aaa' }

// Shared stat bar — thin track, dark border, bright pill at the value position.
// label: shown in native tooltip on the pill (e.g. "Influence: 30").
function _statBar(pct, fillColor, pillColor, label) {
  const p = Math.max(0, Math.min(100, pct))
  const pc = pillColor || fillColor
  const tip = label != null ? ` title="${label}: ${Math.round(pct)}"` : ''
  return `<div style="position:relative;height:3px;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:3px;overflow:visible">`
    + `<div style="position:absolute;left:0;top:0;height:100%;width:${p}%;background:${fillColor};border-radius:3px">`
    + `<div${tip} style="position:absolute;right:-5px;top:50%;transform:translateY(-50%);width:10px;height:4px;border-radius:2px;background:${pc};box-shadow:0 0 6px 3px ${pc}66;cursor:default"></div>`
    + `</div></div>`
}

const ROLE_ORDER = { 'guild-leader': 0, 'guild-second': 1, member: 2, recruit: 3 }
function sortChars(chars) {
  return [...chars].sort((a, b) => {
    const ro = (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9)
    return ro !== 0 ? ro : b.level - a.level
  })
}

export default class GuildPanel {
  constructor(eventBus) {
    this.eventBus = eventBus
    this.el = null
    this.guild = null
    this.factions = []
    this.districts = []
    this.hq = null
    this.tokens = { veto: 0, guild: 0, character: 0, round: 0 }
    this.playerName = ''
    this.tab = 'Roster'
    this.guildName = ''
    this._traitPickMode = false   // false | 'pick'
    this._expandedTraitId = null
    this._expandedUpgradeId = null
    this._previewDistrictId = null
    this._hqSnapshot = null
    this._pendingHq = null         // hq chosen but not yet Applied
    this._pendingSnapshot = null
    this._selectedFactionId = null  // for Diplomacy ring click
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
    this._view = { el, close: () => this.hide() }
    el.addEventListener('mousedown', () => ViewStack.bringToFront(this._view))
    el.addEventListener('wheel', e => e.stopPropagation(), { passive: true })
    el.addEventListener('keydown', e => { if (e.key !== 'Escape') e.stopPropagation() })
    this._makeDraggable(el)
    document.body.appendChild(el)
    this.el = el
    this._render()
  }

  show() {
    if (!this.el) this.render()
    this.el.style.display = 'flex'
    ViewStack.bringToFront(this._view)
  }

  hide() {
    if (this.el) this.el.style.display = 'none'
    ViewStack.remove(this._view)
    const tt = document.getElementById('gp-ability-tooltip')
    if (tt) tt.style.display = 'none'
  }

  toggle() {
    if (!this.el) this.render()
    if (this.el.style.display === 'none' || !this.el.style.display) this.show()
    else this.hide()
  }

  reset() {
    this.guild = null
    this.hq = null
    this.guildName = ''
    this.tab = 'Roster'
    this.tokens = { veto: 0, guild: 0, character: 0, round: 0 }
    this.hide()
    if (this.el) this._render()
  }

  setData({ guild, factions, districts, tokens, playerName } = {}) {
    if (guild      !== undefined) this.guild      = guild
    if (factions)                 this.factions   = factions
    if (districts)                this.districts  = districts
    if (tokens != null)           this.tokens     = tokens
    if (playerName !== undefined) this.playerName = playerName
    if (this.el) this._render()
  }

  setHQSnapshot(dataUrl) {
    this._hqSnapshot = dataUrl
    if (this.el && this.tab === 'Headquarters') this._render()
  }

  setHQPreview(hq, snapshot) {
    this._pendingHq = hq
    this._pendingSnapshot = snapshot || null
    this.tab = 'Headquarters'
    if (this.el) this._render()
  }

  clearHQPreview() {
    this._pendingHq = null
    this._pendingSnapshot = null
    if (this.el) this._render()
  }

  setPreviewDistrict(districtId) {
    this._previewDistrictId = districtId
    if (this.el && this.tab === 'Guild Traits') this._render()
  }

  setHeadquarters(hq) {
    this.hq = hq
    this._pendingHq = null
    this._pendingSnapshot = null
    this._previewDistrictId = null  // confirmed HQ supersedes preview
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
    // Save scroll position of current body before wiping
    const prevBody = el.querySelector('[data-tab-body]')
    const savedScroll = prevBody ? prevBody.scrollTop : 0
    el.innerHTML = ''

    // Title bar (drag handle + close)
    const titleBar = document.createElement('div')
    titleBar.className = 'guild-title-bar'
    titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(0,0,0,0.4);border-bottom:1px solid #444;cursor:move;flex-shrink:0'
    const title = document.createElement('span')
    title.textContent = this.guild?.name ? this.guild.name : 'Guild Setup'
    title.style.cssText = 'font-size:13px;font-weight:bold;user-select:none'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '×'
    closeBtn.style.cssText = 'background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;line-height:1;padding:0 4px'
    closeBtn.addEventListener('click', () => this.hide())
    titleBar.appendChild(title)
    titleBar.appendChild(closeBtn)
    el.appendChild(titleBar)

    // Token bar
    const TOKEN_LABELS = { veto: 'Veto', guild: 'Guild', character: 'Character', round: 'Month' }
    const TOKEN_TIPS = {
      veto:      'Spend to Call a vote to veto a player\'s action. On a successful vote you keep the token; on a failed vote you lose it.',
      guild:     'Spend to swap for 2 Month Tokens; swap for 2 Character Tokens; Triple your guild\'s coin (only during Guild Setup); Gain 3 new recruits; Gain a Guild Trait.',
      character: 'Spend to Level up characters:  Costs 1 token per target level (L0→L1 = 1 token, L1→L2 = 2 tokens, etc.).',
      round:     'Monthly Action token. Spend to take additional actions during a game Month (~1 month of in-game time). See Game Play rules.',
    }
    const tokenBar = document.createElement('div')
    tokenBar.style.cssText = 'display:flex;gap:16px;padding:5px 12px;background:rgba(0,0,0,0.3);border-bottom:1px solid #333;flex-shrink:0;font-size:11px'
    for (const [key, label] of Object.entries(TOKEN_LABELS)) {
      const chip = document.createElement('span')
      chip.title = TOKEN_TIPS[key]
      chip.style.cssText = 'color:#aaa;cursor:default'
      chip.innerHTML = `${label}: <span style="color:#7fd;font-weight:bold">${this.tokens[key] ?? 0}</span>`
      tokenBar.appendChild(chip)
    }
    el.appendChild(tokenBar)

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
    body.setAttribute('data-tab-body', '1')
    body.style.cssText = 'flex:1;overflow-y:auto;padding:16px;font-size:12px'
    el.appendChild(body)

    if (this.tab !== 'Guild Traits') this._traitPickMode = false

    const tabFns = {
      Overview:        () => this._tabOverview(body),
      Diplomacy:       () => this._tabDiplomacy(body),
      Roster:          () => this._tabCharacters(body),
      Resources:       () => this._tabResources(body),
      Headquarters:    () => this._tabHeadquarters(body),
      'Guild Traits':  () => this._tabSpecial(body),
    }
    ;(tabFns[this.tab] || tabFns.Roster)()

    body.scrollTop = savedScroll
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  _tabOverview(body) {
    if (!this.guild) { body.innerHTML = '<div style="color:#666;font-style:italic">Loading…</div>'; return }

    // Name row
    const nameRow = document.createElement('div')
    nameRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px'
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
    sub.style.cssText = 'font-size:10px;color:#555;font-style:italic;margin-bottom:12px'
    sub.textContent = locked ? 'Guild name is set and cannot be changed.' : 'A name is not required until the end of Guild Setup.'
    body.appendChild(sub)

    // Dashboard helper: clickable info box that navigates to a tab
    const mkBox = (label, targetTab) => {
      const box = document.createElement('div')
      box.style.cssText = 'border:1px solid #2a2a2a;border-radius:4px;padding:8px 10px;cursor:pointer;background:#0d0d0d;overflow:hidden'
      box.addEventListener('mouseenter', () => { box.style.borderColor = '#4a7c59' })
      box.addEventListener('mouseleave', () => { box.style.borderColor = '#2a2a2a' })
      box.addEventListener('click', () => { this.tab = targetTab; this._render() })
      const hdr = document.createElement('div')
      hdr.style.cssText = 'font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px'
      hdr.textContent = label
      box.appendChild(hdr)
      return box
    }

    const dash = document.createElement('div')
    dash.style.cssText = 'display:flex;flex-direction:column;gap:8px'
    body.appendChild(dash)

    // ── Traits ────────────────────────────────────────────────────────────────
    const traitsBox = mkBox('Special Traits', 'Guild Traits')
    const traits = this.guild.traits || []
    if (traits.length === 0) {
      traitsBox.innerHTML += '<span style="color:#333;font-style:italic;font-size:11px">No traits purchased yet.</span>'
    } else {
      traits.forEach(t => {
        const chip = document.createElement('span')
        chip.style.cssText = 'display:inline-block;background:#1a2a1a;border:1px solid #3a5a3a;border-radius:3px;padding:2px 7px;font-size:11px;margin:2px'
        chip.textContent = t
        traitsBox.appendChild(chip)
      })
    }
    dash.appendChild(traitsBox)

    // ── HQ + Characters (two columns) ─────────────────────────────────────────
    const row2 = document.createElement('div')
    row2.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px'
    dash.appendChild(row2)

    const hqBox = mkBox('Headquarters', 'Headquarters')
    const hq = this.hq || this.guild?.headquarters
    if (hq) {
      const label = hq.kind === 'plot' ? `Plot ${hq.refId}` : `Landmark ${hq.name || hq.refId}`
      const distName = this._districtFactionName(hq.districtId)
      const info = document.createElement('div')
      info.style.cssText = 'font-size:11px;color:#aaa;margin-bottom:6px'
      info.innerHTML = `<b style="color:#ddd">${this._esc(label)}</b> · ${this._esc(distName)}`
      hqBox.appendChild(info)
    }
    const imgPlaceholder = document.createElement('div')
    imgPlaceholder.style.cssText = 'width:100%;height:90px;background:#080808;border:1px solid #1a1a1a;border-radius:3px;display:flex;align-items:center;justify-content:center'
    imgPlaceholder.innerHTML = `<span style="color:#333;font-size:10px">${hq ? 'Image — coming soon' : 'No HQ selected'}</span>`
    hqBox.appendChild(imgPlaceholder)
    row2.appendChild(hqBox)

    const charsBox = mkBox('Characters', 'Characters')
    const chars = sortChars(this.guild.characters || [])
    const ROLE_COL = { 'guild-leader': '#fc8', 'guild-second': '#7fd', member: '#ccc', recruit: '#666' }
    const ROLE_LBL = { 'guild-leader': 'Leader', 'guild-second': 'Second', member: 'Member', recruit: 'Recruit' }
    if (chars.length === 0) {
      charsBox.innerHTML += '<span style="color:#333;font-style:italic;font-size:11px">No characters.</span>'
    } else {
      for (const ch of chars) {
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;padding:2px 0;border-bottom:1px solid #111'
        row.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px">${this._esc(ch.name)}</span>`
          + `<span style="color:${ROLE_COL[ch.role]||'#aaa'};flex-shrink:0">${ROLE_LBL[ch.role]||ch.role}</span>`
          + `<span style="color:#444;flex-shrink:0;margin-left:6px">L${ch.level}</span>`
        charsBox.appendChild(row)
      }
    }
    row2.appendChild(charsBox)

    // ── Factions (4 columns) ──────────────────────────────────────────────────
    const factBox = mkBox('Factions', 'Diplomacy')
    const inf = this.guild.influence || {}
    const std = this.guild.standing || {}
    if (!this.factions.length) {
      factBox.innerHTML += '<span style="color:#333;font-style:italic;font-size:11px">No factions.</span>'
    } else {
      const grid = document.createElement('div')
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px'
      for (const f of this.factions) {
        const nm = f.subclass ? `${f.name}: ${f.subclass}` : f.name
        const health = f.health ?? 70
        const influence = inf[f.id] ?? 0
        const standing = std[f.id] ?? 50
        const card = document.createElement('div')
        card.style.cssText = 'background:#080808;border:1px solid #1a1a1a;border-radius:3px;padding:5px'
        card.innerHTML = `<div style="font-size:10px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px">${this._esc(nm)}</div>`
          + `<div style="font-size:8px;color:#7fd;margin-bottom:2px">Inf: ${influence}</div>`
          + _statBar(influence, '#4a9', null, 'Influence') + '<div style="margin-bottom:3px"></div>'
          + `<div style="font-size:8px;color:#fc8;margin-bottom:2px">Std: ${standing}</div>`
          + _statBar(standing, '#c8a040', null, 'Standing') + '<div style="margin-bottom:3px"></div>'
          + `<div style="font-size:8px;color:#888;margin-bottom:2px">Health: ${health}</div>`
          + _statBar(health, '#4ade80', null, 'Health')
        grid.appendChild(card)
      }
      factBox.appendChild(grid)
    }
    dash.appendChild(factBox)

    // ── Resources ─────────────────────────────────────────────────────────────
    const resBox = mkBox('Resources & Services', 'Resources')
    const res = this.guild.resources || {}
    const resEntries = Object.entries(res)
    if (!resEntries.length) {
      resBox.innerHTML += '<span style="color:#333;font-style:italic;font-size:11px">No resources.</span>'
    } else {
      const grid = document.createElement('div')
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px'
      for (const [name, qty] of resEntries) {
        const item = document.createElement('div')
        item.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;background:#080808;border:1px solid #1a1a1a;border-radius:3px;padding:3px 6px'
        item.innerHTML = `<span style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._esc(name)}</span><span style="color:#fc8;flex-shrink:0;margin-left:4px">${qty}</span>`
        grid.appendChild(item)
      }
      resBox.appendChild(grid)
    }
    dash.appendChild(resBox)
  }

  _tabDiplomacy(body) {
    if (!this.guild) { body.innerHTML = '<div style="color:#666">No guild yet.</div>'; return }

    const inf  = this.guild.influence || {}
    const std  = this.guild.standing  || {}
    const factions = this.factions

    const SVG_NS = 'http://www.w3.org/2000/svg'
    const W = 740, H = 460, CX = W / 2, CY = H * 0.48
    const RX = 310, RY = 175   // ellipse semi-axes
    const NODE_R = 14, GUILD_R = 22, ARC_GAP = 5

    const mkEl = (tag, attrs = {}) => {
      const el = document.createElementNS(SVG_NS, tag)
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
      return el
    }
    // angleDeg: 0=top, clockwise — maps onto the ellipse
    const pt = (angleDeg, rx = RX, ry = RY) => {
      const rad = (angleDeg - 90) * Math.PI / 180
      return { x: CX + rx * Math.cos(rad), y: CY + ry * Math.sin(rad) }
    }

    // Bar rendered along a straight line: track + fill + tangent pill + glow
    const svgLineBar = (ax, ay, bx, by, pct, fillColor, pillColor) => {
      const p = Math.max(0, Math.min(100, pct)) / 100
      const fx = ax + p * (bx - ax), fy = ay + p * (by - ay)
      const angleDeg = Math.atan2(by - ay, bx - ax) * 180 / Math.PI
      const els = []
      els.push(mkEl('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: '#0d0d0d', 'stroke-width': '5', 'stroke-linecap': 'round' }))
      els.push(mkEl('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: '#242424', 'stroke-width': '3', 'stroke-linecap': 'round' }))
      if (p > 0.005) {
        els.push(mkEl('line', { x1: ax, y1: ay, x2: fx, y2: fy, stroke: fillColor, 'stroke-width': '3', 'stroke-linecap': 'round' }))
        els.push(mkEl('rect', { x: -7, y: -4, width: 14, height: 8, rx: 4, fill: pillColor, opacity: '0.28', transform: `translate(${fx},${fy}) rotate(${angleDeg})` }))
        els.push(mkEl('rect', { x: -5, y: -2, width: 10, height: 4,  rx: 2, fill: pillColor, transform: `translate(${fx},${fy}) rotate(${angleDeg})` }))
      }
      return els
    }

    // Bar rendered along an arc: track circle + fill arc + tangent pill + glow
    const svgArcBar = (cx, cy, r, pct, fillColor, pillColor) => {
      const p = Math.max(0, Math.min(0.9999, pct / 100))
      const els = []
      els.push(mkEl('circle', { cx, cy, r, stroke: '#0d0d0d', 'stroke-width': '5', fill: 'none' }))
      els.push(mkEl('circle', { cx, cy, r, stroke: '#242424', 'stroke-width': '3', fill: 'none' }))
      if (p > 0.005) {
        const startRad = -Math.PI / 2
        const endRad = startRad + p * 2 * Math.PI
        const ex = cx + r * Math.cos(endRad), ey = cy + r * Math.sin(endRad)
        const angle = p * 360
        els.push(mkEl('path', {
          d: `M ${cx + r * Math.cos(startRad)} ${cy + r * Math.sin(startRad)} A ${r} ${r} 0 ${angle > 180 ? 1 : 0} 1 ${ex} ${ey}`,
          stroke: fillColor, 'stroke-width': '3', fill: 'none', 'stroke-linecap': 'round'
        }))
        const tangentDeg = (endRad + Math.PI / 2) * 180 / Math.PI
        els.push(mkEl('rect', { x: -7, y: -4, width: 14, height: 8, rx: 4, fill: pillColor, opacity: '0.28', transform: `translate(${ex},${ey}) rotate(${tangentDeg})` }))
        els.push(mkEl('rect', { x: -5, y: -2, width: 10, height: 4,  rx: 2, fill: pillColor, transform: `translate(${ex},${ey}) rotate(${tangentDeg})` }))
      }
      return els
    }

    const leadershipFaction = factions.find(f => f.type === 'leadership')
    const others = factions.filter(f => f.type !== 'leadership')
    // Sort by guild's influence descending
    others.sort((a, b) => (inf[b.id] ?? 0) - (inf[a.id] ?? 0))

    // Leadership at top (0°), guild at bottom (180°)
    // Others alternate right then left, starting just below leadership
    const positions = new Map()
    positions.set('__guild__', { angle: 180 })
    if (leadershipFaction) positions.set(leadershipFaction.id, { angle: 0, f: leadershipFaction })

    // Odd count → one extra faction on the right side.
    // Each side gets equal spacing: step = 180 / (sideCount + 1)
    // so gaps between leadership→factions→guild are uniform on each side.
    const rightCount = Math.ceil(others.length / 2)
    const leftCount  = Math.floor(others.length / 2)
    const rightStep  = 180 / (rightCount + 1)   // clockwise from 0° (leadership) → 180° (guild)
    const leftStep   = leftCount > 0 ? 180 / (leftCount + 1) : 0  // counter-clockwise from 360° → 180°
    let ri = 0, li = 0
    for (let i = 0; i < others.length; i++) {
      let angle
      if (i % 2 === 0) { angle = rightStep * (ri + 1);          ri++ }
      else              { angle = 360 - leftStep * (li + 1);     li++ }
      positions.set(others[i].id, { angle, f: others[i] })
    }

    const isAlwaysVisible = (f) => f.type === 'leadership' || f.type === 'terrain'
    const selectedKey = this._selectedFactionId ?? '__guild__'

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.setAttribute('width', '100%')
    svg.setAttribute('style', 'display:block;max-height:460px')

    // Ring (ellipse)
    svg.appendChild(mkEl('ellipse', { cx: CX, cy: CY, rx: RX, ry: RY, stroke: '#1e1e1e', 'stroke-width': '1', fill: 'none' }))

    const gPt = pt(180)

    // Helper: draw influence+standing bars between two ring points
    const drawBars = (ax, ay, bx, by, inflVal, standVal) => {
      const dx = bx - ax, dy = by - ay
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const offX = (-dy / len) * 4, offY = (dx / len) * 4
      for (const el of svgLineBar(ax + offX, ay + offY, bx + offX, by + offY, inflVal, '#7c3aed', '#c084fc')) svg.appendChild(el)
      for (const el of svgLineBar(ax - offX, ay - offY, bx - offX, by - offY, standVal, '#0f766e', '#2dd4bf')) svg.appendChild(el)
    }

    // ── Selected-node lines ────────────────────────────────────────────────────
    if (selectedKey === '__guild__') {
      // Guild selected: influence + standing bars to every faction
      for (const [key, pos] of positions.entries()) {
        if (key === '__guild__' || !pos.f) continue
        const fPt = pt(pos.angle)
        drawBars(gPt.x, gPt.y, fPt.x, fPt.y, inf[pos.f.id] ?? 0, std[pos.f.id] ?? 50)
      }
    } else if (leadershipFaction && selectedKey === leadershipFaction.id) {
      // Leadership selected: show its known influence + standing to all factions + guild
      const lPos = positions.get(leadershipFaction.id)
      if (lPos) {
        const lPt = pt(lPos.angle)
        const lInf = leadershipFaction.influence || {}
        const lStd = leadershipFaction.standing  || {}
        for (const [key, pos] of positions.entries()) {
          if (key === leadershipFaction.id || key === '__guild__' || !pos.f) continue
          const fPt = pt(pos.angle)
          drawBars(lPt.x, lPt.y, fPt.x, fPt.y, lInf[pos.f.id] ?? 60, lStd[pos.f.id] ?? 50)
        }
        drawBars(lPt.x, lPt.y, gPt.x, gPt.y, lInf[this.guild?.id] ?? 0, lStd[this.guild?.id] ?? 50)
      }
    } else {
      // Other faction selected: no influence lines.
      // Solid teal standing bar to guild (known). Dotted dim lines to all others.
      const selPos = positions.get(selectedKey)
      if (selPos?.f) {
        const sPt = pt(selPos.angle)
        for (const [key, pos] of positions.entries()) {
          if (key === selectedKey || key === '__guild__' || !pos.f) continue
          const fPt = pt(pos.angle)
          svg.appendChild(mkEl('line', { x1: sPt.x, y1: sPt.y, x2: fPt.x, y2: fPt.y, stroke: '#1a3a38', 'stroke-width': '2', 'stroke-dasharray': '3 6', 'stroke-linecap': 'round' }))
        }
        for (const el of svgLineBar(sPt.x, sPt.y, gPt.x, gPt.y, std[selPos.f.id] ?? 50, '#0f766e', '#2dd4bf')) svg.appendChild(el)
      }
    }

    // Faction nodes + health arcs
    for (const [key, pos] of positions.entries()) {
      if (key === '__guild__' || !pos.f) continue
      const f = pos.f
      const { x, y } = pt(pos.angle)
      const health = f.health ?? 70
      const visible = isAlwaysVisible(f)
      const isSelected = this._selectedFactionId === f.id
      const arcR = NODE_R + ARC_GAP

      // Health arc bar
      for (const el of svgArcBar(x, y, arcR, health, '#22c55e', '#4ade80')) svg.appendChild(el)

      // Node circle — stroke matches the faction's colour in the faction list
      const fColor = _factionCssColor(f)
      const circle = mkEl('circle', {
        cx: x, cy: y, r: NODE_R,
        fill: isSelected ? '#1a1a1a' : '#0e0e0e',
        stroke: fColor,
        'stroke-width': isSelected ? '2.5' : '1.5', cursor: 'pointer'
      })
      circle.addEventListener('click', () => {
        this._selectedFactionId = isSelected ? null : f.id
        this._render()
      })
      svg.appendChild(circle)

      // Label outside the arc
      const labelPt = pt(pos.angle, RX + arcR + 14, RY + arcR + 14)
      const nm = f.name || ''
      const lbl = mkEl('text', {
        x: labelPt.x, y: labelPt.y + 4,
        'font-size': '8', fill: visible ? '#bbb' : '#444',
        'text-anchor': 'middle', 'pointer-events': 'none'
      })
      lbl.textContent = nm.length > 14 ? nm.slice(0, 13) + '…' : nm
      svg.appendChild(lbl)
    }

    // Guild node
    const gArcR = GUILD_R + ARC_GAP
    const gHealth = this.guild.health ?? 100
    const gIsSelected = selectedKey === '__guild__'
    for (const el of svgArcBar(gPt.x, gPt.y, gArcR, gHealth, '#22c55e', '#4ade80')) svg.appendChild(el)
    const gCircle = mkEl('circle', {
      cx: gPt.x, cy: gPt.y, r: GUILD_R,
      fill: gIsSelected ? '#102010' : '#0e0e0e',
      stroke: this.guild.color || '#4c4',
      'stroke-width': gIsSelected ? '3' : '2', cursor: 'pointer'
    })
    gCircle.addEventListener('click', () => { this._selectedFactionId = null; this._render() })
    svg.appendChild(gCircle)
    const gLbl = mkEl('text', { x: gPt.x, y: gPt.y + gArcR + 14, 'font-size': '9', fill: '#ccc', 'text-anchor': 'middle' })
    gLbl.textContent = (this.guild.name || 'Guild').slice(0, 14)
    svg.appendChild(gLbl)

    // Legend
    const legY = H - 12
    svg.appendChild(mkEl('line', { x1: 8, y1: legY, x2: 24, y2: legY, stroke: '#6d28d9', 'stroke-width': '2' }))
    const l1 = mkEl('text', { x: 28, y: legY + 4, 'font-size': '8', fill: '#777' }); l1.textContent = 'Influence (purple)'; svg.appendChild(l1)
    svg.appendChild(mkEl('line', { x1: 130, y1: legY, x2: 146, y2: legY, stroke: '#0f766e', 'stroke-width': '2' }))
    const l2 = mkEl('text', { x: 150, y: legY + 4, 'font-size': '8', fill: '#777' }); l2.textContent = 'Standing (teal)'; svg.appendChild(l2)
    svg.appendChild(mkEl('line', { x1: 246, y1: legY, x2: 262, y2: legY, stroke: '#4ade80', 'stroke-width': '2.5' }))
    const l3 = mkEl('text', { x: 266, y: legY + 4, 'font-size': '8', fill: '#777' }); l3.textContent = 'Health (arc)'; svg.appendChild(l3)

    body.appendChild(svg)
  }

  _tabCharacters(body) {
    if (!this.guild) { body.innerHTML = '<div style="color:#666">No guild yet.</div>'; return }
    const chars = sortChars(this.guild.characters || [])

    if (chars.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No characters yet.'
      empty.style.cssText = 'color:#555;font-style:italic'
      body.appendChild(empty)
      return
    }

    // Header
    const header = document.createElement('div')
    header.style.cssText = 'display:grid;grid-template-columns:1fr 80px 80px 80px 40px;gap:4px;padding:4px 8px;background:#1a1a1a;border-radius:3px;font-size:10px;color:#888;margin-bottom:2px'
    header.innerHTML = '<span>Name</span><span>Race</span><span>Role</span><span>Class</span><span>Lvl</span>'
    body.appendChild(header)

    const ROLE_COLORS = { 'guild-leader': '#fc8', 'guild-second': '#7fd', member: '#ccc', recruit: '#888' }
    const ROLE_LABELS = { 'guild-leader': 'Leader', 'guild-second': 'Second', member: 'Member', recruit: 'Recruit' }
    const RACE_LABELS = { human: 'Human', elf: 'Elf', dwarf: 'Dwarf', halfOrc: 'Half-Orc', halfling: 'Halfling', gnome: 'Gnome' }
    const _ms = s => { const m = Math.floor(((s ?? 10) - 10) / 2); return (m >= 0 ? '+' : '') + m }

    // Shared ability-score tooltip (one per document, reused across renders)
    let tt = document.getElementById('gp-ability-tooltip')
    if (!tt) {
      tt = document.createElement('div')
      tt.id = 'gp-ability-tooltip'
      tt.style.cssText = 'position:fixed;display:none;background:#111;border:1px solid #3a3a3a;border-radius:4px;padding:7px 10px;font-family:monospace;font-size:11px;color:#ccc;z-index:9999;pointer-events:none;line-height:1.75;white-space:pre'
      document.body.appendChild(tt)
    }

    for (const ch of chars) {
      const row = document.createElement('div')
      row.style.cssText = 'display:grid;grid-template-columns:1fr 80px 80px 80px 40px;gap:4px;padding:5px 8px;border-bottom:1px solid #222;cursor:pointer;border-radius:2px'

      // Name span with ability score popup
      const ab = ch.abilityScores || {}
      const tipText = `STR: ${ab.str ?? '—'} (${_ms(ab.str)})\nDEX: ${ab.dex ?? '—'} (${_ms(ab.dex)})\nCON: ${ab.con ?? '—'} (${_ms(ab.con)})\nINT: ${ab.int ?? '—'} (${_ms(ab.int)})\nWIS: ${ab.wis ?? '—'} (${_ms(ab.wis)})\nCHA: ${ab.cha ?? '—'} (${_ms(ab.cha)})`
      const nameSpan = document.createElement('span')
      nameSpan.textContent = ch.name
      nameSpan.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      nameSpan.addEventListener('mouseenter', () => {
        tt.textContent = tipText
        tt.style.display = 'block'
        const r = nameSpan.getBoundingClientRect()
        tt.style.left = r.left + 'px'
        tt.style.top  = (r.bottom + 4) + 'px'
      })
      nameSpan.addEventListener('mouseleave', () => { tt.style.display = 'none' })
      row.appendChild(nameSpan)

      const mkCell = (text, color) => {
        const s = document.createElement('span')
        s.textContent = text
        if (color) s.style.color = color
        return s
      }
      row.appendChild(mkCell(RACE_LABELS[ch.race] || ch.race || '—', '#aaa'))
      row.appendChild(mkCell(ROLE_LABELS[ch.role] || ch.role, ROLE_COLORS[ch.role] || '#aaa'))
      row.appendChild(mkCell(ch.class || '—', '#aaa'))
      row.appendChild(mkCell(String(ch.level), '#aaa'))

      row.addEventListener('mouseenter', () => { row.style.background = '#1e2e1e' })
      row.addEventListener('mouseleave', () => { row.style.background = '' })
      row.addEventListener('click', () => CharacterSheet.open(ch, {
        tokens:     this.tokens,
        playerName: this.playerName,
        guild:      this.guild,
        onUpdate:   (guild, tokens) => {
          if (guild)  this.guild  = guild
          if (tokens) this.tokens = tokens
          this._render()
        },
      }))
      body.appendChild(row)
    }
  }

  _tabResources(body) {
    if (!this.guild) { body.innerHTML = '<div style="color:#666">No guild yet.</div>'; return }

    const std = this.guild.standing || {}
    const STANDING_THRESHOLD = 70

    const sectionHdr = (text, color = '#888') => {
      const h = document.createElement('div')
      h.style.cssText = `font-size:10px;color:${color};text-transform:uppercase;letter-spacing:1px;margin:12px 0 6px;font-weight:bold`
      h.textContent = text
      return h
    }
    const resourceRow = (name, qty) => {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1a1a1a'
      row.innerHTML = `<span style="font-size:11px;color:#bbb">${this._esc(name)}</span><span style="color:#fc8;font-size:11px">${qty}</span>`
      return row
    }

    // ── Our resources ─────────────────────────────────────────────────────────
    body.appendChild(sectionHdr('Our Resources', '#fc8'))
    const res = this.guild.resources || {}
    if (!Object.keys(res).length) {
      const empty = document.createElement('div')
      empty.style.cssText = 'font-size:11px;color:#444;font-style:italic;margin-bottom:8px'
      empty.textContent = 'No resources yet.'
      body.appendChild(empty)
    } else {
      for (const [name, qty] of Object.entries(res)) body.appendChild(resourceRow(name, qty))
    }

    // ── Faction resources (visible when Standing ≥ 70) ───────────────────────
    const knownFactions = this.factions.filter(f => (std[f.id] ?? 50) >= STANDING_THRESHOLD && f.resources && Object.keys(f.resources).length)
    const unknownFactions = this.factions.filter(f => (std[f.id] ?? 50) < STANDING_THRESHOLD)

    if (knownFactions.length || unknownFactions.length) {
      body.appendChild(sectionHdr('Faction Resources', '#7fd'))
      for (const f of knownFactions) {
        const nm = f.subclass ? `${f.name}: ${f.subclass}` : f.name
        const fHdr = document.createElement('div')
        fHdr.style.cssText = 'font-size:10px;color:#7fd;margin:8px 0 3px'
        fHdr.textContent = nm
        body.appendChild(fHdr)
        for (const [name, qty] of Object.entries(f.resources)) body.appendChild(resourceRow(name, qty))
      }
      if (unknownFactions.length) {
        const note = document.createElement('div')
        note.style.cssText = 'font-size:10px;color:#444;font-style:italic;margin-top:10px;padding:6px 8px;border:1px solid #1e1e1e;border-radius:3px'
        note.innerHTML = `<span style="color:#555">${unknownFactions.length} faction${unknownFactions.length > 1 ? 's' : ''} unknown</span> — reach <span style="color:#7fd">70 Standing</span> to reveal their resources.`
        body.appendChild(note)
      }
    }

    // ── Resource dependency graph ──────────────────────────────────────────────
    body.appendChild(sectionHdr('Resource Flow', '#a0a0ff'))
    this._renderResourceGraph(body, this.factions, std)
  }

  // Compute per-round resource production/consumption for a faction.
  // Fixed row order: Gold, Labour, Basic Food, Security.
  _factionFlows(f) {
    const sub  = f.subclass || ''
    const name = f.name || ''
    const isResidential    = f.type === 'district' && (name === 'Residential' || /Residential/i.test(name))
    const isLabourProducer = isResidential && /Slums|Middle/i.test(sub)
    const isMarket         = f.type === 'district' && name === 'Market'
    const isNonResidential = f.type === 'district' && !isResidential
    const isLeadership     = f.type === 'leadership'

    const produces = {}, consumes = {}

    // Gold upkeep — all factions
    consumes.Gold = f.upkeep ?? 5

    // Labour
    if (isLabourProducer)                 produces.Labour = 15
    if (isNonResidential || isLeadership) consumes.Labour = isLeadership ? 20 : 10

    // Basic Food — residential districts
    if (isResidential) {
      const food = Math.max(1, Math.floor((f.health ?? 70) / 2))
      produces['Basic Food'] = food
      consumes['Basic Food'] = 10
    }

    // Market: produces Gold. 2× when not producing other resources.
    if (isMarket) {
      const producingOther = Object.keys(produces).some(r => r !== 'Gold')
      produces.Gold = producingOther ? 10 : 20
    }

    // Security — demand set by events
    if (f.securityDemand) consumes.Security = f.securityDemand

    return { produces, consumes }
  }

  _renderResourceGraph(body, factions, guildStanding) {
    const SVG_NS = 'http://www.w3.org/2000/svg'
    const RES_ORDER  = ['Gold', 'Labour', 'Basic Food', 'Security']
    const RES_COLORS = { Gold: '#ffd700', Labour: '#8888d8', 'Basic Food': '#70c860', Security: '#ff8040' }
    const THRESHOLD  = 70

    // Build node data for all factions (known + always-visible leadership)
    const nodes = factions.map(f => ({
      f,
      flows: this._factionFlows(f),
      known: f.type === 'leadership' || (guildStanding[f.id] ?? 50) >= THRESHOLD
    }))

    // Layout: 3-column grid, centre each row
    const COLS = 3, NW = 190, NH = 104, GX = 28, GY = 36, PAD = 16
    const rows = Math.ceil(nodes.length / COLS)
    const W = 740, H = rows * (NH + GY) + PAD * 2

    nodes.forEach((n, i) => {
      const col = i % COLS, row = Math.floor(i / COLS)
      const countInRow = Math.min(COLS, nodes.length - row * COLS)
      const rowW = countInRow * NW + (countInRow - 1) * GX
      const x0 = (W - rowW) / 2
      n.x  = x0 + col * (NW + GX)
      n.y  = PAD + row * (NH + GY)
      n.cx = n.x + NW / 2
      n.cy = n.y + NH / 2
    })

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.setAttribute('width', '100%')
    svg.setAttribute('style', 'display:block')

    const mkEl = (tag, attrs = {}) => {
      const el = document.createElementNS(SVG_NS, tag)
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
      return el
    }

    // ── Edges: resource flow producer → consumer ───────────────────────────────
    for (const res of RES_ORDER) {
      const color = RES_COLORS[res]
      const producers = nodes.filter(n => n.flows.produces[res] && n.known)
      const consumers = nodes.filter(n => n.flows.consumes[res])
      for (const p of producers) {
        for (const c of consumers) {
          if (p === c) continue  // skip self-loops
          // Offset parallel lines slightly per resource
          const idx = RES_ORDER.indexOf(res)
          const offX = (idx - 1.5) * 2.5
          svg.appendChild(mkEl('line', {
            x1: p.cx + offX, y1: p.cy,
            x2: c.cx + offX, y2: c.cy,
            stroke: color, 'stroke-width': '1.5', opacity: '0.4',
            'marker-end': `url(#arr-${res.replace(' ', '')})`
          }))
        }
      }
    }

    // Arrow markers
    for (const res of RES_ORDER) {
      const id = `arr-${res.replace(' ', '')}`
      const marker = mkEl('marker', { id, markerWidth: '6', markerHeight: '6', refX: '5', refY: '3', orient: 'auto' })
      const arrow  = mkEl('path',   { d: 'M0,0 L0,6 L6,3 z', fill: RES_COLORS[res], opacity: '0.6' })
      marker.appendChild(arrow)
      const defs = mkEl('defs', {})
      defs.appendChild(marker)
      svg.appendChild(defs)
    }

    // ── Nodes ──────────────────────────────────────────────────────────────────
    for (const n of nodes) {
      const { f, flows, x, y, cx } = n
      const fColor = _factionCssColor(f)
      const nm = f.subclass ? `${f.name}: ${f.subclass}` : f.name

      // Card background
      svg.appendChild(mkEl('rect', { x, y, width: NW, height: NH, rx: 3, fill: '#0b0b0b', stroke: fColor, 'stroke-width': '1.5' }))

      // Name
      const nameEl = mkEl('text', { x: cx, y: y + 13, 'font-size': '8.5', fill: '#ddd', 'text-anchor': 'middle', 'font-weight': 'bold' })
      nameEl.textContent = nm.length > 24 ? nm.slice(0, 23) + '…' : nm
      svg.appendChild(nameEl)

      // Divider
      svg.appendChild(mkEl('line', { x1: x + 4, y1: y + 17, x2: x + NW - 4, y2: y + 17, stroke: fColor, 'stroke-width': '0.5', opacity: '0.5' }))

      // Resource rows in fixed order
      let ly = y + 27
      for (const res of RES_ORDER) {
        const prod = flows.produces[res] ?? 0
        const cons = flows.consumes[res] ?? 0
        if (prod === 0 && cons === 0) { ly += 17; continue }
        const color = RES_COLORS[res]

        // Resource name
        const rLabel = mkEl('text', { x: x + 6, y: ly, 'font-size': '7.5', fill: color, opacity: n.known ? '1' : '0.4' })
        rLabel.textContent = res
        svg.appendChild(rLabel)

        // Production (green +)
        const prodEl = mkEl('text', { x: x + NW - 52, y: ly, 'font-size': '7.5', fill: '#4ade80', 'text-anchor': 'end' })
        prodEl.textContent = n.known && prod ? `+${prod}` : ''
        svg.appendChild(prodEl)

        // Consumption (red -)
        const consEl = mkEl('text', { x: x + NW - 6, y: ly, 'font-size': '7.5', fill: '#f87171', 'text-anchor': 'end' })
        consEl.textContent = n.known && cons ? `−${cons}` : (n.known ? '' : '?')
        svg.appendChild(consEl)

        ly += 17
      }
    }

    // Legend
    const legY = H - 10
    let lx = 8
    for (const res of RES_ORDER) {
      const color = RES_COLORS[res]
      svg.appendChild(mkEl('line', { x1: lx, y1: legY, x2: lx + 14, y2: legY, stroke: color, 'stroke-width': '2' }))
      const lt = mkEl('text', { x: lx + 18, y: legY + 4, 'font-size': '7.5', fill: '#666' })
      lt.textContent = res
      svg.appendChild(lt)
      lx += res.length * 5 + 30
    }

    body.appendChild(svg)
  }

  _tabHeadquarters(body) {
    const confirmedHq = this.hq || this.guild?.headquarters
    const pending = this._pendingHq
    const UPG_CAT_COLORS = { Defensive: '#7090c0', Economic: '#c8a040', Political: '#a080d0', Member: '#60a0e0', Intelligence: '#7fd', Prestige: '#e07060' }
    const ownedUpgrades = new Set(this.guild?.hqUpgrades || [])
    const gold = this.guild?.resources?.Gold ?? 0

    const mkPickBtn = () => {
      const btn = document.createElement('button')
      btn.textContent = 'Choose Headquarters'
      btn.style.cssText = btnCss + ';background:#333;border:1px solid #666'
      btn.addEventListener('click', () => this.eventBus.emit('GUILD_HQ_PICK_START'))
      return btn
    }

    const mkSnapshot = (snapshot) => {
      if (snapshot) {
        const img = document.createElement('img')
        img.src = snapshot
        img.style.cssText = 'width:240px;height:150px;object-fit:cover;border-radius:4px;flex-shrink:0;border:1px solid #333'
        return img
      }
      const box = document.createElement('div')
      box.style.cssText = 'width:240px;height:150px;background:#111;border:1px solid #222;border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0'
      box.innerHTML = '<span style="color:#333;font-size:11px">No snapshot</span>'
      return box
    }

    // ── State: pending preview (building clicked, not yet applied) ──────────
    if (pending) {
      const distName = this._districtFactionName(pending.districtId)
      const kindLabel = pending.kind === 'plot' ? `Plot ${pending.refId}` : `Landmark ${pending.refId}`

      const infoEl = document.createElement('div')
      infoEl.style.cssText = 'margin-bottom:10px'
      infoEl.innerHTML = `<div style="font-size:15px;font-weight:bold;margin-bottom:2px">${this._esc(distName || 'Unknown District')}</div>`
        + `<div style="color:#666;font-size:10px;margin-bottom:3px">${this._esc(kindLabel)}</div>`
        + `<div style="color:#7fd;font-size:11px">+30 Influence · +20 Standing with district faction</div>`
      body.appendChild(infoEl)

      body.appendChild(mkSnapshot(this._pendingSnapshot))

      const btnRow = document.createElement('div')
      btnRow.style.cssText = 'display:flex;gap:8px;margin-top:12px'
      btnRow.appendChild(mkPickBtn())
      const applyBtn = document.createElement('button')
      applyBtn.textContent = 'Apply'
      applyBtn.style.cssText = btnCss + ';background:#2a5a2a;border:1px solid #4a9a4a;font-weight:bold'
      applyBtn.addEventListener('click', () => this.eventBus.emit('HQ_APPLY', pending))
      btnRow.appendChild(applyBtn)
      body.appendChild(btnRow)
      return
    }

    // ── State: no HQ confirmed yet ─────────────────────────────────────────
    if (!confirmedHq) {
      const info = document.createElement('div')
      info.textContent = 'No Headquarters chosen.'
      info.style.cssText = 'color:#666;margin-bottom:12px'
      body.appendChild(info)
      body.appendChild(mkPickBtn())
      return
    }

    // ── State: confirmed HQ ─────────────────────────────────────────────────
    const hq = confirmedHq
    const distName = this._districtFactionName(hq.districtId)
    const kindLabel = hq.kind === 'plot'
      ? (hq.refId != null ? `Plot ${hq.refId}` : 'Plot')
      : (hq.refId != null ? `Landmark ${hq.refId}` : 'Landmark')

    const infoEl = document.createElement('div')
    infoEl.style.cssText = 'margin-bottom:10px'
    infoEl.innerHTML = `<div style="font-size:15px;font-weight:bold;margin-bottom:2px">${this._esc(distName)}</div>`
      + `<div style="color:#666;font-size:10px;margin-bottom:3px">${this._esc(kindLabel)}</div>`
      + `<div style="color:#7fd;font-size:11px">+30 Influence · +20 Standing with district faction</div>`
    body.appendChild(infoEl)

    // ── Snapshot + owned upgrades side by side ─────────────────────────────
    const snapRow = document.createElement('div')
    snapRow.style.cssText = 'display:flex;gap:10px;margin-bottom:12px;align-items:flex-start'

    snapRow.appendChild(mkSnapshot(this._hqSnapshot))

    // Owned upgrades (right)
    const ownedCol = document.createElement('div')
    ownedCol.style.cssText = 'flex:1;min-width:0'
    if (ownedUpgrades.size === 0) {
      ownedCol.innerHTML = '<div style="color:#333;font-size:10px;font-style:italic">No upgrades purchased.</div>'
    } else {
      const ownedHdr = document.createElement('div')
      ownedHdr.style.cssText = 'font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px'
      ownedHdr.textContent = 'Owned Upgrades'
      ownedCol.appendChild(ownedHdr)
      for (const id of ownedUpgrades) {
        const u = UPGRADE_BY_ID.get(id)
        if (!u) continue
        const catColor = UPG_CAT_COLORS[u.category] || '#aaa'
        const row = document.createElement('div')
        row.style.cssText = `display:flex;align-items:center;gap:5px;font-size:10px;color:${catColor};padding:2px 0`
        row.innerHTML = `<span style="color:#4a8a4a">✓</span> ${this._esc(u.title)}`
        ownedCol.appendChild(row)
      }
    }
    snapRow.appendChild(ownedCol)
    body.appendChild(snapRow)

    // ── Change HQ button + note ────────────────────────────────────────────
    body.appendChild(mkPickBtn())
    const rehouseNote = document.createElement('div')
    rehouseNote.style.cssText = 'font-size:10px;color:#555;margin-top:6px;margin-bottom:18px;line-height:1.5'
    rehouseNote.textContent = 'Changing your HQ costs 2 Monthly Actions and forfeits all HQ Upgrades.'
    body.appendChild(rehouseNote)

    // ── Available HQ Upgrades ─────────────────────────────────────────────────
    const upgHdr = document.createElement('div')
    upgHdr.style.cssText = 'font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px'
    upgHdr.textContent = 'Available Upgrades'
    body.appendChild(upgHdr)

    // Group by category
    const byCategory = {}
    for (const u of HQ_UPGRADES) {
      if (!byCategory[u.category]) byCategory[u.category] = []
      byCategory[u.category].push(u)
    }

    for (const [cat, upgrades] of Object.entries(byCategory)) {
      const catColor = UPG_CAT_COLORS[cat] || '#aaa'
      const catHdr = document.createElement('div')
      catHdr.style.cssText = `font-size:10px;color:${catColor};text-transform:uppercase;letter-spacing:1px;margin:10px 0 5px`
      catHdr.textContent = cat
      body.appendChild(catHdr)

      const grid = document.createElement('div')
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:5px'

      for (const upgrade of upgrades) {
        const isOwned = ownedUpgrades.has(upgrade.id)
        const isExpanded = this._expandedUpgradeId === upgrade.id
        const costGold = upgrade.cost.Gold ?? 0
        const canAfford = gold >= costGold
        const canBuy = !isOwned && canAfford

        const card = document.createElement('div')
        card.style.cssText = `background:#0d0d0d;border:1px solid ${isOwned ? '#2a3a2a' : isExpanded ? catColor + '88' : '#222'};border-radius:4px;overflow:hidden;cursor:pointer`

        if (!isOwned && !isExpanded) {
          card.addEventListener('mouseenter', () => { card.style.borderColor = catColor + '55' })
          card.addEventListener('mouseleave', () => { card.style.borderColor = '#222' })
        }
        card.addEventListener('click', () => {
          if (isOwned) return
          this._expandedUpgradeId = isExpanded ? null : upgrade.id
          this._render()
        })

        const row = document.createElement('div')
        row.style.cssText = `display:flex;${isOwned ? 'opacity:0.7' : ''}`

        const inner = document.createElement('div')
        inner.style.cssText = 'padding:8px;flex:1;min-width:0'

        const titleRow = document.createElement('div')
        titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:3px'
        const titleSpan = document.createElement('span')
        titleSpan.style.cssText = `font-size:11px;font-weight:bold;color:${isOwned ? '#4a8a4a' : '#ccc'}`
        titleSpan.textContent = upgrade.title
        titleRow.appendChild(titleSpan)
        if (!isOwned) {
          const arrow = document.createElement('span')
          arrow.style.cssText = `font-size:9px;color:${isExpanded ? catColor : '#444'};flex-shrink:0`
          arrow.textContent = isExpanded ? '▲' : '▼'
          titleRow.appendChild(arrow)
        } else {
          const tick = document.createElement('span')
          tick.style.cssText = 'font-size:10px;color:#4a8a4a;flex-shrink:0'
          tick.textContent = '✓'
          titleRow.appendChild(tick)
        }
        inner.appendChild(titleRow)

        const desc = document.createElement('div')
        if (isExpanded) {
          desc.style.cssText = 'font-size:10px;color:#aaa;line-height:1.5'
        } else {
          desc.style.cssText = 'font-size:10px;color:#555;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden'
        }
        desc.textContent = upgrade.description
        inner.appendChild(desc)

        if (isExpanded) {
          const costRow = document.createElement('div')
          costRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-top:8px'
          const costLbl = document.createElement('span')
          costLbl.style.cssText = `font-size:10px;color:${canAfford ? '#c8a040' : '#a04040'}`
          const costParts = Object.entries(upgrade.cost).map(([r, n]) => `${n} ${r}`).join(' + ')
          costLbl.textContent = costParts
          costRow.appendChild(costLbl)
          const btn = document.createElement('button')
          btn.textContent = !canAfford ? 'Cannot Afford' : 'Purchase'
          btn.disabled = !canBuy
          btn.style.cssText = `padding:4px 12px;border-radius:3px;font-size:10px;color:#fff;cursor:${canBuy ? 'pointer' : 'not-allowed'};background:${canBuy ? '#3a6a3a' : '#1a1a1a'};border:1px solid ${canBuy ? '#5a9a5a' : '#333'};opacity:${canBuy ? '1' : '0.5'}`
          btn.addEventListener('click', async e => {
            e.stopPropagation()
            if (!canBuy) return
            btn.disabled = true
            btn.textContent = 'Purchasing…'
            try {
              const res = await GameAPI.purchaseHQUpgrade(upgrade.id)
              if (res.ok) {
                if (res.guild) this.guild = res.guild
                this._expandedUpgradeId = null
                this._render()
              } else {
                btn.textContent = res.error || 'Failed'
                btn.disabled = false
              }
            } catch {
              btn.textContent = 'Error'
              btn.disabled = false
            }
          })
          costRow.appendChild(btn)
          inner.appendChild(costRow)
        }

        row.appendChild(inner)
        card.appendChild(row)
        grid.appendChild(card)
      }
      body.appendChild(grid)
    }
  }

  _tabSpecial(body) {
    if (!this.guild) { body.innerHTML = '<div style="color:#666">No guild yet.</div>'; return }

    const ownedIds = new Set(this.guild.traits || [])
    const hqType = this._hqDistrictType()
    const hasTokens = (this.tokens.guild ?? 0) >= 1

    // ── Owned traits ──────────────────────────────────────────────────────────
    if (ownedIds.size > 0) {
      const ownedHdr = document.createElement('div')
      ownedHdr.style.cssText = 'font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px'
      ownedHdr.textContent = `Owned — ${ownedIds.size}`
      body.appendChild(ownedHdr)

      const ownedGrid = document.createElement('div')
      ownedGrid.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-bottom:14px'
      for (const traitId of ownedIds) {
        const trait = TRAIT_BY_ID.get(traitId)
        if (!trait) continue
        const catColor = _traitCatColor(trait.category)
        const card = document.createElement('div')
        card.style.cssText = 'background:#0d0d0d;border:1px solid #2a3a2a;border-radius:4px;display:flex;overflow:hidden'
        if (trait.image) {
          const img = document.createElement('img')
          img.src = trait.image
          img.style.cssText = 'width:64px;height:64px;object-fit:cover;flex-shrink:0'
          img.alt = trait.title
          card.appendChild(img)
        }
        const inner = document.createElement('div')
        inner.style.cssText = 'padding:8px;flex:1;min-width:0'
        inner.innerHTML = `<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px">`
          + `<span style="font-size:12px;font-weight:bold;color:#ddd">${this._esc(trait.title)}</span>`
          + `<span style="font-size:9px;color:${catColor};background:#0a0a0a;border:1px solid ${catColor}33;border-radius:2px;padding:1px 5px;flex-shrink:0">${this._esc(trait.category)}</span>`
          + `</div>`
          + `<div style="font-size:11px;color:#888;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${this._esc(trait.description)}</div>`
        card.appendChild(inner)
        ownedGrid.appendChild(card)
      }
      body.appendChild(ownedGrid)

      const sep = document.createElement('div')
      sep.style.cssText = 'border-top:1px solid #1a1a1a;margin-bottom:12px'
      body.appendChild(sep)
    }

    // ── Available traits ──────────────────────────────────────────────────────
    const available = GUILD_TRAITS.filter(t => !ownedIds.has(t.id))
    if (available.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = 'color:#444;font-style:italic;font-size:12px;text-align:center;padding:20px 0'
      empty.textContent = 'All traits have been purchased.'
      body.appendChild(empty)
      return
    }

    const availHdr = document.createElement('div')
    availHdr.style.cssText = 'font-size:10px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px'
    availHdr.textContent = ownedIds.size === 0 ? 'Available traits — click to expand' : 'Available'
    body.appendChild(availHdr)

    const byCategory = {}
    for (const t of available) {
      if (!byCategory[t.category]) byCategory[t.category] = []
      byCategory[t.category].push(t)
    }

    for (const [cat, traits] of Object.entries(byCategory)) {
      const catHdr = document.createElement('div')
      catHdr.style.cssText = `font-size:10px;color:${_traitCatColor(cat)};text-transform:uppercase;letter-spacing:1px;margin:10px 0 6px`
      catHdr.textContent = cat
      body.appendChild(catHdr)

      const grid = document.createElement('div')
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:5px'

      for (const trait of traits) {
        const meetsReq = !trait.requiresHQType?.length || (hqType && trait.requiresHQType.includes(hqType))
        const catColor = _traitCatColor(trait.category)
        const isExpanded = this._expandedTraitId === trait.id
        const canBuy = hasTokens && meetsReq

        const card = document.createElement('div')
        card.style.cssText = `background:#0d0d0d;border:1px solid ${isExpanded ? catColor + '88' : '#222'};border-radius:4px;overflow:hidden;opacity:${meetsReq ? '1' : '0.5'};cursor:pointer`

        if (meetsReq && !isExpanded) {
          card.addEventListener('mouseenter', () => { card.style.borderColor = catColor + '55' })
          card.addEventListener('mouseleave', () => { card.style.borderColor = '#222' })
        }
        card.addEventListener('click', () => {
          this._expandedTraitId = isExpanded ? null : trait.id
          this._render()
        })

        if (isExpanded) {
          const expRow = document.createElement('div')
          expRow.style.cssText = 'display:flex'
          if (trait.image) {
            const img = document.createElement('img')
            img.src = trait.image
            img.style.cssText = 'width:90px;min-height:90px;object-fit:cover;flex-shrink:0;align-self:stretch'
            img.alt = trait.title
            expRow.appendChild(img)
          }

          const inner = document.createElement('div')
          inner.style.cssText = 'padding:10px;flex:1;min-width:0'

          const titleRow = document.createElement('div')
          titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:8px'
          const titleSpan = document.createElement('span')
          titleSpan.style.cssText = 'font-size:13px;font-weight:bold;color:#ddd'
          titleSpan.textContent = trait.title
          titleRow.appendChild(titleSpan)
          const arrow = document.createElement('span')
          arrow.style.cssText = `font-size:10px;color:${catColor};flex-shrink:0`
          arrow.textContent = '▲'
          titleRow.appendChild(arrow)
          inner.appendChild(titleRow)

          const desc = document.createElement('div')
          desc.style.cssText = 'font-size:11px;color:#aaa;line-height:1.6;margin-bottom:10px'
          desc.textContent = trait.description
          inner.appendChild(desc)

          if (trait.requiresHQType?.length) {
            const reqEl = document.createElement('div')
            reqEl.style.cssText = `font-size:10px;margin-bottom:10px;padding:5px 8px;border-radius:3px;background:#0a0a0a;border:1px solid ${meetsReq ? catColor + '44' : '#2a0a0a'};color:${meetsReq ? catColor : '#a04040'}`
            reqEl.textContent = meetsReq
              ? `✓ Requires HQ in ${trait.requiresHQType.join(' or ')} district — met`
              : `✗ Requires HQ in a ${trait.requiresHQType.join(' or ')} district`
            inner.appendChild(reqEl)
          }

          const purchaseRow = document.createElement('div')
          purchaseRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between'
          const costSpan = document.createElement('span')
          costSpan.style.cssText = 'font-size:10px;color:#555'
          costSpan.textContent = 'Cost: 1 Guild Token'
          purchaseRow.appendChild(costSpan)
          const btn = document.createElement('button')
          btn.textContent = !hasTokens ? 'No Tokens' : !meetsReq ? 'Wrong District' : 'Purchase'
          btn.disabled = !canBuy
          btn.style.cssText = `padding:6px 18px;border-radius:3px;font-size:11px;color:#fff;cursor:${canBuy ? 'pointer' : 'not-allowed'};background:${canBuy ? '#3a6a3a' : '#1a1a1a'};border:1px solid ${canBuy ? '#5a9a5a' : '#333'};opacity:${canBuy ? '1' : '0.5'}`
          btn.addEventListener('click', async e => {
            e.stopPropagation()
            if (!canBuy) return
            btn.disabled = true
            btn.textContent = 'Purchasing…'
            try {
              const res = await GameAPI.purchaseGuildTrait(trait.id)
              if (res.ok) {
                if (res.guild)  this.guild  = res.guild
                if (res.tokens) this.tokens = res.tokens
                this._expandedTraitId = null
                this._render()
              } else {
                btn.textContent = res.error || 'Failed'
                btn.disabled = false
              }
            } catch {
              btn.textContent = 'Error'
              btn.disabled = false
            }
          })
          purchaseRow.appendChild(btn)
          inner.appendChild(purchaseRow)
          expRow.appendChild(inner)
          card.appendChild(expRow)

        } else {
          // Collapsed: icon left, text right, fixed height
          card.style.height = '64px'
          const row = document.createElement('div')
          row.style.cssText = 'display:flex;height:100%'
          if (trait.image) {
            const img = document.createElement('img')
            img.src = trait.image
            img.style.cssText = 'width:64px;height:64px;object-fit:cover;flex-shrink:0'
            img.alt = trait.title
            row.appendChild(img)
          }
          const inner = document.createElement('div')
          inner.style.cssText = 'padding:7px 8px;flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center'
          const titleRow = document.createElement('div')
          titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:3px'
          const titleSpan = document.createElement('span')
          titleSpan.style.cssText = `font-size:11px;font-weight:bold;color:${meetsReq ? '#ccc' : '#555'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`
          titleSpan.textContent = trait.title
          titleRow.appendChild(titleSpan)
          const arrow = document.createElement('span')
          arrow.style.cssText = 'font-size:9px;color:#444;flex-shrink:0'
          arrow.textContent = '▼'
          titleRow.appendChild(arrow)
          inner.appendChild(titleRow)
          const desc = document.createElement('div')
          desc.style.cssText = 'font-size:10px;color:#555;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden'
          desc.textContent = trait.description
          inner.appendChild(desc)
          row.appendChild(inner)
          card.appendChild(row)
        }

        grid.appendChild(card)
      }
      body.appendChild(grid)
    }
  }

  _districtFactionName(districtId) {
    const f = this.factions.find(x => x.districtId === districtId)
    return f ? (f.subclass ? `${f.name}: ${f.subclass}` : f.name) : `District ${districtId ?? '?'}`
  }

  _hqDistrictType() {
    const hq = this.hq || this.guild?.headquarters
    const districtId = hq?.districtId ?? this._previewDistrictId ?? null
    if (districtId == null) return null
    return this.districts.find(x => x.id === districtId)?.assignedType ?? null
  }
}
