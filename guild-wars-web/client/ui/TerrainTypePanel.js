import TerrainColors from '../rendering/TerrainColors.js'
import NameDialog from './NameDialog.js'

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

const TERRAIN_TYPES = ['Plains', 'Forest', 'Mountains', 'Desert', 'Swamp', 'Hills', 'Lake', 'Sea']
const EDGE_TYPES = ['River', 'Cliff']

// Preferred gap between the anchor screen point and the floating panel edge.
const PANEL_GAP = 16
const PANEL_WIDTH = 220

export default class TerrainTypePanel {
  constructor(eventBus, renderer) {
    this.eventBus = eventBus
    this.renderer = renderer
    this._currentContext = 'none'
    this._currentOptions = {}
    this._anchorPoints = []  // [{x, y}] world 2D boundary of the selected entity
    this._el = null
    this._cameraCB = null
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

    // Register camera-follow callback
    this._cameraCB = () => this._reposition()
    this.renderer.addCameraMoveCallback(this._cameraCB)
  }

  // Set the world-space boundary points of the selected entity so _reposition can
  // compute its screen bounding box. pts is an array of {x, y} in 2D map coords
  // (map y → world z). Replaces the old single-point setAnchor.
  setAnchorPoints(pts) {
    this._anchorPoints = pts
  }

  showContext(type, options = {}) {
    this._currentContext = type
    this._currentOptions = options
    this._el.innerHTML = ''

    if (type === 'none') {
      this._el.style.display = 'none'
      return
    }

    const content = document.createElement('div')
    content.style.cssText = 'display:flex;flex-direction:column;gap:0'

    if (type === 'region') {
      this._buildRegionContent(content, options)
    } else if (type === 'edge') {
      this._buildEdgeContent(content, options)
    }

    this._el.appendChild(content)
    this._el.style.display = 'block'
    this._reposition()
  }

  _reposition() {
    if (this._el.style.display === 'none') return
    if (!this._anchorPoints?.length) return

    // Project every boundary point to screen space and compute the bounding box.
    const pts = this._anchorPoints.map(p => this.renderer.worldToScreen(p.x, 0, p.y))
    const minX = Math.min(...pts.map(p => p.x))
    const maxX = Math.max(...pts.map(p => p.x))
    const minY = Math.min(...pts.map(p => p.y))
    const maxY = Math.max(...pts.map(p => p.y))
    const midY = (minY + maxY) / 2
    const midX = (minX + maxX) / 2

    const panelH = this._el.offsetHeight || 300
    const margin = 8

    // Prefer right of the bounding box so the panel never overlaps the entity.
    const rightLeft = maxX + PANEL_GAP
    if (rightLeft + PANEL_WIDTH < window.innerWidth - margin) {
      this._el.style.left = rightLeft + 'px'
      this._el.style.top  = Math.max(margin, Math.min(midY - panelH / 2, window.innerHeight - panelH - margin)) + 'px'
    } else {
      // Fall back: above the bounding box.
      this._el.style.left = Math.max(margin, Math.min(midX - PANEL_WIDTH / 2, window.innerWidth - PANEL_WIDTH - margin)) + 'px'
      this._el.style.top  = Math.max(margin, minY - panelH - PANEL_GAP) + 'px'
    }
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
      btn.style.cssText = `padding:6px 4px;background:${isActive ? hex : '#2a2a2a'};border:2px solid ${disabled ? '#444' : hex};color:${disabled ? '#555' : '#fff'};cursor:${disabled ? 'not-allowed' : 'pointer'};border-radius:3px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`
      if (disabled) {
        _attachDisabledTooltip(btn, disabledReason)
      } else {
        btn.addEventListener('click', () => this.eventBus.emit('TERRAIN_TYPE_PREVIEW', type))
      }
      grid.appendChild(btn)
    }
    container.appendChild(grid)

    if (pendingType) {
      const color = TerrainColors.get(pendingType)
      const hex = '#' + color.toString(16).padStart(6, '0')
      const applyBtn = document.createElement('button')
      applyBtn.textContent = `Apply: ${pendingType}`
      applyBtn.style.cssText = `width:100%;padding:8px;margin-top:6px;background:${hex};color:#fff;border:none;cursor:pointer;border-radius:3px;font-weight:bold;font-size:12px`
      applyBtn.addEventListener('click', () => {
        applyBtn.disabled = true
        applyBtn.style.opacity = '0.6'
        applyBtn.style.cursor = 'default'
        const dialog = new NameDialog({
          entityKind: 'terrain', entityLabel: pendingType, subType: pendingType,
          onApply: (name, description) => {
            this.eventBus.emit('TERRAIN_APPLY', { name, description })
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

  _buildEdgeContent(container, { edgeCount, pendingType, adjacentTypes = [], riverDisabledReason = null }) {
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
      if (type === 'Cliff' && edgeCount > 2)     disabledReason = 'Cliffs can only span 1–2 edges'
      else if (type === 'River' && riverDisabledReason) disabledReason = riverDisabledReason
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

    if (pendingType) {
      const applyBtn = document.createElement('button')
      applyBtn.textContent = `Apply: ${pendingType}`
      applyBtn.style.cssText = 'width:100%;padding:8px;margin-top:6px;background:#4455aa;color:#fff;border:none;cursor:pointer;border-radius:3px;font-weight:bold;font-size:12px'
      applyBtn.addEventListener('click', () => {
        applyBtn.disabled = true
        applyBtn.style.opacity = '0.6'
        applyBtn.style.cursor = 'default'
        const dialog = new NameDialog({
          entityKind: 'edge', entityLabel: pendingType, subType: pendingType,
          onApply: (name, description) => {
            this.eventBus.emit('EDGE_APPLY', { name, description })
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

  // Called by UIManager.showSetupPhase — no-op since panel manages itself
  addFinishButton() {}

  // Legacy render() — no longer attaches to a container; kept so call sites don't crash
  render() {}
}
