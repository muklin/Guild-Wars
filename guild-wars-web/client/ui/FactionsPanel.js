import { DISTRICT_COLORS } from '../rendering/DistrictRenderer.js'

const TYPE_COLORS = {
  district:   '#7aafff',
  terrain:    '#88cc88',
  trade:      '#ffcc44',
  leadership: '#cc88ff'
}

function factionColorHex(faction) {
  if (faction.type === 'leadership') return DISTRICT_COLORS.get(faction.subclass) ?? DISTRICT_COLORS.Leadership
  if (faction.type === 'district')   return (faction.subclass && DISTRICT_COLORS.get(faction.subclass)) || DISTRICT_COLORS.get(faction.name) || DISTRICT_COLORS.Residential
  if (faction.type === 'terrain')    return 0x6a9b5a
  if (faction.type === 'trade')      return 0xd4a017
  return DISTRICT_COLORS.Neutral
}
const toCss = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0')
const contrastText = (n) => (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150 ? '#161616' : '#fff'

export default class FactionsPanel {
  constructor(eventBus) {
    this.eventBus = eventBus
    this.container = null
    this.threatsSection = null
    this.factionsSection = null
    this._guild = null
  }

  setGuild(guild) {
    this._guild = guild
    this._rebuildFactions()
  }

  render(container) {
    this.container = container
    container.style.display = 'flex'
    container.style.flexDirection = 'column'
    container.style.overflow = 'hidden'
    container.style.padding = '0'

    // ── Top: Threats ──
    const threatWrapper = document.createElement('div')
    threatWrapper.style.cssText = 'flex:0 0 auto;max-height:25%;min-height:60px;display:flex;flex-direction:column;padding:8px 10px 4px 10px'
    threatWrapper.appendChild(this._sectionLabel('Threats'))
    this.threatsSection = document.createElement('div')
    this.threatsSection.style.cssText = 'overflow-y:auto;flex:1'
    threatWrapper.appendChild(this.threatsSection)
    container.appendChild(threatWrapper)

    container.appendChild(this._divider())

    // ── Middle: Factions ──
    const factionsWrapper = document.createElement('div')
    factionsWrapper.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;padding:8px 10px 4px 10px'
    factionsWrapper.appendChild(this._sectionLabel('Factions'))
    this.factionsSection = document.createElement('div')
    this.factionsSection.style.cssText = 'flex:1;min-height:0;overflow-y:auto'
    factionsWrapper.appendChild(this.factionsSection)
    container.appendChild(factionsWrapper)

    this.updateThreats([])
    this.update([])
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

    // Render factions
    for (const faction of sorted) {
      this.factionsSection.appendChild(this._factionItem(faction, factionColorHex(faction)))
    }

    // Render guild as last entry using its own color
    if (this._guild) {
      const g = this._guild
      const colorNum = parseInt((g.color || '#4c4').replace('#', ''), 16)
      this.factionsSection.appendChild(this._factionItem(
        { name: g.name || 'Our Guild', health: g.health ?? 100, _isGuild: true },
        isNaN(colorNum) ? 0x44cc44 : colorNum
      ))
    }
  }

  _factionItem(faction, colorNum) {
    const item = document.createElement('div')
    item.style.cssText = `margin-bottom:5px;padding:5px 8px;background:${toCss(colorNum)};border:1px solid rgba(0,0,0,0.35);border-radius:3px;cursor:default;transition:filter 0.1s`

    const title = faction.subclass ? `${faction.name}: ${faction.subclass}` : faction.name
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
    }

    return item
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
