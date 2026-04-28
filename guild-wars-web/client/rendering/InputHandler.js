import * as THREE from 'three'

export default class InputHandler {
  constructor(eventBus) {
    this.eventBus = eventBus
    this.renderer = null
    this.terrainData = null
    this.tooltipEl = document.getElementById('tooltip')
  }

  init(renderer) {
    this.renderer = renderer
    document.addEventListener('click', (e) => this.onMouseClick(e))
    document.addEventListener('mousemove', (e) => this.onMouseMove(e))
  }

  setTerrainData(data) {
    this.terrainData = data
  }

  screenToWorld(screenX, screenY) {
    const rect = this.renderer.renderer.domElement.getBoundingClientRect()
    const x = screenX - rect.left
    const y = screenY - rect.top

    const ndcX = (x / rect.width) * 2 - 1
    const ndcY = -(y / rect.height) * 2 + 1

    const vector = new THREE.Vector3(ndcX, ndcY, 0.5)
    vector.unproject(this.renderer.camera)

    return { x: vector.x, y: vector.z }
  }

  onMouseClick(e) {
    const worldPos = this.screenToWorld(e.clientX, e.clientY)

    const region = this.renderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
    if (region) {
      this.eventBus.emit('REGION_CLICKED', region.id)
    }
  }

  onMouseMove(e) {
    const worldPos = this.screenToWorld(e.clientX, e.clientY)
    const region = this.renderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
    
    if (region) {
      this.tooltipEl.textContent = `Region ${region.id} - ${region.assignedType || 'Unassigned'}`
      this.tooltipEl.style.left = e.clientX + 10 + 'px'
      this.tooltipEl.style.top = e.clientY + 10 + 'px'
      this.tooltipEl.style.display = 'block'
    } else {
      this.tooltipEl.style.display = 'none'
    }
  }
}
