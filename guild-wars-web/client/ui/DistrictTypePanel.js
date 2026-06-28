import TerrainColors from '../rendering/TerrainColors.js'
import NameDialog from './NameDialog.js'
import ResourceDialog from './ResourceDialog.js'

const DISTRICT_TYPES = [
  'Residential', 'Market',
  'Religious', 'Military',
  'Magical', 'Entertainment',
  'Industry'
]
const RESIDENTIAL_CLASSES = ['Slums', 'Middle', 'Noble']
const RULING_BODY_CLASSES = ['Monarchy', 'Republic', 'Tyrant', 'Oligarchy', 'Theocracy', 'Anarchist']
const CITY_EDGE_TYPES = [
  { type: 'Wall',     maxCount: 3 },
  { type: 'MainRoad', maxCount: 3 },
  { type: 'Canal',    maxCount: 3 },
  { type: 'Docks',    maxCount: Infinity, nearWaterOnly: true }
]

// Terrain district actions shown in the picker
const TERRAIN_DISTRICT_ACTIONS = [
  { action: 'Agriculture', label: 'Agriculture', types: ['Plains'],       color: '#2a3a1a', border: '#6a9c40' },
  { action: 'Forestry',   label: 'Forestry',    types: ['Forest'],       color: '#1a2a1a', border: '#4a7a4a' },
  { action: 'Mining',     label: 'Mines',        types: ['Hills'],        color: '#2a2a1a', border: '#7a7a3a' },
  { action: 'Fishing',    label: 'Fishing',      types: ['Lake', 'Sea'],  color: '#1a2a3a', border: '#3a7aaa' },
]
const TERRAIN_EDGE_ACTIONS = [
  { action: 'Threat',  label: 'Threat',      color: '#3a1010', border: '#994444' },
  { action: 'Trade',   label: 'Trade Route', color: '#3a3010', border: '#998800' },
]

const PANEL_GAP = 16
const PANEL_WIDTH = 220

export default class DistrictTypePanel {
  constructor(eventBus, renderer) {
    this.eventBus = eventBus
    this.renderer = renderer
    this._anchorPoints = []
    this._el = null
    this._cameraCB = null
    // Resource selection state — reset when type or context changes
    this._cityConsumed = []
    this._cityProduced = []
    this._lastCityPendingType = null
    this._terrainConsumed = []
    this._terrainProduced = null
    this._lastTerrainKey = null
    this._tradeBuys = []
    this._tradeSells = []
    this._lastTradeRegionId = null
    this._build()
  }

  _build() {
    const el = document.createElement('div')
    el.style.cssText = [
      'position:fixed', 'z-index:25', `width:${PANEL_WIDTH}px`,
      'background:#000', 'border:2px solid #444', 'border-radius:4px',
      'color:#fff', 'font-family:Arial', 'padding:10px',
      'box-sizing:border-box', 'display:none', 'pointer-events:auto',
      'overflow-y:auto', 'max-height:80vh'
    ].join(';')
    el.addEventListener('click',     (e) => e.stopPropagation())
    el.addEventListener('mousedown', (e) => e.stopPropagation())
    document.body.appendChild(el)
    this._el = el

    this._cameraCB = () => this._reposition()
    this.renderer.addCameraMoveCallback(this._cameraCB)
  }

  setAnchorPoints(pts) {
    this._anchorPoints = pts
  }

  _reposition() {
    if (this._el.style.display === 'none') return
    if (!this._anchorPoints?.length) return

    const pts = this._anchorPoints.map(p => this.renderer.worldToScreen(p.x, 0, p.y))
    const minX = Math.min(...pts.map(p => p.x))
    const maxX = Math.max(...pts.map(p => p.x))
    const minY = Math.min(...pts.map(p => p.y))
    const maxY = Math.max(...pts.map(p => p.y))
    const midY = (minY + maxY) / 2
    const midX = (minX + maxX) / 2

    const panelH = this._el.offsetHeight || 300
    const margin = 8

    const rightLeft = maxX + PANEL_GAP
    if (rightLeft + PANEL_WIDTH < window.innerWidth - margin) {
      this._el.style.left = rightLeft + 'px'
      this._el.style.top  = Math.max(margin, Math.min(midY - panelH / 2, window.innerHeight - panelH - margin)) + 'px'
    } else {
      this._el.style.left = Math.max(margin, Math.min(midX - PANEL_WIDTH / 2, window.innerWidth - PANEL_WIDTH - margin)) + 'px'
      this._el.style.top  = Math.max(margin, minY - panelH - PANEL_GAP) + 'px'
    }
  }

  showContext(type, options = {}) {
    if (!this._el) return
    this._el.innerHTML = ''

    if (type === 'none') {
      this._el.style.display = 'none'
      return
    }

    // Close button
    const closeRow = document.createElement('div')
    closeRow.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:4px'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.title = 'Close'
    closeBtn.style.cssText = 'background:none;border:none;color:#666;cursor:pointer;font-size:13px;line-height:1;padding:0'
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#ccc' })
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#666' })
    closeBtn.addEventListener('click', () => this.showContext('none'))
    closeRow.appendChild(closeBtn)
    this._el.appendChild(closeRow)

    const main = document.createElement('div')
    if (type === 'district') {
      this._buildDistrictContent(main, options)
    } else if (type === 'cityEdge') {
      this._buildCityEdgeContent(main, options)
    } else if (type === 'terrainRegion') {
      this._buildTerrainRegionContent(main, options)
    }
    this._el.appendChild(main)

    this._el.style.display = 'block'
    this._reposition()
  }

  // Legacy no-ops — kept so existing call sites don't crash
  render() {}
  addFinishButton() {}

  // ── Section builders ──────────────────────────────────────────────────────

  _buildTerrainRegionContent(container, options) {
    const {
      regionType, isEdge = false, hasDistrict = false,
      pendingAction = null, regionId, plotId,
      resourceRegistry = [], usedProducedResources = []
    } = options

    if (!regionType) return

    // Header row — label + back button when in sub-state
    const headerRow = document.createElement('div')
    headerRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px'

    if (pendingAction) {
      const backBtn = document.createElement('button')
      backBtn.textContent = '← Back'
      backBtn.style.cssText = 'background:none;border:1px solid #555;color:#aaa;cursor:pointer;border-radius:3px;padding:2px 7px;font-size:10px;flex-shrink:0'
      backBtn.addEventListener('click', () => this.eventBus.emit('TERRAIN_ACTION_BACK'))
      headerRow.appendChild(backBtn)
    }

    const label = document.createElement('div')
    label.textContent = regionType + ' Region'
    label.style.cssText = 'font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:1px;font-weight:bold'
    headerRow.appendChild(label)
    container.appendChild(headerRow)

    // ── Picker: no pending action ──
    if (!pendingAction) {
      const grid = document.createElement('div')
      grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:4px'

      for (const { action, label, types, color, border } of TERRAIN_DISTRICT_ACTIONS) {
        const enabled = !hasDistrict && types.includes(regionType)
        const btn = document.createElement('button')
        btn.textContent = label
        btn.disabled = !enabled
        btn.title = !enabled
          ? (hasDistrict ? 'Region already has a district' : `Only for ${types.join('/')} terrain`)
          : label
        btn.style.cssText = `padding:7px 4px;background:${enabled ? color : '#1e1e1e'};border:2px solid ${enabled ? border : '#333'};color:${enabled ? '#fff' : '#444'};cursor:${enabled ? 'pointer' : 'not-allowed'};border-radius:3px;font-size:11px`
        if (enabled) btn.addEventListener('click', () => this.eventBus.emit('TERRAIN_ACTION_SELECT', { action }))
        grid.appendChild(btn)
      }

      for (const { action, label, color, border } of TERRAIN_EDGE_ACTIONS) {
        const enabled = !!isEdge
        const btn = document.createElement('button')
        btn.textContent = label
        btn.disabled = !enabled
        btn.title = enabled ? label : 'Only available on boundary regions'
        btn.style.cssText = `padding:7px 4px;background:${enabled ? color : '#1e1e1e'};border:2px solid ${enabled ? border : '#333'};color:${enabled ? '#fff' : '#444'};cursor:${enabled ? 'pointer' : 'not-allowed'};border-radius:3px;font-size:11px`
        if (enabled) btn.addEventListener('click', () => this.eventBus.emit('TERRAIN_ACTION_SELECT', { action }))
        grid.appendChild(btn)
      }

      container.appendChild(grid)
      return
    }

    // ── Threat form ──
    if (pendingAction === 'Threat') {
      const applyBtn = document.createElement('button')
      applyBtn.textContent = 'Apply Threat'
      applyBtn.style.cssText = 'width:100%;padding:7px;background:#6b1a1a;color:#fff;border:1px solid #994444;border-radius:3px;cursor:pointer;font-weight:bold;font-size:12px'
      applyBtn.addEventListener('click', () => {
        applyBtn.disabled = true
        applyBtn.style.opacity = '0.6'
        applyBtn.style.cursor = 'default'
        const dialog = new NameDialog({
          entityKind: 'threat', entityLabel: 'Threat', subType: 'Threat',
          onApply: (name, description) => {
            this.eventBus.emit('TERRAIN_THREAT_APPLY', { name, description })
          },
          onCancel: () => {
            applyBtn.disabled = false
            applyBtn.style.opacity = '1'
            applyBtn.style.cursor = 'pointer'
          }
        })
        dialog.open()
      })
      container.appendChild(applyBtn)
      return
    }

    // ── Trade form ──
    if (pendingAction === 'Trade') {
      if (regionId !== this._lastTradeRegionId) {
        this._tradeBuys = []
        this._tradeSells = []
        this._lastTradeRegionId = regionId
      }

      const tradeSection = document.createElement('div')
      container.appendChild(tradeSection)

      const renderTradeSection = () => {
        tradeSection.innerHTML = ''

        const localNewNames = [...this._tradeBuys, ...this._tradeSells]
          .filter(r => r.isNew).map(r => r.name)
        const extendedRegistry = [
          ...resourceRegistry,
          ...localNewNames.filter(n => !resourceRegistry.some(r => r.toLowerCase() === n.toLowerCase()))
        ]

        const makeTradeGroup = (label, items, setItems, otherItems) => {
          const section = document.createElement('div')
          section.appendChild(this._fieldLabel(label))
          const pills = document.createElement('div')
          pills.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px'
          for (const item of items) {
            pills.appendChild(this._resourcePill(item.name, () => {
              setItems(items.filter(r => r !== item))
              renderTradeSection()
            }))
          }
          section.appendChild(pills)
          if (items.length < 3) {
            section.appendChild(this._addResourceButton(`Add ${label}`, () => {
              new ResourceDialog({
                mode: 'consumed',
                showSpec: false,
                titleOverride: `Add ${label}`,
                resourceRegistry: extendedRegistry,
                usedProduced: [],
                alreadySelected: [...items, ...otherItems].map(r => r.name),
                onAdd: item => { setItems([...items, item]); renderTradeSection() }
              }).open()
            }))
          }
          return section
        }

        tradeSection.appendChild(makeTradeGroup(
          'Buys (Resources or Services In)',
          this._tradeBuys,
          v => { this._tradeBuys = v },
          this._tradeSells
        ))
        tradeSection.appendChild(makeTradeGroup(
          'Sells (Resources or Services Out)',
          this._tradeSells,
          v => { this._tradeSells = v },
          this._tradeBuys
        ))
      }

      renderTradeSection()

      const warn = document.createElement('div')
      warn.style.cssText = 'font-size:10px;color:#ff6666;margin-bottom:4px;display:none'
      container.appendChild(warn)

      const applyBtn = document.createElement('button')
      applyBtn.textContent = 'Apply Trade Route'
      applyBtn.style.cssText = 'width:100%;padding:7px;background:#6b5a1a;color:#fff;border:1px solid #998800;border-radius:3px;cursor:pointer;font-weight:bold;font-size:12px'
      applyBtn.addEventListener('click', () => {
        const buys = this._tradeBuys.map(r => r.name)
        const sells = this._tradeSells.map(r => r.name)
        if (buys.length < 1) { warn.textContent = 'Select at least one resource or service to buy.'; warn.style.display = 'block'; return }
        if (sells.length < 1) { warn.textContent = 'Select at least one resource or service to sell.'; warn.style.display = 'block'; return }
        warn.style.display = 'none'
        applyBtn.disabled = true
        applyBtn.style.opacity = '0.6'
        applyBtn.style.cursor = 'default'
        const dialog = new NameDialog({
          entityKind: 'trade', entityLabel: 'Trade Route', subType: 'Trade Route',
          onApply: (name, description) => {
            this.eventBus.emit('TERRAIN_TRADE_APPLY', { name, description, buys, sells })
          },
          onCancel: () => {
            applyBtn.disabled = false
            applyBtn.style.opacity = '1'
            applyBtn.style.cursor = 'pointer'
          }
        })
        dialog.open()
      })
      container.appendChild(applyBtn)
      return
    }

    // ── District form (Agriculture / Forestry / Mining / Fishing) ──
    const districtType = pendingAction

    const typeRow = document.createElement('div')
    typeRow.textContent = `${districtType} District`
    typeRow.style.cssText = 'font-size:12px;color:#ccc;font-weight:bold;margin-bottom:8px'
    container.appendChild(typeRow)

    // Reset terrain state when region/action changes
    const terrainKey = `${regionId}:${districtType}`
    if (terrainKey !== this._lastTerrainKey) {
      this._terrainConsumed = []
      this._terrainProduced = null
      this._lastTerrainKey = terrainKey
    }

    const terrainConsumedSection = document.createElement('div')
    const terrainProducedSection = document.createElement('div')

    const renderTerrainResources = () => {
      terrainConsumedSection.innerHTML = ''
      terrainProducedSection.innerHTML = ''

      const localNewNames = [...this._terrainConsumed, ...(this._terrainProduced ? [this._terrainProduced] : [])]
        .filter(r => r.isNew).map(r => r.name)
      const extendedRegistry = [
        ...resourceRegistry,
        ...localNewNames.filter(n => !resourceRegistry.some(r => r.toLowerCase() === n.toLowerCase()))
      ]

      terrainConsumedSection.appendChild(this._fieldLabel('Consumed Resources or Services'))
      const consPills = document.createElement('div')
      consPills.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px'
      for (const item of this._terrainConsumed) {
        consPills.appendChild(this._resourcePill(item.name, () => {
          this._terrainConsumed = this._terrainConsumed.filter(r => r !== item)
          renderTerrainResources()
        }))
      }
      terrainConsumedSection.appendChild(consPills)
      if (this._terrainConsumed.length < 3) {
        terrainConsumedSection.appendChild(this._addResourceButton('Add Consumed Resource or Service', () => {
          new ResourceDialog({
            mode: 'consumed',
            resourceRegistry: extendedRegistry,
            usedProduced: [],
            alreadySelected: this._terrainConsumed.map(r => r.name),
            onAdd: item => { this._terrainConsumed.push(item); renderTerrainResources() }
          }).open()
        }))
      }

      terrainProducedSection.appendChild(this._fieldLabel('Produced Resource or Service'))
      if (this._terrainProduced) {
        const prodPills = document.createElement('div')
        prodPills.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px'
        prodPills.appendChild(this._resourcePill(this._terrainProduced.name, () => {
          this._terrainProduced = null
          renderTerrainResources()
        }))
        terrainProducedSection.appendChild(prodPills)
      } else {
        terrainProducedSection.appendChild(this._addResourceButton('Add Produced Resource or Service', () => {
          new ResourceDialog({
            mode: 'produced',
            resourceRegistry: extendedRegistry,
            usedProduced: usedProducedResources,
            alreadySelected: [],
            consumedResources: this._terrainConsumed.map(r => r.name),
            onAdd: item => { this._terrainProduced = item; renderTerrainResources() }
          }).open()
        }))
      }
    }

    renderTerrainResources()
    container.appendChild(terrainConsumedSection)
    container.appendChild(terrainProducedSection)

    const implicitNote = document.createElement('div')
    implicitNote.textContent = 'Always consumed: Water, Basic Food'
    implicitNote.style.cssText = 'font-size:10px;color:#555;font-style:italic;margin-bottom:5px'
    container.appendChild(implicitNote)

    const validWarn = document.createElement('div')
    validWarn.style.cssText = 'font-size:10px;color:#ff6666;margin-bottom:4px;display:none'
    container.appendChild(validWarn)

    const applyBtn = document.createElement('button')
    applyBtn.textContent = `Apply: ${districtType}`
    applyBtn.style.cssText = 'width:100%;padding:7px;background:#2a3a2a;color:#fff;border:1px solid #4a7c59;border-radius:3px;cursor:pointer;font-weight:bold;font-size:12px'
    applyBtn.addEventListener('click', () => {
      const produced = this._terrainProduced?.name || ''
      const consumed = this._terrainConsumed.map(r => r.name)
      if (!produced) { validWarn.textContent = 'Must define at least one produced resource or service.'; validWarn.style.display = 'block'; return }
      if (consumed.length < 2) { validWarn.textContent = 'Must define at least 2 consumed resources or services.'; validWarn.style.display = 'block'; return }
      validWarn.style.display = 'none'
      applyBtn.disabled = true
      applyBtn.style.opacity = '0.6'
      applyBtn.style.cursor = 'default'
      const resourceDefs = [...this._terrainConsumed, this._terrainProduced].filter(r => r?.isNew)
      const dialog = new NameDialog({
        entityKind: 'terrain-district', entityLabel: districtType, subType: districtType, producedResource: produced,
        onApply: (name, description) => {
          this.eventBus.emit('TERRAIN_DISTRICT_ASSIGN', { regionId, plotId, districtType, description, producedResource: produced, consumedResources: consumed, name, resourceDefs })
        },
        onCancel: () => {
          applyBtn.disabled = false
          applyBtn.style.opacity = '1'
          applyBtn.style.cursor = 'pointer'
        }
      })
      dialog.open()
    })
    container.appendChild(applyBtn)
  }

  // A "Regenerate streets" button — reshuffles the district's street layout without
  // touching the resources/description form. Shown once a type (and class) is chosen.
  _regenerateStreetsButton() {
    const btn = document.createElement('button')
    btn.textContent = '↻ Regenerate streets'
    btn.style.cssText = 'width:100%;padding:6px;background:#5a3a1a;color:#ffb84d;border:1px solid #8a5a2a;border-radius:3px;cursor:pointer;font-size:11px;margin-bottom:6px'
    btn.addEventListener('click', () => this.eventBus.emit('DISTRICT_REGENERATE'))
    return btn
  }

  _buildDistrictContent(container, { pendingType, residentialClass = null, LeadershipClass = null, resourceRegistry = [], usedProducedResources = [] }) {
    // Leadership district shows only the class picker — skip the type grid
    if (pendingType === 'Leadership') {
      container.appendChild(this._sectionLabel('Leadership Class'))
      const classGrid = document.createElement('div')
      classGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px'
      for (const cls of RULING_BODY_CLASSES) {
        const clsColor = TerrainColors.get(cls)
        const hex = '#' + clsColor.toString(16).padStart(6, '0')
        const isActiveClass = cls === LeadershipClass
        const btn = document.createElement('button')
        btn.textContent = cls
        btn.style.cssText = `padding:6px 4px;background:${isActiveClass ? hex : '#2a2a2a'};border:2px solid ${hex};color:#fff;cursor:pointer;border-radius:3px;font-size:10px`
        btn.addEventListener('click', () => this.eventBus.emit('DISTRICT_RULING_BODY_CLASS', { LeadershipClass: cls }))
        classGrid.appendChild(btn)
      }
      container.appendChild(classGrid)
      if (!LeadershipClass) return

      container.appendChild(this._regenerateStreetsButton())

      const clsColor = TerrainColors.get(LeadershipClass)
      const applyHex = '#' + clsColor.toString(16).padStart(6, '0')
      const applyBtn = document.createElement('button')
      applyBtn.textContent = `Apply: ${LeadershipClass}`
      applyBtn.style.cssText = `width:100%;padding:7px;background:${applyHex};color:#fff;border:none;cursor:pointer;border-radius:3px;font-weight:bold;font-size:12px`
      applyBtn.addEventListener('click', () => {
        applyBtn.disabled = true
        applyBtn.style.opacity = '0.6'
        applyBtn.style.cursor = 'default'
        const dialog = new NameDialog({
          entityKind: 'district', entityLabel: 'Leadership', subType: 'Leadership',
          onApply: (name, description) => {
            this.eventBus.emit('DISTRICT_APPLY', { description, producedResource: '', consumedResources: [], residentialClass: null, LeadershipClass, name })
          },
          onCancel: () => {
            applyBtn.disabled = false
            applyBtn.style.opacity = '1'
            applyBtn.style.cursor = 'pointer'
          }
        })
        dialog.open()
      })
      container.appendChild(applyBtn)
      return
    }

    container.appendChild(this._sectionLabel('District Type'))

    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px'
    for (const type of DISTRICT_TYPES) {
      const color = TerrainColors.get(type)
      const hex = '#' + color.toString(16).padStart(6, '0')
      const isActive = type === pendingType
      const btn = document.createElement('button')
      btn.textContent = type
      btn.style.cssText = `padding:5px 4px;background:${isActive ? hex : '#2a2a2a'};border:2px solid ${hex};color:#fff;cursor:pointer;border-radius:3px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`
      btn.addEventListener('click', () => this.eventBus.emit('DISTRICT_TYPE_PREVIEW', type))
      grid.appendChild(btn)
    }
    container.appendChild(grid)

    if (!pendingType) return

    if (pendingType === 'Residential') {
      // ── Class sub-picker ──
      container.appendChild(this._sectionLabel('Residential Class'))
      const classRow = document.createElement('div')
      classRow.style.cssText = 'display:flex;gap:4px;margin-bottom:8px'
      for (const cls of RESIDENTIAL_CLASSES) {
        const clsColor = TerrainColors.get(cls)
        const hex = '#' + clsColor.toString(16).padStart(6, '0')
        const isActiveClass = cls === residentialClass
        const btn = document.createElement('button')
        btn.textContent = cls
        btn.style.cssText = `flex:1;padding:6px 2px;background:${isActiveClass ? hex : '#2a2a2a'};border:2px solid ${hex};color:#fff;cursor:pointer;border-radius:3px;font-size:10px`
        btn.addEventListener('click', () => this.eventBus.emit('DISTRICT_RESIDENTIAL_CLASS', { residentialClass: cls }))
        classRow.appendChild(btn)
      }
      container.appendChild(classRow)
      if (!residentialClass) return
    }

    // ── Resource or Service form ──
    const isResidential = pendingType === 'Residential'
    const isNoble = isResidential && residentialClass === 'Noble'
    const isIndustry = pendingType === 'Industry'
    const isMarket = pendingType === 'Market'
    const maxConsumed = isIndustry ? 5 : 3
    const maxProduced = isIndustry ? 2 : 1

    // Reset state when type changes
    if (pendingType !== this._lastCityPendingType) {
      this._cityConsumed = []
      this._cityProduced = []
      this._lastCityPendingType = pendingType
    }

    const renderResourceSection = () => {
      consumedSection.innerHTML = ''
      producedSection.innerHTML = ''

      // Merge locally-pending new resources into the registry so each dialog
      // can see resources defined in the same editing session (not yet submitted).
      const localNewNames = [...this._cityConsumed, ...this._cityProduced]
        .filter(r => r.isNew).map(r => r.name)
      const extendedRegistry = [
        ...resourceRegistry,
        ...localNewNames.filter(n => !resourceRegistry.some(r => r.toLowerCase() === n.toLowerCase()))
      ]

      // ── Consumed ──
      consumedSection.appendChild(this._fieldLabel(`Consumed Resources or Services${isIndustry ? ' (up to 5)' : ''}`))
      const consPills = document.createElement('div')
      consPills.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px'
      for (const item of this._cityConsumed) {
        consPills.appendChild(this._resourcePill(item.name, () => {
          this._cityConsumed = this._cityConsumed.filter(r => r !== item)
          renderResourceSection()
        }))
      }
      consumedSection.appendChild(consPills)

      if (this._cityConsumed.length < maxConsumed) {
        const addBtn = this._addResourceButton('Add Consumed Resource or Service', () => {
          new ResourceDialog({
            mode: 'consumed',
            resourceRegistry: extendedRegistry,
            usedProduced: [],
            alreadySelected: this._cityConsumed.map(r => r.name),
            onAdd: item => { this._cityConsumed.push(item); renderResourceSection() }
          }).open()
        })
        consumedSection.appendChild(addBtn)
      }

      // ── Produced ──
      if (!isResidential) {
        producedSection.appendChild(this._fieldLabel(isIndustry ? 'Produced Resources or Services (up to 2)' : 'Produced Resource or Service'))
        const prodPills = document.createElement('div')
        prodPills.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px'
        for (const item of this._cityProduced) {
          prodPills.appendChild(this._resourcePill(item.name, () => {
            this._cityProduced = this._cityProduced.filter(r => r !== item)
            renderResourceSection()
          }))
        }
        producedSection.appendChild(prodPills)

        if (this._cityProduced.length < maxProduced) {
          const usedForDialog = isMarket
            ? usedProducedResources.filter(r => r !== 'gold')
            : usedProducedResources
          const addProdBtn = this._addResourceButton('Add Produced Resource or Service', () => {
            new ResourceDialog({
              mode: 'produced',
              resourceRegistry: extendedRegistry,
              usedProduced: usedForDialog,
              alreadySelected: this._cityProduced.map(r => r.name),
              consumedResources: this._cityConsumed.map(r => r.name),
              isMarket,
              onAdd: item => { this._cityProduced.push(item); renderResourceSection() }
            }).open()
          })
          producedSection.appendChild(addProdBtn)
        }

        const goldNote = document.createElement('div')
        goldNote.textContent = isMarket
          ? 'Note: Markets can produce Gold directly (sells consumed items at +10%)'
          : 'Note: always produces Gold (automatic)'
        goldNote.style.cssText = 'font-size:10px;color:#aa8800;font-style:italic;margin-bottom:3px'
        producedSection.appendChild(goldNote)
      }
    }

    const consumedSection = document.createElement('div')
    const producedSection = document.createElement('div')
    renderResourceSection()
    container.appendChild(consumedSection)
    container.appendChild(producedSection)

    const implicitNote = document.createElement('div')
    implicitNote.textContent = 'Always consumed: Water, Basic Food'
    implicitNote.style.cssText = 'font-size:10px;color:#555;font-style:italic;margin-bottom:5px'
    container.appendChild(implicitNote)

    const color = TerrainColors.get(isResidential ? (residentialClass || 'Residential') : pendingType)
    const hex = '#' + color.toString(16).padStart(6, '0')
    const label = isResidential ? `Residential (${residentialClass})` : pendingType

    const validWarn = document.createElement('div')
    validWarn.style.cssText = 'font-size:10px;color:#ff6666;margin-bottom:4px;display:none'
    container.appendChild(validWarn)

    container.appendChild(this._regenerateStreetsButton())

    const applyBtn = document.createElement('button')
    applyBtn.textContent = `Apply: ${label}`
    applyBtn.style.cssText = `width:100%;padding:7px;background:${hex};color:#fff;border:none;cursor:pointer;border-radius:3px;font-weight:bold;font-size:12px`
    applyBtn.addEventListener('click', () => {
      const produced = isResidential ? '' : (this._cityProduced[0]?.name || '')
      const produced2 = isIndustry ? (this._cityProduced[1]?.name || '') : ''
      const consumed = this._cityConsumed.map(r => r.name)
      if (!isResidential && !isNoble && !produced) { validWarn.textContent = 'Must define a produced resource or service (in addition to Gold).'; validWarn.style.display = 'block'; return }
      if (!isMarket && produced.toLowerCase() === 'gold') { validWarn.textContent = 'Gold is produced automatically — choose a different resource or service.'; validWarn.style.display = 'block'; return }
      if (produced && produced2 && produced.toLowerCase() === produced2.toLowerCase()) { validWarn.textContent = 'Cannot produce the same resource or service twice.'; validWarn.style.display = 'block'; return }
      const minConsumed = (isIndustry && produced2) ? 5 : (!isResidential ? 2 : 0)
      if (minConsumed && consumed.length < minConsumed) {
        validWarn.textContent = produced2
          ? 'Must consume 5 Resources or Services when producing 2.'
          : 'Must consume at least 2 Resources or Services.'
        validWarn.style.display = 'block'; return
      }
      validWarn.style.display = 'none'
      applyBtn.disabled = true
      applyBtn.style.opacity = '0.6'
      applyBtn.style.cursor = 'default'
      const resourceDefs = [...this._cityConsumed, ...this._cityProduced].filter(r => r.isNew)
      const dialog = new NameDialog({
        entityKind: 'district', entityLabel: label, subType: pendingType, producedResource: produced || produced2,
        onApply: (name, description) => {
          this.eventBus.emit('DISTRICT_APPLY', { description, producedResource: produced, secondProducedResource: produced2, consumedResources: consumed, residentialClass: isResidential ? residentialClass : null, name, resourceDefs })
        },
        onCancel: () => {
          applyBtn.disabled = false
          applyBtn.style.opacity = '1'
          applyBtn.style.cursor = 'pointer'
        }
      })
      dialog.open()
    })
    container.appendChild(applyBtn)
  }

  _buildCityEdgeContent(container, { edgeCount, pendingType, nearWater = false }) {
    container.appendChild(this._sectionLabel(`${edgeCount} Edge${edgeCount > 1 ? 's' : ''} Selected`))

    const hint = document.createElement('div')
    hint.textContent = 'Click connected edges to add to selection.'
    hint.style.cssText = 'font-size:10px;color:#777;margin-bottom:6px;line-height:1.4'
    container.appendChild(hint)

    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px'
    for (const { type, maxCount, nearWaterOnly } of CITY_EDGE_TYPES) {
      if (edgeCount > maxCount) continue
      const disabled = nearWaterOnly && !nearWater
      const color = TerrainColors.get(type)
      const hex = '#' + color.toString(16).padStart(6, '0')
      const isActive = type === pendingType
      const label = type === 'MainRoad' ? 'Main Road' : type
      const btn = document.createElement('button')
      btn.textContent = label
      btn.disabled = disabled
      btn.title = disabled
        ? 'Docks require adjacency to Sea, Lake, or River'
        : maxCount < Infinity ? `${label} (max ${maxCount} continuous)` : label
      btn.style.cssText = `padding:6px 4px;background:${isActive ? hex : '#2a2a2a'};border:2px solid ${disabled ? '#444' : hex};color:${disabled ? '#555' : '#fff'};cursor:${disabled ? 'not-allowed' : 'pointer'};border-radius:3px;font-size:11px`
      if (!disabled) btn.addEventListener('click', () => this.eventBus.emit('CITY_EDGE_TYPE_PREVIEW', type))
      grid.appendChild(btn)
    }
    container.appendChild(grid)

    if (pendingType) {
      const color = TerrainColors.get(pendingType)
      const hex = '#' + color.toString(16).padStart(6, '0')
      const displayType = pendingType === 'MainRoad' ? 'Main Road' : pendingType
      const applyBtn = document.createElement('button')
      applyBtn.textContent = `Apply: ${displayType}`
      applyBtn.style.cssText = `width:100%;padding:7px;margin-top:6px;background:${hex};color:#fff;border:none;cursor:pointer;border-radius:3px;font-weight:bold;font-size:12px`
      applyBtn.addEventListener('click', () => {
        applyBtn.disabled = true
        applyBtn.style.opacity = '0.6'
        applyBtn.style.cursor = 'default'
        const dialog = new NameDialog({
          entityKind: 'cityEdge', entityLabel: displayType, subType: pendingType,
          onApply: (name, description) => {
            this.eventBus.emit('CITY_EDGE_APPLY', { description, name })
          },
          onCancel: () => {
            applyBtn.disabled = false
            applyBtn.style.opacity = '1'
            applyBtn.style.cursor = 'pointer'
          }
        })
        dialog.open()
      })
      container.appendChild(applyBtn)
    }
  }

  // ── Bottom list builders (no Add buttons — actions are now in terrain picker) ─

  _buildThreatList(container, { threats = [] }) {
    container.appendChild(this._sectionLabel('Threats'))
    if (threats.length > 0) {
      const list = document.createElement('div')
      list.style.cssText = 'max-height:52px;overflow-y:auto'
      for (const t of threats) {
        const item = document.createElement('div')
        item.textContent = `• ${t.name || 'Threat'}${t.description ? ' – ' + t.description : ''}`
        item.title = t.description || ''
        item.style.cssText = 'font-size:10px;color:#ff6666;margin-bottom:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
        list.appendChild(item)
      }
      container.appendChild(list)
    }
  }

  _buildTradeList(container, { tradingDestinations = [] }) {
    container.appendChild(this._sectionLabel('Trade Routes'))
    if (tradingDestinations.length > 0) {
      const list = document.createElement('div')
      list.style.cssText = 'max-height:52px;overflow-y:auto'
      for (const t of tradingDestinations) {
        const item = document.createElement('div')
        item.textContent = `• ${t.terrainType || 'Region'} ${t.regionId}`
        item.style.cssText = 'font-size:10px;color:#ffcc00;margin-bottom:1px'
        list.appendChild(item)
      }
      container.appendChild(list)
    }
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  _divider() {
    const d = document.createElement('div')
    d.style.cssText = 'border-top:1px solid #333;margin:5px 0'
    return d
  }

  _sectionLabel(text) {
    const el = document.createElement('div')
    el.textContent = text
    el.style.cssText = 'font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;font-weight:bold'
    return el
  }

  _fieldLabel(text) {
    const el = document.createElement('div')
    el.textContent = text
    el.style.cssText = 'margin-bottom:2px;margin-top:4px;font-size:10px;color:#777;text-transform:uppercase;letter-spacing:0.5px'
    return el
  }

  _resourcePill(name, onRemove) {
    const pill = document.createElement('div')
    pill.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:#1a2a1a;border:1px solid #4a7c59;border-radius:12px;padding:2px 8px 2px 10px;font-size:11px;color:#cfc'
    const label = document.createElement('span')
    label.textContent = name
    const x = document.createElement('button')
    x.textContent = '×'
    x.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:13px;line-height:1;padding:0;margin:0'
    x.addEventListener('click', onRemove)
    pill.appendChild(label)
    pill.appendChild(x)
    return pill
  }

  _addResourceButton(label, onClick) {
    const btn = document.createElement('button')
    btn.textContent = `+ ${label}`
    btn.style.cssText = 'width:100%;padding:5px 8px;background:#1a3a1a;color:#8f8;border:1px solid #4a7c59;border-radius:4px;cursor:pointer;font-size:11px;text-align:left;margin-bottom:4px'
    btn.addEventListener('mouseenter', () => { btn.style.background = '#2a4a2a' })
    btn.addEventListener('mouseleave', () => { btn.style.background = '#1a3a1a' })
    btn.addEventListener('click', onClick)
    return btn
  }
}
