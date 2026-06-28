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
    this._coordDisplay = this._buildCoordDisplay()
  }

  _buildCoordDisplay() {
    const el = document.createElement('div')
    el.style.cssText = [
      'position:fixed', 'top:10px', 'left:10px', 'z-index:50',
      'background:#111c', 'border:1px solid #555', 'border-radius:5px',
      'padding:6px 10px', 'color:#4ade80', 'font:12px/1.4 monospace',
      'pointer-events:none', 'display:none',
      'box-shadow:0 4px 16px #0008', 'letter-spacing:0.04em',
    ].join(';')
    document.body.appendChild(el)
    return el
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
        if (plot) { this.eventBus.emit('HQ_PREVIEW', { kind: 'plot', refId: plot.id, districtId: plot.districtId }); return }
        const landmark = this.renderer.getLandmarkAtWorldPos(worldPos.x, worldPos.y)
        if (landmark) { this.eventBus.emit('HQ_PREVIEW', { kind: 'landmark', refId: landmark.refId, districtId: landmark.districtId }); return }
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
        const fineCell = this.renderer.getFineCellAtWorldPos(worldPos.x, worldPos.y)
        if (fineCell) { this.eventBus.emit('TERRAIN_FINE_CELL_CLICKED', fineCell); return }
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

  _showTooltip(html, e) {
    this.tooltipEl.innerHTML = html
    this.tooltipEl.style.left = e.clientX + 10 + 'px'
    this.tooltipEl.style.top  = e.clientY + 10 + 'px'
    this.tooltipEl.style.display = 'block'
  }

  _hideTooltip() {
    this.tooltipEl && (this.tooltipEl.style.display = 'none')
  }

  onMouseMove(e) {
    if (document.getElementById('ui-container')?.contains(e.target)) {
      this.renderer.clearHover()
      this._hideTooltip()
      if (this.renderer.hqPickMode) document.body.style.cursor = ''
      return
    }
    const worldPos = this.screenToWorld(e.clientX, e.clientY)
    const debug = this.renderer.showDebug
    const isTopDown = this.renderer.cameraController?._topDown
    if (this._coordDisplay) {
      if (debug && isTopDown) {
        this._coordDisplay.textContent = `X: ${worldPos.x.toFixed(3)}  Y: ${worldPos.y.toFixed(3)}`
        this._coordDisplay.style.display = 'block'
      } else {
        this._coordDisplay.style.display = 'none'
      }
    }

    if (this.renderer.mode === 'city') {
      // District hover applies in all sub-modes (debug and non-debug alike)
      const district = this.renderer.getDistrictAtWorldPos(worldPos.x, worldPos.y)
      if (district) { this.renderer.setDistrictHover(district.id); this._hideTooltip() }

      if (debug) {
        // Debug dot priority: block > plot > street junction seed > district center
        // Thresholds are ~1.5× the sphere visual radius so hovering is responsive
        // without the hit area feeling huge.
        const blockCenter    = this.renderer.getBlockCenterAtWorldPos(worldPos.x, worldPos.y, 0.05)
        const plotCenter     = blockCenter ? null : this.renderer.getPlotCenterAtWorldPos(worldPos.x, worldPos.y, 0.04)
        const streetSeed     = (!blockCenter && !plotCenter) ? this.renderer.getStreetSeedAtWorldPos(worldPos.x, worldPos.y, 0.03) : null
        const districtCenter = (!blockCenter && !plotCenter && !streetSeed) ? this.renderer.getDistrictCenterAtWorldPos(worldPos.x, worldPos.y, 0.1) : null
        const dot = blockCenter || plotCenter || streetSeed || districtCenter
        if (dot) {
          this.renderer.clearHover()
          if (dot.kind === 'block') {
            this.renderer.setBlockHover(dot.id)
            this._showTooltip(
              `<div style="font-weight:bold">Block ${dot.id}</div>` +
              `<div style="font-size:0.9em;margin-top:2px">type: ${dot.blockType ?? '?'} &nbsp;|&nbsp; district: ${dot.districtId ?? '?'}</div>`,
              e)
          } else if (dot.kind === 'plot') {
            this._showTooltip(
              `<div style="font-weight:bold">Plot ${dot.id}</div>` +
              `<div style="font-size:0.9em;margin-top:2px">block: ${dot.blockId ?? '?'} &nbsp;|&nbsp; district: ${dot.districtId ?? '?'}</div>` +
              `<div style="font-size:0.85em;opacity:0.85">blockType: ${dot.blockType} &nbsp;|&nbsp; streetEdges: ${dot.streetEdges}</div>`,
              e)
          } else if (dot.kind === 'streetSeed') {
            this._showTooltip(
              `<div style="font-weight:bold">Junction ${dot.id}</div>` +
              `<div style="font-size:0.9em;margin-top:2px">type: ${dot.type ?? '?'} &nbsp;|&nbsp; district: ${dot.districtId ?? '?'}</div>` +
              `<div style="font-size:0.85em;opacity:0.85">connections: ${dot.connections} &nbsp;|&nbsp; (${dot.x?.toFixed(3)}, ${dot.y?.toFixed(3)})</div>`,
              e)
          } else if (dot.kind === 'districtCenter') {
            this._showTooltip(
              `<div style="font-weight:bold">District ${dot.id}</div>` +
              `<div style="font-size:0.9em;margin-top:2px">type: ${dot.assignedType ?? '?'}</div>` +
              (dot.residentialClass ? `<div style="font-size:0.85em;opacity:0.85">class: ${dot.residentialClass}</div>` : ''),
              e)
          }
          return
        }
        // Street graph hover (junction nodes and edges)
        const junction = this.renderer.getJunctionAtWorldPos(worldPos.x, worldPos.y, 0.05)
        if (junction) {
          this._showTooltip(
            `<div style="font-weight:bold">Junction ${junction.id}</div>` +
            `<div style="font-size:0.9em;margin-top:2px">type: ${junction.type ?? '?'} &nbsp;|&nbsp; district: ${junction.districtId ?? '?'}</div>` +
            `<div style="font-size:0.85em;margin-top:2px;opacity:0.85">connections: ${junction.connections.length} &nbsp;|&nbsp; (${junction.x.toFixed(3)}, ${junction.y.toFixed(3)})</div>`,
            e)
          this.renderer.setJunctionHover(junction.id)
          return
        }
        const edge = this.renderer.getStreetEdgeAtWorldPos(worldPos.x, worldPos.y)
        if (edge) {
          const idStr = edge.id !== null && edge.id !== undefined ? String(edge.id) : '?'
          this._showTooltip(
            `<div style="font-weight:bold">Street ${idStr}</div>` +
            `<div style="font-size:0.9em;margin-top:2px">type: ${edge.type ?? '?'} &nbsp;|&nbsp; district: ${edge.districtId ?? '?'}</div>` +
            `<div style="font-size:0.85em;margin-top:2px;opacity:0.85">nodes: ${edge.nodeA}→${edge.nodeB} &nbsp;|&nbsp; len: ${edge.length.toFixed(3)}</div>`,
            e)
          this.renderer.setStreetEdgeHover(edge)
          return
        }
      }
      // HQ pick mode: outline hovered plot or landmark, no other interaction.
      if (this.renderer.hqPickMode) {
        const plot = this.renderer.getPlotAtWorldPos(worldPos.x, worldPos.y)
        if (plot) {
          this.renderer.setHQHover('plot', plot.id)
          document.body.style.cursor = 'pointer'
          return
        }
        const landmark = this.renderer.getLandmarkAtWorldPos(worldPos.x, worldPos.y)
        if (landmark) {
          this.renderer.setHQHover('landmark', landmark.refId)
          document.body.style.cursor = 'pointer'
          return
        }
        document.body.style.cursor = ''
        this.renderer.clearHQHover()
        return
      }

      // Standard non-debug hover: district was already checked above; now check
      // terrain edges, fine cells, and regions. Return after the first hit so
      // clearHover() only fires when nothing is under the cursor.
      if (district) return  // district hover already set; don't clear it
      if (!this.renderer.guildSetupActive) {
        const cityEdge = this.renderer.getCityEdgeAtWorldPos(worldPos.x, worldPos.y)
        if (cityEdge) { this.renderer.setCityEdgeHover(cityEdge.id); this._hideTooltip(); return }
        const fineCell = this.renderer.getFineCellAtWorldPos(worldPos.x, worldPos.y)
        if (fineCell) { this.renderer.setFineCellHover(fineCell.id); this._hideTooltip(); return }
        const region = this.renderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
        if (region) { this.renderer.setRegionHover(region.id); this._hideTooltip(); return }
      }
      this.renderer.clearHover()
      this._hideTooltip()
      return
    }

    // Terrain mode — check region center seed points first
    const regionCenter = this.renderer.getTerrainSeedAtWorldPos(worldPos.x, worldPos.y, 0.1)
    if (regionCenter) {
      this.renderer.setRegionHover(regionCenter.regionId)
      if (debug) {
        this._showTooltip(
          `<div style="font-weight:bold">Region ${regionCenter.regionId} (terrainCenter)</div>` +
          `<div style="margin-top:4px;font-size:0.9em">(${regionCenter.position.x.toFixed(2)}, ${regionCenter.position.y.toFixed(2)})</div>`,
          e)
      } else {
        this._hideTooltip()
      }
      return
    }

    const corner = this.renderer.getTerrainCornerAtWorldPos(worldPos.x, worldPos.y, 0.1)
    if (corner) {
      this.renderer.clearHover()
      if (debug) {
        const regionList = corner.regionIds
          .map((id, i) => `Region ${id} (v${corner.vertexIndices[i]})`).join(', ')
        const vid = corner.point.id !== undefined ? `Vertex ${corner.point.id}` : 'Vertex'
        this._showTooltip(
          `<div style="font-weight:bold">${vid} (${corner.point.x.toFixed(2)}, ${corner.point.y.toFixed(2)})</div>` +
          `<div style="margin-top:4px;font-size:0.9em">${regionList}</div>`,
          e)
      } else { this._hideTooltip() }
      return
    }

    const edge = this.renderer.getEdgeAtWorldPos(worldPos.x, worldPos.y)
    if (edge) { this.renderer.setEdgeHover(edge.id); this._hideTooltip(); return }

    const region = this.renderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
    if (region) {
      this.renderer.setRegionHover(region.id)
      if (debug) {
        this._showTooltip(`Region ${region.id} - ${region.assignedType || 'Unassigned'}`, e)
      } else { this._hideTooltip() }
    } else {
      this.renderer.clearHover()
      this._hideTooltip()
    }
  }

  _isTyping() {
    const el = document.activeElement
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
  }

  onkeypress(e){
    if (this._isTyping()) return
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
    if (e.code === 'KeyB' && e.altKey) {
      const roofsOn = this.renderer.toggleRoofs()
      console.log(`Roofs ${roofsOn ? 'ON' : 'OFF'}`)
      e.preventDefault()
      return
    }
    if (e.code === 'Space') {
      this.renderer.isPaused = !this.renderer.isPaused
      console.log(`Render loop ${this.renderer.isPaused ? 'PAUSED' : 'RESUMED'}`)
      e.preventDefault()
    }
    if (e.code === 'KeyT') {
      const topDown = this.renderer.toggleTopDownMode()
      console.log(`Top-down mode ${topDown ? 'ON' : 'OFF'}`)
      e.preventDefault()
    }
  }
}
