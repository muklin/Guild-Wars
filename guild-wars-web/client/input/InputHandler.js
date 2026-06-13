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
      // Headquarters picking takes priority: a plot, else the nearest Landmark.
      if (this.renderer.hqPickMode) {
        const plot = this.renderer.getPlotAtWorldPos(worldPos.x, worldPos.y)
        if (plot) { this.eventBus.emit('HQ_PICKED', { kind: 'plot', ...plot }); return }
        const landmark = this.renderer.getLandmarkAtWorldPos(worldPos.x, worldPos.y)
        if (landmark) { this.eventBus.emit('HQ_PICKED', { kind: 'landmark', ...landmark }); return }
        return
      }
      // In Guild Setup the city is final: terrain regions and district (city) edges are
      // no longer selectable — only Headquarters picking above remains.
      if (!this.renderer.guildSetupActive) {
        const cityEdge = this.renderer.getCityEdgeAtWorldPos(worldPos.x, worldPos.y)
        if (cityEdge) { this.eventBus.emit('CITY_EDGE_CLICKED', cityEdge); return }
      }
      const district = this.renderer.getDistrictAtWorldPos(worldPos.x, worldPos.y)
      if (district) { this.eventBus.emit('DISTRICT_CLICKED', district.id); return }
      if (!this.renderer.guildSetupActive) {
        const region = this.renderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
        if (region) { this.eventBus.emit('REGION_CLICKED', region.id) }
      }
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

    if (this.renderer.mode === 'streets') {
      if (debug) {
        const blockCenter  = this.renderer.getBlockCenterAtWorldPos(worldPos.x, worldPos.y, 0.2)
        const plotCenter   = blockCenter ? null : this.renderer.getPlotCenterAtWorldPos(worldPos.x, worldPos.y, 0.2)
        const streetSeed   = (!blockCenter && !plotCenter) ? this.renderer.getStreetSeedAtWorldPos(worldPos.x, worldPos.y, 0.1) : null
        const center = blockCenter || plotCenter || streetSeed
        if (center) {
          this.renderer.clearHover()
          if (center.kind === 'block') {
            this.renderer.setBlockHover(center.id)
            this.tooltipEl.innerHTML = `<div style="font-weight:bold">Block ${center.id}</div>`
              + `<div style="font-size:0.9em;margin-top:2px">type: ${center.blockType ?? '?'} &nbsp;|&nbsp; district: ${center.districtId ?? '?'}</div>`
          } else if (center.kind === 'plot') {
            this.tooltipEl.innerHTML = `<div style="font-weight:bold">Plot ${center.id}</div>`
              + `<div style="font-size:0.9em;margin-top:2px">block: ${center.blockId ?? '?'} &nbsp;|&nbsp; district: ${center.districtId ?? '?'}</div>`
              + `<div style="font-size:0.85em;opacity:0.85">blockType: ${center.blockType} &nbsp;|&nbsp; streetEdges: ${center.streetEdges}</div>`
          } else if (center.kind === 'streetSeed') {
            this.tooltipEl.innerHTML = `<div style="font-weight:bold">Junction ${center.id}</div>`
              + `<div style="font-size:0.9em;margin-top:2px">type: ${center.type ?? '?'} &nbsp;|&nbsp; district: ${center.districtId ?? '?'}</div>`
              + `<div style="font-size:0.85em;opacity:0.85">connections: ${center.connections} &nbsp;|&nbsp; (${center.x?.toFixed(3)}, ${center.y?.toFixed(3)})</div>`
          }
          this.tooltipEl.style.left = e.clientX + 10 + 'px'
          this.tooltipEl.style.top  = e.clientY + 10 + 'px'
          this.tooltipEl.style.display = 'block'
          return
        }
        const junction = this.renderer.getJunctionAtWorldPos(worldPos.x, worldPos.y)
        if (junction) {
          this.tooltipEl.innerHTML = `<div style="font-weight:bold">Junction ${junction.id}</div>`
            + `<div style="font-size:0.9em;margin-top:2px">type: ${junction.type ?? '?'} &nbsp;|&nbsp; district: ${junction.districtId ?? '?'}</div>`
            + `<div style="font-size:0.85em;margin-top:2px;opacity:0.85">connections: ${junction.connections.length} &nbsp;|&nbsp; (${junction.x.toFixed(3)}, ${junction.y.toFixed(3)})</div>`
          this.tooltipEl.style.left = e.clientX + 10 + 'px'
          this.tooltipEl.style.top  = e.clientY + 10 + 'px'
          this.tooltipEl.style.display = 'block'
          this.renderer.setJunctionHover(junction.id)
          return
        }
        const edge = this.renderer.getStreetEdgeAtWorldPos(worldPos.x, worldPos.y)
        if (edge) {
          const idStr = edge.id !== null && edge.id !== undefined ? String(edge.id) : '?'
          this.tooltipEl.innerHTML = `<div style="font-weight:bold">Street ${idStr}</div>`
            + `<div style="font-size:0.9em;margin-top:2px">type: ${edge.type ?? '?'} &nbsp;|&nbsp; district: ${edge.districtId ?? '?'}</div>`
            + `<div style="font-size:0.85em;margin-top:2px;opacity:0.85">nodes: ${edge.nodeA}→${edge.nodeB} &nbsp;|&nbsp; len: ${edge.length.toFixed(3)}</div>`
          this.tooltipEl.style.left = e.clientX + 10 + 'px'
          this.tooltipEl.style.top  = e.clientY + 10 + 'px'
          this.tooltipEl.style.display = 'block'
          this.renderer.setStreetEdgeHover(edge)
          return
        }
      }
      this.renderer.clearHover()
      this.tooltipEl && (this.tooltipEl.style.display = 'none')
      return
    }

    if (this.renderer.mode === 'city') {
      const guildSetup = this.renderer.guildSetupActive
      if (!guildSetup) {
        const cityEdge = this.renderer.getCityEdgeAtWorldPos(worldPos.x, worldPos.y)
        if (cityEdge) { this.renderer.setCityEdgeHover(cityEdge.id); return }
      }
      const district = this.renderer.getDistrictAtWorldPos(worldPos.x, worldPos.y)
      if (district) { this.renderer.setDistrictHover(district.id); return }
      if (!guildSetup) {
        const region = this.renderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
        if (region) { this.renderer.setRegionHover(region.id); return }
      }
      this.renderer.clearHover()
      return
    }

    // Terrain mode — check region center seed points first
    const regionCenter = this.renderer.getTerrainSeedAtWorldPos(worldPos.x, worldPos.y, 0.5)
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

    const corner = this.renderer.getTerrainCornerAtWorldPos(worldPos.x, worldPos.y, 0.5)
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
      this.eventBus.emit('DEBUG_TOGGLED', this.renderer.showDebug)
      e.preventDefault()
      return
    }
    if (e.code === 'KeyW' && e.shiftKey) {
      this.eventBus.emit('WALK_MODE_TOGGLED')
      e.preventDefault()
      return
    }
    if (e.code === 'KeyB' && e.shiftKey) {
      this.renderer.toggleBuildings()
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
