import TerrainColors from '../rendering/TerrainColors.js'

const TERRAIN_TYPES = ['Plains', 'Forest', 'Mountains', 'Desert', 'Swamp', 'Hills', 'Lake', 'Delta']
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

    // Finish Terrain always pinned at bottom
    const finishBtn = document.createElement('button')
    finishBtn.textContent = 'Finish Terrain Setup'
    finishBtn.style.cssText = 'width:100%;padding:10px;margin-top:auto;background:#3d5a3d;color:#fff;border:1px solid #4a7c59;cursor:pointer;border-radius:3px;flex-shrink:0'
    finishBtn.addEventListener('click', () => this.eventBus.emit('TERRAIN_COMPLETE'))
    this.container.appendChild(finishBtn)
  }

  _buildRegionContent(container, { pendingType }) {
    const label = document.createElement('div')
    label.textContent = 'Terrain Type'
    label.style.cssText = 'margin-bottom:8px;font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:1px'
    container.appendChild(label)

    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:10px'

    for (const type of TERRAIN_TYPES) {
      const color = TerrainColors.get(type)
      const hex = '#' + color.toString(16).padStart(6, '0')
      const isActive = type === pendingType
      const btn = document.createElement('button')
      btn.textContent = type
      btn.title = type
      btn.style.cssText = `padding:6px 4px;background:${isActive ? hex : '#2a2a2a'};border:2px solid ${hex};color:#fff;cursor:pointer;border-radius:3px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`
      btn.addEventListener('click', () => this.eventBus.emit('TERRAIN_TYPE_PREVIEW', type))
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
        this.eventBus.emit('TERRAIN_APPLY', { description: document.getElementById('terrain-description')?.value?.trim() || '' })
      })
      container.appendChild(applyBtn)
    }
  }

  _buildEdgeContent(container, { edgeCount, pendingType }) {
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
      if (type === 'Cliff' && edgeCount > 2) continue
      const isActive = type === pendingType
      const btn = document.createElement('button')
      btn.textContent = type
      btn.style.cssText = `padding:6px 4px;background:${isActive ? '#667' : '#2a2a2a'};border:2px solid #667;color:#fff;cursor:pointer;border-radius:3px;font-size:11px`
      btn.addEventListener('click', () => this.eventBus.emit('EDGE_TYPE_PREVIEW', type))
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
        this.eventBus.emit('EDGE_APPLY', { description: document.getElementById('edge-description')?.value?.trim() || '' })
      })
      container.appendChild(applyBtn)
    }
  }

  // Called by UIManager.showSetupPhase — no-op since render() handles everything
  addFinishButton() {}
}
