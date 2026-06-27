import { DISTRICT_COLORS } from '../rendering/DistrictRenderer.js'

const POS_KEY = 'gw.factionsPanel.pos'

function _loadPos() {
  try { return JSON.parse(localStorage.getItem(POS_KEY)) } catch { return null }
}
function _savePos(x, y) {
  try { localStorage.setItem(POS_KEY, JSON.stringify({ x, y })) } catch { /* ignore */ }
}

const TYPE_COLORS = {
  district:   '#7aafff',
  terrain:    '#88cc88',
  trade:      '#ffcc44',
  leadership: '#cc88ff'
}

function factionColorHex(faction) {
  if (faction.type === 'leadership') return DISTRICT_COLORS.get(faction.subclass) ?? DISTRICT_COLORS.Leadership
  if (faction.type === 'district')   return (faction.subclass && DISTRICT_COLORS.get(faction.subclass)) || DISTRICT_COLORS.get(faction.typeName) || DISTRICT_COLORS.Residential
  if (faction.type === 'terrain')    return 0x6a9b5a
  if (faction.type === 'trade')      return 0xd4a017
  return DISTRICT_COLORS.Neutral
}
const toCss = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0')
const contrastText = (n) => (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150 ? '#161616' : '#fff'

// Factions panel — self-contained draggable floating window.
// Call show() / hide() / toggle() from UIManager. The internal content area is
// the same as before; only the mounting has changed.
export default class FactionsPanel {
  constructor(eventBus) {
    this.eventBus = eventBus
    this._root = null
    this._contentEl = null
    this.threatsSection = null
    this.factionsSection = null
    this._guild = null
    this._factions = []
  }

  // Build and mount the floating window into document.body.
  render() {
    const root = document.createElement('div')
    root.id = 'factions-panel'
    root.style.cssText = [
      'position:fixed', 'z-index:25',
      'width:220px',
      'background:#0d0d0d', 'border:1px solid #444', 'border-radius:6px',
      'color:#fff', 'font-family:Arial,sans-serif', 'font-size:12px',
      'display:none', 'pointer-events:auto', 'user-select:none',
      'box-shadow:0 4px 20px rgba(0,0,0,0.7)',
      'flex-direction:column', 'overflow:hidden'
    ].join(';')

    root.addEventListener('click',     (e) => e.stopPropagation())
    root.addEventListener('mousedown', (e) => e.stopPropagation())

    // ── Title bar / drag handle ──
    const titleBar = document.createElement('div')
    titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#1a1a1a;border-bottom:1px solid #333;border-radius:6px 6px 0 0;cursor:move;flex-shrink:0'

    const titleText = document.createElement('span')
    titleText.textContent = 'Factions'
    titleText.style.cssText = 'font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:1px;font-weight:bold'

    const closeBtn = document.createElement('button')
    closeBtn.textContent = '×'
    closeBtn.style.cssText = 'background:none;border:none;color:#777;font-size:18px;cursor:pointer;padding:0;line-height:1'
    closeBtn.addEventListener('click', () => this.hide())

    titleBar.appendChild(titleText)
    titleBar.appendChild(closeBtn)
    root.appendChild(titleBar)

    // ── Scrollable content area ──
    const content = document.createElement('div')
    content.style.cssText = 'display:flex;flex-direction:column;overflow:hidden;padding:0;flex:1;min-height:0'
    root.appendChild(content)
    this._contentEl = content

    // ── Threats section ──
    const threatWrapper = document.createElement('div')
    threatWrapper.style.cssText = 'flex:0 0 auto;max-height:25%;min-height:60px;display:flex;flex-direction:column;padding:8px 10px 4px 10px'
    threatWrapper.appendChild(this._sectionLabel('Threats'))
    this.threatsSection = document.createElement('div')
    this.threatsSection.style.cssText = 'overflow-y:auto;flex:1'
    threatWrapper.appendChild(this.threatsSection)
    content.appendChild(threatWrapper)

    content.appendChild(this._divider())

    // ── Factions section ──
    const factionsWrapper = document.createElement('div')
    factionsWrapper.style.cssText = 'flex:1;min-height:100px;display:flex;flex-direction:column;padding:8px 10px 8px 10px'
    factionsWrapper.appendChild(this._sectionLabel('Factions'))
    this.factionsSection = document.createElement('div')
    this.factionsSection.style.cssText = 'flex:1;min-height:0;overflow-y:auto'
    factionsWrapper.appendChild(this.factionsSection)
    content.appendChild(factionsWrapper)

    document.body.appendChild(root)
    this._root = root
    this._makeDraggable(titleBar)

    this.updateThreats([])
    this.update([])
  }

  show() {
    if (!this._root) return
    const saved = _loadPos()
    if (saved) {
      this._root.style.left   = saved.x + 'px'
      this._root.style.top    = saved.y + 'px'
      this._root.style.right  = 'auto'
      this._root.style.bottom = 'auto'
    } else {
      this._root.style.left   = '20px'
      this._root.style.top    = '50px'
      this._root.style.right  = 'auto'
      this._root.style.bottom = 'auto'
    }
    this._root.style.display = 'flex'
  }

  hide() {
    if (this._root) this._root.style.display = 'none'
  }

  toggle() {
    if (!this._root) return
    if (this._root.style.display === 'none' || !this._root.style.display) {
      this.show()
    } else {
      this.hide()
    }
  }

  setGuild(guild) {
    this._guild = guild
    this._rebuildFactions()
  }

  updateThreats(threats = []) {
    if (!this.threatsSection) return
    this.threatsSection.innerHTML = ''
    if (threats.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No threats yet'
      empty.style.cssText = 'font-size:11px;color:#555;font-style:italic'
      this.threatsSection.appendChild(empty)
      return
    }
    for (const t of threats) {
      const item = document.createElement('div')
      item.style.cssText = 'margin-bottom:3px;padding:3px 6px;background:#2a1010;border:1px solid #552222;border-radius:3px'
      const label = document.createElement('div')
      label.textContent = `${t.name || 'Threat'}${t.description ? ' — ' + t.description : ''}`
      label.title = t.description || ''
      label.style.cssText = 'font-size:10px;color:#ff8888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      item.appendChild(label)
      this.threatsSection.appendChild(item)
    }
  }

  update(factions = []) {
    this._factions = factions
    this._rebuildFactions()
  }

  _rebuildFactions() {
    if (!this.factionsSection) return
    this.factionsSection.innerHTML = ''
    const factions = this._factions || []

    if (!this._guild && factions.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No factions yet'
      empty.style.cssText = 'font-size:11px;color:#555;font-style:italic'
      this.factionsSection.appendChild(empty)
      return
    }

    const sorted = [
      ...factions.filter(f => f.type === 'leadership'),
      ...factions.filter(f => f.type !== 'leadership')
    ]

    for (const faction of sorted) {
      this.factionsSection.appendChild(this._factionItem(faction, factionColorHex(faction)))
    }

    if (this._guild) {
      const g = this._guild
      const colorNum = parseInt((g.color || '#4c4').replace('#', ''), 16)
      this.factionsSection.appendChild(this._factionItem(
        { name: g.name || 'Our Guild', health: g.health ?? 100, _isGuild: true, headquarters: g.headquarters ?? null },
        isNaN(colorNum) ? 0x44cc44 : colorNum
      ))
    }
  }

  _factionItem(faction, colorNum) {
    const item = document.createElement('div')
    item.style.cssText = `margin-bottom:5px;padding:5px 8px;background:${toCss(colorNum)};border:1px solid rgba(0,0,0,0.35);border-radius:3px;cursor:default;transition:filter 0.1s`

    const typePart = faction.typeName || ''
    const playerName = faction.name || ''
    const title = faction._isGuild
      ? (playerName || 'Our Guild')
      : playerName
        ? (typePart ? `${playerName} — ${typePart}` : playerName)
        : (typePart || 'Faction')
    const name = document.createElement('div')
    name.textContent = title
    name.title = title
    name.style.cssText = `font-size:11px;color:${contrastText(colorNum)};font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`
    item.appendChild(name)

    const health = faction.health ?? 70
    const healthBar = document.createElement('div')
    healthBar.style.cssText = 'position:relative;height:3px;background:#0d0d0d;border:1px solid #242424;border-radius:3px;margin-top:4px;overflow:visible'
    const healthFill = document.createElement('div')
    healthFill.style.cssText = `position:absolute;left:0;top:0;height:100%;width:${health}%;background:#22c55e;border-radius:3px;transition:width 0.3s`
    const healthPill = document.createElement('div')
    healthPill.style.cssText = 'position:absolute;right:-5px;top:50%;transform:translateY(-50%);width:10px;height:4px;border-radius:2px;background:#4ade80;box-shadow:0 0 6px 3px #4ade8066'
    healthFill.appendChild(healthPill)
    healthBar.appendChild(healthFill)
    item.appendChild(healthBar)

    if (!faction._isGuild) {
      item.addEventListener('mouseenter', () => {
        item.style.filter = 'brightness(1.25)'
        this.eventBus?.emit('FACTION_HOVER', faction)
      })
      item.addEventListener('mouseleave', () => {
        item.style.filter = 'none'
        this.eventBus?.emit('FACTION_HOVER_END')
      })
    } else {
      item.style.cursor = 'pointer'
      item.addEventListener('mouseenter', () => {
        item.style.filter = 'brightness(1.25)'
        if (faction.headquarters) this.eventBus?.emit('GUILD_FACTION_HOVER', faction.headquarters)
      })
      item.addEventListener('mouseleave', () => {
        item.style.filter = 'none'
        this.eventBus?.emit('GUILD_FACTION_HOVER_END')
      })
      item.addEventListener('click', () => {
        if (faction.headquarters) this.eventBus?.emit('GUILD_FACTION_CLICK', faction.headquarters)
      })
      item.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        this.eventBus?.emit('GUILD_FACTION_DBLCLICK')
      })
    }

    return item
  }

  _makeDraggable(handle) {
    const root = this._root
    let startX, startY, startLeft, startTop
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const rect = root.getBoundingClientRect()
      startX = e.clientX; startY = e.clientY
      startLeft = rect.left; startTop = rect.top
      let didDrag = false
      const onMove = (e) => {
        didDrag = true
        root.style.left   = (startLeft + (e.clientX - startX)) + 'px'
        root.style.top    = (startTop  + (e.clientY - startY)) + 'px'
        root.style.right  = 'auto'
        root.style.bottom = 'auto'
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        if (didDrag) {
          _savePos(parseInt(root.style.left), parseInt(root.style.top))
          const suppress = (e) => { e.stopPropagation(); document.removeEventListener('click', suppress, true) }
          document.addEventListener('click', suppress, true)
        }
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
  }

  _sectionLabel(text) {
    const el = document.createElement('div')
    el.textContent = text
    el.style.cssText = 'font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;font-weight:bold;flex-shrink:0'
    return el
  }

  _divider() {
    const d = document.createElement('div')
    d.style.cssText = 'flex-shrink:0;border-top:1px solid #444'
    return d
  }
}
