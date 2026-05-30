import TerrainColors from '../rendering/TerrainColors.js'

// Attaches a custom tooltip to a button that may be visually-disabled.
// We avoid btn.disabled because that strips pointer events, making native title/hover unusable.
function _attachDisabledTooltip(btn, reason) {
  let tip = null
  btn.addEventListener('mouseenter', () => {
    tip = document.createElement('div')
    tip.textContent = reason
    tip.style.cssText = [
      'position:fixed', 'z-index:9999', 'pointer-events:none',
      'background:#1a1a1a', 'color:#ccc', 'border:1px solid #555',
      'border-radius:4px', 'padding:5px 8px',
      'font-size:11px', 'line-height:1.4', 'max-width:180px', 'white-space:normal'
    ].join(';')
    document.body.appendChild(tip)
    const r = btn.getBoundingClientRect()
    tip.style.left = Math.max(0, r.left) + 'px'
    tip.style.top = (r.bottom + 4) + 'px'
  })
  btn.addEventListener('mouseleave', () => { tip?.remove(); tip = null })
  btn.addEventListener('click', e => e.stopImmediatePropagation())
}

//const TERRAIN_TYPES = ['Plains', 'Forest', 'Mountains', 'Desert', 'Swamp', 'Hills', 'Lake', 'Delta']
const TERRAIN_TYPES = ['Plains', 'Forest', 'Mountains', 'Desert', 'Swamp', 'Hills', 'Lake', 'Sea']
const EDGE_TYPES = ['River', 'Cliff']

export default class TerrainTypePanel {
  constructor(eventBus) {
    this.eventBus = eventBus
    this.container = null
    this._currentContext = 'none'
    this._currentOptions = {}
  }

  render(container) {
    this.container = container
    container.style.cssText += ';display:flex;flex-direction:column;height:100%;box-sizing:border-box;overflow:hidden'
    this.showContext('none')
  }

  showContext(type, options = {}) {
    if (!this.container) return
    this._currentContext = type
    this._currentOptions = options
    this.container.innerHTML = ''

    const content = document.createElement('div')
    content.style.cssText = 'flex:1;overflow-y:auto;padding-bottom:8px'

    if (type === 'region') {
      this._buildRegionContent(content, options)
    } else if (type === 'edge') {
      this._buildEdgeContent(content, options)
    }
    // 'none': leave content empty

    this.container.appendChild(content)
  }

  _buildRegionContent(container, { pendingType, isEdge = false, adjacentTypes = [] }) {
    const label = document.createElement('div')
    label.textContent = 'Terrain Type'
    label.style.cssText = 'margin-bottom:8px;font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:1px'
    container.appendChild(label)

    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:10px'

    const EDGE_ONLY = ['Desert', 'Mountains', 'Sea']
    for (const type of TERRAIN_TYPES) {
      const color = TerrainColors.get(type)
      const hex = '#' + color.toString(16).padStart(6, '0')
      const isActive = type === pendingType

      let disabledReason = null
      if (EDGE_ONLY.includes(type) && !isEdge)              disabledReason = `${type} can only be placed on boundary (edge-of-map) regions`
      else if (type === 'Sea' && adjacentTypes.includes('Lake'))  disabledReason = 'Cannot be placed adjacent to a Lake'
      else if (type === 'Lake' && adjacentTypes.includes('Sea'))  disabledReason = 'Cannot be placed adjacent to the Sea'
      const disabled = disabledReason !== null

      const btn = document.createElement('button')
      btn.textContent = type
      // Don't set btn.disabled — it strips pointer events and breaks hover tooltips
      btn.style.cssText = `padding:6px 4px;background:${isActive ? hex : '#2a2a2a'};border:2px solid ${disabled ? '#444' : hex};color:${disabled ? '#555' : '#fff'};cursor:${disabled ? 'not-allowed' : 'pointer'};border-radius:3px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`
      if (disabled) {
        _attachDisabledTooltip(btn, disabledReason)
      } else {
        btn.addEventListener('click', () => this.eventBus.emit('TERRAIN_TYPE_PREVIEW', type))
      }
      grid.appendChild(btn)
    }
    container.appendChild(grid)

    const descLabel = document.createElement('div')
    descLabel.textContent = 'Description'
    descLabel.style.cssText = 'margin-bottom:4px;font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:1px'
    container.appendChild(descLabel)

    const descInput = document.createElement('textarea')
    descInput.id = 'terrain-description'
    descInput.placeholder = 'Optional notes...'
    descInput.style.cssText = 'width:100%;height:56px;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px;font-size:11px;resize:none;box-sizing:border-box'
    container.appendChild(descInput)

    if (pendingType) {
      const applyBtn = document.createElement('button')
      const color = TerrainColors.get(pendingType)
      const hex = '#' + color.toString(16).padStart(6, '0')
      applyBtn.textContent = `Apply: ${pendingType}`
      applyBtn.style.cssText = `width:100%;padding:8px;margin-top:6px;background:${hex};color:#fff;border:none;cursor:pointer;border-radius:3px;font-weight:bold;font-size:12px`
      applyBtn.addEventListener('click', () => {
        applyBtn.disabled = true
        applyBtn.textContent = 'Applying...'
        applyBtn.style.opacity = '0.6'
        applyBtn.style.cursor = 'default'
        this.eventBus.emit('TERRAIN_APPLY', { description: document.getElementById('terrain-description')?.value?.trim() || '' })
      })
      container.appendChild(applyBtn)
    }
  }

  _buildEdgeContent(container, { edgeCount, pendingType, adjacentTypes = [], riverParallel = false }) {
    const label = document.createElement('div')
    label.textContent = `${edgeCount} Edge${edgeCount > 1 ? 's' : ''} Selected`
    label.style.cssText = 'margin-bottom:8px;font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:1px'
    container.appendChild(label)

    const hint = document.createElement('div')
    hint.textContent = 'Click connected edges to add to selection.'
    hint.style.cssText = 'font-size:10px;color:#777;margin-bottom:8px;line-height:1.4'
    container.appendChild(hint)

    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:10px'

    for (const type of EDGE_TYPES) {
      const isActive = type === pendingType

      let disabledReason = null
      if (type === 'Cliff' && edgeCount > 2)  disabledReason = 'Cliffs can only span 1–2 edges'
      else if (type === 'River' && riverParallel) disabledReason = 'Cannot run alongside an existing river'
      const disabled = disabledReason !== null

      const btn = document.createElement('button')
      btn.textContent = type
      btn.style.cssText = `padding:6px 4px;background:${isActive && !disabled ? '#667' : '#2a2a2a'};border:2px solid ${disabled ? '#444' : '#667'};color:${disabled ? '#555' : '#fff'};cursor:${disabled ? 'not-allowed' : 'pointer'};border-radius:3px;font-size:11px`
      if (disabled) {
        _attachDisabledTooltip(btn, disabledReason)
      } else {
        btn.addEventListener('click', () => this.eventBus.emit('EDGE_TYPE_PREVIEW', type))
      }
      grid.appendChild(btn)
    }
    container.appendChild(grid)

    const descLabel = document.createElement('div')
    descLabel.textContent = 'Description'
    descLabel.style.cssText = 'margin-bottom:4px;font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:1px'
    container.appendChild(descLabel)

    const descInput = document.createElement('textarea')
    descInput.id = 'edge-description'
    descInput.placeholder = 'Optional notes...'
    descInput.style.cssText = 'width:100%;height:56px;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px;font-size:11px;resize:none;box-sizing:border-box'
    container.appendChild(descInput)

    if (pendingType) {
      const applyBtn = document.createElement('button')
      applyBtn.textContent = `Apply: ${pendingType}`
      applyBtn.style.cssText = 'width:100%;padding:8px;margin-top:6px;background:#4455aa;color:#fff;border:none;cursor:pointer;border-radius:3px;font-weight:bold;font-size:12px'
      applyBtn.addEventListener('click', () => {
        applyBtn.disabled = true
        applyBtn.textContent = 'Applying...'
        applyBtn.style.opacity = '0.6'
        applyBtn.style.cursor = 'default'
        this.eventBus.emit('EDGE_APPLY', { description: document.getElementById('edge-description')?.value?.trim() || '' })
      })
      container.appendChild(applyBtn)
    }
  }

  // Called by UIManager.showSetupPhase — no-op since render() handles everything
  addFinishButton() {}
}
