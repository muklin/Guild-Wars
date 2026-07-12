import TerrainColors from '../rendering/TerrainColors.js'
import ResourceDialog from './ResourceDialog.js'
import NameDialog from './NameDialog.js'
import { DISTRICTS, DEFAULTS, districtConfigKey } from '../../shared/districtConfig.js'
import { makeDraggable } from './utils/draggable.js'

const DISTRICT_TYPES = [
  'Residential', 'Market',
  'Religious', 'Military',
  'Magical', 'Entertainment',
  'Industry', 'Leadership'
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
  // Trade Route removed — trade routes are only available via Foreign Powers, not terrain plots.
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
    // Resource selection state — reset when type or context changes. Consumption is
    // fully derived from produced Recipes (see App.js/SetupPhase.js) so only the
    // produced side is tracked here.
    this._cityProduced = []
    this._lastCityPendingType = null
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

  // Keeps the settings sub-panel flush to the right of this panel — shared by both
  // the camera-follow reposition and the drag-end handler (see _reposition/makeDraggable).
  _syncSettingsPanelPosition() {
    const sp = document.querySelector('.district-settings-panel')
    if (!sp) return
    const margin = 8
    const rect = this._el.getBoundingClientRect()
    sp.style.left = `${rect.right + 8}px`
    sp.style.top  = `${Math.max(margin, Math.min(rect.top, window.innerHeight - sp.offsetHeight - margin))}px`
  }

  _reposition() {
    if (this._userMoved) return
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

    // Keep the settings panel flush to the right of this panel as it repositions.
    this._syncSettingsPanelPosition()
  }

  showContext(type, options = {}) {
    if (!this._el) return
    this._el.innerHTML = ''

    // Close the settings panel whenever the main panel's context changes — this ensures
    // it closes on ✕, Apply, and when a new district is selected (which always calls
    // showContext again, resetting to that district's own overrides or defaults).
    document.querySelector('.district-settings-panel')?.remove()
    document.removeEventListener('mousedown', this._settingsOutsideClick)

    if (type === 'none') {
      this._el.style.display = 'none'
      this._userMoved = false   // next selection gets a fresh auto-position
      return
    }

    // Close button — also the drag handle for the whole panel.
    const closeRow = document.createElement('div')
    closeRow.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:4px;cursor:move'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.title = 'Close'
    closeBtn.style.cssText = 'background:none;border:none;color:#666;cursor:pointer;font-size:13px;line-height:1;padding:0'
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#ccc' })
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#666' })
    closeBtn.addEventListener('click', () => this.showContext('none'))
    closeRow.appendChild(closeBtn)
    this._el.appendChild(closeRow)
    makeDraggable(this._el, closeRow, {
      onDragEnd: () => { this._userMoved = true; this._syncSettingsPanelPosition() },
    })

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
      resourceRegistry = [], resourceDefinitions = {}, usedProducedResources = [],
      isAdjacentToCity = false, leadershipTaken = false
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

      // ── District types (City Expansion) ──────────────────────────────────────
      // Only shown at all when the server's eligiblePromotionPlotIds (Living Boundary,
      // server-authoritative) includes this plot — an ineligible plot shows no district
      // options rather than disabled ones. Clicking promotes it to a city District via
      // PROMOTE_TERRAIN_TO_DISTRICT → App._handlePromoteWithType.
      if (isAdjacentToCity) {
        const distSep = document.createElement('div')
        distSep.style.cssText = 'border-top:1px solid #2a2a2a;margin:8px 0 6px'
        container.appendChild(distSep)

        const distLabel = document.createElement('div')
        distLabel.textContent = 'City District'
        distLabel.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:0.8px;color:#555;margin-bottom:5px'
        container.appendChild(distLabel)

        const distGrid = document.createElement('div')
        distGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:3px'
        // Exactly one Leadership district is allowed city-wide — stop offering it here
        // once another district already has it.
        for (const type of DISTRICT_TYPES.filter(t => t !== 'Leadership' || !leadershipTaken)) {
          const color = TerrainColors.get(type)
          const hex = '#' + color.toString(16).padStart(6, '0')
          const btn = document.createElement('button')
          btn.textContent = type
          btn.title = `Promote to ${type} District`
          btn.style.cssText = `padding:4px 3px;background:#2a2a2a;border:1px solid ${hex};color:#ccc;cursor:pointer;border-radius:3px;font-size:9px`
          btn.addEventListener('click', () => {
            console.log('[DistrictTypePanel] promote click', type, 'plotId:', plotId)
            this.eventBus.emit('PROMOTE_TERRAIN_TO_DISTRICT', { plotId, pendingType: type })
          })
          distGrid.appendChild(btn)
        }
        container.appendChild(distGrid)
      }
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
        // Local (terrain-plot) threat only — Foreign Power threats already arrive
        // pre-named and use their own dialog (hideSuggestions) elsewhere.
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
                titleOverride: label,
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
          'Buys',
          this._tradeBuys,
          v => { this._tradeBuys = v },
          this._tradeSells
        ))
        tradeSection.appendChild(makeTradeGroup(
          'Sells',
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
        const resourceDefs = [...this._tradeBuys, ...this._tradeSells].filter(r => r.isNew)
        this.eventBus.emit('TERRAIN_TRADE_APPLY', { name: '', description: '', buys, sells, resourceDefs })
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
      this._terrainProduced = null
      this._lastTerrainKey = terrainKey
    }

    const terrainProducedSection = document.createElement('div')

    // Consumption is fully derived from the Recipe of what's produced (plus the always-
    // implicit Water + Basic Food upkeep below) — there is no manual consumed picker.
    const renderTerrainResources = () => {
      terrainProducedSection.innerHTML = ''

      const localNewNames = this._terrainProduced?.isNew ? [this._terrainProduced.name] : []
      const extendedRegistry = [
        ...resourceRegistry,
        ...localNewNames.filter(n => !resourceRegistry.some(r => r.toLowerCase() === n.toLowerCase()))
      ]

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
            resourceDefinitions,
            usedProduced: usedProducedResources,
            alreadySelected: [],
            onAdd: item => { this._terrainProduced = item; renderTerrainResources() }
          }).open()
        }))
      }
    }

    renderTerrainResources()
    container.appendChild(terrainProducedSection)

    const implicitNote = document.createElement('div')
    implicitNote.textContent = 'Always consumed each round: Water, Basic Food'
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
      if (!produced) { validWarn.textContent = 'Must define at least one produced resource or service.'; validWarn.style.display = 'block'; return }
      validWarn.style.display = 'none'
      applyBtn.disabled = true
      applyBtn.style.opacity = '0.6'
      applyBtn.style.cursor = 'default'
      const resourceDefs = [this._terrainProduced].filter(r => r?.isNew)
      const resourceWiring = resourceDefs.filter(r => r.wireIntoExisting).map(r => ({ resourceName: r.name, targetName: r.wireIntoExisting }))
      const dialog = new NameDialog({
        entityKind: 'terrain-district', entityLabel: districtType, subType: districtType, producedResource: produced,
        onApply: (name, description) => {
          this.eventBus.emit('TERRAIN_DISTRICT_ASSIGN', { regionId, plotId, districtType, description, producedResource: produced, name, resourceDefs, resourceWiring })
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

  // Row: [↻ Regenerate streets]  [⚙]
  // The cog opens the district settings dialog; regenerate reshuffles the layout.
  _regenerateStreetsRow(districtKey, configOverrides) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:4px;margin-bottom:6px'

    const regenBtn = document.createElement('button')
    regenBtn.textContent = '↻ Regenerate streets'
    regenBtn.style.cssText = 'flex:1;padding:6px;background:#5a3a1a;color:#ffb84d;border:1px solid #8a5a2a;border-radius:3px;cursor:pointer;font-size:11px'
    regenBtn.addEventListener('click', () => {
      document.querySelector('.district-settings-panel')?.remove()
      this.eventBus.emit('DISTRICT_REGENERATE')
    })

    const cogBtn = document.createElement('button')
    cogBtn.textContent = '⚙'
    cogBtn.title = 'District generation settings'
    const hasOverrides = configOverrides && Object.keys(configOverrides).length > 0
    cogBtn.style.cssText = `padding:6px 8px;background:${hasOverrides ? '#1a3a5a' : '#2a2a2a'};color:${hasOverrides ? '#4ab' : '#aaa'};border:1px solid ${hasOverrides ? '#4ab' : '#555'};border-radius:3px;cursor:pointer;font-size:13px`
    cogBtn.addEventListener('click', () => this._openSettingsDialog(districtKey, configOverrides))

    row.appendChild(regenBtn)
    row.appendChild(cogBtn)
    return row
  }

  // Settings dialog: editable street/block/plot generation params for this district.
  // Changed values are emitted as DISTRICT_SETTINGS_SAVE and (via Regenerate) as
  // DISTRICT_SETTINGS_REGENERATE. Overrides are stored on the district object and
  // applied by getDistrictConfig() when generating streets.
  _openSettingsDialog(districtKey, existingOverrides = {}) {
    document.querySelector('.district-settings-panel')?.remove()
    document.removeEventListener('mousedown', this._settingsOutsideClick)

    if (!document.getElementById('ds-range-style')) {
      const s = document.createElement('style'); s.id = 'ds-range-style'
      s.textContent = `.ds-dr{position:relative;height:14px;margin:2px 0 0}.ds-dr input[type=range]{position:absolute;top:0;left:0;width:100%;pointer-events:none;background:transparent;-webkit-appearance:none;appearance:none;height:14px;margin:0;padding:0}.ds-dr input[type=range]::-webkit-slider-runnable-track{height:2px;background:transparent}.ds-dr input[type=range]::-webkit-slider-thumb{pointer-events:all;cursor:pointer;-webkit-appearance:none;width:11px;height:11px;border-radius:50%;background:#4ab;border:1px solid #2a9;margin-top:-4px}.ds-dr input[type=range]::-moz-range-thumb{pointer-events:all;cursor:pointer;width:11px;height:11px;border-radius:50%;background:#4ab;border:1px solid #2a9}.ds-dr-track{position:absolute;top:50%;transform:translateY(-50%);left:0;right:0;height:2px;background:#2a2a2a;pointer-events:none;border-radius:1px}.ds-dr-fill{position:absolute;height:100%;background:#4ab;pointer-events:none;border-radius:1px}`
      document.head.appendChild(s)
    }

    const base = (districtKey && DISTRICTS[districtKey]) || DEFAULTS
    const baseBs = base.buildingStyle || {}
    const existBs = existingOverrides?.buildingStyle || {}
    const curBs = { ...baseBs, ...existBs }

    const mainRect = this._el.getBoundingClientRect()
    const panel = document.createElement('div')
    panel.className = 'district-settings-panel'
    panel.style.cssText = [
      'position:fixed', `left:${mainRect.right + 8}px`, `top:${mainRect.top}px`,
      'width:360px', 'background:#111', 'border:1px solid #555', 'border-radius:6px',
      'color:#fff', 'font-family:Arial', 'font-size:11px', 'padding:10px 12px',
      'z-index:26', 'pointer-events:auto', 'box-sizing:border-box',
      'max-height:90vh', 'overflow-y:auto',
      'transform:translateX(-12px)', 'opacity:0',
      'transition:transform 0.18s ease,opacity 0.18s ease',
    ].join(';')
    // Stop clicks on the settings panel from reaching the 3-D map but allow camera
    // drag/zoom — wheel and middle-click still fire on the canvas behind the panel.
    panel.addEventListener('click', e => e.stopPropagation())
    panel.addEventListener('mousedown', e => e.stopPropagation())
    requestAnimationFrame(() => { panel.style.transform = 'translateX(0)'; panel.style.opacity = '1' })

    const close = () => {
      panel.style.transform = 'translateX(-12px)'; panel.style.opacity = '0'
      setTimeout(() => panel.remove(), 180)
    }
    // Settings panel stays open until explicitly dismissed — no outside-click auto-close
    // so the user can scroll/zoom the map while keeping the settings open.

    // Title
    const titleRow = document.createElement('div')
    titleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px'
    const titleEl = document.createElement('div')
    titleEl.textContent = 'Customize District Settings'
    titleEl.style.cssText = 'font-size:11px;font-weight:bold;color:#ccc'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.style.cssText = 'background:none;border:none;color:#777;font-size:13px;cursor:pointer;padding:0;line-height:1'
    closeBtn.addEventListener('click', close)
    titleRow.appendChild(titleEl); titleRow.appendChild(closeBtn)
    panel.appendChild(titleRow)

    // Edits
    const edits = {}
    for (const k of ['streetType','street_width','street_spacing','block_density','xyRatio','street_alignment','square_threshhold','plotSpacing']) {
      if (k in existingOverrides) edits[k] = existingOverrides[k]
    }
    if (existBs.wingDepths) { edits.bs_wingDepths_min = Math.min(...existBs.wingDepths); edits.bs_wingDepths_max = Math.max(...existBs.wingDepths) }
    if (existBs.floors) { edits.bs_floors_min = Math.min(...Object.keys(existBs.floors).map(Number)); edits.bs_floors_max = Math.max(...Object.keys(existBs.floors).map(Number)) }
    if (existBs.roofRidgeHeight) { edits.bs_roofRidgeHeight_min = Math.min(...Object.keys(existBs.roofRidgeHeight).map(Number)); edits.bs_roofRidgeHeight_max = Math.max(...Object.keys(existBs.roofRidgeHeight).map(Number)) }
    if (existBs.roof) { for (const t of ['thatch','reed','slate']) if (t in existBs.roof) edits[`bs_roof_${t}`] = existBs.roof[t] }
    for (const k of ['woodChance','stoneChance','graniteChance','brickChance']) if (k in existBs) edits[`bs_${k}`] = existBs[k]

    const getOverrides = () => {
      const out = {}
      for (const k of ['streetType','street_width','street_spacing','block_density','xyRatio','street_alignment','square_threshhold','plotSpacing']) {
        if (k in edits) out[k] = edits[k]
      }
      const bs = {}
      const wMin = edits.bs_wingDepths_min ?? Math.min(...(baseBs.wingDepths||[2]))
      const wMax = edits.bs_wingDepths_max ?? Math.max(...(baseBs.wingDepths||[4]))
      if ('bs_wingDepths_min' in edits || 'bs_wingDepths_max' in edits) { const d=[]; for(let i=wMin;i<=wMax;i++) d.push(i); bs.wingDepths=d.length?d:(baseBs.wingDepths||[2,4]) }
      const baseFKeys = Object.keys(baseBs.floors||{1:1}).map(Number)
      const fMin = edits.bs_floors_min ?? Math.min(...baseFKeys)
      const fMax = edits.bs_floors_max ?? Math.max(...baseFKeys)
      if ('bs_floors_min' in edits || 'bs_floors_max' in edits) { const n=Math.max(1,fMax-fMin+1),f={}; for(let i=fMin;i<=fMax;i++) f[i]=parseFloat((1/n).toFixed(4)); bs.floors=f }
      const baseRRHKeys = Object.keys(baseBs.roofRidgeHeight||{0:1}).map(Number)
      const rrhMin = edits.bs_roofRidgeHeight_min ?? Math.min(...baseRRHKeys)
      const rrhMax = edits.bs_roofRidgeHeight_max ?? Math.max(...baseRRHKeys)
      if ('bs_roofRidgeHeight_min' in edits || 'bs_roofRidgeHeight_max' in edits) {
        // Heights are in floor-height units, half-unit steps (0, 0.5, 1, 1.5, 2 — matches
        // ParametricBuilding's riseHalfUnits quantization). Iterate half-unit integers to
        // avoid float drift, uniform chance across the selected range.
        const iMin = Math.round(rrhMin / 0.5), iMax = Math.round(rrhMax / 0.5)
        const n = Math.max(1, iMax - iMin + 1), rh = {}
        for (let i = iMin; i <= iMax; i++) rh[i * 0.5] = parseFloat((1 / n).toFixed(4))
        bs.roofRidgeHeight = rh
      }
      if (['thatch','reed','slate'].some(t=>`bs_roof_${t}` in edits)) {
        bs.roof = { thatch: edits.bs_roof_thatch??(curBs.roof?.thatch||0), reed: edits.bs_roof_reed??(curBs.roof?.reed||0), slate: edits.bs_roof_slate??(curBs.roof?.slate||0) }
      }
      for (const k of ['woodChance','stoneChance','graniteChance','brickChance']) if(`bs_${k}` in edits) bs[k]=edits[`bs_${k}`]
      if (Object.keys(bs).length) out.buildingStyle = bs
      return out
    }

    // ── Layout: 2-column grid (items span 1 col each; full-width items span 2) ─
    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:3px 10px'
    panel.appendChild(grid)

    const fmt = (v, step) => step < 0.1 ? v.toFixed(3) : step < 1 ? v.toFixed(1) : String(v)

    // Section label — spans both columns
    const secLabel = (txt) => {
      const d = document.createElement('div')
      d.textContent = txt
      d.style.cssText = 'grid-column:1/-1;font-size:9px;text-transform:uppercase;letter-spacing:0.8px;color:#555;margin:6px 0 2px'
      grid.appendChild(d)
    }

    // Single slider — one column
    const sliderRefs = {}   // key → { slider, valEl, lbl }
    const addSlider = (label, editKey, min, max, step, defaultVal, currentVal, normalizeGroup) => {
      const cell = document.createElement('div'); cell.style.cssText = 'min-width:0'
      const top = document.createElement('div'); top.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline'
      const lbl = document.createElement('span'); lbl.textContent = label
      const isOv = editKey in edits
      lbl.style.cssText = `font-size:10px;color:${isOv?'#4ab':'#999'}`
      const valEl = document.createElement('span')
      valEl.style.cssText = `font-size:10px;color:${isOv?'#4ab':'#666'};min-width:28px;text-align:right`
      valEl.textContent = fmt(currentVal, step)
      top.appendChild(lbl); top.appendChild(valEl)
      const sl = document.createElement('input')
      sl.type='range'; sl.min=min; sl.max=max; sl.step=step; sl.value=currentVal
      sl.style.cssText = 'width:100%;accent-color:#4ab;cursor:pointer;height:13px;margin:1px 0 0;display:block'
      sl.addEventListener('input', () => {
        const v = parseFloat(sl.value); valEl.textContent = fmt(v, step)
        if (Math.abs(v-defaultVal)<1e-9) { delete edits[editKey]; lbl.style.color='#999'; valEl.style.color='#666' }
        else { edits[editKey]=v; lbl.style.color='#4ab'; valEl.style.color='#4ab' }
        if (normalizeGroup) normalizeGroup(editKey, v)
      })
      sliderRefs[editKey] = { slider: sl, valEl, lbl, step }
      cell.appendChild(top); cell.appendChild(sl); grid.appendChild(cell)
    }

    // Dual-handle range — spans both columns
    const addDualSlider = (label, minKey, maxKey, rMin, rMax, step, defMin, defMax, curMin, curMax) => {
      const cell = document.createElement('div'); cell.style.cssText = 'grid-column:1/-1;min-width:0'
      const top = document.createElement('div'); top.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline'
      const lbl = document.createElement('span'); lbl.textContent = label
      const isOv = minKey in edits || maxKey in edits
      lbl.style.cssText = `font-size:10px;color:${isOv?'#4ab':'#999'}`
      const valEl = document.createElement('span')
      valEl.style.cssText = `font-size:10px;color:${isOv?'#4ab':'#666'};min-width:38px;text-align:right`
      valEl.textContent = `${curMin} – ${curMax}`
      top.appendChild(lbl); top.appendChild(valEl)
      const wrap = document.createElement('div'); wrap.className = 'ds-dr'
      const bgTrack = document.createElement('div'); bgTrack.className = 'ds-dr-track'
      const fill = document.createElement('div'); fill.className = 'ds-dr-fill'; bgTrack.appendChild(fill)
      const slMin = document.createElement('input'); slMin.type='range'; slMin.min=rMin; slMin.max=rMax; slMin.step=step; slMin.value=curMin
      const slMax = document.createElement('input'); slMax.type='range'; slMax.min=rMin; slMax.max=rMax; slMax.step=step; slMax.value=curMax
      const updateFill = () => { const pMn=(parseFloat(slMin.value)-rMin)/(rMax-rMin)*100,pMx=(parseFloat(slMax.value)-rMin)/(rMax-rMin)*100; fill.style.left=pMn+'%'; fill.style.width=(pMx-pMn)+'%' }
      const updateOv = () => { const ov=edits[minKey]!==undefined||edits[maxKey]!==undefined; lbl.style.color=ov?'#4ab':'#999'; valEl.style.color=ov?'#4ab':'#666'; fill.style.background=ov?'#4ab':'#555' }
      // When both handles coincide, raise the min handle so it can be dragged left.
      const updateZIndex = () => { const atMax=parseFloat(slMin.value)>=parseFloat(slMax.value); slMin.style.zIndex=atMax?'2':'1'; slMax.style.zIndex=atMax?'1':'2' }
      slMin.addEventListener('input',()=>{ if(parseFloat(slMin.value)>parseFloat(slMax.value)) slMin.value=slMax.value; const v=parseFloat(slMin.value); if(v===defMin&&!(maxKey in edits)) delete edits[minKey]; else edits[minKey]=v; valEl.textContent=`${v} – ${parseFloat(slMax.value)}`; updateFill(); updateOv(); updateZIndex() })
      slMax.addEventListener('input',()=>{ if(parseFloat(slMax.value)<parseFloat(slMin.value)) slMax.value=slMin.value; const v=parseFloat(slMax.value); if(v===defMax&&!(minKey in edits)) delete edits[maxKey]; else edits[maxKey]=v; valEl.textContent=`${parseFloat(slMin.value)} – ${v}`; updateFill(); updateOv(); updateZIndex() })
      wrap.appendChild(bgTrack); wrap.appendChild(slMin); wrap.appendChild(slMax); updateFill(); updateZIndex()
      cell.appendChild(top); cell.appendChild(wrap); grid.appendChild(cell)
    }

    // Button group — spans both columns
    const addButtonGroup = (label, options, editKey, defaultVal, currentVal) => {
      const cell = document.createElement('div'); cell.style.cssText = 'grid-column:1/-1;margin-bottom:2px'
      const lbl = document.createElement('div'); lbl.textContent = label
      const isOv = editKey in edits
      lbl.style.cssText = `font-size:10px;color:${isOv?'#4ab':'#999'};margin-bottom:2px`
      const grp = document.createElement('div'); grp.style.cssText = 'display:flex;gap:2px'
      const btns = options.map(opt => {
        const b = document.createElement('button'); b.textContent = opt
        const active = opt === currentVal
        b.style.cssText = `flex:1;padding:3px 2px;font-size:9px;border-radius:3px;cursor:pointer;border:1px solid ${active?'#4ab':'#444'};background:${active?'#1a3a5a':'#222'};color:${active?'#4ab':'#777'}`
        b.addEventListener('click', () => {
          btns.forEach(bb => { bb.style.borderColor='#444'; bb.style.background='#222'; bb.style.color='#777' })
          b.style.borderColor='#4ab'; b.style.background='#1a3a5a'; b.style.color='#4ab'
          if (opt===defaultVal) { delete edits[editKey]; lbl.style.color='#999' } else { edits[editKey]=opt; lbl.style.color='#4ab' }
        })
        grp.appendChild(b); return b
      })
      cell.appendChild(lbl); cell.appendChild(grp); grid.appendChild(cell)
    }

    // Proportional normalization: when one slider in a group moves, others scale so total stays 1.0
    const makeNormGroup = (editKeys, baseVals) => (changedKey, newVal) => {
      const others = editKeys.filter(k => k !== changedKey)
      const othersTotal = others.reduce((s,k) => s + (edits[k] ?? baseVals[k] ?? 0), 0)
      const remaining = Math.max(0, 1.0 - newVal)
      others.forEach(k => {
        const v = othersTotal < 1e-9 ? remaining/others.length : remaining * (edits[k] ?? baseVals[k] ?? 0) / othersTotal
        const clamped = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100
        edits[k] = clamped
        if (sliderRefs[k]) { sliderRefs[k].slider.value = clamped; sliderRefs[k].valEl.textContent = clamped.toFixed(2) }
      })
    }

    // ── Street Generation ──────────────────────────────────────────────────────
    secLabel('Street Generation')
    addButtonGroup('Street Type', ['Mud','Brick','Stone'], 'streetType', base.streetType, edits.streetType??base.streetType??'Mud')
    addSlider('Street Width',     'street_width',      0.5,5,    0.1,  base.street_width,      edits.street_width??base.street_width)
    addSlider('Street Spacing',   'street_spacing',    1,  5,    0.1,  base.street_spacing,    edits.street_spacing??base.street_spacing)
    addSlider('Block Density',    'block_density',     0.5,12,   0.5,  base.block_density,     edits.block_density??base.block_density)
    addSlider('XY Ratio',         'xyRatio',           1,  8,    0.5,  base.xyRatio,           edits.xyRatio??base.xyRatio)
    addButtonGroup('Street Alignment', ['euclidean','manhattan','chebyshev','centroid'], 'street_alignment', base.street_alignment, edits.street_alignment??base.street_alignment??'euclidean')
    addSlider('Square Threshold', 'square_threshhold', 0.01,1.0, 0.01, base.square_threshhold, edits.square_threshhold??base.square_threshhold)
    addSlider('Plot Width',       'plotSpacing',       0.01,0.5, 0.01, base.plotSpacing,       edits.plotSpacing??base.plotSpacing)


    // ── Building Style ─────────────────────────────────────────────────────────
    secLabel('Building Style')
    const baseWD = baseBs.wingDepths||[2,4]
    addDualSlider('Wing Depth','bs_wingDepths_min','bs_wingDepths_max',2,10,1,Math.min(...baseWD),Math.max(...baseWD),edits.bs_wingDepths_min??Math.min(...baseWD),edits.bs_wingDepths_max??Math.max(...baseWD))
    const baseFKeys = Object.keys(baseBs.floors||{1:1}).map(Number)
    addDualSlider('Floor Count','bs_floors_min','bs_floors_max',1,6,1,Math.min(...baseFKeys),Math.max(...baseFKeys),edits.bs_floors_min??Math.min(...baseFKeys),edits.bs_floors_max??Math.max(...baseFKeys))
    const baseRRHKeys = Object.keys(baseBs.roofRidgeHeight||{0:1}).map(Number)
    addDualSlider('Roof Ridge Height','bs_roofRidgeHeight_min','bs_roofRidgeHeight_max',0,2,0.5,Math.min(...baseRRHKeys),Math.max(...baseRRHKeys),edits.bs_roofRidgeHeight_min??Math.min(...baseRRHKeys),edits.bs_roofRidgeHeight_max??Math.max(...baseRRHKeys))

    secLabel('Roof Material')
    const br = baseBs.roof||{}
    const roofNorm = makeNormGroup(['bs_roof_thatch','bs_roof_reed','bs_roof_slate'],{'bs_roof_thatch':br.thatch??0,'bs_roof_reed':br.reed??0,'bs_roof_slate':br.slate??0})
    addSlider('Thatch','bs_roof_thatch',0,1,0.01,br.thatch??0,edits.bs_roof_thatch??(curBs.roof?.thatch??0),roofNorm)
    addSlider('Reed',  'bs_roof_reed',  0,1,0.01,br.reed??0,  edits.bs_roof_reed??(curBs.roof?.reed??0),  roofNorm)
    addSlider('Slate', 'bs_roof_slate', 0,1,0.01,br.slate??0, edits.bs_roof_slate??(curBs.roof?.slate??0),roofNorm)

    secLabel('Wall Material')
    const wallNorm = makeNormGroup(['bs_woodChance','bs_stoneChance','bs_graniteChance','bs_brickChance'],{'bs_woodChance':baseBs.woodChance??0,'bs_stoneChance':baseBs.stoneChance??0,'bs_graniteChance':baseBs.graniteChance??0,'bs_brickChance':baseBs.brickChance??0})
    addSlider('Wood',    'bs_woodChance',   0,1,0.01,baseBs.woodChance??0,   edits.bs_woodChance??curBs.woodChance??0,   wallNorm)
    addSlider('Stone',   'bs_stoneChance',  0,1,0.01,baseBs.stoneChance??0,  edits.bs_stoneChance??curBs.stoneChance??0, wallNorm)
    addSlider('Granite', 'bs_graniteChance',0,1,0.01,baseBs.graniteChance??0,edits.bs_graniteChance??curBs.graniteChance??0,wallNorm)
    addSlider('Brick',   'bs_brickChance',  0,1,0.01,baseBs.brickChance??0,  edits.bs_brickChance??curBs.brickChance??0, wallNorm)

    // ── Actions ────────────────────────────────────────────────────────────────
    const hr = document.createElement('div'); hr.style.cssText = 'border-top:1px solid #222;margin:8px 0 5px'
    panel.appendChild(hr)
    const btnRow = document.createElement('div'); btnRow.style.cssText = 'display:flex;gap:5px'
    const resetBtn = document.createElement('button')
    resetBtn.textContent = 'Reset'
    resetBtn.style.cssText = 'flex:1;padding:5px;background:transparent;border:1px solid #333;border-radius:3px;color:#555;cursor:pointer;font-size:10px'
    resetBtn.addEventListener('click', () => {
      // Clear all edits and save empty overrides — then reopen the dialog fresh at defaults
      // so sliders snap back visually. Re-opening is the simplest way to rebuild the UI.
      this.eventBus.emit('DISTRICT_SETTINGS_SAVE', { configOverrides: {} })
      // Re-open immediately with empty overrides so sliders show defaults
      this._openSettingsDialog(districtKey, {})
    })
    const regenBtn = document.createElement('button')
    regenBtn.textContent = '↻ Regenerate streets'
    regenBtn.style.cssText = 'flex:2;padding:5px;background:#5a3a1a;color:#ffb84d;border:1px solid #8a5a2a;border-radius:3px;cursor:pointer;font-size:10px'
    regenBtn.addEventListener('click', () => this.eventBus.emit('DISTRICT_SETTINGS_REGENERATE', { configOverrides: getOverrides() }))
    btnRow.appendChild(resetBtn); btnRow.appendChild(regenBtn); panel.appendChild(btnRow)

    document.body.appendChild(panel)
  }

  _buildDistrictContent(container, { pendingType, residentialClass = null, LeadershipClass = null, resourceRegistry = [], resourceDefinitions = {}, usedProducedResources = [], configOverrides = {}, locked = false, leadershipTaken = false }) {
    // Resolve the config key for the settings dialog
    const _districtKey = pendingType === 'Residential' ? `Residential-${residentialClass || 'Middle'}`
      : pendingType === 'Leadership' ? `Leadership-${LeadershipClass || 'Monarchy'}`
      : pendingType

    container.appendChild(this._sectionLabel('District Type'))

    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px'
    // Exactly one Leadership district is allowed city-wide — stop offering it here once
    // another district already has it (this district's own existing/pending Leadership
    // assignment, if any, is never excluded — see leadershipTaken's caller in App.js).
    for (const type of DISTRICT_TYPES.filter(t => t !== 'Leadership' || !leadershipTaken || pendingType === 'Leadership')) {
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

    if (pendingType === 'Leadership') {
      // ── Tutorial: explain Leadership before showing the class picker ──
      const tutNote = document.createElement('div')
      tutNote.style.cssText = 'font-size:10px;color:#aaa;line-height:1.4;margin-bottom:8px;background:#1a1a1a;border:1px solid #444;border-radius:3px;padding:7px 9px'
      tutNote.textContent = 'The Leadership District is the seat of city government. Exactly one is required — it determines succession rules and shapes certain victory conditions. Choose a Leadership Class below.'
      container.appendChild(tutNote)

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

      // Extra note for Monarchy/Tyrant re castle landmark
      if (LeadershipClass === 'Monarchy' || LeadershipClass === 'Tyrant') {
        const castleNote = document.createElement('div')
        castleNote.style.cssText = 'font-size:10px;color:#c8a000;margin-bottom:8px'
        castleNote.textContent = `⚑ ${LeadershipClass} districts include a castle landmark.`
        container.appendChild(castleNote)
      }

      if (!locked) container.appendChild(this._regenerateStreetsRow(_districtKey, configOverrides))
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
            this.eventBus.emit('DISTRICT_APPLY', { description, producedResource: '', residentialClass: null, LeadershipClass, name })
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
      return   // Leadership has no resource sections
    }

    // ── Resource or Service form ──
    const isResidential = pendingType === 'Residential'
    const isNoble = isResidential && residentialClass === 'Noble'
    const isIndustry = pendingType === 'Industry'
    const isMarket = pendingType === 'Market'
    const maxProduced = isIndustry ? 2 : 1

    // Reset state when type changes
    if (pendingType !== this._lastCityPendingType) {
      this._cityProduced = []
      this._lastCityPendingType = pendingType
    }

    // Consumption is fully derived from the Recipe of what's produced (plus the always-
    // implicit Water + Basic Food upkeep below) — there is no manual consumed picker.
    const renderResourceSection = () => {
      producedSection.innerHTML = ''
      if (isResidential) return

      // Merge locally-pending new resources into the registry so the dialog can see
      // resources defined in the same editing session (not yet submitted).
      const localNewNames = this._cityProduced.filter(r => r.isNew).map(r => r.name)
      const extendedRegistry = [
        ...resourceRegistry,
        ...localNewNames.filter(n => !resourceRegistry.some(r => r.toLowerCase() === n.toLowerCase()))
      ]

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
            resourceDefinitions,
            usedProduced: usedForDialog,
            alreadySelected: this._cityProduced.map(r => r.name),
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

    const producedSection = document.createElement('div')
    renderResourceSection()
    container.appendChild(producedSection)

    const implicitNote = document.createElement('div')
    implicitNote.textContent = 'Always consumed each round: Water, Basic Food'
    implicitNote.style.cssText = 'font-size:10px;color:#555;font-style:italic;margin-bottom:5px'
    container.appendChild(implicitNote)

    const color = TerrainColors.get(isResidential ? (residentialClass || 'Residential') : pendingType)
    const hex = '#' + color.toString(16).padStart(6, '0')
    const label = isResidential ? `Residential (${residentialClass})` : pendingType

    const validWarn = document.createElement('div')
    validWarn.style.cssText = 'font-size:10px;color:#ff6666;margin-bottom:4px;display:none'
    container.appendChild(validWarn)

    if (!locked) container.appendChild(this._regenerateStreetsRow(_districtKey, configOverrides))

    const applyBtn = document.createElement('button')
    applyBtn.textContent = `Apply: ${label}`
    applyBtn.style.cssText = `width:100%;padding:7px;background:${hex};color:#fff;border:none;cursor:pointer;border-radius:3px;font-weight:bold;font-size:12px`
    applyBtn.addEventListener('click', () => {
      const produced = isResidential ? '' : (this._cityProduced[0]?.name || '')
      const produced2 = isIndustry ? (this._cityProduced[1]?.name || '') : ''
      if (!isResidential && !isNoble && !produced) { validWarn.textContent = 'Must define a produced resource or service (in addition to Gold).'; validWarn.style.display = 'block'; return }
      if (!isMarket && produced.toLowerCase() === 'gold') { validWarn.textContent = 'Gold is produced automatically — choose a different resource or service.'; validWarn.style.display = 'block'; return }
      if (produced && produced2 && produced.toLowerCase() === produced2.toLowerCase()) { validWarn.textContent = 'Cannot produce the same resource or service twice.'; validWarn.style.display = 'block'; return }
      validWarn.style.display = 'none'
      applyBtn.disabled = true
      applyBtn.style.opacity = '0.6'
      applyBtn.style.cursor = 'default'
      const resourceDefs = this._cityProduced.filter(r => r.isNew)
      const resourceWiring = resourceDefs.filter(r => r.wireIntoExisting).map(r => ({ resourceName: r.name, targetName: r.wireIntoExisting }))
      const dialog = new NameDialog({
        entityKind: 'district', entityLabel: label, subType: pendingType, producedResource: produced || produced2,
        onApply: (name, description) => {
          this.eventBus.emit('DISTRICT_APPLY', { description, producedResource: produced, secondProducedResource: produced2, residentialClass: isResidential ? residentialClass : null, name, resourceDefs, resourceWiring })
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
        this.eventBus.emit('CITY_EDGE_APPLY', { name: '', description: '' })
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
