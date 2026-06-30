import * as THREE from 'three'
import PolylineRenderer from './utils/PolylineRenderer.js'
import FeatureManager from './utils/FeatureManager.js'
import { pointInPolygon, distanceToLineSegment, clipPolygonToBox } from './utils/renderUtils.js'

const TERRAIN_COLORS = {
  City:          0x808080,
  Plains:        0xb2de69,
  Desert:        0xedca72,
  Mountains:     0x8d8d8d,
  Forest:        0x218c21,
  Lake:          0x1a5abf,
  Sea:           0x0e6e6c,
  Hills:         0x699B4F,
  Swamp:         0x4a6b4a,
  'Ice Sheet':   0xf4f8ff,
  unassigned:    0xb8a680,
  Cliff:         0xaaaaaa,
  River:         0x4488ff,
  get(type) {
    return this[type] ?? null
  }
}

export default class TerrainRenderer {
  constructor(scene) {
    this.scene = scene
    this.showDebug = false
    this.debugObjects = []
    this._terrainCenterMeshes = []   // red spheres at region seed points
    this._terrainVertexMeshes = []   // green boxes at polygon vertices

    this._terrainCentersVisible = true
    this._terrainSeedsVisible   = true

    this.terrainData = null
    this.worldSize = 50
    this.edgePointsById = new Map()

    this.regionMeshes = new Map()
    this.terrainPlotMeshes = new Map()
    this.regionTerrainPlots = new Map()
    this.terrainPolylines = null

    this.threatMeshes = []
    this.tradeMeshes = []
    this.roadMeshes = []

    this.featureManager = new FeatureManager(scene)
    this.spawnedFeatureRegions = new Map()

    this._fpBandMeshes  = []
    this._fpBandCenters = []  // [{fp, worldX, worldZ}] for DOM label positioning

    this.hoveredRegionId = null
    this.hoveredEdgeId = null
    this.hoveredTerrainPlotId = null
    this.selectedRegionId = null
    this.selectedTerrainPlotId = null
    this._debugPreHoverColors = new Map()
  }

  setDebugVisible(show) {
    this.showDebug = show
    for (const m of this._terrainCenterMeshes) m.visible = show && this._terrainCentersVisible
    for (const m of this._terrainVertexMeshes) m.visible = show && this._terrainSeedsVisible
  }

  setTerrainCentersVisible(on) {
    this._terrainCentersVisible = on
    for (const m of this._terrainCenterMeshes) m.visible = this.showDebug && on
  }

  setTerrainSeedsVisible(on) {
    this._terrainSeedsVisible = on
    for (const m of this._terrainVertexMeshes) m.visible = this.showDebug && on
  }

  clearDebugObjects() {
    this._clearDebugGroup(this._terrainCenterMeshes)
    this._clearDebugGroup(this._terrainVertexMeshes)
    for (const obj of this.debugObjects) this.scene.remove(obj)
    this.debugObjects = []
  }

  _clearDebugGroup(arr) {
    for (const obj of arr) this.scene.remove(obj)
    const toRemove = new Set(arr)
    this.debugObjects = this.debugObjects.filter(o => !toRemove.has(o))
    arr.length = 0
  }

  setTerrainPlotSelected(cellId) {
    if (this.selectedTerrainPlotId !== null && this.selectedTerrainPlotId !== cellId) {
      this._restoreTerrainPlotColor(this.selectedTerrainPlotId)
    }
    this.selectedTerrainPlotId = cellId
    const mesh = this.terrainPlotMeshes.get(cellId)
    if (mesh?.material) {
      mesh.material.color.setHex(0xffffff)
      mesh.material.emissive?.setHex(0xffffff)
      mesh.material.emissiveIntensity = 0.5
    }
  }

  clearTerrainPlotSelected() {
    if (this.selectedTerrainPlotId === null) return
    this._restoreTerrainPlotColor(this.selectedTerrainPlotId)
    this.selectedTerrainPlotId = null
  }

  _restoreTerrainPlotColor(cellId) {
    const cell = this.terrainData?.terrainPlots?.find(c => c.id === cellId)
    const base = cell ? this._regionBaseColor(cell.parentRegionId) : 0x888888
    const mesh = this.terrainPlotMeshes.get(cellId)
    if (mesh?.material) {
      mesh.material.color.setHex(base)
      mesh.material.emissive?.setHex(base)
      mesh.material.emissiveIntensity = 0.2
    }
  }

  clearHover() {
    if (this.hoveredTerrainPlotId !== null) {
      // Don't wipe the selected-cell's white highlight when clearing hover
      if (this.hoveredTerrainPlotId !== this.selectedTerrainPlotId) {
        const cell = this.terrainData?.terrainPlots?.find(c => c.id === this.hoveredTerrainPlotId)
        const baseColor = cell ? this._regionBaseColor(cell.parentRegionId) : 0x888888
        const mesh = this.terrainPlotMeshes.get(this.hoveredTerrainPlotId)
        if (mesh?.material) {
          mesh.material.color.setHex(baseColor)
          mesh.material.emissive?.setHex(baseColor)
          mesh.material.emissiveIntensity = 0.2
        }
      }
      this.hoveredTerrainPlotId = null
    }
    if (this.hoveredRegionId !== null) {
      const isSelected = this.selectedRegionId === this.hoveredRegionId
      const baseColor = isSelected ? 0xffffff : this._regionBaseColor(this.hoveredRegionId)
      const cellIds = this.regionTerrainPlots.get(this.hoveredRegionId) || []
      for (const cellId of cellIds) {
        const mesh = this.terrainPlotMeshes.get(cellId)
        if (mesh?.material) {
          const restoreColor = this.showDebug ? (this._debugPreHoverColors.get(cellId) ?? baseColor) : baseColor
          mesh.material.color.setHex(restoreColor)
          mesh.material.emissive?.setHex(restoreColor)
          mesh.material.emissiveIntensity = 0.2
          this._debugPreHoverColors.delete(cellId)
        }
      }
      if (cellIds.length === 0) {
        const rm = this.regionMeshes.get(this.hoveredRegionId)
        if (rm?.material) {
          const key = 'region_' + this.hoveredRegionId
          const restoreColor = this.showDebug ? (this._debugPreHoverColors.get(key) ?? baseColor) : baseColor
          rm.material.color.setHex(restoreColor)
          rm.material.emissive?.setHex(restoreColor)
          rm.material.emissiveIntensity = 0.2
          this._debugPreHoverColors.delete(key)
        }
      }
      this.hoveredRegionId = null
    }
    if (this.hoveredEdgeId !== null) {
      const mesh = this.edgeMeshes.get(this.hoveredEdgeId)
      if (mesh?.material?.emissiveIntensity !== undefined) mesh.material.emissiveIntensity = 0.5
      this.hoveredEdgeId = null
    }
  }

  // ── Terrain data ────────────────────────────────────────────────────────────

  setTerrainData(regions, edges, terrainPlots, edgePoints) {
    this.clearMarkers()
    console.log('setTerrainData called with', regions.length, 'regions,', Object.keys(edges || {}).length, 'edges,', (terrainPlots || []).length, 'terrain plots,', (edgePoints || []).length, 'edge points')
    this.edgePointsById = new Map((edgePoints || []).map(p => [p.id, p]))
    this.terrainData = { regions, edges: edges || {}, terrainPlots: terrainPlots || [] }
    this.renderTerrain(regions, terrainPlots || [])
    this.drawVoronoiCenters(regions)
    if (edges && Object.keys(edges).length > 0) {
      this.renderEdges(edges)
    }
  }

  renderTerrain(regions, terrainPlots) {
    this.regionMeshes.forEach(mesh => this.scene.remove(mesh))
    this.regionMeshes.clear()
    this.terrainPlotMeshes.forEach(mesh => this.scene.remove(mesh))
    this.terrainPlotMeshes.clear()
    this.regionTerrainPlots.clear()

    if (terrainPlots && terrainPlots.length > 0) {
      const regionMap = new Map(regions.map(r => [r.id, r]))
      let count = 0
      for (const cell of terrainPlots) {
        const parent = regionMap.get(cell.parentRegionId)
        const mesh = this.buildRegionMesh({ ...cell, assignedType: parent?.assignedType ?? null })
        if (mesh) {
          this.scene.add(mesh)
          this.terrainPlotMeshes.set(cell.id, mesh)
          if (!this.regionTerrainPlots.has(cell.parentRegionId)) {
            this.regionTerrainPlots.set(cell.parentRegionId, [])
          }
          this.regionTerrainPlots.get(cell.parentRegionId).push(cell.id)
          count++
        }
      }
      console.log(`Rendered ${count}/${terrainPlots.length} terrain plots across ${this.regionTerrainPlots.size} merged regions`)
      for (const region of regions) {
        if (region.assignedType === 'Forest')    this._spawnFeatureForRegion('forest', region.id)
        if (region.assignedType === 'Mountains') this._spawnFeatureForRegion('mountains', region.id)
        if (region.assignedType === 'Hills')     this._spawnFeatureForRegion('hills', region.id)
        if (region.assignedType === 'Sea')       this._spawnFeatureForRegion('sea', region.id)
        if (region.assignedType === 'Lake')      this._spawnFeatureForRegion('lake', region.id)
        if (region.terrainDistrict === 'Agriculture') this._spawnFieldsForRegion(region.id)
      }
    } else {
      let successCount = 0
      regions.forEach(region => {
        const mesh = this.buildRegionMesh(region)
        if (mesh) {
          this.scene.add(mesh)
          this.regionMeshes.set(region.id, mesh)
          successCount++
        }
      })
      console.log(`Rendered ${successCount}/${regions.length} merged region meshes (fallback)`)
    }
  }

  buildRegionMesh(region) {
    if (!region.polygon || region.polygon.length < 3) {
      console.warn(`Region ${region.id} has invalid polygon:`, region.polygon)
      return null
    }

    const polygon = clipPolygonToBox(region.polygon, 0, this.worldSize, 0, this.worldSize)
    if (polygon.length < 3) return null

    const cx = polygon.reduce((s, v) => s + v.x, 0) / polygon.length
    const cy = polygon.reduce((s, v) => s + v.y, 0) / polygon.length
    const vertices = [cx, 0, cy]
    for (const v of polygon) {
      vertices.push(v.x || 0, 0, v.y || 0)
    }
    if (vertices.some(v => !isFinite(v))) {
      console.warn(`Region ${region.id} has non-finite vertices after clip`)
      return null
    }

    const triangles = []
    for (let i = 0; i < polygon.length; i++) {
      const a = i + 1
      const b = ((i + 1) % polygon.length) + 1
      triangles.push(0, a, b)
    }

    if (triangles.length === 0) return null

    let geometry
    try {
      geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3))
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(triangles), 1))
      geometry.computeVertexNormals()
      geometry.computeBoundingBox()
    } catch (e) {
      console.error(`Error creating geometry for region ${region.id}:`, e)
      return null
    }

    const color = TERRAIN_COLORS.get(region.assignedType) || TERRAIN_COLORS.unassigned
    const material = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.6,
      metalness: 0,
      emissive: color,
      emissiveIntensity: 0.2
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData = { regionId: region.id }
    return mesh
  }

  renderEdges(edges) {
    if (!this.terrainPolylines) {
      this.terrainPolylines = new PolylineRenderer(this.scene, { thickness: 0.5, stripY: 0.01, priorityColor: TERRAIN_COLORS.River })
    }
    console.log(`Rendering ${Object.keys(edges).length} edges`)
    this.terrainPolylines.render(
      edges,
      this.edgePointsById,
      (edge) => edge.assignedType ? TERRAIN_COLORS.get(edge.assignedType) : TERRAIN_COLORS.unassigned
    )
    console.log(`Successfully created ${this.edgeMeshes.size} edge meshes`)
  }

  get edgeMeshes()     { return this.terrainPolylines?.edgeMeshes     ?? new Map() }
  get junctionMeshes() { return this.terrainPolylines?.junctionMeshes ?? new Map() }

  hideUndefinedEdges() {
    const edges = this.terrainData?.edges || {}
    const hiddenEdgeIds = new Set()
    for (const [edgeId, edge] of Object.entries(edges)) {
      if (!edge.assignedType) {
        const mesh = this.terrainPolylines?._edgeMeshes?.get(edgeId)
        if (mesh) mesh.visible = false
        hiddenEdgeIds.add(edgeId)
      }
    }
    if (this.terrainPolylines) {
      for (const [ptId, mesh] of this.terrainPolylines.junctionMeshes) {
        const adjEdgeIds = this.terrainPolylines._junctionEdgeIds.get(ptId) ?? new Set()
        if ([...adjEdgeIds].every(id => hiddenEdgeIds.has(id))) mesh.visible = false
      }
    }
  }

  updateRegionColor(regionId, terrainType) {
    this._applyRegionColor(regionId, TERRAIN_COLORS.get(terrainType) || TERRAIN_COLORS.unassigned)
    if (terrainType === 'Forest')    this._spawnFeatureForRegion('forest', regionId)
    if (terrainType === 'Mountains') this._spawnFeatureForRegion('mountains', regionId)
    if (terrainType === 'Hills')     this._spawnFeatureForRegion('hills', regionId)
    if (terrainType === 'Sea')       this._spawnFeatureForRegion('sea', regionId)
  }

  selectRegion(regionId) {
    this.clearTerrainPlotSelected()
    this.selectedRegionId = regionId
    this._applyRegionColor(regionId, 0xffffff)
  }

  deselectRegion(regionId) {
    if (this.selectedRegionId === regionId) this.selectedRegionId = null
    if (this.selectedTerrainPlotId !== null) {
      const plot = this.terrainData?.terrainPlots?.find(p => p.id === this.selectedTerrainPlotId)
      if (plot?.parentRegionId === regionId) this.clearTerrainPlotSelected()
    }
    this._applyRegionColor(regionId, this._regionBaseColor(regionId))
  }

  previewRegionType(regionId, terrainType) {
    const color = terrainType ? TERRAIN_COLORS.get(terrainType) : 0xffffff
    this._applyRegionColor(regionId, color)
  }

  selectEdge(edgeId) {
    this.terrainPolylines?.setEdgeColor(edgeId, 0xffffff)
  }

  deselectEdge(edgeId) {
    this.terrainPolylines?.resetEdgeColor(edgeId)
  }

  previewEdgeType(edgeId, edgeType) {
    const color = edgeType ? TERRAIN_COLORS.get(edgeType) : 0xffffff
    this.terrainPolylines?.setEdgeColor(edgeId, color)
  }

  updateEdgeColor(edgeId, terrainType) {
    const color = TERRAIN_COLORS.get(terrainType) || TERRAIN_COLORS.unassigned
    this.terrainPolylines?.updateBaseColor(edgeId, color)
  }

  setRegionHover(regionId) {
    if (this.hoveredRegionId === regionId && this.hoveredEdgeId === null) return
    this.clearHover()

    this.hoveredRegionId = regionId
    const baseColor = this._regionBaseColor(regionId)
    const lightened = new THREE.Color(baseColor).lerp(new THREE.Color(0xffffff), 0.35)
    const lightenedHex = lightened.getHex()

    const cellIds = this.regionTerrainPlots.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.terrainPlotMeshes.get(cellId)
      if (mesh?.material) {
        if (this.showDebug) this._debugPreHoverColors.set(cellId, mesh.material.color.getHex())
        mesh.material.color.setHex(lightenedHex)
        mesh.material.emissive?.setHex(lightenedHex)
        mesh.material.emissiveIntensity = 0.45
      }
    }
    if (cellIds.length === 0) {
      const rm = this.regionMeshes.get(regionId)
      if (rm?.material) {
        if (this.showDebug) this._debugPreHoverColors.set('region_' + regionId, rm.material.color.getHex())
        rm.material.color.setHex(lightenedHex)
        rm.material.emissive?.setHex(lightenedHex)
        rm.material.emissiveIntensity = 0.45
      }
    }
  }

  setTerrainPlotHover(cellId) {
    if (this.hoveredTerrainPlotId === cellId) return
    this.clearHover()
    this.hoveredTerrainPlotId = cellId
    const mesh = this.terrainPlotMeshes.get(cellId)
    if (!mesh?.material) return
    const cell = this.terrainData?.terrainPlots?.find(c => c.id === cellId)
    const baseColor = cell ? this._regionBaseColor(cell.parentRegionId) : 0x888888
    const lightened = new THREE.Color(baseColor).lerp(new THREE.Color(0xffffff), 0.35)
    const lightenedHex = lightened.getHex()
    mesh.material.color.setHex(lightenedHex)
    mesh.material.emissive?.setHex(lightenedHex)
    mesh.material.emissiveIntensity = 0.45
  }

  getTerrainPlotAtWorldPos(worldX, worldY) {
    if (!this.terrainData?.terrainPlots?.length) return null
    for (const cell of this.terrainData.terrainPlots) {
      if (cell.polygon && pointInPolygon(worldX, worldY, cell.polygon)) return cell
    }
    return null
  }

  setEdgeHover(edgeId) {
    if (this.hoveredEdgeId === edgeId && this.hoveredRegionId === null) return
    this.clearHover()
    if (this.terrainData?.edges?.[edgeId]?.assignedType) return
    this.hoveredEdgeId = edgeId
    const mesh = this.edgeMeshes.get(edgeId)
    if (mesh?.material?.emissiveIntensity !== undefined) mesh.material.emissiveIntensity = 0.9
  }

  // Faction-hover highlight of an off-map region. Uses its OWN state (not
  // hoveredRegionId) so map-hover clearing never wipes it — only clearFactionRegion().
  highlightFactionRegion(regionId) {
    this.clearFactionRegion()
    this._factionRegionId = regionId
    const lightened = new THREE.Color(this._regionBaseColor(regionId)).lerp(new THREE.Color(0xffffff), 0.35).getHex()
    this._paintRegion(regionId, lightened, 0.45)
  }

  clearFactionRegion() {
    if (this._factionRegionId == null) return
    const id = this._factionRegionId
    const base = (this.selectedRegionId === id) ? 0xffffff : this._regionBaseColor(id)
    this._paintRegion(id, base, 0.2)
    this._factionRegionId = null
  }

  _paintRegion(regionId, hex, ei) {
    const cellIds = this.regionTerrainPlots.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.terrainPlotMeshes.get(cellId)
      if (mesh?.material) { mesh.material.color.setHex(hex); mesh.material.emissive?.setHex(hex); mesh.material.emissiveIntensity = ei }
    }
    if (cellIds.length === 0) {
      const rm = this.regionMeshes.get(regionId)
      if (rm?.material) { rm.material.color.setHex(hex); rm.material.emissive?.setHex(hex); rm.material.emissiveIntensity = ei }
    }
  }

  // ── Threats and trades ──────────────────────────────────────────────────────

  renderThreats(threats, regions) {
    this.threatMeshes.forEach(m => this.scene.remove(m))
    this.threatMeshes = []
    if (!threats?.length || !regions) return
    const regionMap = new Map(regions.map(r => [r.id, r]))
    const geo = new THREE.OctahedronGeometry(0.7)
    for (const threat of threats) {
      const region = regionMap.get(threat.regionId)
      if (!region) continue
      const mat = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff2222, emissiveIntensity: 0.6 })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(region.seedPoint.x, 1.8, region.seedPoint.y)
      this.scene.add(mesh)
      this.threatMeshes.push(mesh)
    }
  }

  renderTrades(tradingDestinations, terrainData, featureManager) {
    this.tradeMeshes.forEach(m => this.scene.remove(m))
    this.tradeMeshes = []
    this.roadMeshes.forEach(m => this.scene.remove(m))
    this.roadMeshes = []
    if (!tradingDestinations?.length || !terrainData?.regions) return
    const regionMap = new Map(terrainData.regions.map(r => [r.id, r]))
    const cellsByRegion = new Map()
    for (const cell of (terrainData.terrainPlots || [])) {
      if (!cellsByRegion.has(cell.parentRegionId)) cellsByRegion.set(cell.parentRegionId, [])
      cellsByRegion.get(cell.parentRegionId).push(cell)
    }
    for (const trade of tradingDestinations) {
      let terrainPlotPath = null, cellMap = null
      if (trade.roadPath?.length >= 2) {
        const result = this._buildFineRoadMesh(trade.roadPath, regionMap, cellsByRegion)
        if (result) {
          if (result.mesh) { this.scene.add(result.mesh); this.roadMeshes.push(result.mesh) }
          terrainPlotPath = result.terrainPlotPath
          cellMap = result.cellMap
        }
      }
      for (const bridge of (trade.bridges || [])) {
        if (!terrainPlotPath || !cellMap) continue
        let crossA = null, crossB = null
        for (let i = 0; i < terrainPlotPath.length - 1; i++) {
          const ca = cellMap.get(terrainPlotPath[i])
          const cb = cellMap.get(terrainPlotPath[i + 1])
          if (!ca || !cb) continue
          if (ca.parentRegionId === bridge.fromRegionId && cb.parentRegionId === bridge.toRegionId) { crossA = ca; crossB = cb; break }
          if (ca.parentRegionId === bridge.toRegionId && cb.parentRegionId === bridge.fromRegionId) { crossA = cb; crossB = ca; break }
        }
        if (!crossA || !crossB) continue
        const mx = (crossA.seedPoint.x + crossB.seedPoint.x) / 2
        const mz = (crossA.seedPoint.y + crossB.seedPoint.y) / 2
        const dx = crossB.seedPoint.x - crossA.seedPoint.x
        const dz = crossB.seedPoint.y - crossA.seedPoint.y
        const rotZ = Math.atan2(dz, dx)
        this.featureManager.spawn('bridge', [{ id: bridge.fromRegionId * 10000 + bridge.toRegionId }], { x: mx, z: mz, rotX: Math.PI / 2, rotY: 0, rotZ })
      }
    }
  }

  _buildFineRoadMesh(path, regionMap, cellsByRegion) {
    const W = this.worldSize
    const pathSet = new Set(path)
    const cityRegionId = path[path.length - 1]

    const pathCells = []
    for (const regionId of path) {
      for (const cell of (cellsByRegion.get(regionId) || [])) pathCells.push(cell)
    }
    if (pathCells.length === 0) return null
    const cellMap = new Map(pathCells.map(c => [c.id, c]))

    const adj = new Map()
    const vertToCells = new Map()
    for (const cell of pathCells) {
      for (const v of (cell.polygon || [])) {
        const key = `${Math.round(v.x * 20)},${Math.round(v.y * 20)}`
        if (!vertToCells.has(key)) vertToCells.set(key, [])
        vertToCells.get(key).push(cell.id)
      }
    }
    for (const [, ids] of vertToCells) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i], b = ids[j]
          if (!adj.has(a)) adj.set(a, new Set())
          if (!adj.has(b)) adj.set(b, new Set())
          adj.get(a).add(b)
          adj.get(b).add(a)
        }
      }
    }

    const edgeCells = cellsByRegion.get(path[0]) || []
    if (edgeCells.length === 0) return null
    let startCell = edgeCells[0], minBoundDist = Infinity
    for (const cell of edgeCells) {
      const { x, y } = cell.seedPoint
      const d = Math.min(x, W - x, y, W - y)
      if (d < minBoundDist) { minBoundDist = d; startCell = cell }
    }

    const cityIds = new Set((cellsByRegion.get(cityRegionId) || []).map(c => c.id))

    const queue = [[startCell.id, [startCell.id]]]
    const visited = new Set([startCell.id])
    let terrainPlotPath = null

    bfs: while (queue.length > 0) {
      const [curr, currPath] = queue.shift()
      if (cityIds.has(curr)) { terrainPlotPath = currPath; break bfs }
      for (const next of (adj.get(curr) || [])) {
        if (visited.has(next)) continue
        const nextCell = cellMap.get(next)
        if (!nextCell || !pathSet.has(nextCell.parentRegionId)) continue
        visited.add(next)
        queue.push([next, [...currPath, next]])
      }
    }

    if (!terrainPlotPath || terrainPlotPath.length < 2) return null

    // A waypoint is "wet" when its terrain plot belongs to a Sea/Lake region — no road
    // is drawn over water (bridges span the crossing instead).
    const isWater = (cell) => {
      const r = cell && regionMap.get(cell.parentRegionId)
      return !!r && (r.assignedType === 'Sea' || r.assignedType === 'Lake')
    }

    const waypoints = []
    const waterFlags = []
    for (let i = 0; i < terrainPlotPath.length - 1; i++) {
      const cell = cellMap.get(terrainPlotPath[i])
      if (cell) { waypoints.push({ x: cell.seedPoint.x, y: cell.seedPoint.y }); waterFlags.push(isWater(cell)) }
    }
    const cityCell = cellMap.get(terrainPlotPath[terrainPlotPath.length - 1])
    if (cityCell && waypoints.length > 0) {
      const last = waypoints[waypoints.length - 1]
      waypoints.push({
        x: (last.x + cityCell.seedPoint.x) / 2,
        y: (last.y + cityCell.seedPoint.y) / 2
      })
      waterFlags.push(isWater(cityCell))
    }

    if (waypoints.length < 2) return null

    const w0 = waypoints[0], w1 = waypoints[1]
    const dx = w0.x - w1.x, dy = w0.y - w1.y
    const candidates = []
    if (Math.abs(dx) > 1e-9) candidates.push(dx > 0 ? (W - w0.x) / dx : (0 - w0.x) / dx)
    if (Math.abs(dy) > 1e-9) candidates.push(dy > 0 ? (W - w0.y) / dy : (0 - w0.y) / dy)
    const t = Math.min(...candidates.filter(b => b > 1e-9))
    if (isFinite(t)) waypoints[0] = { x: w0.x + t * dx, y: w0.y + t * dy }

    return { mesh: this._buildRoadStripMesh(waypoints, waterFlags), terrainPlotPath, cellMap }
  }

  _buildRoadStripMesh(waypoints, waterFlags = []) {
    const thickness = 0.15
    const allVerts = [], allIdx = []
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (waterFlags[i] || waterFlags[i + 1]) continue   // no road over Sea/Lake cells
      const p1 = waypoints[i], p2 = waypoints[i + 1]
      const dx = p2.x - p1.x, dy = p2.y - p1.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len === 0) continue
      const px = (-dy / len) * (thickness / 2), py = (dx / len) * (thickness / 2)
      const base = allVerts.length / 3
      allVerts.push(
        p1.x - px, 0.04, p1.y - py, p1.x + px, 0.04, p1.y + py,
        p2.x + px, 0.04, p2.y + py, p2.x - px, 0.04, p2.y - py
      )
      allIdx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    if (allVerts.length === 0) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVerts), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(allIdx), 1))
    geometry.computeVertexNormals()
    const color = 0xc8a050
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, emissive: color, emissiveIntensity: 0.3 })
    return new THREE.Mesh(geometry, mat)
  }

  // Remove the terrain-plot trade-road ribbon (the setup-phase preview). In the
  // city phase the trade road is a real street-graph member rendered by
  // StreetRenderer, so the ribbon is cleared to avoid double-rendering the path.
  clearTradeRoadRibbon() {
    this.roadMeshes.forEach(m => this.scene.remove(m))
    this.roadMeshes = []
  }

  clearMarkers() {
    this.threatMeshes.forEach(m => this.scene.remove(m))
    this.threatMeshes = []
    this.tradeMeshes.forEach(m => this.scene.remove(m))
    this.tradeMeshes = []
    this.roadMeshes.forEach(m => this.scene.remove(m))
    this.roadMeshes = []
    this.featureManager?.clear()
    this.spawnedFeatureRegions.clear()
  }

  spawnTerrainDistrictFeature(regionId, districtType) {
    if (districtType === 'Agriculture') this._spawnFieldsForRegion(regionId)
  }

  deleteCityTerrainCells() {
    const cityRegion = this.terrainData?.regions?.find(r => r.assignedType === 'City')
    if (!cityRegion) return
    const cellIds = this.regionTerrainPlots.get(cityRegion.id) || []
    for (const cellId of cellIds) {
      const mesh = this.terrainPlotMeshes.get(cellId)
      if (mesh) { this.scene.remove(mesh); this.terrainPlotMeshes.delete(cellId) }
    }
    this.regionTerrainPlots.delete(cityRegion.id)
    const regionMesh = this.regionMeshes.get(cityRegion.id)
    if (regionMesh) { this.scene.remove(regionMesh); this.regionMeshes.delete(cityRegion.id) }
  }

  // Remove all non-city terrain plot meshes — called when ground terrain plots take over
  // rendering of the terrain outside the city with gutter-aligned boundaries.
  deleteNonCityTerrainPlots() {
    const cityRegion = this.terrainData?.regions?.find(r => r.assignedType === 'City')
    const cityRegionId = cityRegion?.id ?? -1
    for (const [regionId, cellIds] of this.regionTerrainPlots) {
      if (regionId === cityRegionId) continue
      for (const cellId of cellIds) {
        const mesh = this.terrainPlotMeshes.get(cellId)
        if (mesh) { this.scene.remove(mesh); this.terrainPlotMeshes.delete(cellId) }
      }
      this.regionTerrainPlots.delete(regionId)
    }
  }

  // ── Hit testing ─────────────────────────────────────────────────────────────

  getRegionAtWorldPos(worldX, worldY) {
    if (!this.terrainData) return null
    const terrainPlots = this.terrainData.terrainPlots
    if (terrainPlots && terrainPlots.length > 0) {
      const regionMap = new Map(this.terrainData.regions.map(r => [r.id, r]))
      for (const cell of terrainPlots) {
        if (cell.polygon && pointInPolygon(worldX, worldY, cell.polygon)) {
          return regionMap.get(cell.parentRegionId) || null
        }
      }
      return null
    }
    for (const region of this.terrainData.regions) {
      if (pointInPolygon(worldX, worldY, region.polygon)) return region
    }
    return null
  }

  getEdgeAtWorldPos(worldX, worldY) {
    if (!this.terrainData || !this.terrainData.edges) return null
    const threshold = 0.375
    let closestEdge = null
    let closestDistance = threshold
    for (const edgeId in this.terrainData.edges) {
      const edge = this.terrainData.edges[edgeId]
      const ids = edge.pointIds
      if (!ids || ids.length < 2) continue
      for (let i = 0; i < ids.length - 1; i++) {
        const p1 = this.edgePointsById.get(ids[i])
        const p2 = this.edgePointsById.get(ids[i + 1])
        if (!p1 || !p2) continue
        const distance = distanceToLineSegment(worldX, worldY, p1.x, p1.y, p2.x, p2.y)
        if (distance < closestDistance) {
          closestDistance = distance
          closestEdge = { ...edge, id: edgeId }
        }
      }
    }
    return closestEdge
  }

  getTerrainCornerAtWorldPos(worldX, worldY, threshold = 0.5) {
    if (!this.terrainData || !this.terrainData.regions) return null
    const cornerMap = new Map()
    for (let i = 0; i < this.terrainData.regions.length; i++) {
      const region = this.terrainData.regions[i]
      region.polygon.forEach((vertex, vertexIndex) => {
        const key = `${vertex.x.toFixed(4)},${vertex.y.toFixed(4)}`
        if (!cornerMap.has(key)) {
          cornerMap.set(key, { point: vertex, regionIds: [], vertexIndices: [] })
        }
        const entry = cornerMap.get(key)
        entry.regionIds.push(i)
        entry.vertexIndices.push(vertexIndex)
      })
    }
    for (const [, data] of cornerMap) {
      const dist = Math.sqrt(Math.pow(worldX - data.point.x, 2) + Math.pow(worldY - data.point.y, 2))
      if (dist < threshold && data.regionIds.length >= 2) return data
    }
    return null
  }

  getTerrainSeedAtWorldPos(worldX, worldY, threshold = 0.5) {
    if (!this.terrainData || !this.terrainData.regions) return null
    for (let i = 0; i < this.terrainData.regions.length; i++) {
      const region = this.terrainData.regions[i]
      const dist = Math.sqrt(Math.pow(worldX - region.seedPoint.x, 2) + Math.pow(worldY - region.seedPoint.y, 2))
      if (dist < threshold) return { regionId: region.id, position: region.seedPoint }
    }
    return null
  }

  // ── Animation update ────────────────────────────────────────────────────────

  update(delta, camera) {
    this.featureManager?.update(delta, camera)
  }

  // ── Debug ───────────────────────────────────────────────────────────────────

  drawVoronoiCenters(regions) {
    this._clearDebugGroup(this._terrainCenterMeshes)
    this._clearDebugGroup(this._terrainVertexMeshes)

    const seedGeo = new THREE.SphereGeometry(0.075, 8, 8)
    const seedMat = new THREE.MeshBasicMaterial({ color: 0xff0000 })
    regions.forEach(region => {
      const seed = new THREE.Mesh(seedGeo, seedMat)
      seed.position.set(region.seedPoint.x, 0.1, region.seedPoint.y)
      seed.userData = { kind: 'terrainCenter', regionId: region.id, assignedType: region.assignedType, x: region.seedPoint.x, y: region.seedPoint.y }
      seed.visible = this.showDebug && this._terrainCentersVisible
      this.scene.add(seed)
      this.debugObjects.push(seed)
      this._terrainCenterMeshes.push(seed)
    })

    const vertGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05)
    const vertMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 })
    regions.forEach(region => {
      region.polygon.forEach(vertex => {
        const vert = new THREE.Mesh(vertGeo, vertMat)
        vert.position.set(vertex.x, 0.1, vertex.y)
        vert.visible = this.showDebug && this._terrainSeedsVisible
        this.scene.add(vert)
        this.debugObjects.push(vert)
        this._terrainVertexMeshes.push(vert)
      })
    })
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _applyRegionColor(regionId, color) {
    const cellIds = this.regionTerrainPlots.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.terrainPlotMeshes.get(cellId)
      if (mesh) { mesh.material.color.setHex(color); mesh.material.emissive?.setHex(color) }
    }
    const rm = this.regionMeshes.get(regionId)
    if (rm) { rm.material.color.setHex(color); rm.material.emissive?.setHex(color) }
  }

  _regionBaseColor(regionId) {
    const region = this.terrainData?.regions?.find(r => r.id === regionId)
    return TERRAIN_COLORS.get(region?.assignedType) || TERRAIN_COLORS.unassigned
  }

  _cellsForRegion(regionId) {
    const cellIds = this.regionTerrainPlots.get(regionId) || []
    const cellMap = new Map((this.terrainData?.terrainPlots || []).map(p => [p.id, p]))
    return cellIds.map(id => cellMap.get(id)).filter(Boolean)
  }

  _spawnFeatureForRegion(featureName, regionId) {
    if (!this.spawnedFeatureRegions.has(regionId)) this.spawnedFeatureRegions.set(regionId, new Set())
    const spawned = this.spawnedFeatureRegions.get(regionId)
    if (spawned.has(featureName)) return
    spawned.add(featureName)
    const cells = this._cellsForRegion(regionId)
    if (cells.length > 0) this.featureManager.spawn(featureName, cells)
  }

  // ── Foreign Power border bands ───────────────────────────────────────────────

  renderForeignPowerBands(foreignPowers) {
    this.clearForeignPowerBands()
    if (!foreignPowers?.length) return
    for (const fp of foreignPowers) {
      const band = this._buildFPBand(fp.direction, fp.colour || '#888888')
      if (band) { this.scene.add(band); this._fpBandMeshes.push(band) }
      const center = this._computeFPBandCenter(fp.direction)
      if (center) this._fpBandCenters.push({ fp, worldX: center.x, worldY: center.y, worldZ: center.z })
    }
  }

  clearForeignPowerBands() {
    for (const m of this._fpBandMeshes) { m.geometry?.dispose(); m.material?.dispose(); this.scene.remove(m) }
    this._fpBandMeshes  = []
    this._fpBandCenters = []
  }

  setFPBandsVisible(visible) {
    for (const m of this._fpBandMeshes) m.visible = visible
  }

  _fpRayBoundary(cx, cy, vx, vy, W) {
    const candidates = []
    if (Math.abs(vx) > 1e-9) {
      const t = vx > 0 ? (W - cx) / vx : -cx / vx
      if (t > 0) {
        const hy = cy + t * vy
        if (hy >= -0.01 && hy <= W + 0.01)
          candidates.push({ t, x: Math.min(W, Math.max(0, cx + t * vx)), y: Math.min(W, Math.max(0, hy)) })
      }
    }
    if (Math.abs(vy) > 1e-9) {
      const t = vy > 0 ? (W - cy) / vy : -cy / vy
      if (t > 0) {
        const hx = cx + t * vx
        if (hx >= -0.01 && hx <= W + 0.01)
          candidates.push({ t, x: Math.min(W, Math.max(0, hx)), y: Math.min(W, Math.max(0, cy + t * vy)) })
      }
    }
    return candidates.length ? candidates.reduce((a, b) => a.t < b.t ? a : b) : null
  }

  // Convert a boundary hit point to a perimeter parameter t ∈ [0, 4W).
  // Perimeter goes clockwise from NW corner: North→East→South→West.
  _perimPosOf(hit, W) {
    const eps = 0.01
    if (hit.y <= eps)     return hit.x                  // North edge
    if (hit.x >= W - eps) return W + hit.y              // East edge
    if (hit.y >= W - eps) return 2 * W + (W - hit.x)    // South edge
    return 3 * W + (W - hit.y)                           // West edge
  }

  // Return {x, y, inX, inY} for a perimeter position t (wraps around 4W).
  // (x,y) is the 2D map point; (inX,inY) is the inward-facing normal.
  _perimPt(t, W) {
    const P = 4 * W
    const T = ((t % P) + P) % P
    if (T < W)       return { x: T,         y: 0,         inX: 0,  inY: 1  }
    if (T < 2 * W)   return { x: W,         y: T - W,     inX: -1, inY: 0  }
    if (T < 3 * W)   return { x: 3 * W - T, y: W,         inX: 0,  inY: -1 }
    return                 { x: 0,          y: 4 * W - T, inX: 1,  inY: 0  }
  }

  _buildFPBand(bearing, colourStr) {
    const W     = this.worldSize, toRad = Math.PI / 180
    const vx    = Math.sin(bearing * toRad), vy = -Math.cos(bearing * toRad)
    const hit   = this._fpRayBoundary(W / 2, W / 2, vx, vy, W)
    if (!hit) return null

    const halfLen = 12    // units along perimeter on each side of bearing point
    const depth   = 1.5  // strip thickness inward from boundary
    const Y       = 4.0  // float height — ShaderMaterial bypasses clip plane so it's visible in top-down
    const N_STRIP = 60   // samples for main strip
    const N_CAP   = 14   // semicircle segments per pill cap

    const hitT = this._perimPosOf(hit, W)
    const t0   = hitT - halfLen
    const t1   = hitT + halfLen

    const verts = [], tris = []
    let vi = 0
    const pushV = (x, z) => { verts.push(x, Y, z); return vi++ }

    // ── Main strip ───────────────────────────────────────────────────────────
    const oIdx = [], iIdx = []
    for (let i = 0; i <= N_STRIP; i++) {
      const t = t0 + (i / N_STRIP) * (t1 - t0)
      const p = this._perimPt(t, W)
      oIdx.push(pushV(p.x, p.y))
      iIdx.push(pushV(p.x + p.inX * depth, p.y + p.inY * depth))
    }
    for (let i = 0; i < N_STRIP; i++) {
      const a = oIdx[i], b = iIdx[i], c = oIdx[i + 1], d = iIdx[i + 1]
      tris.push(a, c, b,  b, c, d)
    }

    // ── Corner fill triangles (closes the gap when strip wraps a map corner) ─
    for (const ct of [W, 2 * W, 3 * W, 4 * W]) {
      const frac = (ct - t0) / (t1 - t0) * N_STRIP
      if (frac > 0.5 && frac < N_STRIP - 0.5) {
        const pBefore = this._perimPt(ct - 0.01, W)
        const pAfter  = this._perimPt(ct + 0.01, W)
        const pCorner = this._perimPt(ct, W)
        const iA = pushV(pBefore.x + pBefore.inX * depth, pBefore.y + pBefore.inY * depth)
        const iB = pushV(pAfter.x  + pAfter.inX  * depth, pAfter.y  + pAfter.inY  * depth)
        const ov = pushV(pCorner.x, pCorner.y)
        tris.push(ov, iA, iB)
      }
    }

    // ── Pill caps (rounded ends) ─────────────────────────────────────────────
    // sign: -1 = start cap (opens in −t direction), +1 = end cap (+t direction)
    const addCap = (t, sign) => {
      const p  = this._perimPt(t, W)
      const r  = depth / 2
      const cx = p.x + p.inX * r, cz = p.y + p.inY * r   // cap centre
      const tX = p.inY * sign,    tZ = -p.inX * sign       // outward tangent for this end

      const cv  = pushV(cx, cz)
      const arc = []
      for (let j = 0; j <= N_CAP; j++) {
        const a  = (j / N_CAP) * Math.PI
        // angle=0 → outer edge (boundary), angle=π → inner edge
        const ex = Math.cos(a) * (-p.inX) + Math.sin(a) * tX
        const ez = Math.cos(a) * (-p.inY) + Math.sin(a) * tZ
        arc.push(pushV(cx + ex * r, cz + ez * r))
      }
      for (let j = 0; j < N_CAP; j++) tris.push(cv, arc[j], arc[j + 1])
    }
    addCap(t0, -1)
    addCap(t1, +1)

    // ── Geometry + material ──────────────────────────────────────────────────
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1))

    // ShaderMaterial with default clipping:false bypasses the floor-scroll
    // clip plane, keeping the band visible in top-down orthographic mode.
    const color = new THREE.Color(colourStr)
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uOpacity: { value: 0.5 } },
      vertexShader: `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        void main() {
          gl_FragColor = vec4(uColor, uOpacity);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    return new THREE.Mesh(geo, mat)
  }

  _computeFPBandCenter(bearing) {
    const W   = this.worldSize, toRad = Math.PI / 180
    const vx  = Math.sin(bearing * toRad), vy = -Math.cos(bearing * toRad)
    const hit = this._fpRayBoundary(W / 2, W / 2, vx, vy, W)
    if (!hit) return null
    const p = this._perimPt(this._perimPosOf(hit, W), W)
    // Label sits at strip centre: depth/2 = 0.75 inward from boundary
    return { x: hit.x + p.inX * 0.75, y: 4.0, z: hit.y + p.inY * 0.75 }
  }

  _spawnFieldsForRegion(regionId) {
    if (!this.spawnedFeatureRegions.has(regionId)) this.spawnedFeatureRegions.set(regionId, new Set())
    const spawned = this.spawnedFeatureRegions.get(regionId)
    if (spawned.has('fields')) return
    spawned.add('fields')

    const cells = this._cellsForRegion(regionId)
    if (cells.length === 0) return

    let s = (regionId * 2654435761) >>> 0
    const rng = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0x100000000 }

    const arr = [...cells]
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]]
    }
    const count = Math.min(arr.length, rng() < 0.5 ? 1 : 2)
    this.featureManager.spawn('fields', arr.slice(0, count))
  }
}
