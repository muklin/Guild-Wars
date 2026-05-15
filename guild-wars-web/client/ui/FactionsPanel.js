const TYPE_COLORS = {
  district:   '#7aafff',
  terrain:    '#88cc88',
  trade:      '#ffcc44',
  leadership: '#cc88ff'
}

const TOP_RESOURCES    = ['Gold', 'Labour', 'Security']
const BOTTOM_RESOURCES = ['Water', 'Basic Food']
const ALL_PREDEFINED   = [...TOP_RESOURCES, ...BOTTOM_RESOURCES]

export default class FactionsPanel {
  constructor(eventBus) {
    this.eventBus = eventBus
    this.container = null
    this.threatsSection = null
    this.factionsSection = null
    this.resourcesSection = null
    this.guildDefined = false
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

    // ── Divider ──
    container.appendChild(this._divider())

    // ── Middle: Factions ──
    const factionsWrapper = document.createElement('div')
    factionsWrapper.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;padding:8px 10px 4px 10px'

    factionsWrapper.appendChild(this._sectionLabel('Factions'))
    this.factionsSection = document.createElement('div')
    this.factionsSection.style.cssText = 'flex:1;min-height:0;overflow-y:auto'
    factionsWrapper.appendChild(this.factionsSection)
    container.appendChild(factionsWrapper)

    // ── Divider ──
    container.appendChild(this._divider())

    // ── Bottom: Resources ──
    const resourcesWrapper = document.createElement('div')
    resourcesWrapper.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;padding:8px 10px 10px 10px'

    resourcesWrapper.appendChild(this._sectionLabel('Resources'))
    this.resourcesSection = document.createElement('div')
    this.resourcesSection.style.cssText = 'flex:1;min-height:0;overflow-y:auto'
    resourcesWrapper.appendChild(this.resourcesSection)
    container.appendChild(resourcesWrapper)

    this.updateThreats([])
    this.update([])
    this.updateResources([])
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
    if (!this.factionsSection) return
    this.factionsSection.innerHTML = ''

    if (factions.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No factions yet'
      empty.style.cssText = 'font-size:11px;color:#555;font-style:italic'
      this.factionsSection.appendChild(empty)
      return
    }

    // Leadership always rendered first (server guarantees order, but enforce visually)
    const sorted = [
      ...factions.filter(f => f.type === 'leadership'),
      ...factions.filter(f => f.type !== 'leadership')
    ]

    for (const faction of sorted) {
      const item = document.createElement('div')
      item.style.cssText = 'margin-bottom:5px;padding:5px 6px;background:#1a1a2a;border:1px solid #2a2a3a;border-radius:3px;cursor:default'

      const title = faction.subclass
        ? `${faction.name}: ${faction.subclass}`
        : faction.name
      const name = document.createElement('div')
      name.textContent = title
      name.title = title
      name.style.cssText = 'font-size:11px;color:#ccc;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      item.appendChild(name)

      item.addEventListener('mouseenter', () => {
        item.style.background = '#252535'
        this.eventBus?.emit('FACTION_HOVER', faction)
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = '#1a1a2a'
        this.eventBus?.emit('FACTION_HOVER_END')
      })

      this.factionsSection.appendChild(item)
    }
  }

  updateResources(resources = []) {
    if (!this.resourcesSection) return
    this.resourcesSection.innerHTML = ''

    const predefinedLower = ALL_PREDEFINED.map(d => d.toLowerCase())
    const allResources = [
      ...TOP_RESOURCES,
      ...resources.filter(r => !predefinedLower.includes(r.toLowerCase())),
      ...BOTTOM_RESOURCES
    ]

    for (const resource of allResources) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:3px 6px;margin-bottom:2px;background:#1a1a1a;border-radius:2px'

      const nameEl = document.createElement('span')
      nameEl.textContent = resource
      nameEl.style.cssText = 'font-size:11px;color:#ccc'
      row.appendChild(nameEl)

      if (this.guildDefined) {
        const qty = document.createElement('span')
        qty.textContent = '0'
        qty.style.cssText = 'font-size:11px;color:#888'
        row.appendChild(qty)
      }

      this.resourcesSection.appendChild(row)
    }
  }

  setGuildDefined(defined) {
    this.guildDefined = defined
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
