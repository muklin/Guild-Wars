import * as THREE from 'three'
import CameraController, { FLOOR_SCROLL_MAX } from '../input/CameraController.js'
import WalkMode from './WalkMode.js'
import Minimap from './Minimap.js'
import Compass from './Compass.js'

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
    this.minimap           = null

    this._walkMode = null
    this._walkModeOnExit = null
    this._hqHoverMesh = null
    this._cameraMoveCallbacks = []
  }


  // ── Engine / Lifecycle ──────────────────────────────────────────────────────

  init() {
    this.scene = new THREE.Scene()
    // background = null → transparent; CSS sky gradient on body shows through.
    // Debug mode overrides this with solid magenta (see toggleDebugVisualization).
    this.scene.background = null

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setClearColor(0x000000, 0)   // fully transparent clear
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.shadowMap.enabled = false
    // Floor-scroll (see CameraController's floorScrollUnits) clips the scene with a
    // world-space horizontal plane while active — see _applyFloorScrollClip().
    this.renderer.localClippingEnabled = true
    this._floorScrollClipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)
    this._lastAppliedFloorScrollUnits = null
    this._floorScrollClipActive = false   // tracks whether the floor-scroll plane (vs just world-boundary) is the live clippingPlanes state
    // World-boundary clip planes — trim all standard materials at the map edge so
    // geometry (edge ribbons, region fills) never bleeds outside the generated world.
    // ShaderMaterials with clipping:false (FP bands, sky quad) are exempt.
    // Outer ring rewrite (user-confirmed 2026-07-13): this was hard-locked to the
    // literal [0,worldSize] square — a GPU-level clip, applied to every standard
    // material regardless of the underlying mesh geometry. That's the REAL "circling
    // the square" bug: the outer ring's own clip circle (TerrainVoronoiGenerator's
    // outerClipCircle) already extends past this square with margin to spare, and
    // every earlier fix to the actual polygon/mesh DATA (buildRegionMesh's box clip,
    // _clipEdgeChainsToWorldBounds) was correct but couldn't matter — this renderer-
    // level clip re-cropped the result back down to the square on every frame,
    // independent of what geometry existed. Confirmed live (2026-07-13): widening the
    // data-side clips alone produced zero visible change, which only makes sense if
    // something downstream of all of them was still clipping. Widened with the same
    // generous margin as buildRegionMesh's box clip so it only ever catches genuinely
    // unbounded/sentinel-influenced artefacts, never legitimate outer-ring geometry.
    const W = this.worldSize
    const clipMargin = W
    this._worldBoundaryClipPlanes = [
      new THREE.Plane(new THREE.Vector3( 1, 0,  0),  clipMargin),      // x ≥ -clipMargin
      new THREE.Plane(new THREE.Vector3(-1, 0,  0),  W + clipMargin),  // x ≤ W+clipMargin
      new THREE.Plane(new THREE.Vector3( 0, 0,  1),  clipMargin),      // z ≥ -clipMargin
      new THREE.Plane(new THREE.Vector3( 0, 0, -1),  W + clipMargin),  // z ≤ W+clipMargin
    ]
    this.renderer.clippingPlanes = [...this._worldBoundaryClipPlanes]
    document.body.insertBefore(this.renderer.domElement, document.body.firstChild)

    // Sky quad — full-screen plane rendered behind all scene geometry.
    // Vertex shader maps directly to clip-space so it works in any camera mode
    // (orthographic iso, top-down, walk perspective). ShaderMaterial default
    // clipping:false means it ignores world-boundary and floor-scroll clip planes.
    const skyGeo = new THREE.BufferGeometry()
    skyGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0,   1, -1, 0,   1,  1, 0,  -1,  1, 0,
    ]), 3))

    skyGeo.setIndex([0, 1, 2,  0, 2, 3])
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uColorBottom: { value: new THREE.Color(0x0a0a12) },  // near-black ground/nadir
        uColorMid:    { value: new THREE.Color(0x87ceeb) },  // horizon sky blue
        uColorTop:    { value: new THREE.Color(0x1a4a9a) },  // deep overhead blue
        uInvProj:     { value: new THREE.Matrix4() },         // updated each frame
        uInvView:     { value: new THREE.Matrix4() },         // updated each frame
      },
      // NDC xy → view-space direction → world direction → gradient by elevation (Y)
      vertexShader: `
        varying vec2 vNDC;
        void main() { vNDC = position.xy; gl_Position = vec4(position.xy, 1.0, 1.0); }
      `,
      fragmentShader: `
        varying vec2 vNDC;
        uniform vec3 uColorBottom, uColorMid, uColorTop;
        uniform mat4 uInvProj, uInvView;
        void main() {
          vec4 viewDir = uInvProj * vec4(vNDC, 0.0, 1.0);
          viewDir.w = 0.0;
          vec3 worldDir = normalize((uInvView * viewDir).xyz);
          // worldDir.y: -1=down → 0=horizon → +1=up; map to [0,1]
          float t = clamp(worldDir.y * 0.5 + 0.5, 0.0, 1.0);
          const float mid = 0.5;
          vec3 col = t < mid
            ? mix(uColorBottom, uColorMid, t / mid)
            : mix(uColorMid, uColorTop, (t - mid) / (1.0 - mid));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    })
    this._skyMesh = new THREE.Mesh(skyGeo, skyMat)
    this._skyMesh.renderOrder = -999
    this._skyMesh.frustumCulled = false
    // Update camera matrices just before draw so gradient is always in sync
    this._skyMesh.onBeforeRender = (_r, _s, cam) => {
      const u = skyMat.uniforms
      u.uInvProj.value.copy(cam.projectionMatrixInverse)
      u.uInvView.value.copy(cam.matrixWorld)
    }
    this.scene.add(this._skyMesh)

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
    this.minimap          = new Minimap()
    this.compass          = new Compass()
    // Compass shows in Top-down/Iso (the two non-walk view modes); Minimap shows in
    // Walk Mode. Walk mode is never active on load, so the compass starts visible.
    this.compass.show()

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
      const { x, z } = this._walkMode.characterPosition
      this.minimap.update(x, z, this._walkMode.yaw)
      return
    }

    this.cameraController.update()
    this._applyFloorScrollClip()
    this.compass.update(this.cameraController.azimuth, this.cameraController._topDown)
    const p = this.camera.position
    const lp = this._lastCamPos
    const camMoved = !lp || lp.x !== p.x || lp.y !== p.y || lp.z !== p.z
    const periodicRefresh = this._frameCount % 60 === 0
    if (camMoved || this._needsRender || periodicRefresh) {
      this._lastCamPos = { x: p.x, y: p.y, z: p.z }
      this._needsRender = false
      if (camMoved) this._cameraMoveCallbacks.forEach(fn => fn())
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

  // New-game default view: iso mode, North at the top, city centred, whole map visible
  // (see CameraController.centerOnMap's doc comment for the azimuth math).
  centerOnMap() {
    this.cameraController?.centerOnMap()
  }

  // Pan + zoom to an HQ location. No-op in walk mode.
  focusOnHQ(hq) {
    if (!hq || this._walkMode) return
    const cc = this.cameraController
    const cd = this.cityDistrictData
    let x = 0, z = 0, found = false
    if (hq.kind === 'plot') {
      const plot = cd?.plots?.find(p => p.id === hq.refId)
      if (plot?.blockCorners?.length) {
        x = plot.blockCorners.reduce((s, c) => s + c.x, 0) / plot.blockCorners.length
        z = plot.blockCorners.reduce((s, c) => s + c.y, 0) / plot.blockCorners.length
        found = true
      }
    } else if (hq.kind === 'landmark') {
      const lb = cd?.landmarkBuildings?.[hq.refId]
      if (lb) { x = lb.x; z = lb.z; found = true }
    }
    if (!found) return
    cc.focusOn(x, z)
    this.camera.zoom = cc.maxZoom * 0.5
    this.camera.updateProjectionMatrix()
    this.markDirty()
  }

  setHomePosition(x, z) {
    this.cameraController?.setHomePosition(x, z)
  }

  // See CameraController.clearSavedState — discards a previous game's saved camera view.
  clearSavedCameraState() {
    this.cameraController?.clearSavedState()
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
    // Only treat this as an actual MODE TRANSITION, not every redundant same-mode call
    // — _applyState calls setMode('city') on EVERY live sync once past Terrain Setup,
    // unconditionally, not just on the one real transition into it. clearDebugObjects()
    // below used to run every single time regardless, wiping every terrain debug marker
    // (region/plot centers, edge points, surface corners) that THIS SAME sync's
    // setTerrainData call (which always runs first — see App.js._applyState) had just
    // finished drawing, with nothing after this point to redraw them — confirmed live,
    // 2026-07-13: District Setup's debug panel checkboxes stayed checked but nothing
    // ever rendered, because they were destroyed within the same tick they were created.
    // deleteCityTerrainCells() is NOT part of this gating — it must keep running every
    // sync: renderTerrain() (inside setTerrainData, called just before this) rebuilds
    // ALL terrain plot meshes fresh every time, including the City region's own cells,
    // with no knowledge of city mode at all — deleteCityTerrainCells() is what retires
    // those again each time so district geometry doesn't get an unwanted terrain fill
    // showing through underneath it.
    const modeChanged = this.mode !== mode
    this.mode = mode
    const inStreets = mode === 'streets'
    this.districtRenderer.setModeVisibility(inStreets)
    if (mode === 'city' || mode === 'streets') {
      this.terrainRenderer.deleteCityTerrainCells()
      if (modeChanged) {
        this.terrainRenderer.clearDebugObjects()
        // Redraw immediately from whatever terrain data is already cached, rather than
        // leaving every terrain debug layer blank until the next sync's setTerrainData
        // call happens to come in.
        const td = this.terrainRenderer.terrainData
        if (td) {
          this.terrainRenderer.drawVoronoiCenters(td.regions)
          this.terrainRenderer.drawTerrainPlotCenters(td.terrainPlots)
          this.terrainRenderer.drawSurfaceCorners(td.terrainPlots, td.riverCliffFaces)
        }
      }
      this.terrainRenderer.setCityModeActive(true)
    } else {
      this.terrainRenderer.setCityModeActive(false)
    }
    if (mode === 'streets' && modeChanged) {
      this.districtRenderer.clearDistrictLayer()
      this.districtRenderer.clearDebugObjects()
    }
  }


  // ── Camera helpers ──────────────────────────────────────────────────────────

  // Convert a world-space point (x, y, z) to CSS pixel coordinates.
  worldToScreen(x, y, z) {
    const v = new THREE.Vector3(x, y ?? 0, z)
    v.project(this.camera)
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight
    }
  }

  addCameraMoveCallback(fn) { this._cameraMoveCallbacks.push(fn) }
  removeCameraMoveCallback(fn) {
    this._cameraMoveCallbacks = this._cameraMoveCallbacks.filter(f => f !== fn)
  }

  // ── Getters ─────────────────────────────────────────────────────────────────

  get terrainData()         { return this.terrainRenderer.terrainData }
  get cityDistrictData()    { return this.districtRenderer.cityDistrictData }
  get edgePointsById()      { return this.terrainRenderer.edgePointsById }
  get cityEdgePointsById()  { return this.districtRenderer.cityEdgePointsById }
  get isWalkMode()          { return !!this._walkMode }


  // ── Terrain delegation ──────────────────────────────────────────────────────

  setTerrainData(regions, edges, terrainPlots, edgePoints, pointsById, riverCliffFaces = [], hiddenRegions = []) {
    this.districtRenderer.setTerrainWaterData(regions, edges, edgePoints, terrainPlots, pointsById)
    const result = this.terrainRenderer.setTerrainData(regions, edges, terrainPlots, edgePoints, pointsById, riverCliffFaces, hiddenRegions)
    this._reapplyTopDownFlatten()
    return result
  }

  // Every fresh mesh a renderer builds starts un-flattened (real relief) regardless of
  // the current camera mode — toggleTopDownMode() only flattens what exists AT THE
  // MOMENT it's called. A phase change (e.g. "Done" in District Setup, entering
  // gameplay) rebuilds ground meshes on its own, independent of any camera toggle; if
  // that happens while already in top-down, the fresh meshes render at real height
  // against the (top-down-only) floor-scroll clip plane calibrated for a flat world —
  // confirmed live (2026-07-13) as most of the map going black after clicking Done in
  // top-down. Call this after any ground-mesh rebuild, not just from the T-key toggle.
  _reapplyTopDownFlatten() {
    if (!this.cameraController?._topDown) return
    this.terrainRenderer.setGroundFlattened(true)
    this.groundRenderer.setTerrainFlattened(true)
    this.terrainRenderer.terrainPolylines?.setFlattened(true)
    this.terrainRenderer.setDebugMarkersFlattened(true)
  }

  // Hide/show terrain plot meshes and exclude/include them from hit-testing based on
  // which plots are currently the source of a promoted (City Expansion) city district.
  // Reversible — a plot dropped from cityData (promotion abandoned/reverted) is un-suppressed.
  syncPromotedPlots(cityData) {
    const promotedPlotIds = new Set(
      (cityData?.districts || [])
        .filter(d => d.promotedFromPlotId != null)
        .map(d => d.promotedFromPlotId)
    )
    return this.terrainRenderer.setPromotedPlotIds(promotedPlotIds)
  }

  renderTerrain(regions, terrainPlots) {
    return this.terrainRenderer.renderTerrain(regions, terrainPlots)
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
    this.terrainRenderer.updateRegionColor(regionId, terrainType); this.markDirty()
  }

  selectRegion(regionId) {
    this.terrainRenderer.selectRegion(regionId); this.markDirty()
  }

  deselectRegion(regionId) {
    this.terrainRenderer.deselectRegion(regionId); this.markDirty()
  }

  previewRegionType(regionId, terrainType) {
    this.terrainRenderer.previewRegionType(regionId, terrainType); this.markDirty()
  }

  selectEdge(edgeId) {
    this.terrainRenderer.selectEdge(edgeId); this.markDirty()
  }

  deselectEdge(edgeId) {
    this.terrainRenderer.deselectEdge(edgeId); this.markDirty()
  }

  previewEdgeType(edgeId, edgeType) {
    this.terrainRenderer.previewEdgeType(edgeId, edgeType); this.markDirty()
  }

  updateEdgeColor(edgeId, terrainType) {
    this.terrainRenderer.updateEdgeColor(edgeId, terrainType); this.markDirty()
  }

  setEdgeHover(edgeId) {
    if (this.mode !== 'terrain') return
    this.terrainRenderer.setEdgeHover(edgeId); this.markDirty()
  }

  renderThreats(threats, regions) {
    return this.terrainRenderer.renderThreats(threats, regions)
  }

  renderTrades(tradingDestinations, terrainData) {
    return this.terrainRenderer.renderTrades(tradingDestinations, terrainData)
  }

  renderForeignPowerBands(foreignPowers) {
    return this.terrainRenderer.renderForeignPowerBands(foreignPowers)
  }

  getFPBandCenters() {
    return this.terrainRenderer._fpBandCenters
  }

  setFPBandsVisible(visible) {
    return this.terrainRenderer.setFPBandsVisible(visible)
  }

  clearMarkers() {
    return this.terrainRenderer.clearMarkers()
  }

  spawnTerrainDistrictFeature(regionId, plotId, districtType) {
    return this.terrainRenderer.spawnTerrainDistrictFeature(regionId, plotId, districtType)
  }

  getRegionAtWorldPos(worldX, worldY) {
    return this.terrainRenderer.getRegionAtWorldPos(worldX, worldY)
  }

  getTerrainSetupPlotAtWorldPos(worldX, worldY) {
    return this.terrainRenderer.getTerrainPlotAtWorldPos(worldX, worldY)
  }

  getZHeightAtWorldPos(worldX, worldY) {
    return this.terrainRenderer.getZHeightAtWorldPos(worldX, worldY)
  }

  getPickableMeshes() {
    return this.terrainRenderer.getPickableMeshes()
  }

  setTerrainPlotHover(plotId) {
    this.terrainRenderer.setTerrainPlotHover(plotId)
    this._needsRender = true
  }

  setTerrainPlotSelected(plotId) {
    this.terrainRenderer.setTerrainPlotSelected(plotId)
    this._needsRender = true
  }

  clearTerrainPlotSelected() {
    this.terrainRenderer.clearTerrainPlotSelected()
    this._needsRender = true
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

  getTerrainPlotCenterAtWorldPos(worldX, worldY, threshold) {
    return this.terrainRenderer.getTerrainPlotCenterAtWorldPos(worldX, worldY, threshold)
  }

  getTerrainCenterAtWorldPos(worldX, worldY, threshold) {
    return this.terrainRenderer.getTerrainCenterAtWorldPos(worldX, worldY, threshold)
  }

  getSurfaceCornerAtWorldPos(worldX, worldY, threshold) {
    return this.terrainRenderer.getSurfaceCornerAtWorldPos(worldX, worldY, threshold)
  }

  drawVoronoiCenters(regions) {
    return this.terrainRenderer.drawVoronoiCenters(regions)
  }


  // ── District delegation ─────────────────────────────────────────────────────

  setCityDistrictData(data, pointsById) {
    this.districtRenderer.setCityDistrictData(data, pointsById)
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
    this.districtRenderer.updateDistrictColor(districtId, districtType); this.markDirty()
  }

  selectDistrict(districtId) {
    this.districtRenderer.selectDistrict(districtId); this.markDirty()
  }

  deselectDistrict(districtId) {
    this.districtRenderer.deselectDistrict(districtId); this.markDirty()
  }

  previewDistrictType(districtId, type) {
    this.districtRenderer.previewDistrictType(districtId, type); this.markDirty()
  }

  selectCityEdge(edgeId) {
    this.districtRenderer.selectCityEdge(edgeId)
    this._highlightBoundaryChain(edgeId, 0xffffff)
    this.markDirty()
  }

  deselectCityEdge(edgeId) {
    this.districtRenderer.deselectCityEdge(edgeId)
    this.groundRenderer.clearBoundaryChainHighlight(edgeId)
    this.markDirty()
  }

  previewCityEdgeType(edgeId, type) {
    this.districtRenderer.previewCityEdgeType(edgeId, type); this.markDirty()
  }

  updateCityEdgeColor(edgeId, type) {
    return this.districtRenderer.updateCityEdgeColor(edgeId, type)
  }

  setDistrictHover(districtId) {
    this.districtRenderer.setDistrictHover(districtId); this.markDirty()
  }

  setCityEdgeHover(edgeId) {
    this.groundRenderer.clearBoundaryChainHighlight()
    this.districtRenderer.setCityEdgeHover(edgeId)
    this._highlightBoundaryChain(edgeId, 0xffff66)
    this.markDirty()
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

  renderPlots(plots, districtData, opts) {
    if (!RENDER_PLOTS) return
    // Terrain plots are now part of the unified plots array. When present, retire the
    // coarse TerrainRenderer fills so fine city-boundary plots take over without double-render.
    // Skip this when preserving terrain plots (they're already showing correctly).
    if (!opts?.preserveTerrainPlots && (plots || []).some(p => p.type === 'terrain')) {
      this.terrainRenderer.deleteNonCityTerrainPlots()
    }
    const result = this.groundRenderer.renderPlots(plots, districtData, opts)
    this._reapplyTopDownFlatten()
    return result
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
    this.groundRenderer.clearPlotLayer()   // also clears terrain plot state
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
    this.groundRenderer.clearTerrainPlotHighlight()
    this.markDirty()
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
    } else if (faction.plotId !== undefined) {
      this.groundRenderer.highlightTerrainPlot(faction.plotId)
    } else if (faction.regionId !== undefined) {
      this.terrainRenderer.highlightFactionRegion(faction.regionId)
    }
    this.markDirty()
  }

  getTerrainPlotAtWorldPos(worldX, worldY) {
    return this.groundRenderer.getTerrainPlotAtWorldPos(worldX, worldY)
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
    // Flatten the whole ground to z=0 in top-down mode (user-confirmed 2026-07-13) —
    // reinstates the floor-scroll clip plane's original assumption instead of fighting
    // real terrain relief with a single world-space plane. Reversible: leaving top-down
    // restores real relief from the realY stashed on each mesh at build time.
    this.terrainRenderer.setGroundFlattened(isTopDown)
    this.groundRenderer.setTerrainFlattened(isTopDown)
    this.terrainRenderer.terrainPolylines?.setFlattened(isTopDown)
    this.terrainRenderer.setDebugMarkersFlattened(isTopDown)
    this._lastAppliedFloorScrollUnits = null   // force _applyFloorScrollClip to re-sync next frame
    this._cameraMoveCallbacks.forEach(fn => fn())  // reposition DOM overlays immediately
    this.markDirty()
    return isTopDown
  }

  // Floor-scroll (PageUp/PageDown, see CameraController): clips the whole scene —
  // including roofs — with a world-space horizontal plane at the scrolled-to level, so
  // everything above it disappears and the scrolled-to level + everything below renders
  // normally (decision #10). Reinstated Top-down-mode-only (TODO.md "Groundplane
  // Z-height implementation", plan "rustling-churning-finch", user-confirmed
  // 2026-07-13): a world-space clip plane only makes sense against a flat world, and
  // toggleTopDownMode now flattens the whole ground to z=0 whenever top-down is active
  // — in the normal iso view, terrain keeps its real relief, so floor-scroll stays off
  // there (the black-void bug this guard originally fixed). Only re-applies the (cheap)
  // plane constant when the scroll level actually changed.
  _applyFloorScrollClip() {
    const cc = this.cameraController
    if (!cc._topDown) {
      // Bug fixed 2026-07-13: this used to gate the reset on `_lastAppliedFloorScrollUnits
      // !== null`, but toggleTopDownMode() itself sets that field to null right before
      // this runs next (to force a resync) — so the guard was always false at exactly
      // the moment it needed to fire, and the stale top-down floor-scroll clip plane
      // silently persisted into iso view, clipping away all but a sliver of the now-
      // real (unflattened) terrain relief. Track the reset with its own flag instead.
      if (this._floorScrollClipActive) {
        this._floorScrollClipActive = false
        this.renderer.clippingPlanes = [...this._worldBoundaryClipPlanes]
      }
      this._lastAppliedFloorScrollUnits = null
      return
    }
    this._floorScrollClipActive = true
    if (cc.floorScrollUnits === this._lastAppliedFloorScrollUnits) return
    this._lastAppliedFloorScrollUnits = cc.floorScrollUnits

    if (cc.floorScrollUnits >= FLOOR_SCROLL_MAX) {
      this.renderer.clippingPlanes = [...this._worldBoundaryClipPlanes]
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
    this.renderer.clippingPlanes = [...this._worldBoundaryClipPlanes, this._floorScrollClipPlane]
  }

  // ── Walk Mode ─────────────────────────────────────────────────────────────────

  // Walk, top-down, and iso are fully isolated camera modes — neither elevation/zoom
  // state nor the floor-scroll clip plane should leak between them. _applyFloorScrollClip
  // never runs while walk mode owns rendering (animate() returns early), so without this
  // a clip plane left over from a prior top-down session would silently clip the walk
  // view too (and vice versa, stale walk state would leak into the next top-down/iso view).
  _clearFloorScrollClip() {
    this.renderer.clippingPlanes = [...this._worldBoundaryClipPlanes]
    this._lastAppliedTopDown = false
    this._lastAppliedFloorScrollUnits = null
    this._floorScrollClipActive = false
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
      // Capture the minimap snapshot before WalkMode exists — its Avatar mesh hasn't
      // been added to the scene yet (so it can't get baked into the bitmap), and the
      // main renderer hasn't switched to WalkMode's camera yet (so the player never
      // sees this frame). Briefly apply Top-down mode's own wall treatment (interbuilding/
      // plot-boundary walls shown — see toggleTopDownMode) for JUST this one capture:
      // seen from directly above, those boundaries read clearly on a minimap the same
      // way they do in the real Top-down view; restored immediately after (we've
      // already forced _topDown false above, so false is always the correct restore
      // value here, never a guess).
      this.groundRenderer.buildingRenderer.setInterbuildingWallsVisible(true)
      this.minimap.captureSnapshot(this.renderer, this.scene, targetPos.x, targetPos.z)
      this.groundRenderer.buildingRenderer.setInterbuildingWallsVisible(false)
      this._walkMode = new WalkMode(
        this.scene, this.renderer, streetGraph, targetPos, initialYaw,
        () => this._exitWalkMode(), this.groundRenderer.buildingRenderer, this.groundRenderer._fenceSegments,
      )
      this.cameraController.setEnabled(false)
      this.terrainRenderer.setFPBandsVisible(false)
      this.minimap.show()
      this.compass.hide()
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
    this.minimap.hide()
    this.compass.show()
    this.terrainRenderer.setFPBandsVisible(true)
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
          child.material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.7, 0.6), side: THREE.DoubleSide })
        }
      })
    } else {
      this.scene.children.forEach(child => {
        if (this.originalMaterials.has(child)) child.material = this.originalMaterials.get(child)
      })
      this.originalMaterials.clear()
    }
    // Magenta background in debug so transparent areas are obvious; sky quad otherwise.
    this.scene.background = this.showDebug ? new THREE.Color(0xff00ff) : null
    if (this._skyMesh) this._skyMesh.visible = !this.showDebug
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
      case 'terrainPlotCenters': this.terrainRenderer.setTerrainPlotCentersVisible(on); break
      case 'terrainSeeds':    this.terrainRenderer.setTerrainSeedsVisible(on); break
      case 'surfaceCorners':  this.terrainRenderer.setSurfaceCornersVisible(on); break
      case 'streetSeeds':     this.groundRenderer.setStreetSeedsVisible(on); break
    }
    this.markDirty()
  }

  // Draw wing-pass debug lines for one plot — same visualisation as ?debugPlot= in
  // blockpreview. Clears any previous debug group first so repeated "Go" calls are clean.
  // white=pass1 quad, grey=setback strip, red=naive result, blue=post-subtraction, green=final.
  debugPlotWings(plotId) {
    if (this._plotDebugGroup) {
      this._plotDebugGroup.clear()
    } else {
      this._plotDebugGroup = new THREE.Group()
      this.scene.add(this._plotDebugGroup)
    }

    const cd = this.cityDistrictData
    const plot = (cd?.plots || []).find(p => p.id === plotId)
    if (!plot) {
      console.warn(`[debugPlotWings] plot ${plotId} not found`)
      this.markDirty()
      return `Plot ${plotId} not found`
    }
    const district = (cd?.districts || []).find(d => d.id === plot.districtId)
    const sink = this.groundRenderer.buildingRenderer.debugTownhouseWingPasses(plot, district)

    const Y = BUILDING_GROUND_Y
    const mkLine = (corners, color, y) => {
      if (!corners?.length) return
      const pts = [...corners, corners[0]].map(c => new THREE.Vector3(c.x, y, c.y))
      const geo = new THREE.BufferGeometry().setFromPoints(pts)
      const mat = new THREE.LineBasicMaterial({ color, depthTest: false })
      const line = new THREE.Line(geo, mat)
      line.renderOrder = 999
      this._plotDebugGroup.add(line)
    }

    for (const rec of sink) {
      let y = Y
      mkLine(rec.white, 0xffffff, y); y += 0.002
      mkLine(rec.grey,  0x999999, y); y += 0.002
      for (const piece of (rec.red || [])) mkLine(piece, 0xff2222, y)
      y += 0.002
      mkLine(rec.blue,  0x3355ff, y); y += 0.002
      mkLine(rec.green, 0x22ff44, y)
    }

    const built = sink.filter(r => r.green).length
    const msg = `plot ${plotId}: ${built}/${sink.length} wings built`
    console.log(`[debugPlotWings] ${msg}`, sink)
    this.markDirty()
    return msg
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
      terrainPlotCenters: this.terrainRenderer._terrainPlotCentersVisible,
      terrainSeeds:    this.terrainRenderer._terrainSeedsVisible,
      surfaceCorners:  this.terrainRenderer._surfaceCornersVisible,
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
      const br = this.groundRenderer?.buildingRenderer

      let cx = 0, cz = 0, halfW = 0.25, halfH = 0.25

      if (hq.kind === 'landmark') {
        const lb = cd?.landmarkBuildings?.[hq.refId]
        if (lb) { cx = lb.x; cz = lb.z }
      } else {
        const plot = cd?.plots?.find(p => p.id === hq.refId)
        if (plot?.blockCorners?.length) {
          const xs = plot.blockCorners.map(c => c.x)
          const zs = plot.blockCorners.map(c => c.y)
          const minX = Math.min(...xs), maxX = Math.max(...xs)
          const minZ = Math.min(...zs), maxZ = Math.max(...zs)
          cx = (minX + maxX) / 2; cz = (minZ + maxZ) / 2
          halfW = (maxX - minX) / 2; halfH = (maxZ - minZ) / 2
        }
      }

      const pad = Math.max(halfW, halfH) * 0.25
      const sz = Math.max(halfW + pad, halfH + pad)

      // Orthographic camera directly overhead — top-down ground-floor plan view
      const snapCam = new THREE.OrthographicCamera(-sz, sz, sz, -sz, 0.01, 50)
      snapCam.position.set(cx, 20, cz)
      snapCam.lookAt(cx, 0, cz)
      snapCam.up.set(0, 0, -1)

      // Hide roofs so we see the building footprint/walls from above, not the roof surface
      const roofsWere = br?._roofsVisible ?? true
      if (br) br.setRoofsVisible(false)

      const origW = this.renderer.domElement.width
      const origH = this.renderer.domElement.height
      const origPixelRatio = this.renderer.getPixelRatio()
      const origBackground = this.scene.background
      const origClipPlanes = [...this.renderer.clippingPlanes]

      this.renderer.clippingPlanes = []
      this.scene.background = new THREE.Color(0x0d1117)
      this.renderer.setPixelRatio(1)
      this.renderer.setSize(240, 240, false)
      this.renderer.render(this.scene, snapCam)
      const dataUrl = this.renderer.domElement.toDataURL('image/jpeg', 0.90)

      this.scene.background = origBackground
      this.renderer.clippingPlanes = origClipPlanes
      if (br) br.setRoofsVisible(roofsWere)
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
