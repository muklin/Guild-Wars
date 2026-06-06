import * as THREE from 'three'
import CameraController from '../input/CameraController.js'

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

    this.terrainRenderer = null
    this.districtRenderer = null
    this.streetRenderer = null
    this.plotRenderer = null
  }


  // ── Engine / Lifecycle ──────────────────────────────────────────────────────

  init() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0xff00ff)

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.shadowMap.enabled = true
    document.body.insertBefore(this.renderer.domElement, document.body.firstChild)

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

    this.cameraController = new CameraController(this.camera, this.renderer)

    this.terrainRenderer  = new TerrainRenderer(this.scene)
    this.districtRenderer = new DistrictRenderer(this.scene)
    this.streetRenderer   = new StreetRenderer(this.scene)
    this.plotRenderer     = new PlotRenderer(this.scene, this.originalMaterials)

    window.addEventListener('resize', () => this.onWindowResize())

    this.animate()
  }

  animate() {
    requestAnimationFrame(() => this.animate())
    const delta = this.clock.getDelta()
    if (!this.isPaused) {
      this.cameraController.update()
      this.terrainRenderer.update(delta, this.camera)
      this.districtRenderer.updateWallAnimations()
      this.renderer.render(this.scene, this.camera)
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

  drawDistrictCenters(districts) {
    return this.districtRenderer.drawDistrictCenters(districts)
  }


  // ── Street delegation ───────────────────────────────────────────────────────

  renderStreetGraph(streetGraph) {
    if (!RENDER_STREETS) return
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

  clearHover() {
    this.terrainRenderer.clearHover()
    this.districtRenderer.clearHover()
    this.streetRenderer.clearHover()
    this.plotRenderer.clearHover()
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
    this.clearHover()
    if (faction.districtId !== undefined) {
      this.districtRenderer.highlightFactionDistrict(faction.districtId)
    } else if (faction.regionId !== undefined) {
      this.terrainRenderer.highlightFactionRegion(faction.regionId)
    }
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
