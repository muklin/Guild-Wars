import TerrainColors from '../rendering/TerrainColors.js'

const TERRAIN_TYPES = ['Plains', 'Forest', 'Mountains', 'Desert', 'Swamp', 'Hills', 'Lake', 'Delta']
const EDGE_TYPES = ['Cliff', 'River']

export default class TerrainTypePanel {
  constructor(eventBus) {
    this.eventBus = eventBus
    this.mode = 'terrain' // 'terrain' or 'edge'
    this.container = null
  }

  render(container) {
    this.container = container
    container.innerHTML = ''

    const modeSelector = document.createElement('div')
    modeSelector.style.cssText = 'margin-bottom:15px;display:flex;gap:10px'

    const terrainBtn = document.createElement('button')
    terrainBtn.textContent = 'Terrain'
    terrainBtn.style.cssText = `flex:1;padding:8px;background:${this.mode === 'terrain' ? '#4a7c59' : '#333'};color:#fff;border:1px solid #666;cursor:pointer`
    terrainBtn.addEventListener('click', () => this.setMode('terrain'))
    modeSelector.appendChild(terrainBtn)

    const edgeBtn = document.createElement('button')
    edgeBtn.textContent = 'Edges'
    edgeBtn.style.cssText = `flex:1;padding:8px;background:${this.mode === 'edge' ? '#4a7c59' : '#333'};color:#fff;border:1px solid #666;cursor:pointer`
    edgeBtn.addEventListener('click', () => this.setMode('edge'))
    modeSelector.appendChild(edgeBtn)

    container.appendChild(modeSelector)

    if (this.mode === 'terrain') {
      this.renderTerrainButtons(container)
    } else {
      this.renderEdgeButtons(container)
    }
  }

  renderTerrainButtons(container) {
    const label = document.createElement('div')
    label.textContent = 'Select Terrain Type:'
    label.style.cssText = 'margin-bottom:10px;font-size:12px;color:#aaa'
    container.appendChild(label)

    const buttonContainer = document.createElement('div')
    buttonContainer.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:5px'

    for (const terrainType of TERRAIN_TYPES) {
      const btn = document.createElement('button')
      const color = TerrainColors.get(terrainType)
      btn.textContent = terrainType
      btn.style.cssText = `padding:8px;background:#2a2a2a;border:2px solid ${color};color:#fff;cursor:pointer;border-radius:3px;font-size:11px`
      btn.addEventListener('click', () => this.eventBus.emit('TERRAIN_ASSIGNED', { terrainType }))
      buttonContainer.appendChild(btn)
    }

    container.appendChild(buttonContainer)
  }

  renderEdgeButtons(container) {
    const label = document.createElement('div')
    label.textContent = 'Select Edge Type:'
    label.style.cssText = 'margin-bottom:10px;font-size:12px;color:#aaa'
    container.appendChild(label)

    const buttonContainer = document.createElement('div')
    buttonContainer.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:5px'

    for (const edgeType of EDGE_TYPES) {
      const btn = document.createElement('button')
      btn.textContent = edgeType
      btn.style.cssText = `padding:8px;background:#2a2a2a;border:2px solid #666;color:#fff;cursor:pointer;border-radius:3px;font-size:11px`
      btn.addEventListener('click', () => this.eventBus.emit('EDGE_ASSIGNED', { edgeType }))
      buttonContainer.appendChild(btn)
    }

    container.appendChild(buttonContainer)
  }

  addFinishButton(container) {
    const finishBtn = document.createElement('button')
    finishBtn.textContent = 'Finish Terrain Setup'
    finishBtn.style.cssText = 'width:100%;padding:10px;margin-top:15px;background:#3d5a3d;color:#fff;border:1px solid #4a7c59;cursor:pointer;border-radius:3px'
    finishBtn.addEventListener('click', () => this.eventBus.emit('TERRAIN_COMPLETE'))
    container.appendChild(finishBtn)
  }

  setMode(mode) {
    this.mode = mode
    if (this.container) {
      this.render(this.container)
    }
  }
}
