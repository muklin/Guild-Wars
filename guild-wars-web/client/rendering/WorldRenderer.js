import * as THREE from 'three'
import CameraController, { FLOOR_SCROLL_MAX } from '../input/CameraController.js'
import WalkMode from './WalkMode.js'

import TerrainRenderer from './TerrainRenderer.js'
import DistrictRenderer from './DistrictRenderer.js'
import GroundRenderer from './GroundRenderer.js'
import { pointInPolygon, distanceToLineSegment } from './utils/renderUtils.js'
import { GROUND_Y as BUILDING_GROUND_Y } from './utils/BuildingRenderer.js'

const RENDER_STREETS = true
const RENDER_GUTTERS = false
const RENDER_BLOCKS  = false
const RENDER_PLOTS   = true


export default class WorldRenderer {
  constructor() {
    this.scene = null
    this.camera = null
    this.renderer = null
    this.cameraController = null
    this.clock = new THREE.Clock()
    this.originalMaterials = new Map()
    this.showDebug = false
    this.mode = 'terrain'
    this.isPaused = false
    this.worldSize = 50
    this._needsRender = true
    this._lastCamPos = null
    this._frameCount = 0

    this.terrainRenderer  = null
    this.districtRenderer = null
    this.groundRenderer   = null

    this._walkMode = null
    this._walkModeOnExit = null
    this._hqHoverMesh = null
  }


  // ── Engine / Lifecycle ──────────────────────────────────────────────────────

  init() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0xff00ff)

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.shadowMap.enabled = false
    // Floor-scroll (see CameraController's floorScrollUnits) clips the scene with a
    // world-space horizontal plane while active — see _applyFloorScrollClip().
    this.renderer.localClippingEnabled = true
    this._floorScrollClipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)
    this._lastAppliedFloorScrollUnits = null
    document.body.insertBefore(this.renderer.domElement, document.body.firstChild)

    this._debugEl = document.createElement('div')
    this._debugEl.style.cssText = 'position:fixed;top:8px;left:8px;z-index:20;color:#fff;font:12px monospace;pointer-events:none;text-shadow:1px 1px 2px #000;display:none'
    document.body.appendChild(this._debugEl)

    const aspect = window.innerWidth / window.innerHeight
    const frustumHeight = 80
    const frustumWidth = frustumHeight * aspect

    this.camera = new THREE.OrthographicCamera(
      -frustumWidth / 2,
      frustumWidth / 2,
      frustumHeight / 2,
      -frustumHeight / 2,
      0.1,
      1000
    )

    this.camera.position.set(25, 60, 25)
    this.camera.lookAt(25, 0, 25)

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    this.scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
    directionalLight.position.set(50, 100, 50)
    directionalLight.castShadow = true
    directionalLight.shadow.mapSize.width = 2048
    directionalLight.shadow.mapSize.height = 2048
    this.scene.add(directionalLight)

    this.cameraController = new CameraController(this.camera, this.renderer, () => this.markDirty())

    this.terrainRenderer  = new TerrainRenderer(this.scene)
    this.districtRenderer = new DistrictRenderer(this.scene)
    this.groundRenderer   = new GroundRenderer(this.scene, this.originalMaterials)
    this.groundRenderer.buildingRenderer.setDirtyCallback(() => this.markDirty())

    window.addEventListener('resize', () => this.onWindowResize())

    this.animate()
  }

  markDirty() { this._needsRender = true }

  animate() {
    requestAnimationFrame(() => this.animate())
    const delta = this.clock.getDelta()
    if (this.isPaused) return

    this.terrainRenderer.update(delta, this.camera)
    this.districtRenderer.updateWallAnimations()
    this._frameCount++

    if (this._walkMode) {
      this._walkMode.update(delta)
      this.renderer.render(this.scene, this._walkMode.camera)
      return
    }

    this.cameraController.update()
    this._applyFloorScrollClip()
    const p = this.camera.position
    const lp = this._lastCamPos
    const camMoved = !lp || lp.x !== p.x || lp.y !== p.y || lp.z !== p.z
    const periodicRefresh = this._frameCount % 60 === 0
    if (camMoved || this._needsRender || periodicRefresh) {
      this._lastCamPos = { x: p.x, y: p.y, z: p.z }
      this._needsRender = false
      this.renderer.render(this.scene, this.camera)
      if (this.showDebug) {
        this._debugEl.textContent = `triangles: ${this.renderer.info.render.triangles}  draws: ${this.renderer.info.render.calls}`
        this._debugEl.style.display = ''
      } else {
        this._debugEl.style.display = 'none'
      }
    }
  }

  onWindowResize() {
    const width = window.innerWidth
    const height = window.innerHeight
    const aspect = width / height
    const frustumHeight = 80
    const frustumWidth = frustumHeight * aspect

    this.camera.left = -frustumWidth / 2
    this.camera.right = frustumWidth / 2
    this.camera.top = frustumHeight / 2
    this.camera.bottom = -frustumHeight / 2
    this.camera.updateProjectionMatrix()

    this.renderer.setSize(width, height)
  }

  focusCameraOn(x, z) {
    this.cameraController?.focusOn(x, z)
  }

  setHomePosition(x, z) {
    this.cameraController?.setHomePosition(x, z)
  }

  // Restores a previously-saved view mode + camera location (see CameraController's
  // _saveState/restoreSavedState). Returns true if there was one to restore.
  restoreCameraState() {
    const restored = this.cameraController?.restoreSavedState() ?? false
    if (restored) {
      // Mirrors toggleTopDownMode()'s side effects — restoring straight through
      // CameraController skips them since it isn't a toggle from the current state.
      this.groundRenderer.buildingRenderer.setInterbuildingWallsVisible(this.cameraController._topDown)
      this._lastAppliedFloorScrollUnits = null   // force _applyFloorScrollClip to re-sync next frame
      this.markDirty()
    }
    return restored
  }


  // ── Mode ────────────────────────────────────────────────────────────────────

  setMode(mode) {
    this.clearHover()
    this.mode = mode
    const inStreets = mode === 'streets'
    this.districtRenderer.setModeVisibility(inStreets)
    if (mode === 'city' || mode === 'streets') {
      this.terrainRenderer.deleteCityTerrainCells()
      this.terrainRenderer.clearDebugObjects()
    }
    if (mode === 'streets') {
      this.districtRenderer.clearDistrictLayer()
      this.districtRenderer.clearDebugObjects()
    }
  }


  // ── Getters ─────────────────────────────────────────────────────────────────

  get terrainData()         { return this.terrainRenderer.terrainData }
  get cityDistrictData()    { return this.districtRenderer.cityDistrictData }
  get edgePointsById()      { return this.terrainRenderer.edgePointsById }
  get cityEdgePointsById()  { return this.districtRenderer.cityEdgePointsById }


  // ── Terrain delegation ──────────────────────────────────────────────────────

  setTerrainData(regions, edges, fineCells, edgePoints) {
    return this.terrainRenderer.setTerrainData(regions, edges, fineCells, edgePoints)
  }

  renderTerrain(regions, fineCells) {
    return this.terrainRenderer.renderTerrain(regions, fineCells)
  }

  renderEdges(edges) {
    return this.terrainRenderer.renderEdges(edges)
  }

  get edgeMeshes()     { return this.terrainRenderer.edgeMeshes }
  get junctionMeshes() { return this.terrainRenderer.junctionMeshes }

  hideUndefinedEdges() {
    return this.terrainRenderer.hideUndefinedEdges()
  }

  updateRegionColor(regionId, terrainType) {
    return this.terrainRenderer.updateRegionColor(regionId, terrainType)
  }

  selectRegion(regionId) {
    return this.terrainRenderer.selectRegion(regionId)
  }

  deselectRegion(regionId) {
    return this.terrainRenderer.deselectRegion(regionId)
  }

  previewRegionType(regionId, terrainType) {
    return this.terrainRenderer.previewRegionType(regionId, terrainType)
  }

  selectEdge(edgeId) {
    return this.terrainRenderer.selectEdge(edgeId)
  }

  deselectEdge(edgeId) {
    return this.terrainRenderer.deselectEdge(edgeId)
  }

  previewEdgeType(edgeId, edgeType) {
    return this.terrainRenderer.previewEdgeType(edgeId, edgeType)
  }

  updateEdgeColor(edgeId, terrainType) {
    return this.terrainRenderer.updateEdgeColor(edgeId, terrainType)
  }

  setEdgeHover(edgeId) {
    if (this.mode !== 'terrain') return
    return this.terrainRenderer.setEdgeHover(edgeId)
  }

  renderThreats(threats, regions) {
    return this.terrainRenderer.renderThreats(threats, regions)
  }

  renderTrades(tradingDestinations, terrainData) {
    return this.terrainRenderer.renderTrades(tradingDestinations, terrainData)
  }

  clearMarkers() {
    return this.terrainRenderer.clearMarkers()
  }

  spawnTerrainDistrictFeature(regionId, districtType) {
    return this.terrainRenderer.spawnTerrainDistrictFeature(regionId, districtType)
  }

  getRegionAtWorldPos(worldX, worldY) {
    return this.terrainRenderer.getRegionAtWorldPos(worldX, worldY)
  }

  getEdgeAtWorldPos(worldX, worldY) {
    return this.terrainRenderer.getEdgeAtWorldPos(worldX, worldY)
  }

  getTerrainCornerAtWorldPos(worldX, worldY, threshold) {
    return this.terrainRenderer.getTerrainCornerAtWorldPos(worldX, worldY, threshold)
  }

  getTerrainSeedAtWorldPos(worldX, worldY, threshold) {
    return this.terrainRenderer.getTerrainSeedAtWorldPos(worldX, worldY, threshold)
  }

  drawVoronoiCenters(regions) {
    return this.terrainRenderer.drawVoronoiCenters(regions)
  }


  // ── District delegation ─────────────────────────────────────────────────────

  setCityDistrictData(data) {
    this.districtRenderer.setCityDistrictData(data)
    this.groundRenderer.setStreetGraph(this.districtRenderer.cityDistrictData?.streetGraph)
  }

  renderDistricts(districts) {
    return this.districtRenderer.renderDistricts(districts)
  }

  renderCityEdges(edges) {
    return this.districtRenderer.renderCityEdges(edges)
  }

  // Guild Setup hides the City-Edge overlay. Re-renders edges so the change takes
  // effect immediately (hide → clear; show → redraw from current data).
  setCityEdgesHidden(hidden) {
    this.districtRenderer.hideCityEdges = !!hidden
    this.districtRenderer.renderCityEdges(this.districtRenderer.cityDistrictData?.edges || {})
  }

  clearDistrictLayer() {
    return this.districtRenderer.clearDistrictLayer()
  }

  updateDistrictColor(districtId, districtType) {
    return this.districtRenderer.updateDistrictColor(districtId, districtType)
  }

  selectDistrict(districtId) {
    return this.districtRenderer.selectDistrict(districtId)
  }

  deselectDistrict(districtId) {
    return this.districtRenderer.deselectDistrict(districtId)
  }

  previewDistrictType(districtId, type) {
    return this.districtRenderer.previewDistrictType(districtId, type)
  }

  selectCityEdge(edgeId) {
    this.districtRenderer.selectCityEdge(edgeId)
    this._highlightBoundaryChain(edgeId, 0xffffff)
  }

  deselectCityEdge(edgeId) {
    this.districtRenderer.deselectCityEdge(edgeId)
    this.groundRenderer.clearBoundaryChainHighlight(edgeId)
  }

  previewCityEdgeType(edgeId, type) {
    return this.districtRenderer.previewCityEdgeType(edgeId, type)
  }

  updateCityEdgeColor(edgeId, type) {
    return this.districtRenderer.updateCityEdgeColor(edgeId, type)
  }

  setDistrictHover(districtId) {
    return this.districtRenderer.setDistrictHover(districtId)
  }

  setCityEdgeHover(edgeId) {
    this.groundRenderer.clearBoundaryChainHighlight()
    this.districtRenderer.setCityEdgeHover(edgeId)
    this._highlightBoundaryChain(edgeId, 0xffff66)
  }

  // Recolor boundary-sampled streets for a district edge.
  // Skips typed edges (Canal/Wall/etc.) — they are already rendered as geometry.
  _highlightBoundaryChain(edgeId, color) {
    const edge = this.districtRenderer.cityDistrictData?.edges?.[edgeId]
    if (!edge || edge.assignedType) return
    if (this.districtRenderer._edgeHasDefinedDistrict(edge)) {
      this.groundRenderer.setBoundaryChainHighlight(edgeId, color)
    }
  }

  getDistrictAtWorldPos(worldX, worldY) {
    return this.districtRenderer.getDistrictAtWorldPos(worldX, worldY)
  }

  getCityEdgeAtWorldPos(worldX, worldY) {
    return this.districtRenderer.getCityEdgeAtWorldPos(worldX, worldY)
  }

  // ── Guild Headquarters picking ────────────────────────────────────────────────
  // The non-square plot whose polygon contains the point → { id, districtId }.
  getPlotAtWorldPos(worldX, worldY) {
    for (const p of (this.cityDistrictData?.plots || [])) {
      if (p.blockType === 'square') continue
      if (p.blockCorners?.length && pointInPolygon(worldX, worldY, p.blockCorners)) {
        return { id: p.id, districtId: p.districtId }
      }
    }
    return null
  }

  // The nearest Landmark within `r` world units → { refId, districtId, name }.
  getLandmarkAtWorldPos(worldX, worldY, r = 0.4) {
    const lbs = this.cityDistrictData?.landmarkBuildings || []
    let best = null, bestD = r * r
    for (let i = 0; i < lbs.length; i++) {
      const dx = worldX - lbs[i].x, dy = worldY - lbs[i].z
      const d = dx * dx + dy * dy
      if (d < bestD) { bestD = d; best = { refId: i, districtId: lbs[i].districtId, name: lbs[i].name } }
    }
    return best
  }

  // ── Influence overlay ─────────────────────────────────────────────────────────
  // Recolour each district mesh by `districtColor` (Map districtId → hex string), or
  // restore base colours when null.
  applyInfluenceOverlay(districtColor) {
    const meshes = this.districtRenderer.districtMeshes
    if (!this._overlaySaved) {
      this._overlaySaved = new Map()
      meshes.forEach((m, id) => this._overlaySaved.set(id, m.material.color.getHex()))
    }
    meshes.forEach((m, id) => {
      const hex = districtColor?.get(id)
      const num = hex ? parseInt(hex.replace('#', ''), 16) : this._overlaySaved.get(id)
      m.material.color.setHex(num)
      m.material.emissive?.setHex(num)
    })
  }

  clearInfluenceOverlay() {
    if (!this._overlaySaved) return
    const meshes = this.districtRenderer.districtMeshes
    meshes.forEach((m, id) => {
      const num = this._overlaySaved.get(id)
      if (num != null) { m.material.color.setHex(num); m.material.emissive?.setHex(num) }
    })
    this._overlaySaved = null
  }

  drawDistrictCenters(districts) {
    return this.districtRenderer.drawDistrictCenters(districts)
  }


  // ── Ground delegation (streets + plots + squares + blocks + fences) ─────────

  renderStreetGraph(streetGraph) {
    if (!RENDER_STREETS) return
    // The trade road is now a street-graph member; drop the setup-phase ribbon
    // so the same path isn't drawn twice.
    this.terrainRenderer.clearTradeRoadRibbon()
    return this.groundRenderer.renderStreetGraph(streetGraph)
  }

  clearStreetLayer() {
    return this.groundRenderer.clearStreetLayer()
  }

  renderGutters(streetGraph) {
    if (!RENDER_GUTTERS) return
    return this.groundRenderer.renderGutters(streetGraph)
  }

  clearGutterLayer() {
    return this.groundRenderer.clearGutterLayer()
  }

  setStreetEdgeHover(edge) {
    return this.groundRenderer.setStreetEdgeHover(edge)
  }

  setJunctionHover(junctionId) {
    return this.groundRenderer.setJunctionHover(junctionId)
  }

  getStreetEdgeAtWorldPos(worldX, worldY, threshold) {
    return this.groundRenderer.getStreetEdgeAtWorldPos(worldX, worldY, threshold)
  }

  getJunctionAtWorldPos(worldX, worldY, threshold) {
    return this.groundRenderer.getJunctionAtWorldPos(worldX, worldY, threshold)
  }

  drawStreetSeeds(streetGraph) {
    return this.groundRenderer.drawStreetSeeds(streetGraph)
  }

  getStreetSeedAtWorldPos(worldX, worldY, threshold) {
    return this.groundRenderer.getStreetSeedAtWorldPos(worldX, worldY, threshold)
  }

  renderBlocks(blocks) {
    if (!RENDER_BLOCKS) {
      this.groundRenderer._blockById = new Map((blocks || []).map(b => [b.id, b.blockCorners]))
      return
    }
    return this.groundRenderer.renderBlocks(blocks)
  }

  clearBlockLayer() {
    return this.groundRenderer.clearBlockLayer()
  }

  setBlockHover(blockId) {
    return this.groundRenderer.setBlockHover(blockId)
  }

  clearBlockHover() {
    return this.groundRenderer.clearBlockHover()
  }

  renderPlots(plots, districtData) {
    if (!RENDER_PLOTS) return
    return this.groundRenderer.renderPlots(plots, districtData)
  }

  clearPlotLayer() {
    return this.groundRenderer.clearPlotLayer()
  }

  drawBlockCenters(blocks) {
    return this.groundRenderer.drawBlockCenters(blocks)
  }

  getBlockCenterAtWorldPos(worldX, worldY, threshold) {
    return this.groundRenderer.getBlockCenterAtWorldPos(worldX, worldY, threshold)
  }

  drawPlotCenters(plots) {
    return this.groundRenderer.drawPlotCenters(plots)
  }

  getPlotCenterAtWorldPos(worldX, worldY, threshold) {
    return this.groundRenderer.getPlotCenterAtWorldPos(worldX, worldY, threshold)
  }

  clearDerivedLayers() {
    this.groundRenderer.clearGutterLayer()
    this.groundRenderer.clearBlockLayer()
    this.groundRenderer.clearPlotLayer()
  }


  // ── Hover ────────────────────────────────────────────────────────────────────

  // Outline a plot polygon or ring a landmark during HQ pick mode.
  setHQHover(kind, refId) {
    this.clearHQHover()
    const cd = this.cityDistrictData
    const mat = new THREE.LineBasicMaterial({ color: 0x88ddff })
    if (kind === 'plot') {
      const plot = (cd?.plots || []).find(p => p.id === refId)
      const poly = plot?.blockCorners
      if (!poly?.length) return
      const verts = []
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length]
        verts.push(a.x, 0.14, a.y, b.x, 0.14, b.y)
      }
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
      this._hqHoverMesh = new THREE.LineSegments(geom, mat)
    } else if (kind === 'landmark') {
      const lb = (cd?.landmarkBuildings || [])[refId]
      if (!lb) return
      const segs = 24, r = 0.12
      const verts = []
      for (let i = 0; i < segs; i++) {
        const a1 = (i / segs) * Math.PI * 2, a2 = ((i + 1) / segs) * Math.PI * 2
        verts.push(lb.x + r * Math.cos(a1), 0.14, lb.z + r * Math.sin(a1),
                   lb.x + r * Math.cos(a2), 0.14, lb.z + r * Math.sin(a2))
      }
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
      this._hqHoverMesh = new THREE.LineSegments(geom, mat)
    }
    if (this._hqHoverMesh) { this.scene.add(this._hqHoverMesh); this.markDirty() }
  }

  clearHQHover() {
    if (this._hqHoverMesh) {
      this.scene.remove(this._hqHoverMesh)
      this._hqHoverMesh.geometry.dispose()
      this._hqHoverMesh = null
      this.markDirty()
    }
  }

  // Transient map hovers only (cursor over the map). Does NOT touch the panel-driven
  // faction highlight, so moving the mouse over the faction panel won't wipe it.
  clearHover() {
    this.clearHQHover()
    this.terrainRenderer.clearHover()
    this.districtRenderer.clearHover()
    this.groundRenderer.clearHover()
  }

  // Revert the faction-hover highlight (district mesh + streets + plots + squares, or
  // an off-map region). Called on un-hover, independent of map-hover clearing.
  clearFactionHighlight() {
    this.districtRenderer.clearFactionDistrict()
    this.groundRenderer.clearDistrictHighlight()
    this.terrainRenderer.clearFactionRegion()
  }

  setRegionHover(regionId) {
    const region = this.terrainRenderer.terrainData?.regions?.find(r => r.id === regionId)
    if (this.mode === 'terrain' && region?.assignedType) return
    if (this.mode === 'city') {
      const DISTRICT_ELIGIBLE = new Set(['Forest', 'Hills', 'Plains', 'Lake', 'Sea'])
      const canDistrict = DISTRICT_ELIGIBLE.has(region?.assignedType) && !region?.terrainDistrict
      if (!canDistrict && !region?.isEdge) return
    }
    this.terrainRenderer.setRegionHover(regionId)
  }

  highlightFaction(faction) {
    this.clearFactionHighlight()
    if (faction.districtId !== undefined) {
      this.districtRenderer.highlightFactionDistrict(faction.districtId)
      this.groundRenderer.highlightDistrict(faction.districtId)
    } else if (faction.regionId !== undefined) {
      this.terrainRenderer.highlightFactionRegion(faction.regionId)
    }
  }

  // Switch plot bases to/from the finished grassy-brown ground (leaving District Setup).
  // When finishing, also remove the district fill polygons — they're fully covered by
  // plots/streets/buildings and would bleed through any gap in the geometry.
  setFinishedGround(finished) {
    this.groundRenderer.setFinishedGround(finished)
    if (finished) this.districtRenderer.clearDistrictLayer()
  }

  toggleBuildings() {
    const br = this.groundRenderer.buildingRenderer
    br.setBuildingsVisible(!br._visible)
    this.markDirty()
  }

  toggleRoofs() {
    const br = this.groundRenderer.buildingRenderer
    br.setRoofsVisible(!br._roofsVisible)
    this.markDirty()
    return br._roofsVisible
  }

  // ── Top-down mode ────────────────────────────────────────────────────────────
  // Straight-down orthographic view (camera elevation locked near 90°). Roofs are NOT
  // separately toggled off here — they're just more geometry, hidden/revealed by the
  // SAME floor-scroll clip plane as everything else (see _applyFloorScrollClip), so
  // they appear in line with their actual z-height instead of popping in as a step.
  toggleTopDownMode() {
    if (this._walkMode) this._exitWalkMode()   // T while walking switches straight to top-down
    const isTopDown = this.cameraController.toggleTopDown()
    this.groundRenderer.buildingRenderer.setInterbuildingWallsVisible(isTopDown)
    this._lastAppliedFloorScrollUnits = null   // force _applyFloorScrollClip to re-sync next frame
    this.markDirty()
    return isTopDown
  }

  // Floor-scroll (PageUp/PageDown, see CameraController): clips the whole scene —
  // including roofs — with a world-space horizontal plane at the scrolled-to level, so
  // everything above it disappears and the scrolled-to level + everything below renders
  // normally (decision #10). Active in BOTH top-down and the normal iso view, each with
  // its own default level. Only re-applies the (cheap) plane constant when the scroll
  // level actually changed.
  _applyFloorScrollClip() {
    const cc = this.cameraController
    if (cc.floorScrollUnits === this._lastAppliedFloorScrollUnits) return
    this._lastAppliedFloorScrollUnits = cc.floorScrollUnits

    if (cc.floorScrollUnits >= FLOOR_SCROLL_MAX) {
      this.renderer.clippingPlanes = []
      return
    }
    const br = this.groundRenderer.buildingRenderer
    // +0.1 floor-height-units above the exact half-floor multiple: floor surfaces now
    // sit exactly AT that multiple (see ParametricBuilding.js's addFloor call site), so
    // clipping exactly at the boundary would cut the floor away along with the wall
    // above it — comfortably below the NEXT half-floor step (0.5 away) so it never
    // bleeds into the level above.
    const clipY = BUILDING_GROUND_Y + (cc.floorScrollUnits * 0.5 + 0.1) * br.floorHeightWorld
    this._floorScrollClipPlane.constant = clipY
    this.renderer.clippingPlanes = [this._floorScrollClipPlane]
  }

  // ── Walk Mode ─────────────────────────────────────────────────────────────────

  // Walk, top-down, and iso are fully isolated camera modes — neither elevation/zoom
  // state nor the floor-scroll clip plane should leak between them. _applyFloorScrollClip
  // never runs while walk mode owns rendering (animate() returns early), so without this
  // a clip plane left over from a prior top-down session would silently clip the walk
  // view too (and vice versa, stale walk state would leak into the next top-down/iso view).
  _clearFloorScrollClip() {
    this.renderer.clippingPlanes = []
    this._lastAppliedTopDown = false
    this._lastAppliedFloorScrollUnits = null
  }

  // Returns true if walk mode was entered, false if it was exited.
  // onExitCallback is called whenever walk mode ends (including Esc key).
  toggleWalkMode(onExitCallback) {
    if (!this._walkMode) {
      if (this.cameraController._topDown) this.cameraController.toggleTopDown()   // leave top-down cleanly first
      this._clearFloorScrollClip()
      this._walkModeOnExit = onExitCallback
      const streetGraph   = this.districtRenderer.cityDistrictData?.streetGraph
      const targetPos     = { x: this.cameraController.targetPosition.x, z: this.cameraController.targetPosition.z }
      const initialYaw    = this.cameraController.azimuth
      this._walkMode = new WalkMode(
        this.scene, this.renderer, streetGraph, targetPos, initialYaw,
        () => this._exitWalkMode(), this.groundRenderer.buildingRenderer, this.groundRenderer._fenceSegments,
      )
      this.cameraController.setEnabled(false)
      return true
    } else {
      this._exitWalkMode()
      return false
    }
  }

  _exitWalkMode() {
    if (!this._walkMode) return
    const { x, z } = this._walkMode.characterPosition
    this._walkMode.destroy()
    this._walkMode = null
    this._clearFloorScrollClip()   // back to iso — always unclipped, never inherits walk/top-down state
    // Re-centre the iso camera on the character's last position at max zoom
    this.cameraController.targetPosition.set(x, 0, z)
    this.cameraController.updateCameraPosition()
    this.camera.zoom = this.cameraController.maxZoom
    this.camera.updateProjectionMatrix()
    this.cameraController.setEnabled(true)
    this.markDirty()
    const cb = this._walkModeOnExit
    this._walkModeOnExit = null
    cb?.()
  }


  // ── Debug ────────────────────────────────────────────────────────────────────

  toggleDebugVisualization() {
    this.clearHover()
    this.showDebug = !this.showDebug
    this.terrainRenderer.setDebugVisible(this.showDebug)
    this.districtRenderer.setDebugVisible(this.showDebug)
    this.groundRenderer.setDebugVisible(this.showDebug)

    const allDebug = new Set([
      ...this.terrainRenderer.debugObjects,
      ...this.districtRenderer.debugObjects,
      ...this.groundRenderer.debugObjects,
    ])

    if (this.showDebug) {
      this.scene.children.forEach(child => {
        if (child.isMesh && child.material && !allDebug.has(child) && child.visible) {
          this.originalMaterials.set(child, child.material)
          child.material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.7, 0.6) })
        }
      })
    } else {
      this.scene.children.forEach(child => {
        if (this.originalMaterials.has(child)) child.material = this.originalMaterials.get(child)
      })
      this.originalMaterials.clear()
    }
    console.log(`Debug mode ${this.showDebug ? 'ON' : 'OFF'}`)
    this.markDirty()
  }

  clearAllDebugObjects() {
    this.terrainRenderer.clearDebugObjects()
    this.districtRenderer.clearDebugObjects()
    this.groundRenderer.clearDebugObjects()
  }

  // Set a single debug layer's visibility. Called by DebugPanel checkboxes.
  setDebugLayer(name, on) {
    switch (name) {
      case 'buildings':       this.groundRenderer.buildingRenderer.setBuildingsVisible(on); break
      case 'blockCenters':    this.groundRenderer.setBlockCentersVisible(on); break
      case 'blockSeeds':      this.groundRenderer.setBlockSeedsVisible(on); break
      case 'plotCenters':     this.groundRenderer.setPlotCentersVisible(on); break
      case 'districtCenters': this.districtRenderer.setDistrictCentersVisible(on); break
      case 'terrainCenters':  this.terrainRenderer.setTerrainCentersVisible(on); break
      case 'streetSeeds':     this.groundRenderer.setStreetSeedsVisible(on); break
    }
    this.markDirty()
  }

  // Returns current per-layer visibility so DebugPanel can initialise its checkboxes.
  getDebugLayerStates() {
    const br = this.groundRenderer.buildingRenderer
    return {
      buildings:       br._visible,
      blockCenters:    this.groundRenderer._blockCentersVisible,
      blockSeeds:      this.groundRenderer._blockSeedsVisible,
      plotCenters:     this.groundRenderer._plotCentersVisible,
      districtCenters: this.districtRenderer._districtCentersVisible,
      terrainCenters:  this.terrainRenderer._terrainCentersVisible,
      streetSeeds:     this.groundRenderer._streetSeedsVisible,
    }
  }

  getDistrictCenterAtWorldPos(worldX, worldY, threshold) {
    return this.districtRenderer.getDistrictCenterAtWorldPos(worldX, worldY, threshold)
  }


  // ── Utility methods (called by App.js directly) ──────────────────────────────

  pointInPolygon(x, y, polygon) {
    return pointInPolygon(x, y, polygon)
  }

  distanceToLineSegment(px, py, x1, y1, x2, y2) {
    return distanceToLineSegment(px, py, x1, y1, x2, y2)
  }

  // Render a 300×180 snapshot of the HQ building and return a JPEG data URL.
  captureHQSnapshot(hq) {
    if (!hq || !this.renderer || !this.scene) return null
    try {
      const cd = this.cityDistrictData
      let wx = 0, wz = 0

      if (hq.kind === 'landmark') {
        const lb = cd?.landmarkBuildings?.[hq.refId]
        if (lb) { wx = lb.x; wz = lb.z }
      } else {
        const plot = cd?.plots?.find(p => p.id === hq.refId)
        if (plot?.blockCorners?.length) {
          wx = plot.blockCorners.reduce((s, c) => s + c.x, 0) / plot.blockCorners.length
          wz = plot.blockCorners.reduce((s, c) => s + c.y, 0) / plot.blockCorners.length
        }
      }

      // Isometric-ish shot from above-and-south. Buildings sit at Y≈0.075 and
      // are ~0.05-0.2 world units tall, so camera at Y=0.35 gives a clean view.
      const snapCam = new THREE.PerspectiveCamera(45, 300 / 180, 0.001, 100)
      snapCam.position.set(wx + 0.12, 0.35, wz + 0.30)
      snapCam.lookAt(wx, 0.08, wz)

      // Resize renderer to snapshot dimensions, render, capture, restore
      const origW = this.renderer.domElement.width
      const origH = this.renderer.domElement.height
      const origPixelRatio = this.renderer.getPixelRatio()
      const origBackground = this.scene.background
      this.scene.background = new THREE.Color(0x0d1117)  // dark neutral for snapshot
      this.renderer.setPixelRatio(1)
      this.renderer.setSize(300, 180, false)
      this.renderer.render(this.scene, snapCam)
      const dataUrl = this.renderer.domElement.toDataURL('image/jpeg', 0.85)
      this.scene.background = origBackground
      this.renderer.setSize(origW / origPixelRatio, origH / origPixelRatio, false)
      this.renderer.setPixelRatio(origPixelRatio)
      this.markDirty()
      return dataUrl
    } catch (e) {
      console.warn('captureHQSnapshot failed:', e)
      return null
    }
  }
}
