import * as THREE from 'three'
import PolylineRenderer from './utils/PolylineRenderer.js'
import FeatureManager from './utils/FeatureManager.js'
import { pointInPolygon, distanceToLineSegment, clipPolygonToBox } from './utils/renderUtils.js'

const TERRAIN_COLORS = {
  City:        0x808080,
  Plains:      0xb2de69,
  Desert:      0xedca72,
  Mountains:   0x8d8d8d,
  Forest:      0x218c21,
  Lake:        0x1a5abf,
  Sea:         0x0e6e6c,
  Hills:       0x699B4F,
  Swamp:       0x4a6b4a,
  unassigned:  0xb8a680,
  Cliff:       0xaaaaaa,
  River:       0x4488ff,
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
    this.fineCellMeshes = new Map()
    this.regionFineCells = new Map()
    this.terrainPolylines = null

    this.threatMeshes = []
    this.tradeMeshes = []
    this.roadMeshes = []

    this.featureManager = new FeatureManager(scene)
    this.spawnedFeatureRegions = new Map()

    this.hoveredRegionId = null
    this.hoveredEdgeId = null
    this.selectedRegionId = null
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

  clearHover() {
    if (this.hoveredRegionId !== null) {
      const isSelected = this.selectedRegionId === this.hoveredRegionId
      const baseColor = isSelected ? 0xffffff : this._regionBaseColor(this.hoveredRegionId)
      const cellIds = this.regionFineCells.get(this.hoveredRegionId) || []
      for (const cellId of cellIds) {
        const mesh = this.fineCellMeshes.get(cellId)
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

  setTerrainData(regions, edges, fineCells, edgePoints) {
    this.clearMarkers()
    console.log('setTerrainData called with', regions.length, 'regions,', Object.keys(edges || {}).length, 'edges,', (fineCells || []).length, 'fine cells,', (edgePoints || []).length, 'edge points')
    this.edgePointsById = new Map((edgePoints || []).map(p => [p.id, p]))
    this.terrainData = { regions, edges: edges || {}, fineCells: fineCells || [] }
    this.renderTerrain(regions, fineCells || [])
    this.drawVoronoiCenters(regions)
    if (edges && Object.keys(edges).length > 0) {
      this.renderEdges(edges)
    }
  }

  renderTerrain(regions, fineCells) {
    this.regionMeshes.forEach(mesh => this.scene.remove(mesh))
    this.regionMeshes.clear()
    this.fineCellMeshes.forEach(mesh => this.scene.remove(mesh))
    this.fineCellMeshes.clear()
    this.regionFineCells.clear()

    if (fineCells && fineCells.length > 0) {
      const regionMap = new Map(regions.map(r => [r.id, r]))
      let count = 0
      for (const cell of fineCells) {
        const parent = regionMap.get(cell.parentRegionId)
        const mesh = this.buildRegionMesh({ ...cell, assignedType: parent?.assignedType ?? null })
        if (mesh) {
          this.scene.add(mesh)
          this.fineCellMeshes.set(cell.id, mesh)
          if (!this.regionFineCells.has(cell.parentRegionId)) {
            this.regionFineCells.set(cell.parentRegionId, [])
          }
          this.regionFineCells.get(cell.parentRegionId).push(cell.id)
          count++
        }
      }
      console.log(`Rendered ${count}/${fineCells.length} fine cells across ${this.regionFineCells.size} merged regions`)
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
    const vertices = [cx, 0.05, cy]
    for (const v of polygon) {
      vertices.push(v.x || 0, 0.05, v.y || 0)
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
      this.terrainPolylines = new PolylineRenderer(this.scene, { thickness: 0.5, stripY: 0.06, priorityColor: TERRAIN_COLORS.River })
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
    this.selectedRegionId = regionId
    this._applyRegionColor(regionId, 0xffffff)
  }

  deselectRegion(regionId) {
    if (this.selectedRegionId === regionId) this.selectedRegionId = null
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

    const cellIds = this.regionFineCells.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.fineCellMeshes.get(cellId)
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
    const cellIds = this.regionFineCells.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.fineCellMeshes.get(cellId)
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
    for (const cell of (terrainData.fineCells || [])) {
      if (!cellsByRegion.has(cell.parentRegionId)) cellsByRegion.set(cell.parentRegionId, [])
      cellsByRegion.get(cell.parentRegionId).push(cell)
    }
    for (const trade of tradingDestinations) {
      let fineCellPath = null, cellMap = null
      if (trade.roadPath?.length >= 2) {
        const result = this._buildFineRoadMesh(trade.roadPath, regionMap, cellsByRegion)
        if (result) {
          if (result.mesh) { this.scene.add(result.mesh); this.roadMeshes.push(result.mesh) }
          fineCellPath = result.fineCellPath
          cellMap = result.cellMap
        }
      }
      for (const bridge of (trade.bridges || [])) {
        if (!fineCellPath || !cellMap) continue
        let crossA = null, crossB = null
        for (let i = 0; i < fineCellPath.length - 1; i++) {
          const ca = cellMap.get(fineCellPath[i])
          const cb = cellMap.get(fineCellPath[i + 1])
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
    let fineCellPath = null

    bfs: while (queue.length > 0) {
      const [curr, currPath] = queue.shift()
      if (cityIds.has(curr)) { fineCellPath = currPath; break bfs }
      for (const next of (adj.get(curr) || [])) {
        if (visited.has(next)) continue
        const nextCell = cellMap.get(next)
        if (!nextCell || !pathSet.has(nextCell.parentRegionId)) continue
        visited.add(next)
        queue.push([next, [...currPath, next]])
      }
    }

    if (!fineCellPath || fineCellPath.length < 2) return null

    // A waypoint is "wet" when its fine cell belongs to a Sea/Lake region — no road
    // is drawn over water (bridges span the crossing instead).
    const isWater = (cell) => {
      const r = cell && regionMap.get(cell.parentRegionId)
      return !!r && (r.assignedType === 'Sea' || r.assignedType === 'Lake')
    }

    const waypoints = []
    const waterFlags = []
    for (let i = 0; i < fineCellPath.length - 1; i++) {
      const cell = cellMap.get(fineCellPath[i])
      if (cell) { waypoints.push({ x: cell.seedPoint.x, y: cell.seedPoint.y }); waterFlags.push(isWater(cell)) }
    }
    const cityCell = cellMap.get(fineCellPath[fineCellPath.length - 1])
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

    return { mesh: this._buildRoadStripMesh(waypoints, waterFlags), fineCellPath, cellMap }
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
        p1.x - px, 0.09, p1.y - py, p1.x + px, 0.09, p1.y + py,
        p2.x + px, 0.09, p2.y + py, p2.x - px, 0.09, p2.y - py
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

  // Remove just the fine-cell trade-road ribbon (the setup-phase preview). In the
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
    const cellIds = this.regionFineCells.get(cityRegion.id) || []
    for (const cellId of cellIds) {
      const mesh = this.fineCellMeshes.get(cellId)
      if (mesh) { this.scene.remove(mesh); this.fineCellMeshes.delete(cellId) }
    }
    this.regionFineCells.delete(cityRegion.id)
    const regionMesh = this.regionMeshes.get(cityRegion.id)
    if (regionMesh) { this.scene.remove(regionMesh); this.regionMeshes.delete(cityRegion.id) }
  }

  // ── Hit testing ─────────────────────────────────────────────────────────────

  getRegionAtWorldPos(worldX, worldY) {
    if (!this.terrainData) return null
    const fineCells = this.terrainData.fineCells
    if (fineCells && fineCells.length > 0) {
      const regionMap = new Map(this.terrainData.regions.map(r => [r.id, r]))
      for (const cell of fineCells) {
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
    const threshold = 1.5
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
    const cellIds = this.regionFineCells.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.fineCellMeshes.get(cellId)
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
    const cellIds = this.regionFineCells.get(regionId) || []
    const cellMap = new Map((this.terrainData?.fineCells || []).map(c => [c.id, c]))
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
