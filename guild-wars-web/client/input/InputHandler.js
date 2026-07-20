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

  // Real raycast against the ground meshes (TODO.md "Groundplane Z-height
  // implementation", plan "rustling-churning-finch") — first plane actually intersected,
  // not an analytic z=0 plane assumption, so hover/click land on the right spot now that
  // terrain plots render with real relief (TerrainRenderer.buildRegionMesh). Falls back
  // to the old flat y=0 plane intersection when nothing is hit (no terrain rendered yet,
  // City mode's still-flat ground, empty space) so every existing 2-D containment test
  // downstream (getRegionAtWorldPos etc.) keeps working unchanged either way — only HOW
  // x/y get derived changed, not their meaning. `.z` is new: the actual hit height,
  // straight from the mesh, more accurate than a data-average lookup.
  screenToWorld(screenX, screenY) {
    const rect = this.renderer.renderer.domElement.getBoundingClientRect()
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1
    const ndcY = -(((screenY - rect.top) / rect.height)) * 2 + 1
    const camera = this.renderer.camera

    const meshes = this.renderer.getPickableMeshes?.() || []
    if (meshes.length) {
      if (!this._raycaster) this._raycaster = new THREE.Raycaster()
      this._raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera)
      const hits = this._raycaster.intersectObjects(meshes, false)
      if (hits.length) return { x: hits[0].point.x, y: hits[0].point.z, z: hits[0].point.y }
    }
    return this._screenToWorldFlatPlane(ndcX, ndcY, camera)
  }

  // Original analytic method — intersect the camera ray with the y=0 plane directly,
  // without a raycaster or any mesh. Kept as the fallback for when no pickable mesh
  // exists yet (or the ray misses every mesh, e.g. past the map edge).
  _screenToWorldFlatPlane(ndcX, ndcY, camera) {
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

    if (Math.abs(rayDir.y) < 0.0001) return { x: 0, y: 0, z: 0 }
    const t = -rayOrigin.y / rayDir.y
    if (t < 0) return { x: 0, y: 0, z: 0 }

    rayOrigin.addScaledVector(rayDir, t)
    return { x: rayOrigin.x, y: rayOrigin.z, z: 0 }
  }

  onMouseClick(e) {
    if (e.target !== this.renderer?.renderer?.domElement) return
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
        const cityEdge = this.renderer.districtRenderer.getCityEdgeAtWorldPos(worldPos.x, worldPos.y)
        if (cityEdge) { this.eventBus.emit('CITY_EDGE_CLICKED', cityEdge); return }
      }
      const district = this.renderer.districtRenderer.getDistrictAtWorldPos(worldPos.x, worldPos.y)
      if (district) { this.eventBus.emit('DISTRICT_CLICKED', district.id); return }
      if (!this.renderer.guildSetupActive) {
        const rawPlot = this.renderer.terrainRenderer.getTerrainPlotAtWorldPos(worldPos.x, worldPos.y)
        if (rawPlot) { this.eventBus.emit('TERRAIN_PLOT_CLICKED', rawPlot); return }
        const region = this.renderer.terrainRenderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
        if (region) { this.eventBus.emit('REGION_CLICKED', region.id); return }
      }
      this.eventBus.emit('MAP_EMPTY_CLICKED')
      return
    }

    // Terrain mode
    const edge = this.renderer.terrainRenderer.getEdgeAtWorldPos(worldPos.x, worldPos.y)
    if (edge) { this.eventBus.emit('EDGE_CLICKED', edge); return }
    const region = this.renderer.terrainRenderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
    if (region) { this.eventBus.emit('REGION_CLICKED', region.id); return }
    this.eventBus.emit('MAP_EMPTY_CLICKED')
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
    // Not the canvas itself → the pointer is over SOME floating UI surface. Most
    // panels (TerrainTypePanel/GuildPanel/FactionsPanel/action-panel/help window/etc.)
    // mount straight to document.body rather than inside #ui-container (see
    // UIManager.setWalkMode's own doc comment — deliberate, so they can float/toggle
    // independently), so an #ui-container-only containment check missed all of them:
    // moving the mouse over e.g. the "N Edges Selected" panel kept raycasting the
    // scene underneath it, showing a phantom hover highlight instead of leaving the
    // real selection visible (confirmed live 2026-07-19). Checking the actual event
    // target against the canvas element itself covers every current and future
    // floating panel by construction, not just whichever ones happen to be registered.
    if (e.target !== this.renderer?.renderer?.domElement) {
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
        // Top-down mode renders the ground flattened to z=0 (user-confirmed 2026-07-13,
        // floor-scroll clip reinstatement), so worldPos.z (the raycast hit) is now
        // always ~0 — not useful. Show what the height would be in iso mode instead:
        // getZHeightAtWorldPos reads the original data polygon (cell.polygon[i].z),
        // a separate copy from the flattened GPU vertex buffer, so it's unaffected by
        // the flatten toggle.
        const realZ = this.renderer.getZHeightAtWorldPos?.(worldPos.x, worldPos.y)
        const zStr = realZ == null ? '—' : realZ.toFixed(3)
        this._coordDisplay.textContent = `X: ${worldPos.x.toFixed(3)}  Y: ${worldPos.y.toFixed(3)}  Z: ${zStr}`
        this._coordDisplay.style.display = 'block'
      } else {
        this._coordDisplay.style.display = 'none'
      }
    }

    if (this.renderer.mode === 'city') {
      // District hover applies in non-debug sub-modes only — disabled in debug mode
      // (2026-07-12) so highlighting a whole district's colour doesn't fight visually
      // with precisely positioning over a small debug dot (confirmed live: this branch
      // used to run unconditionally, INCLUDING while debug was on).
      const district = debug ? null : this.renderer.districtRenderer.getDistrictAtWorldPos(worldPos.x, worldPos.y)
      if (district) { this.renderer.districtRenderer.setDistrictHover(district.id); this._hideTooltip() }

      if (debug) {
        // Debug dot priority: block > plot > street junction seed > district center >
        // terrain plot center > terrain (region) center. City-specific dots take
        // priority since that's the more common thing being inspected in city mode;
        // terrain centers are checked last since they're coarser/less specific and
        // still persist in the background under city geometry.
        const blockCenter    = this.renderer.groundRenderer.getBlockCenterAtWorldPos(worldPos.x, worldPos.y, 0.05)
        const plotCenter     = blockCenter ? null : this.renderer.groundRenderer.getPlotCenterAtWorldPos(worldPos.x, worldPos.y, 0.04)
        const streetSeed     = (!blockCenter && !plotCenter) ? this.renderer.groundRenderer.getStreetSeedAtWorldPos(worldPos.x, worldPos.y, 0.03) : null
        const districtCenter = (!blockCenter && !plotCenter && !streetSeed) ? this.renderer.districtRenderer.getDistrictCenterAtWorldPos(worldPos.x, worldPos.y, 0.1) : null
        const priorSoFar = blockCenter || plotCenter || streetSeed || districtCenter
        const surfaceCorner = priorSoFar ? null : this.renderer.terrainRenderer.getSurfaceCornerAtWorldPos(worldPos.x, worldPos.y, 0.05)
        const priorSoFar2 = priorSoFar || surfaceCorner
        const terrainVertex = priorSoFar2 ? null : this.renderer.terrainRenderer.getTerrainCornerAtWorldPos(worldPos.x, worldPos.y, 0.06)
        const priorSoFar3 = priorSoFar2 || terrainVertex
        const terrainPlotCenter = priorSoFar3 ? null : this.renderer.terrainRenderer.getTerrainPlotCenterAtWorldPos(worldPos.x, worldPos.y, 0.06)
        const terrainCenter     = (priorSoFar3 || terrainPlotCenter) ? null : this.renderer.terrainRenderer.getTerrainCenterAtWorldPos(worldPos.x, worldPos.y, 0.12)
        const dot = priorSoFar3 || terrainPlotCenter || terrainCenter
        if (dot === terrainVertex && terrainVertex) {
          this.renderer.clearHover()
          const regionList = terrainVertex.regionIds
            .map((id, i) => `Region ${id} (v${terrainVertex.vertexIndices[i]})`).join(', ')
          const vid = terrainVertex.point.id !== undefined ? `Vertex ${terrainVertex.point.id}` : 'Vertex'
          this._showTooltip(
            `<div style="font-weight:bold">${vid}</div>` +
            `<div style="font-size:0.9em;margin-top:2px">${regionList}</div>` +
            `<div style="font-size:0.85em;opacity:0.85">(${terrainVertex.point.x.toFixed(3)}, ${terrainVertex.point.y.toFixed(3)}) &nbsp;Z: ${(terrainVertex.point.z ?? 0).toFixed(3)}</div>`,
            e)
          return
        }
        if (dot === surfaceCorner && surfaceCorner) {
          this.renderer.clearHover()
          this._showTooltip(
            `<div style="font-weight:bold">Surface Corner ${surfaceCorner.id}</div>` +
            `<div style="font-size:0.9em;margin-top:2px">source: ${surfaceCorner.sourceKind ?? '?'}</div>` +
            `<div style="font-size:0.85em;opacity:0.85">(${surfaceCorner.x?.toFixed(3)}, ${surfaceCorner.y?.toFixed(3)}) &nbsp;Z: ${(surfaceCorner.z ?? 0).toFixed(3)}</div>`,
            e)
          return
        }
        if (dot) {
          this.renderer.clearHover()
          if (dot.kind === 'block') {
            this.renderer.groundRenderer.setBlockHover(dot.id)
            this._showTooltip(
              `<div style="font-weight:bold">Block ${dot.id}</div>` +
              `<div style="font-size:0.9em;margin-top:2px">type: ${dot.blockType ?? '?'} &nbsp;|&nbsp; district: ${dot.districtId ?? '?'}</div>`,
              e)
          } else if (dot.kind === 'plot') {
            this._showTooltip(
              `<div style="font-weight:bold">Plot ${dot.id}</div>` +
              `<div style="font-size:0.9em;margin-top:2px">block: ${dot.blockId ?? '?'} &nbsp;|&nbsp; district: ${dot.districtId ?? '?'}</div>` +
              `<div style="font-size:0.85em;opacity:0.85">blockType: ${dot.blockType} &nbsp;|&nbsp; streetEdges: ${dot.streetEdges?.length ?? 0}</div>`,
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
          } else if (dot.kind === 'terrainPlotCenter') {
            this._showTooltip(
              `<div style="font-weight:bold">Terrain Plot ${dot.id}</div>` +
              `<div style="font-size:0.9em;margin-top:2px">region: ${dot.parentRegionId ?? '?'} &nbsp;|&nbsp; type: ${dot.assignedType ?? 'unassigned'}</div>` +
              `<div style="font-size:0.85em;opacity:0.85">(${dot.x?.toFixed(3)}, ${dot.y?.toFixed(3)}) &nbsp;Z: ${(dot.z ?? 0).toFixed(3)}</div>`,
              e)
          } else if (dot.kind === 'terrainCenter') {
            this._showTooltip(
              `<div style="font-weight:bold">Region ${dot.id}</div>` +
              `<div style="font-size:0.9em;margin-top:2px">type: ${dot.assignedType ?? 'unassigned'}</div>` +
              `<div style="font-size:0.85em;opacity:0.85">(${dot.x?.toFixed(3)}, ${dot.y?.toFixed(3)}) &nbsp;Z: ${(dot.z ?? 0).toFixed(3)}</div>`,
              e)
          }
          return
        }
        // Street graph hover (junction nodes and edges)
        const junction = this.renderer.groundRenderer.getJunctionAtWorldPos(worldPos.x, worldPos.y, 0.05)
        if (junction) {
          this._showTooltip(
            `<div style="font-weight:bold">Junction ${junction.id}</div>` +
            `<div style="font-size:0.9em;margin-top:2px">type: ${junction.type ?? '?'} &nbsp;|&nbsp; district: ${junction.districtId ?? '?'}</div>` +
            `<div style="font-size:0.85em;margin-top:2px;opacity:0.85">connections: ${junction.connections.length} &nbsp;|&nbsp; (${junction.x.toFixed(3)}, ${junction.y.toFixed(3)})</div>`,
            e)
          this.renderer.groundRenderer.setJunctionHover(junction.id)
          return
        }
        const edge = this.renderer.groundRenderer.getStreetEdgeAtWorldPos(worldPos.x, worldPos.y)
        if (edge) {
          const idStr = edge.id !== null && edge.id !== undefined ? String(edge.id) : '?'
          this._showTooltip(
            `<div style="font-weight:bold">Street ${idStr}</div>` +
            `<div style="font-size:0.9em;margin-top:2px">type: ${edge.type ?? '?'} &nbsp;|&nbsp; district: ${edge.districtId != null ? edge.districtId : (edge.left != null || edge.right != null) ? `${edge.left ?? '?'} → ${edge.right ?? 'ext'}` : '?'}</div>` +
            `<div style="font-size:0.85em;margin-top:2px;opacity:0.85">nodes: ${edge.nodeA}→${edge.nodeB} &nbsp;|&nbsp; len: ${edge.length.toFixed(3)}</div>`,
            e)
          this.renderer.groundRenderer.setStreetEdgeHover(edge)
          return
        }
        // Debug mode with nothing under the cursor: stay quiet — do NOT fall through
        // to the broad terrain/district/edge highlighting below (that fallthrough was
        // confirmed live as the actual cause of "hover fights with picking a dot": it
        // ran even in debug mode whenever the cursor wasn't exactly on a dot).
        this.renderer.clearHover()
        this._hideTooltip()
        return
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
      // terrain edges, terrain plots, and regions. Return after the first hit so
      // clearHover() only fires when nothing is under the cursor.
      if (district) return  // district hover already set; don't clear it
      if (!this.renderer.guildSetupActive) {
        const cityEdge = this.renderer.districtRenderer.getCityEdgeAtWorldPos(worldPos.x, worldPos.y)
        if (cityEdge) { this.renderer.setCityEdgeHover(cityEdge.id); this._hideTooltip(); return }
        const rawPlot = this.renderer.terrainRenderer.getTerrainPlotAtWorldPos(worldPos.x, worldPos.y)
        if (rawPlot) { this.renderer.setTerrainPlotHover(rawPlot.id); this._hideTooltip(); return }
        const region = this.renderer.terrainRenderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
        if (region) { this.renderer.setRegionHover(region.id); this._hideTooltip(); return }
      }
      this.renderer.clearHover()
      this._hideTooltip()
      return
    }

    // Terrain mode — check Surface corner points first (finest granularity, off by
    // default — see DebugPanel), then terrain PLOT centers, then coarse region centers.
    const surfaceCorner = this.renderer.terrainRenderer.getSurfaceCornerAtWorldPos(worldPos.x, worldPos.y, 0.05)
    if (surfaceCorner) {
      this.renderer.clearHover()
      if (debug) {
        this._showTooltip(
          `<div style="font-weight:bold">Surface Corner ${surfaceCorner.id}</div>` +
          `<div style="font-size:0.9em;margin-top:2px">source: ${surfaceCorner.sourceKind ?? '?'}</div>` +
          `<div style="font-size:0.85em;opacity:0.85">(${surfaceCorner.x?.toFixed(3)}, ${surfaceCorner.y?.toFixed(3)})</div>`,
          e)
      } else { this._hideTooltip() }
      return
    }

    // Both terrain PLOT centers and region centers are debug-only dots
    // (drawVoronoiCenters/drawTerrainPlotCenters) but stay hoverable outside debug mode
    // too, same as before, for the tooltip-off/region-hover-only legacy behaviour.
    const terrainPlotCenter = this.renderer.terrainRenderer.getTerrainPlotCenterAtWorldPos(worldPos.x, worldPos.y, 0.06)
    if (terrainPlotCenter) {
      this.renderer.clearHover()
      if (debug) {
        this._showTooltip(
          `<div style="font-weight:bold">Terrain Plot ${terrainPlotCenter.id}</div>` +
          `<div style="font-size:0.9em;margin-top:2px">region: ${terrainPlotCenter.parentRegionId ?? '?'} &nbsp;|&nbsp; type: ${terrainPlotCenter.assignedType ?? 'unassigned'}</div>` +
          `<div style="font-size:0.85em;opacity:0.85">(${terrainPlotCenter.x?.toFixed(3)}, ${terrainPlotCenter.y?.toFixed(3)}) &nbsp;Z: ${(terrainPlotCenter.z ?? 0).toFixed(3)}</div>`,
          e)
      } else { this._hideTooltip() }
      return
    }

    const regionCenter = this.renderer.terrainRenderer.getTerrainSeedAtWorldPos(worldPos.x, worldPos.y, 0.1)
    if (regionCenter) {
      // Region hover highlight is disabled in debug mode (2026-07-12) — see the
      // city-mode branch's matching comment; only the tooltip should show while
      // precisely positioning over a debug dot.
      if (!debug) this.renderer.setRegionHover(regionCenter.regionId)
      else this.renderer.clearHover()
      if (debug) {
        this._showTooltip(
          `<div style="font-weight:bold">Region ${regionCenter.regionId} (terrainCenter)</div>` +
          `<div style="margin-top:4px;font-size:0.9em">(${regionCenter.position.x.toFixed(2)}, ${regionCenter.position.y.toFixed(2)}) &nbsp;Z: ${(regionCenter.position.z ?? 0).toFixed(3)}</div>`,
          e)
      } else {
        this._hideTooltip()
      }
      return
    }

    const corner = this.renderer.terrainRenderer.getTerrainCornerAtWorldPos(worldPos.x, worldPos.y, 0.1)
    if (corner) {
      this.renderer.clearHover()
      if (debug) {
        const regionList = corner.regionIds
          .map((id, i) => `Region ${id} (v${corner.vertexIndices[i]})`).join(', ')
        const vid = corner.point.id !== undefined ? `Vertex ${corner.point.id}` : 'Vertex'
        this._showTooltip(
          `<div style="font-weight:bold">${vid} (${corner.point.x.toFixed(2)}, ${corner.point.y.toFixed(2)}) Z: ${(corner.point.z ?? 0).toFixed(3)}</div>` +
          `<div style="margin-top:4px;font-size:0.9em">${regionList}</div>`,
          e)
      } else { this._hideTooltip() }
      return
    }

    // Broad edge/region hover (highlighting) is disabled in debug mode — same reasoning
    // as the district/region hover disabling above: it otherwise fights with precisely
    // positioning over a small debug dot.
    if (debug) { this.renderer.clearHover(); this._hideTooltip(); return }

    const edge = this.renderer.terrainRenderer.getEdgeAtWorldPos(worldPos.x, worldPos.y)
    if (edge) { this.renderer.setEdgeHover(edge.id); this._hideTooltip(); return }

    const region = this.renderer.terrainRenderer.getRegionAtWorldPos(worldPos.x, worldPos.y)
    if (region) {
      this.renderer.setRegionHover(region.id)
      this._hideTooltip()
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
