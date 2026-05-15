import TerrainColors from '../rendering/TerrainColors.js'

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

export default class DistrictTypePanel {
  constructor(eventBus) {
    this.eventBus = eventBus
    this.container = null
  }

  render(container) {
    this.container = container
    container.style.cssText += ';display:flex;flex-direction:column;height:100%;box-sizing:border-box;overflow:hidden'
    this.showContext('none')
  }

  showContext(type, options = {}) {
    if (!this.container) return
    this.container.innerHTML = ''

    // ── Top section: main content (scrollable, fills space)
    const section1 = document.createElement('div')
    section1.style.cssText = 'flex:1;overflow-y:auto;min-height:0;padding-bottom:4px'

    if (type === 'district') {
      this._buildDistrictContent(section1, options)
    } else if (type === 'cityEdge') {
      this._buildCityEdgeContent(section1, options)
    } else if (type === 'terrainRegion') {
      this._buildTerrainRegionContent(section1, options)
    }

    this.container.appendChild(section1)

    // ── Bottom section: threats + trade lists (fixed, no Add buttons)
    const bottom = document.createElement('div')
    bottom.style.cssText = 'flex-shrink:0;border-top:1px solid #444;padding-top:6px;overflow-y:auto;max-height:44%'
    this._buildThreatList(bottom, options)
    bottom.appendChild(this._divider())
    this._buildTradeList(bottom, options)
    this.container.appendChild(bottom)
  }

  // ── Section builders ──────────────────────────────────────────────────────

  _buildTerrainRegionContent(container, options) {
    const {
      regionType, isEdge = false, hasDistrict = false,
      pendingAction = null, regionId,
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
      const nameLabel = document.createElement('div')
      nameLabel.textContent = 'Threat Name'
      nameLabel.style.cssText = 'font-size:10px;color:#777;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px'
      container.appendChild(nameLabel)

      const nameInput = document.createElement('input')
      nameInput.id = 'terrain-threat-name'
      nameInput.type = 'text'
      nameInput.placeholder = 'Name this threat...'
      nameInput.style.cssText = 'width:100%;background:#1a1a1a;color:#fff;border:1px solid #994444;border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box;margin-bottom:6px'
      container.appendChild(nameInput)

      const nameWarn = document.createElement('div')
      nameWarn.style.cssText = 'font-size:10px;color:#ff6666;margin-bottom:4px;display:none'
      nameWarn.textContent = 'A name is required.'
      container.appendChild(nameWarn)

      const descLabel = document.createElement('div')
      descLabel.textContent = 'Description'
      descLabel.style.cssText = 'font-size:10px;color:#777;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px'
      container.appendChild(descLabel)

      const textarea = document.createElement('textarea')
      textarea.id = 'terrain-threat-description'
      textarea.placeholder = 'Optional notes...'
      textarea.style.cssText = 'width:100%;height:56px;background:#1a1a1a;color:#fff;border:1px solid #994444;border-radius:3px;padding:4px;font-size:11px;resize:none;box-sizing:border-box;margin-bottom:6px'
      container.appendChild(textarea)

      const applyBtn = document.createElement('button')
      applyBtn.textContent = 'Apply Threat'
      applyBtn.style.cssText = 'width:100%;padding:7px;background:#6b1a1a;color:#fff;border:1px solid #994444;border-radius:3px;cursor:pointer;font-weight:bold;font-size:12px'
      applyBtn.addEventListener('click', () => {
        const name = document.getElementById('terrain-threat-name')?.value?.trim() || ''
        if (!name) { nameWarn.style.display = 'block'; return }
        nameWarn.style.display = 'none'
        const desc = document.getElementById('terrain-threat-description')?.value?.trim() || ''
        applyBtn.disabled = true
        applyBtn.textContent = 'Applying...'
        applyBtn.style.opacity = '0.6'
        applyBtn.style.cursor = 'default'
        this.eventBus.emit('TERRAIN_THREAT_APPLY', { name, description: desc })
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

    // Datalist for consumed resources only (produced uses a plain text input)
    const DROPDOWN_PREDEFINED = ['Gold', 'Labour', 'Security']
    const EXCLUDED_LOWER = ['water', 'basic food']
    const predefinedLower = DROPDOWN_PREDEFINED.map(r => r.toLowerCase())
    const allDropdownResources = [
      ...DROPDOWN_PREDEFINED,
      ...resourceRegistry.filter(r => !predefinedLower.includes(r.toLowerCase()) && !EXCLUDED_LOWER.includes(r.toLowerCase()))
    ]

    const consDatalist = document.createElement('datalist')
    consDatalist.id = 'terrain-resource-cons-list'
    container.appendChild(consDatalist)

    const rebuildConsDatalist = (producedValue) => {
      const produced = (producedValue || '').trim().toLowerCase()
      consDatalist.innerHTML = ''
      for (const r of allDropdownResources) {
        if (r.toLowerCase() === produced && produced !== 'labour') continue
        const opt = document.createElement('option'); opt.value = r; consDatalist.appendChild(opt)
      }
    }
    rebuildConsDatalist('')

    container.appendChild(this._fieldLabel('Consumed Resources'))
    for (let i = 0; i < 3; i++) {
      const inp = document.createElement('input')
      inp.id = `terrain-district-consumed-${i}`
      inp.type = 'text'
      inp.placeholder = `Resource ${i + 1}...`
      inp.setAttribute('list', 'terrain-resource-cons-list')
      inp.style.cssText = 'width:100%;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box;margin-bottom:3px'
      inp.addEventListener('change', () => inp.blur())
      container.appendChild(inp)
    }
    
    container.appendChild(this._fieldLabel('Produced Resource'))
    const prodWrap = document.createElement('div')
    prodWrap.style.cssText = 'margin-bottom:5px'
    const prodInput = document.createElement('input')
    prodInput.id = 'terrain-district-produced-resource'
    prodInput.type = 'text'
    prodInput.placeholder = 'Produced resource...'
    prodInput.style.cssText = 'width:100%;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box'
    const dupWarn = document.createElement('div')
    dupWarn.style.cssText = 'font-size:10px;color:#ff6666;margin-top:1px;display:none'
    dupWarn.textContent = 'Already produced by another district'
    prodInput.addEventListener('input', () => {
      dupWarn.style.display = (prodInput.value.trim().toLowerCase() && usedProducedResources.includes(prodInput.value.trim().toLowerCase())) ? 'block' : 'none'
      rebuildConsDatalist(prodInput.value)
    })
    prodInput.addEventListener('change', () => prodInput.blur())
    prodWrap.appendChild(prodInput)
    prodWrap.appendChild(dupWarn)
    container.appendChild(prodWrap)

    const implicitNote = document.createElement('div')
    implicitNote.textContent = 'Always consumed: Water, Basic Food'
    implicitNote.style.cssText = 'font-size:10px;color:#555;font-style:italic;margin-bottom:5px'
    container.appendChild(implicitNote)

    container.appendChild(this._fieldLabel('Description'))
    const descInput = document.createElement('textarea')
    descInput.id = 'terrain-district-description'
    descInput.placeholder = 'Optional notes...'
    descInput.style.cssText = 'width:100%;height:40px;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px;font-size:11px;resize:none;box-sizing:border-box;margin-bottom:6px'
    container.appendChild(descInput)

    const validWarn = document.createElement('div')
    validWarn.style.cssText = 'font-size:10px;color:#ff6666;margin-bottom:4px;display:none'
    container.appendChild(validWarn)

    const applyBtn = document.createElement('button')
    applyBtn.textContent = `Apply: ${districtType}`
    applyBtn.style.cssText = 'width:100%;padding:7px;background:#2a3a2a;color:#fff;border:1px solid #4a7c59;border-radius:3px;cursor:pointer;font-weight:bold;font-size:12px'
    applyBtn.addEventListener('click', () => {
      const produced = document.getElementById('terrain-district-produced-resource')?.value?.trim() || ''
      const consumed = [0, 1, 2].map(i => document.getElementById(`terrain-district-consumed-${i}`)?.value?.trim() || '').filter(Boolean)
      if (!produced) { validWarn.textContent = 'Must define at least one produced resource.'; validWarn.style.display = 'block'; return }
      if (consumed.length < 2) { validWarn.textContent = 'Must define at least 2 consumed resources.'; validWarn.style.display = 'block'; return }
      if (usedProducedResources.includes(produced.toLowerCase())) return
      validWarn.style.display = 'none'
      applyBtn.disabled = true
      applyBtn.textContent = 'Applying...'
      applyBtn.style.opacity = '0.6'
      applyBtn.style.cursor = 'default'
      this.eventBus.emit('TERRAIN_DISTRICT_ASSIGN', {
        regionId,
        districtType,
        description: document.getElementById('terrain-district-description')?.value?.trim() || '',
        producedResource: produced,
        consumedResources: consumed
      })
    })
    container.appendChild(applyBtn)
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

      container.appendChild(this._fieldLabel('Description'))
      const descInput = document.createElement('textarea')
      descInput.id = 'district-description'
      descInput.placeholder = 'Optional notes...'
      descInput.style.cssText = 'width:100%;height:40px;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px;font-size:11px;resize:none;box-sizing:border-box;margin-bottom:4px'
      container.appendChild(descInput)

      const clsColor = TerrainColors.get(LeadershipClass)
      const applyHex = '#' + clsColor.toString(16).padStart(6, '0')
      const applyBtn = document.createElement('button')
      applyBtn.textContent = `Apply: ${LeadershipClass}`
      applyBtn.style.cssText = `width:100%;padding:7px;background:${applyHex};color:#fff;border:none;cursor:pointer;border-radius:3px;font-weight:bold;font-size:12px`
      applyBtn.addEventListener('click', () => {
        applyBtn.disabled = true
        applyBtn.textContent = 'Applying...'
        applyBtn.style.opacity = '0.6'
        applyBtn.style.cursor = 'default'
        this.eventBus.emit('DISTRICT_APPLY', {
          description: document.getElementById('district-description')?.value?.trim() || '',
          producedResource: '',
          consumedResources: [],
          residentialClass: null,
          LeadershipClass
        })
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

    // ── Resource form ──
    const isResidential = pendingType === 'Residential'
    const isNoble = isResidential && residentialClass === 'Noble'
    const lockedLabour = isResidential && !isNoble

    const DROPDOWN_PREDEFINED = ['Gold', 'Labour', 'Security']
    const EXCLUDED_LOWER = ['water', 'basic food']
    const predefinedLower = DROPDOWN_PREDEFINED.map(r => r.toLowerCase())
    const allDropdownResources = [
      ...DROPDOWN_PREDEFINED,
      ...resourceRegistry.filter(r => !predefinedLower.includes(r.toLowerCase()) && !EXCLUDED_LOWER.includes(r.toLowerCase()))
    ]

    const consDatalist = document.createElement('datalist')
    consDatalist.id = 'resource-cons-list'
    for (const r of allDropdownResources) {
      const opt = document.createElement('option'); opt.value = r; consDatalist.appendChild(opt)
    }
    container.appendChild(consDatalist)


    container.appendChild(this._fieldLabel('Consumed Resources'))
    for (let i = 0; i < 3; i++) {
      const inp = document.createElement('input')
      inp.id = `district-consumed-${i}`
      inp.type = 'text'
      inp.placeholder = `Resource ${i + 1}...`
      inp.setAttribute('list', 'resource-cons-list')
      inp.style.cssText = 'width:100%;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box;margin-bottom:3px'
      inp.addEventListener('change', () => inp.blur())
      container.appendChild(inp)
    }
    
    if (!isResidential) {
      
      container.appendChild(this._fieldLabel('Produced Resource'))
      const prodWrap = document.createElement('div')
      prodWrap.style.cssText = 'margin-bottom:5px'
      const prodInput = document.createElement('input')
      prodInput.id = 'district-produced-resource'
      prodInput.type = 'text'
      prodInput.placeholder = 'Produced resource...'
      prodInput.setAttribute('list', 'resource-prod-list')
      prodInput.style.cssText = 'width:100%;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box'
      const dupWarn = document.createElement('div')
      dupWarn.style.cssText = 'font-size:10px;color:#ff6666;margin-top:1px;display:none'
      dupWarn.textContent = 'Already produced by another district'
      prodInput.addEventListener('input', () => {
        dupWarn.style.display = (prodInput.value.trim().toLowerCase() && usedProducedResources.includes(prodInput.value.trim().toLowerCase())) ? 'block' : 'none'
      })
      prodInput.addEventListener('change', () => prodInput.blur())
      prodWrap.appendChild(prodInput)
      prodWrap.appendChild(dupWarn)
      container.appendChild(prodWrap)
    }

    const implicitNote = document.createElement('div')
    implicitNote.textContent = 'Always consumed: Water, Basic Food'
    implicitNote.style.cssText = 'font-size:10px;color:#555;font-style:italic;margin-bottom:5px'
    container.appendChild(implicitNote)

    container.appendChild(this._fieldLabel('Description'))
    const descInput = document.createElement('textarea')
    descInput.id = 'district-description'
    descInput.placeholder = 'Optional notes...'
    descInput.style.cssText = 'width:100%;height:40px;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px;font-size:11px;resize:none;box-sizing:border-box;margin-bottom:4px'
    container.appendChild(descInput)

    const color = TerrainColors.get(isResidential ? (residentialClass || 'Residential') : pendingType)
    const hex = '#' + color.toString(16).padStart(6, '0')
    const label = isResidential ? `Residential (${residentialClass})` : pendingType

    const validWarn = document.createElement('div')
    validWarn.style.cssText = 'font-size:10px;color:#ff6666;margin-bottom:4px;display:none'
    container.appendChild(validWarn)

    const applyBtn = document.createElement('button')
    applyBtn.textContent = `Apply: ${label}`
    applyBtn.style.cssText = `width:100%;padding:7px;background:${hex};color:#fff;border:none;cursor:pointer;border-radius:3px;font-weight:bold;font-size:12px`
    applyBtn.addEventListener('click', () => {
      const produced = isResidential ? '' : (document.getElementById('district-produced-resource')?.value?.trim() || '')
      const consumed = [0, 1, 2].map(i => document.getElementById(`district-consumed-${i}`)?.value?.trim() || '').filter(Boolean)
      if (!isResidential && !produced) { validWarn.textContent = 'Must define at least one produced resource.'; validWarn.style.display = 'block'; return }
      if (!isResidential && consumed.length < 2) { validWarn.textContent = 'Must define at least 2 consumed resources.'; validWarn.style.display = 'block'; return }
      if (!isResidential && usedProducedResources.includes(produced.toLowerCase())) return
      validWarn.style.display = 'none'
      applyBtn.disabled = true
      applyBtn.textContent = 'Applying...'
      applyBtn.style.opacity = '0.6'
      applyBtn.style.cursor = 'default'
      this.eventBus.emit('DISTRICT_APPLY', {
        description: document.getElementById('district-description')?.value?.trim() || '',
        producedResource: produced,
        consumedResources: consumed,
        residentialClass: isResidential ? residentialClass : null
      })
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

    container.appendChild(this._fieldLabel('Description'))
    const descInput = document.createElement('textarea')
    descInput.id = 'city-edge-description'
    descInput.placeholder = 'Optional notes...'
    descInput.style.cssText = 'width:100%;height:48px;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px;font-size:11px;resize:none;box-sizing:border-box'
    container.appendChild(descInput)

    if (pendingType) {
      const color = TerrainColors.get(pendingType)
      const hex = '#' + color.toString(16).padStart(6, '0')
      const displayType = pendingType === 'MainRoad' ? 'Main Road' : pendingType
      const applyBtn = document.createElement('button')
      applyBtn.textContent = `Apply: ${displayType}`
      applyBtn.style.cssText = `width:100%;padding:7px;margin-top:6px;background:${hex};color:#fff;border:none;cursor:pointer;border-radius:3px;font-weight:bold;font-size:12px`
      applyBtn.addEventListener('click', () => {
        applyBtn.disabled = true
        applyBtn.textContent = 'Applying...'
        applyBtn.style.opacity = '0.6'
        applyBtn.style.cursor = 'default'
        this.eventBus.emit('CITY_EDGE_APPLY', {
          description: document.getElementById('city-edge-description')?.value?.trim() || ''
        })
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

  addFinishButton() {}
}
