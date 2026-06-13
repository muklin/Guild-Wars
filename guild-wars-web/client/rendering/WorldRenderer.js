import * as THREE from 'three'
import CameraController from '../input/CameraController.js'
import WalkMode from './WalkMode.js'

import TerrainRenderer from './TerrainRenderer.js'
import DistrictRenderer from './DistrictRenderer.js'
import StreetRenderer from './StreetRenderer.js'
import PlotRenderer from './PlotRenderer.js'
import { pointInPolygon, distanceToLineSegment } from './utils/renderUtils.js'

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

    this.terrainRenderer = null
    this.districtRenderer = null
    this.streetRenderer = null
    this.plotRenderer = null

    this._walkMode = null
    this._walkModeOnExit = null
  }


  // ── Engine / Lifecycle ──────────────────────────────────────────────────────

  init() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0xff00ff)

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.shadowMap.enabled = false
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
    this.streetRenderer   = new StreetRenderer(this.scene)
    this.plotRenderer     = new PlotRenderer(this.scene, this.originalMaterials)
    this.plotRenderer.buildingRenderer.setDirtyCallback(() => this.markDirty())

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
    this.streetRenderer.setStreetGraph(this.districtRenderer.cityDistrictData?.streetGraph)
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
    return this.districtRenderer.selectCityEdge(edgeId)
  }

  deselectCityEdge(edgeId) {
    return this.districtRenderer.deselectCityEdge(edgeId)
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
    return this.districtRenderer.setCityEdgeHover(edgeId)
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


  // ── Street delegation ───────────────────────────────────────────────────────

  renderStreetGraph(streetGraph) {
    if (!RENDER_STREETS) return
    // The trade road is now a street-graph member; drop the setup-phase ribbon
    // so the same path isn't drawn twice.
    this.terrainRenderer.clearTradeRoadRibbon()
    return this.streetRenderer.renderStreetGraph(streetGraph)
  }

  clearStreetLayer() {
    return this.streetRenderer.clearStreetLayer()
  }

  renderGutters(streetGraph) {
    if (!RENDER_GUTTERS) return
    return this.streetRenderer.renderGutters(streetGraph)
  }

  clearGutterLayer() {
    return this.streetRenderer.clearGutterLayer()
  }

  setStreetEdgeHover(edge) {
    return this.streetRenderer.setStreetEdgeHover(edge)
  }

  setJunctionHover(junctionId) {
    return this.streetRenderer.setJunctionHover(junctionId)
  }

  getStreetEdgeAtWorldPos(worldX, worldY, threshold) {
    return this.streetRenderer.getStreetEdgeAtWorldPos(worldX, worldY, threshold)
  }

  getJunctionAtWorldPos(worldX, worldY, threshold) {
    return this.streetRenderer.getJunctionAtWorldPos(worldX, worldY, threshold)
  }

  drawStreetSeeds(streetGraph) {
    return this.streetRenderer.drawStreetSeeds(streetGraph)
  }


  // ── Plot / Block delegation ─────────────────────────────────────────────────

  renderBlocks(blocks) {
    if (!RENDER_BLOCKS) {
      this.plotRenderer._blockById = new Map((blocks || []).map(b => [b.id, b.blockCorners]))
      return
    }
    return this.plotRenderer.renderBlocks(blocks)
  }

  clearBlockLayer() {
    return this.plotRenderer.clearBlockLayer()
  }

  setBlockHover(blockId) {
    return this.plotRenderer.setBlockHover(blockId)
  }

  clearBlockHover() {
    return this.plotRenderer.clearBlockHover()
  }

  renderPlots(plots, districtData) {
    if (!RENDER_PLOTS) return
    return this.plotRenderer.renderPlots(plots, districtData)
  }

  clearPlotLayer() {
    return this.plotRenderer.clearPlotLayer()
  }

  drawBlockCenters(blocks) {
    return this.plotRenderer.drawBlockCenters(blocks)
  }

  getBlockCenterAtWorldPos(worldX, worldY, threshold) {
    return this.plotRenderer.getBlockCenterAtWorldPos(worldX, worldY, threshold)
  }

  drawPlotCenters(plots) {
    return this.plotRenderer.drawPlotCenters(plots)
  }

  getPlotCenterAtWorldPos(worldX, worldY, threshold) {
    return this.plotRenderer.getPlotCenterAtWorldPos(worldX, worldY, threshold)
  }

  clearDerivedLayers() {
    this.streetRenderer.clearGutterLayer()
    this.plotRenderer.clearBlockLayer()
    this.plotRenderer.clearPlotLayer()
  }


  // ── Hover ────────────────────────────────────────────────────────────────────

  // Transient map hovers only (cursor over the map). Does NOT touch the panel-driven
  // faction highlight, so moving the mouse over the faction panel won't wipe it.
  clearHover() {
    this.terrainRenderer.clearHover()
    this.districtRenderer.clearHover()
    this.streetRenderer.clearHover()
    this.plotRenderer.clearHover()
  }

  // Revert the faction-hover highlight (district mesh + streets + plots + squares, or
  // an off-map region). Called on un-hover, independent of map-hover clearing.
  clearFactionHighlight() {
    this.districtRenderer.clearFactionDistrict()
    this.streetRenderer.clearDistrictHighlight()
    this.plotRenderer.clearDistrictPlotHighlight()
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
      this.streetRenderer.highlightDistrictStreets(faction.districtId)
      this.plotRenderer.highlightDistrictPlots(faction.districtId)
    } else if (faction.regionId !== undefined) {
      this.terrainRenderer.highlightFactionRegion(faction.regionId)
    }
  }

  // Switch plot bases to/from the finished grassy-brown ground (leaving District Setup).
  setFinishedGround(finished) {
    this.plotRenderer.setFinishedGround(finished)
  }

  toggleBuildings() {
    const br = this.plotRenderer.buildingRenderer
    br.setBuildingsVisible(!br._visible)
    this.markDirty()
  }

  // ── Walk Mode ─────────────────────────────────────────────────────────────────

  // Returns true if walk mode was entered, false if it was exited.
  // onExitCallback is called whenever walk mode ends (including Esc key).
  toggleWalkMode(onExitCallback) {
    if (!this._walkMode) {
      this._walkModeOnExit = onExitCallback
      const streetGraph   = this.districtRenderer.cityDistrictData?.streetGraph
      const plots         = this.cityDistrictData?.plots || []
      const targetPos     = { x: this.cameraController.targetPosition.x, z: this.cameraController.targetPosition.z }
      const initialYaw    = this.cameraController.azimuth
      this._walkMode = new WalkMode(
        this.scene, this.renderer, streetGraph, plots, targetPos, initialYaw,
        () => this._exitWalkMode()
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
    this.streetRenderer.setDebugVisible(this.showDebug)
    this.plotRenderer.setDebugVisible(this.showDebug)

    const allDebug = new Set([
      ...this.terrainRenderer.debugObjects,
      ...this.districtRenderer.debugObjects,
      ...this.streetRenderer.debugObjects,
      ...this.plotRenderer.debugObjects,
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
    this.streetRenderer.clearDebugObjects()
    this.plotRenderer.clearDebugObjects()
  }


  // ── Utility methods (called by App.js directly) ──────────────────────────────

  pointInPolygon(x, y, polygon) {
    return pointInPolygon(x, y, polygon)
  }

  distanceToLineSegment(px, py, x1, y1, x2, y2) {
    return distanceToLineSegment(px, py, x1, y1, x2, y2)
  }
}
