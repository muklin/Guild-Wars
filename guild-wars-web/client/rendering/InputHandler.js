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
    document.addEventListener('keydown',  (e) => this.onkeypress(e))
  }
  
  setTerrainData(data) {
    this.terrainData = data
  }

  screenToWorld(screenX, screenY) {
    const rect = this.renderer.renderer.domElement.getBoundingClientRect()
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1
    const ndcY = -(((screenY - rect.top) / rect.height)) * 2 + 1

    const camera = this.renderer.camera

    // For an orthographic camera all rays are parallel (= camera look direction).
    // Offset the ray origin by the screen position along the camera's right/up axes,
    // then intersect with the y=0 ground plane.
    const cameraRight    = new THREE.Vector3()
    const cameraUp       = new THREE.Vector3()
    const cameraBackward = new THREE.Vector3()
    camera.matrixWorld.extractBasis(cameraRight, cameraUp, cameraBackward)

    const halfWidth  = (camera.right  - camera.left)   / (2 * camera.zoom)
    const halfHeight = (camera.top    - camera.bottom)  / (2 * camera.zoom)

    const rayOrigin = camera.position.clone()
      .addScaledVector(cameraRight, ndcX * halfWidth)
      .addScaledVector(cameraUp,    ndcY * halfHeight)

    const rayDir = cameraBackward.clone().negate() // camera looks in local -Z

    if (Math.abs(rayDir.y) < 0.0001) return { x: 0, y: 0 }
    const t = -rayOrigin.y / rayDir.y
    if (t < 0) return { x: 0, y: 0 }

    rayOrigin.addScaledVector(rayDir, t)
    return { x: rayOrigin.x, y: rayOrigin.z }
  }

  onMouseClick(e) {
    if (document.getElementById('ui-container')?.contains(e.target)) return
    const worldPos = this.screenToWorld(e.clientX, e.clientY)

    if (this.renderer.mode === 'city') {
      const cityEdge = this.renderer.getCityEdgeAtWorldPos(worldPos.x, worldPos.y)
      if (cityEdge) { this.eventBus.emit('CITY_EDGE_CLICKED', cityEdge); return }
      const district = this.renderer.getDistrictAtWorldPos(worldPos.x, worldPos.y)
      if (district) { this.eventBus.emit('DISTRICT_CLICKED', district.id); return }
      const region = this.renderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
      if (region) { this.eventBus.emit('REGION_CLICKED', region.id) }
      return
    }

    // Terrain mode
    const edge = this.renderer.getEdgeAtWorldPos(worldPos.x, worldPos.y)
    if (edge) { this.eventBus.emit('EDGE_CLICKED', edge); return }
    const region = this.renderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
    if (region) { this.eventBus.emit('REGION_CLICKED', region.id) }
  }

  onMouseMove(e) {
    if (document.getElementById('ui-container')?.contains(e.target)) {
      this.renderer.clearHover()
      this.tooltipEl && (this.tooltipEl.style.display = 'none')
      return
    }
    const worldPos = this.screenToWorld(e.clientX, e.clientY)
    const debug = this.renderer.showDebug

    if (this.renderer.mode === 'city') {
      const cityEdge = this.renderer.getCityEdgeAtWorldPos(worldPos.x, worldPos.y)
      if (cityEdge) { this.renderer.setCityEdgeHover(cityEdge.id); return }
      const district = this.renderer.getDistrictAtWorldPos(worldPos.x, worldPos.y)
      if (district) { this.renderer.setDistrictHover(district.id); return }
      const region = this.renderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
      if (region) { this.renderer.setRegionHover(region.id); return }
      this.renderer.clearHover()
      return
    }

    // Terrain mode — check region center seed points first
    const regionCenter = this.renderer.getCenterAtWorldPos(worldPos.x, worldPos.y, 0.5)
    if (regionCenter) {
      this.renderer.setRegionHover(regionCenter.regionId)
      if (debug) {
        this.tooltipEl.innerHTML = `
          <div style="font-weight: bold">Region ${regionCenter.regionId} (regionCenter)</div>
          <div style="margin-top: 4px; font-size: 0.9em">(${regionCenter.position.x.toFixed(2)}, ${regionCenter.position.y.toFixed(2)})</div>
        `
        this.tooltipEl.style.left = e.clientX + 10 + 'px'
        this.tooltipEl.style.top = e.clientY + 10 + 'px'
        this.tooltipEl.style.display = 'block'
      } else {
        this.tooltipEl.style.display = 'none'
      }
      return
    }

    const corner = this.renderer.getCornerAtWorldPos(worldPos.x, worldPos.y, 0.5)
    if (corner) {
      this.renderer.clearHover()
      if (debug) {
        const regionList = corner.regionIds
          .map((id, i) => `Region ${id} (v${corner.vertexIndices[i]})`).join(', ')
        const vid = corner.point.id !== undefined ? `Vertex ${corner.point.id}` : 'Vertex'
        this.tooltipEl.innerHTML = `
          <div style="font-weight: bold">${vid} (${corner.point.x.toFixed(2)}, ${corner.point.y.toFixed(2)})</div>
          <div style="margin-top: 4px; font-size: 0.9em">${regionList}</div>
        `
        this.tooltipEl.style.left = e.clientX + 10 + 'px'
        this.tooltipEl.style.top = e.clientY + 10 + 'px'
        this.tooltipEl.style.display = 'block'
      } else { this.tooltipEl.style.display = 'none' }
      return
    }

    const edge = this.renderer.getEdgeAtWorldPos(worldPos.x, worldPos.y)
    if (edge) { this.renderer.setEdgeHover(edge.id); this.tooltipEl.style.display = 'none'; return }

    const region = this.renderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
    if (region) {
      this.renderer.setRegionHover(region.id)
      if (debug) {
        this.tooltipEl.textContent = `Region ${region.id} - ${region.assignedType || 'Unassigned'}`
        this.tooltipEl.style.left = e.clientX + 10 + 'px'
        this.tooltipEl.style.top = e.clientY + 10 + 'px'
        this.tooltipEl.style.display = 'block'
      } else { this.tooltipEl.style.display = 'none' }
    } else {
      this.renderer.clearHover()
      this.tooltipEl.style.display = 'none'
    }
  }
  _isTyping() {
    const el = document.activeElement
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
  }

  onkeypress(e){
    if (e.code === 'KeyD' && e.shiftKey) {
      this.renderer.toggleDebugVisualization()
      e.preventDefault()
      return
    }
    if (this._isTyping()) return
    if (e.code === 'Space') {
      this.renderer.isPaused = !this.renderer.isPaused
      console.log(`Render loop ${this.renderer.isPaused ? 'PAUSED' : 'RESUMED'}`)
      e.preventDefault()
    }
  }
}
