import * as THREE from 'three'
import CameraController from './CameraController.js'

import TerrainColors from './TerrainColors.js'
import TerrainFeatureManager from './TerrainFeatureManager.js'
import BuildingRenderer from './BuildingRenderer.js'
import PolylineRenderer from './PolylineRenderer.js'
import { RENDER_STREETS, RENDER_GUTTERS, RENDER_BLOCKS, RENDER_PLOTS } from './pipelineFlags.js'


export default class WorldRenderer {
  constructor() {
    this.scene = null
    this.camera = null
    this.renderer = null
    this.cameraController = null
    this.regionMeshes = new Map()
    this.fineCellMeshes = new Map()      // fineCellId  → mesh
    this.regionFineCells = new Map()     // parentRegionId → [fineCellId, ...]
    this.terrainPolylines = null          // PolylineRenderer instance for terrain edges
    this.cityPolylines    = null          // PolylineRenderer instance for non-Wall city edges
    this.streetPolylines  = null          // PolylineRenderer instance for streets
    this.edgePointsById = new Map()      // pointId → {id, x, y}
    this.districtMeshes = new Map()
    this.cityEdgeMeshes = new Map()      // Wall-type city edge meshes only
    this.cityEdgePointsById = new Map()
    this.selectedCityEdgeIds = new Set()
    this.threatMeshes = []
    this.tradeMeshes = []
    this.roadMeshes = []
    this.streetMeshes = []
    this.blockMeshes = []
    this.plotMeshes = []
    this.gutterMeshes = []
    this.buildingRenderer = new BuildingRenderer()
    this.featureManager = null
    this.spawnedFeatureRegions = new Map()  // regionId → Set<featureName>
    this.clock = new THREE.Clock()
    this.terrainData = null
    this.cityDistrictData = null
    this.worldSize = 50
    this.isPaused = false
    this.originalMaterials = new Map()
    this._debugPreHoverColors = new Map()
    this.debugObjects = []
    this._terrainDebugMeshes = []
    this._districtDebugMeshes = []
    this._blockDebugMeshes = []
    this._plotDebugMeshes = []
    this._streetSeedMeshes = []
    this.showDebug = false
    this.hoveredRegionId = null
    this.hoveredEdgeId = null
    this.hoveredDistrictId = null
    this.hoveredCityEdgeId = null
    this.hoveredStreetEdgeKey = null
    this._streetHoverMesh = null
    this.selectedRegionId = null
    this.selectedDistrictId = null
    this.wallAnimations = new Map()  // edgeId → { object: Group, frame }
    this.mode = 'terrain'  // 'terrain' | 'city'
  }

  setMode(mode) {
    this.clearHover()
    this.mode = mode
    const inStreets = mode === 'streets'
    this.cityPolylines?.edgeMeshes.forEach(m => { m.visible = !inStreets })
    this.cityPolylines?.junctionMeshes.forEach(m => { m.visible = !inStreets })
    this.cityEdgeMeshes.forEach(m => { m.visible = !inStreets })

    if (mode === 'city' || mode === 'streets') {
      this._deleteCityTerrainCells()
      this._clearDebugGroup(this._terrainDebugMeshes)
    }
    if (mode === 'streets') {
      this._clearDebugGroup(this._districtDebugMeshes)
    }
  }

  _deleteCityTerrainCells() {
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

  clearDistrictMeshes() {
    console.log(`clearDistrictMeshes: removing ${this.districtMeshes.size} meshes`)
    this.districtMeshes.forEach(m => this.scene.remove(m))
    this.districtMeshes.clear()
  }

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
    this.featureManager = new TerrainFeatureManager(this.scene)
    window.addEventListener('resize', () => this.onWindowResize())

    this.animate()
  }

  focusCameraOn(x, z) {
    this.cameraController?.focusOn(x, z)
  }

  setHomePosition(x, z) {
    this.cameraController?.setHomePosition(x, z)
  }

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

  setCityDistrictData(data) {
    if (Array.isArray(data)) {
      this.cityDistrictData = { districts: data, edges: {}, edgePoints: [] }
      this.cityEdgePointsById = new Map()
      this.renderDistricts(data)
      this.renderCityEdges({})
    } else {
      this.cityDistrictData = data
      this.cityEdgePointsById = new Map((data.edgePoints || []).map(p => [p.id, p]))
      this.renderDistricts(data.districts || [])
      this.renderCityEdges(data.edges || {})
    }
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

  clearStreetLayer() {
    this.streetPolylines?.dispose()
    for (const m of this.streetMeshes) this.scene.remove(m)
    this.streetMeshes = []
  }

  renderStreetGraph(streetGraph) {
    this.clearStreetLayer()
    if (!RENDER_STREETS) return
    if (!streetGraph) return
    if (!streetGraph.nodes?.length || !streetGraph.edges?.length) return

    if (!this.streetPolylines) {
      // miterLimitDist matches SNAP_THRESHOLD / 2 in StreetVoronoiGenerator's
      // buildGutterGraph — so the rendered street outline matches the gutter
      // graph the block tracer consumes.
      this.streetPolylines = new PolylineRenderer(this.scene, { thickness: 0.0875, stripY: 0.075, fillY: 0.076, miterLimitDist: 0.125 })
    }

    const pointsById = new Map(streetGraph.nodes.map(n => [n.id, { x: n.x, y: n.y }]))
    const edgesById = {}
    for (const e of streetGraph.edges) {
      edgesById[e.id] = { pointIds: [e.nodeA, e.nodeB], type: e.type || 'Mud' }
    }
    const fallback = TerrainColors.get('Mud') || 0x6b4226
    const getColor = (edge) => TerrainColors.get(edge.type) || fallback
    this.streetPolylines.render(edgesById, pointsById, getColor)
  }

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

  renderTrades(tradingDestinations, terrainData) {
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
        const result = this.buildFineRoadMesh(trade.roadPath, regionMap, cellsByRegion)
        if (result) {
          if (result.mesh) { this.scene.add(result.mesh); this.roadMeshes.push(result.mesh) }
          fineCellPath = result.fineCellPath
          cellMap = result.cellMap
        }
      }
      for (const bridge of (trade.bridges || [])) {
        if (!fineCellPath || !cellMap) continue
        // Find the step in the fine cell path where it crosses from fromRegionId to toRegionId
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

  buildFineRoadMesh(path, regionMap, cellsByRegion) {
    const W = this.worldSize
    const pathSet = new Set(path)
    const cityRegionId = path[path.length - 1]

    // Collect all fine cells in path regions (including city)
    const pathCells = []
    for (const regionId of path) {
      for (const cell of (cellsByRegion.get(regionId) || [])) pathCells.push(cell)
    }
    if (pathCells.length === 0) return null
    const cellMap = new Map(pathCells.map(c => [c.id, c]))

    // Build adjacency between fine cells via shared polygon vertices
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

    // Start: fine cell in edge region closest to world boundary
    const edgeCells = cellsByRegion.get(path[0]) || []
    if (edgeCells.length === 0) return null
    let startCell = edgeCells[0], minBoundDist = Infinity
    for (const cell of edgeCells) {
      const { x, y } = cell.seedPoint
      const d = Math.min(x, W - x, y, W - y)
      if (d < minBoundDist) { minBoundDist = d; startCell = cell }
    }

    // Goal: any city fine cell
    const cityIds = new Set((cellsByRegion.get(cityRegionId) || []).map(c => c.id))

    // BFS through fine cells restricted to path regions
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

    // Build waypoints: all fine cells except the city cell, plus a midpoint to the city cell
    const waypoints = []
    for (let i = 0; i < fineCellPath.length - 1; i++) {
      const cell = cellMap.get(fineCellPath[i])
      if (cell) waypoints.push({ x: cell.seedPoint.x, y: cell.seedPoint.y })
    }
    const cityCell = cellMap.get(fineCellPath[fineCellPath.length - 1])
    if (cityCell && waypoints.length > 0) {
      const last = waypoints[waypoints.length - 1]
      waypoints.push({
        x: (last.x + cityCell.seedPoint.x) / 2,
        y: (last.y + cityCell.seedPoint.y) / 2
      })
    }

    if (waypoints.length < 2) return null

    // Extend first waypoint outward to the world boundary
    const w0 = waypoints[0], w1 = waypoints[1]
    const dx = w0.x - w1.x, dy = w0.y - w1.y
    const candidates = []
    if (Math.abs(dx) > 1e-9) candidates.push(dx > 0 ? (W - w0.x) / dx : (0 - w0.x) / dx)
    if (Math.abs(dy) > 1e-9) candidates.push(dy > 0 ? (W - w0.y) / dy : (0 - w0.y) / dy)
    const t = Math.min(...candidates.filter(b => b > 1e-9))
    if (isFinite(t)) waypoints[0] = { x: w0.x + t * dx, y: w0.y + t * dy }

    return { mesh: this._buildRoadStripMesh(waypoints), fineCellPath, cellMap }
  }

  _buildRoadStripMesh(waypoints) {
    const thickness = 0.15
    const allVerts = [], allIdx = []
    for (let i = 0; i < waypoints.length - 1; i++) {
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

  renderTerrain(regions, fineCells) {
    // Clear all terrain meshes
    this.regionMeshes.forEach(mesh => this.scene.remove(mesh))
    this.regionMeshes.clear()
    this.fineCellMeshes.forEach(mesh => this.scene.remove(mesh))
    this.fineCellMeshes.clear()
    this.regionFineCells.clear()

    if (fineCells && fineCells.length > 0) {
      // Render each fine cell individually; colour from its parent merged region
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
      // Spawn props for regions already assigned (e.g. loaded from save)
      for (const region of regions) {
        if (region.assignedType === 'Forest')    this._spawnFeatureForRegion('forest', region.id)
        if (region.assignedType === 'Mountains') this._spawnFeatureForRegion('mountains', region.id)
        if (region.assignedType === 'Hills')     this._spawnFeatureForRegion('hills', region.id)
        if (region.assignedType === 'Sea')       this._spawnFeatureForRegion('sea', region.id)
        if (region.assignedType === 'Lake')      this._spawnFeatureForRegion('lake', region.id)
        if (region.terrainDistrict === 'Agriculture') this._spawnFieldsForRegion(region.id)
      }
    } else {
      // Fallback: render merged region polygons (for saves without fine cells)
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

    const polygon = this.clipPolygonToBox(
      region.polygon, 0, this.worldSize, 0, this.worldSize
    )
    if (polygon.length < 3) return null

    // Fan-triangulate from centroid of the clipped polygon. Using seedPoint risks placing
    // the apex outside the clipped polygon for boundary cells (seed near x=0 or y=0 edge),
    // creating degenerate triangles. Centroid of a convex polygon is always interior.
    const cx = polygon.reduce((s, v) => s + v.x, 0) / polygon.length
    const cy = polygon.reduce((s, v) => s + v.y, 0) / polygon.length
    const seed = { x: cx, y: cy }
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

    const color = TerrainColors.get(region.assignedType) || TerrainColors.unassigned
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

  get edgeMeshes()     { return this.terrainPolylines?.edgeMeshes     ?? new Map() }
  get junctionMeshes() { return this.terrainPolylines?.junctionMeshes ?? new Map() }

  renderEdges(edges) {
    if (!this.terrainPolylines) {
      this.terrainPolylines = new PolylineRenderer(this.scene, { thickness: 0.5, stripY: 0.06 })
    }
    console.log(`Rendering ${Object.keys(edges).length} edges`)
    this.terrainPolylines.render(
      edges,
      this.edgePointsById,
      (edge) => edge.assignedType ? TerrainColors.get(edge.assignedType) : TerrainColors.unassigned
    )
    console.log(`Successfully created ${this.edgeMeshes.size} edge meshes`)
  }

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
    return TerrainColors.get(region?.assignedType) || TerrainColors.unassigned
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

    // Deterministic shuffle seeded by regionId — pick 1 or 2 cells
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

  spawnTerrainDistrictFeature(regionId, districtType) {
    if (districtType === 'Agriculture') this._spawnFieldsForRegion(regionId)
  }

  updateRegionColor(regionId, terrainType) {
    this._applyRegionColor(regionId, TerrainColors.get(terrainType) || TerrainColors.unassigned)
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
    const color = terrainType ? TerrainColors.get(terrainType) : 0xffffff
    this._applyRegionColor(regionId, color)
  }

  selectEdge(edgeId) {
    this.terrainPolylines?.setEdgeColor(edgeId, 0xffffff)
  }

  deselectEdge(edgeId) {
    this.terrainPolylines?.resetEdgeColor(edgeId)
  }

  previewEdgeType(edgeId, edgeType) {
    const color = edgeType ? TerrainColors.get(edgeType) : 0xffffff
    this.terrainPolylines?.setEdgeColor(edgeId, color)
  }

  updateEdgeColor(edgeId, terrainType) {
    const color = TerrainColors.get(terrainType) || TerrainColors.unassigned
    this.terrainPolylines?.updateBaseColor(edgeId, color)
  }

  updateDistrictColor(districtId, districtType) {
    const district = this.cityDistrictData?.districts?.find(d => d.id === districtId)
    const colorType = districtType === 'Residential' && district?.residentialClass
      ? district.residentialClass
      : districtType === 'Leadership' && district?.LeadershipClass
        ? district.LeadershipClass
        : districtType
    const color = TerrainColors.get(colorType) || TerrainColors.Neutral
    const mesh = this.districtMeshes.get(districtId)
    if (mesh) {
      mesh.material.color.setHex(color)
      mesh.material.emissive?.setHex(color)
      mesh.material.emissiveIntensity = 0.1
    }
  }

  selectDistrict(districtId) {
    this.selectedDistrictId = districtId
    const mesh = this.districtMeshes.get(districtId)
    if (mesh) { mesh.material.color.setHex(0xffffff); mesh.material.emissive?.setHex(0xffffff); mesh.material.emissiveIntensity = 0.3 }
  }

  deselectDistrict(districtId) {
    if (this.selectedDistrictId === districtId) this.selectedDistrictId = null
    const district = this.cityDistrictData?.districts?.find(d => d.id === districtId)
    const colorType = district?.assignedType === 'Residential' && district?.residentialClass
      ? district.residentialClass
      : district?.assignedType === 'Leadership' && district?.LeadershipClass
        ? district.LeadershipClass
        : district?.assignedType || (district?.isLeadershipDistrict ? 'Leadership' : null)
    const color = colorType ? TerrainColors.get(colorType) : TerrainColors.Neutral
    const mesh = this.districtMeshes.get(districtId)
    if (mesh) { mesh.material.color.setHex(color); mesh.material.emissive?.setHex(color); mesh.material.emissiveIntensity = 0.1 }
  }

  previewDistrictType(districtId, type) {
    const color = type ? TerrainColors.get(type) : TerrainColors.Neutral
    const mesh = this.districtMeshes.get(districtId)
    if (mesh) { mesh.material.color.setHex(color); mesh.material.emissive?.setHex(color) }
  }

  selectCityEdge(edgeId) {
    this.selectedCityEdgeIds.add(edgeId)
    this._applyCityEdgeColor(edgeId, 0xffffff)
  }
  deselectCityEdge(edgeId) {
    this.selectedCityEdgeIds.delete(edgeId)
    if (this.cityEdgeMeshes.has(edgeId)) {
      const color = this._cityEdgeBaseColor(edgeId)
      const mesh = this.cityEdgeMeshes.get(edgeId)
      if (mesh?.material) { mesh.material.color.setHex(color); mesh.material.emissive?.setHex(color) }
    } else {
      this.cityPolylines?.resetEdgeColor(edgeId)
    }
  }
  previewCityEdgeType(edgeId, type) {
    this._applyCityEdgeColor(edgeId, type ? TerrainColors.get(type) : 0xffffff)
  }
  updateCityEdgeColor(edgeId, type) {
    if (type === 'Wall') {
      const edge = this.cityDistrictData?.edges?.[edgeId]
      if (!edge) return
      const polyMesh = this.cityPolylines?.getEdgeMesh(edgeId)
      if (polyMesh) polyMesh.visible = false
      const old = this.cityEdgeMeshes.get(edgeId)
      if (old) this.scene.remove(old)
      const group = this.buildWallMesh(edge, edgeId)
      if (group) {
        group.scale.y = 0
        this.scene.add(group)
        this.cityEdgeMeshes.set(edgeId, group)
        this.wallAnimations.set(edgeId, { object: group, frame: 0 })
      }
      return
    }
    this.cityPolylines?.updateBaseColor(edgeId, TerrainColors.get(type) || TerrainColors.unassigned)
  }
  _applyCityEdgeColor(edgeId, color) {
    const wallMesh = this.cityEdgeMeshes.get(edgeId)
    if (wallMesh?.material) { wallMesh.material.color.setHex(color); wallMesh.material.emissive?.setHex(color) }
    else this.cityPolylines?.setEdgeColor(edgeId, color)
  }
  _cityEdgeBaseColor(edgeId) {
    const edge = this.cityDistrictData?.edges?.[edgeId]
    return edge?.assignedType ? TerrainColors.get(edge.assignedType) : TerrainColors.unassigned
  }

  renderDistricts(districts) {
    this.districtMeshes.forEach(mesh => this.scene.remove(mesh))
    this.districtMeshes.clear()

    console.log(`renderDistricts: ${districts.length} districts, mode=${this.mode}`, new Error().stack.split('\n')[2]?.trim())
    for (const district of districts) {
      const mesh = this.buildDistrictMesh(district)
      if (mesh) {
        this.scene.add(mesh)
        this.districtMeshes.set(district.id, mesh)
      }
    }
  }

  buildDistrictMesh(district) {
    const rawPoly = district.polygon || district.boundary
    if (!rawPoly || rawPoly.length < 3) return null

    const polygon = [...rawPoly]
    const vertices = polygon.map(v => [v.x, 0.07, v.y]).flat()

    const triangles = []
    for (let i = 1; i < polygon.length - 1; i++) {
      triangles.push(0, i, i + 1)
    }
    if (triangles.length === 0) return null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(triangles), 1))
    geometry.computeVertexNormals()

    const colorKey = district.assignedType || (district.isLeadershipDistrict ? 'Leadership' : null)
    const color = colorKey ? TerrainColors.get(colorKey) : TerrainColors.Neutral
    const material = new THREE.MeshStandardMaterial({
      color, roughness: 0.5, metalness: 0,
      emissive: color, emissiveIntensity: 0.1,
      side: THREE.DoubleSide
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData = { districtId: district.id }
    return mesh
  }

  renderCityEdges(edges) {
    this.cityPolylines?.dispose()
    this.cityPolylines = null
    this.cityEdgeMeshes.forEach(mesh => this.scene.remove(mesh))
    this.cityEdgeMeshes.clear()
    this.wallAnimations.clear()
    this.selectedCityEdgeIds.clear()

    const nonWallEdges = {}
    for (const [edgeId, edge] of Object.entries(edges)) {
      if (edge.assignedType === 'Mud') continue
      if (edge.assignedType === 'Wall') {
        const mesh = this.buildWallMesh(edge, edgeId)
        if (mesh) { this.scene.add(mesh); this.cityEdgeMeshes.set(edgeId, mesh) }
      } else {
        nonWallEdges[edgeId] = edge
      }
    }

    this.cityPolylines = new PolylineRenderer(this.scene, { thickness: 0.0875, stripY: 0.075, fillY: 0.08 })
    this.cityPolylines.render(nonWallEdges, this.cityEdgePointsById,
      (edge) => edge.assignedType ? TerrainColors.get(edge.assignedType) : TerrainColors.unassigned
    )
  }

  buildWallMesh(edge, edgeId) {
    const ids = edge.pointIds
    if (!ids || ids.length < 2) return null

    const thickness = 0.0875
    const wallHeight = thickness * 3
    const allVerts = [], allIdx = []

    for (let i = 0; i < ids.length - 1; i++) {
      const p1 = this.cityEdgePointsById.get(ids[i])
      const p2 = this.cityEdgePointsById.get(ids[i + 1])
      if (!p1 || !p2) continue
      const dx = p2.x - p1.x, dy = p2.y - p1.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len === 0) continue
      const px = (-dy / len) * (thickness / 2), py = (dx / len) * (thickness / 2)
      const b = allVerts.length / 3

      // Bottom quad (local y=0), top quad (local y=wallHeight)
      allVerts.push(
        p1.x - px, 0,          p1.y - py,   // b+0 bottom -perp p1
        p1.x + px, 0,          p1.y + py,   // b+1 bottom +perp p1
        p2.x + px, 0,          p2.y + py,   // b+2 bottom +perp p2
        p2.x - px, 0,          p2.y - py,   // b+3 bottom -perp p2
        p1.x - px, wallHeight, p1.y - py,   // b+4 top -perp p1
        p1.x + px, wallHeight, p1.y + py,   // b+5 top +perp p1
        p2.x + px, wallHeight, p2.y + py,   // b+6 top +perp p2
        p2.x - px, wallHeight, p2.y - py    // b+7 top -perp p2
      )

      // Top face
      allIdx.push(b+4, b+5, b+6,  b+4, b+6, b+7)
      // +perp side face
      allIdx.push(b+1, b+2, b+6,  b+1, b+6, b+5)
      // -perp side face
      allIdx.push(b+3, b+0, b+4,  b+3, b+4, b+7)
      // Start cap
      allIdx.push(b+0, b+1, b+5,  b+0, b+5, b+4)
      // End cap
      allIdx.push(b+2, b+3, b+7,  b+2, b+7, b+6)
    }
    if (allVerts.length === 0) return null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVerts), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(allIdx), 1))
    geometry.computeVertexNormals()

    const color = TerrainColors.get('Wall')
    const material = new THREE.MeshStandardMaterial({
      color, roughness: 0.7, metalness: 0,
      emissive: color, emissiveIntensity: 0.15,
      side: THREE.DoubleSide
    })
    const innerMesh = new THREE.Mesh(geometry, material)
    const group = new THREE.Group()
    group.position.y = 0.075
    group.add(innerMesh)
    group.userData = { cityEdgeId: edgeId }
    return group
  }

  _updateWallAnimations() {
    for (const [edgeId, anim] of this.wallAnimations) {
      anim.frame++
      let sy
      if (anim.frame <= 10) {
        sy = (anim.frame / 10) * 1.2
      } else if (anim.frame <= 12) {
        sy = 1.2 - ((anim.frame - 10) / 2) * 0.2
      } else {
        anim.object.scale.y = 1.0
        this.wallAnimations.delete(edgeId)
        continue
      }
      anim.object.scale.y = sy
    }
  }

  getRegionAtWorldPos(worldX, worldY) {
    if (!this.terrainData) return null

    // Fine cells give accurate hit detection (each is star-shaped from its seed).
    // The merged region convex hull is only an approximation and can mis-assign clicks.
    const fineCells = this.terrainData.fineCells
    if (fineCells && fineCells.length > 0) {
      const regionMap = new Map(this.terrainData.regions.map(r => [r.id, r]))
      for (const cell of fineCells) {
        if (cell.polygon && this.pointInPolygon(worldX, worldY, cell.polygon)) {
          return regionMap.get(cell.parentRegionId) || null
        }
      }
      return null
    }

    // Fallback: merged region polygons (old saves without fine cells)
    for (const region of this.terrainData.regions) {
      if (this.pointInPolygon(worldX, worldY, region.polygon)) {
        return region
      }
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
        const distance = this.distanceToLineSegment(worldX, worldY, p1.x, p1.y, p2.x, p2.y)
        if (distance < closestDistance) {
          closestDistance = distance
          closestEdge = { ...edge, id: edgeId }
        }
      }
    }

    return closestEdge
  }

  distanceToLineSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1
    const dy = y2 - y1
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    const closestX = x1 + t * dx
    const closestY = y1 + t * dy
    const distX = px - closestX
    const distY = py - closestY
    return Math.sqrt(distX * distX + distY * distY)
  }

  getDistrictAtWorldPos(worldX, worldY) {
    if (!this.cityDistrictData?.districts) return null
    for (const district of this.cityDistrictData.districts) {
      const poly = district.polygon || district.boundary
      if (poly && this.pointInPolygon(worldX, worldY, poly)) return district
    }
    return null
  }

  getCityEdgeAtWorldPos(worldX, worldY) {
    if (!this.cityDistrictData?.edges) return null
    const threshold = 0.25
    let closestEdge = null, closestDist = threshold
    for (const edgeId in this.cityDistrictData.edges) {
      const edge = this.cityDistrictData.edges[edgeId]
      const ids = edge.pointIds
      if (!ids || ids.length < 2) continue
      for (let i = 0; i < ids.length - 1; i++) {
        const p1 = this.cityEdgePointsById.get(ids[i])
        const p2 = this.cityEdgePointsById.get(ids[i + 1])
        if (!p1 || !p2) continue
        const d = this.distanceToLineSegment(worldX, worldY, p1.x, p1.y, p2.x, p2.y)
        if (d < closestDist) { closestDist = d; closestEdge = { ...edge, id: edgeId } }
      }
    }
    return closestEdge
  }

  getCornerAtWorldPos(worldX, worldY, threshold = 0.5) {
    if (!this.terrainData || !this.terrainData.regions) return null

    // Find all unique vertices and which (region, vertex-index) pairs reference them
    const cornerMap = new Map() // key: "x,y" -> { point, regionIds[], vertexIndices[] }

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
      const dist = Math.sqrt(
        Math.pow(worldX - data.point.x, 2) + Math.pow(worldY - data.point.y, 2)
      )
      if (dist < threshold && data.regionIds.length >= 2) {
        return data
      }
    }

    return null
  }

  getCenterAtWorldPos(worldX, worldY, threshold = 0.5) {
    if (!this.terrainData || !this.terrainData.regions) return null

    for (let i = 0; i < this.terrainData.regions.length; i++) {
      const region = this.terrainData.regions[i]
      const dist = Math.sqrt(
        Math.pow(worldX - region.seedPoint.x, 2) + Math.pow(worldY - region.seedPoint.y, 2)
      )
      if (dist < threshold) {
        return {
          regionId: region.id,
          position: region.seedPoint
        }
      }
    }

    return null
  }

  clipPolygonToBox(polygon, minX, maxX, minY, maxY) {
    const clip = (pts, inside, intersect) => {
      if (pts.length === 0) return []
      const out = []
      for (let i = 0; i < pts.length; i++) {
        const cur = pts[i], nxt = pts[(i + 1) % pts.length]
        const ci = inside(cur), ni = inside(nxt)
        if (ci) out.push(cur)
        if (ci !== ni) out.push(intersect(cur, nxt))
      }
      return out
    }
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    let poly = [...polygon]
    poly = clip(poly, p => p.x >= minX, (a, b) => lerp(a, b, (minX - a.x) / (b.x - a.x)))
    poly = clip(poly, p => p.x <= maxX, (a, b) => lerp(a, b, (maxX - a.x) / (b.x - a.x)))
    poly = clip(poly, p => p.y >= minY, (a, b) => lerp(a, b, (minY - a.y) / (b.y - a.y)))
    poly = clip(poly, p => p.y <= maxY, (a, b) => lerp(a, b, (maxY - a.y) / (b.y - a.y)))
    return poly
  }

  pointInPolygon(x, y, polygon) {
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y
      const xj = polygon[j].x, yj = polygon[j].y

      const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi) / (yj - yi) + xi))
      if (intersect) inside = !inside
    }
    return inside
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

  animate() {
    requestAnimationFrame(() => this.animate())

    const delta = this.clock.getDelta()

    if (!this.isPaused) {
      this.cameraController.update()
      this.featureManager?.update(delta, this.camera)
      this._updateWallAnimations()
      try {
        this.renderer.render(this.scene, this.camera)
      } catch (e) {
        console.error('Render error:', e)
        console.log('Scene children:', this.scene.children.length)
        this.scene.children.forEach((child, i) => {
          if (child.geometry) {
            console.log(`Child ${i}:`, child.constructor.name, 'geometry:', child.geometry.attributes)
          }
        })
        throw e
      }
    }
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
    if (this.hoveredDistrictId !== null) {
      if (this.hoveredDistrictId !== this.selectedDistrictId) {
        const hd = this.cityDistrictData?.districts?.find(d => d.id === this.hoveredDistrictId)
        const colorKey = hd?.assignedType || (hd?.isLeadershipDistrict ? 'Leadership' : null)
        const baseColor = colorKey ? TerrainColors.get(colorKey) : TerrainColors.Neutral
        const mesh = this.districtMeshes.get(this.hoveredDistrictId)
        if (mesh) {
          mesh.material.color.setHex(baseColor)
          mesh.material.emissive?.setHex(baseColor)
          mesh.material.emissiveIntensity = 0.1
        }
      }
      this.hoveredDistrictId = null
    }
    if (this.hoveredCityEdgeId !== null) {
      const isSelected = this.selectedCityEdgeIds.has(this.hoveredCityEdgeId)
      if (this.cityEdgeMeshes.has(this.hoveredCityEdgeId)) {
        const mesh = this.cityEdgeMeshes.get(this.hoveredCityEdgeId)
        if (mesh?.material) {
          const baseColor = isSelected ? 0xffffff : this._cityEdgeBaseColor(this.hoveredCityEdgeId)
          mesh.material.color.setHex(baseColor)
          mesh.material.emissive?.setHex(baseColor)
          mesh.material.emissiveIntensity = isSelected ? 0.5 : 0.3
        }
      } else if (isSelected) {
        this.cityPolylines?.setEdgeColor(this.hoveredCityEdgeId, 0xffffff)
      } else {
        this.cityPolylines?.resetEdgeColor(this.hoveredCityEdgeId)
      }
      this.hoveredCityEdgeId = null
    }
    if (this.hoveredStreetEdgeKey !== null) {
      if (this._streetHoverMesh) {
        this.scene.remove(this._streetHoverMesh)
        this._streetHoverMesh.geometry?.dispose?.()
        this._streetHoverMesh.material?.dispose?.()
        this._streetHoverMesh = null
      }
      this.hoveredStreetEdgeKey = null
    }
  }

  setStreetEdgeHover(edge) {
    if (!edge) return
    const key = edge.id ?? `${edge.nodeA}_${edge.nodeB}`
    if (this.hoveredStreetEdgeKey === key) return
    this.clearHover()
    const sg = this.cityDistrictData?.streetGraph
    if (!sg?.nodes?.length) return
    const byId = new Map(sg.nodes.map(n => [n.id, n]))
    const a = byId.get(edge.nodeA), b = byId.get(edge.nodeB)
    if (!a || !b) return
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len === 0) return
    const thickness = 0.0875 * 1.2
    const r = thickness / 2
    const px = (-dy / len) * r, py = (dx / len) * r
    const Y = 0.078
    const verts = new Float32Array([
      a.x - px, Y, a.y - py,
      a.x + px, Y, a.y + py,
      b.x + px, Y, b.y + py,
      b.x - px, Y, b.y - py,
    ])
    const idx = new Uint16Array([0, 1, 2, 0, 2, 3])
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geom.setIndex(new THREE.BufferAttribute(idx, 1))
    geom.computeVertexNormals()
    const mat = new THREE.MeshBasicMaterial({ color: 0xffff66, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geom, mat)
    this.scene.add(mesh)
    this._streetHoverMesh = mesh
    this.hoveredStreetEdgeKey = key
  }

  highlightFaction(faction) {
    this.clearHover()
    if (faction.districtId !== undefined) {
      this.hoveredDistrictId = faction.districtId
      const mesh = this.districtMeshes.get(faction.districtId)
      if (mesh) { mesh.material.color.setHex(0xffffff); mesh.material.emissive?.setHex(0xffffff); mesh.material.emissiveIntensity = 0.35 }
    } else if (faction.regionId !== undefined) {
      this.hoveredRegionId = faction.regionId
      const baseColor = this._regionBaseColor(faction.regionId)
      const lightened = new THREE.Color(baseColor).lerp(new THREE.Color(0xffffff), 0.35).getHex()
      const cellIds = this.regionFineCells.get(faction.regionId) || []
      for (const cellId of cellIds) {
        const mesh = this.fineCellMeshes.get(cellId)
        if (mesh?.material) { mesh.material.color.setHex(lightened); mesh.material.emissive?.setHex(lightened); mesh.material.emissiveIntensity = 0.45 }
      }
      if (cellIds.length === 0) {
        const rm = this.regionMeshes.get(faction.regionId)
        if (rm?.material) { rm.material.color.setHex(lightened); rm.material.emissive?.setHex(lightened); rm.material.emissiveIntensity = 0.45 }
      }
    }
  }

  setRegionHover(regionId) {
    if (this.hoveredRegionId === regionId && this.hoveredEdgeId === null) return
    this.clearHover()

    const region = this.terrainData?.regions?.find(r => r.id === regionId)
    if (this.mode === 'terrain' && region?.assignedType) return
    if (this.mode === 'city') {
      const DISTRICT_ELIGIBLE = new Set(['Forest', 'Hills', 'Plains', 'Lake', 'Sea'])
      const canDistrict = DISTRICT_ELIGIBLE.has(region?.assignedType) && !region?.terrainDistrict
      const canThreatTrade = !!region?.isEdge
      if (!canDistrict && !canThreatTrade) return
    }

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
    if (this.mode !== 'terrain') return
    if (this.hoveredEdgeId === edgeId && this.hoveredRegionId === null) return
    this.clearHover()
    if (this.terrainData?.edges?.[edgeId]?.assignedType) return
    this.hoveredEdgeId = edgeId
    const mesh = this.edgeMeshes.get(edgeId)
    if (mesh?.material?.emissiveIntensity !== undefined) mesh.material.emissiveIntensity = 0.9
  }

  setDistrictHover(districtId) {
    if (this.hoveredDistrictId === districtId) return
    this.clearHover()
    const district = this.cityDistrictData?.districts?.find(d => d.id === districtId)
    if (district?.assignedType) return
    if (districtId === this.selectedDistrictId) return
    this.hoveredDistrictId = districtId
    const mesh = this.districtMeshes.get(districtId)
    if (mesh) {
      mesh.material.color.setHex(0xd8d8d8)
      mesh.material.emissive?.setHex(0xd8d8d8)
      mesh.material.emissiveIntensity = 0.2
    }
  }

  setCityEdgeHover(edgeId) {
    if (this.hoveredCityEdgeId === edgeId) return
    this.clearHover()
    if (this.cityDistrictData?.edges?.[edgeId]?.assignedType) return
    this.hoveredCityEdgeId = edgeId
    if (this.cityEdgeMeshes.has(edgeId)) {
      const mesh = this.cityEdgeMeshes.get(edgeId)
      if (mesh?.material) {
        mesh.material.color.setHex(0xdddddd)
        mesh.material.emissive?.setHex(0xdddddd)
        mesh.material.emissiveIntensity = 0.9
      }
    } else {
      this.cityPolylines?.setEdgeColor(edgeId, 0xdddddd)
    }
  }

  clearBlockLayer() {
    for (const m of this.blockMeshes) this.scene.remove(m)
    this.blockMeshes = []
  }

  clearPlotLayer() {
    for (const m of this.plotMeshes) this.scene.remove(m)
    this.plotMeshes = []
  }

  clearGutterLayer() {
    for (const m of this.gutterMeshes) this.scene.remove(m)
    this.gutterMeshes = []
  }

  clearDerivedLayers() {
    this.clearGutterLayer()
    this.clearBlockLayer()
    this.clearPlotLayer()
  }

  _makeFill(poly, colorHex, Y) {
    if (!poly || poly.length < 3) return null
    const verts = []
    for (const v of poly) verts.push(v.x, Y, v.y)
    const indices = []
    for (let i = 1; i < poly.length - 1; i++) indices.push(0, i, i + 1)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1))
    geometry.computeVertexNormals()
    const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.5, metalness: 0, emissive: colorHex, emissiveIntensity: 0.15, side: THREE.DoubleSide })
    return new THREE.Mesh(geometry, mat)
  }

  renderGutters(streetGraph) {
    this.clearGutterLayer()
    if (!RENDER_GUTTERS) return
    const nodes = streetGraph?.nodes || []
    const edges = streetGraph?.edges || []
    if (!nodes.length || !edges.length) return

    // Build the gutter geometry directly from the street centerlines, using
    // the same miter math as PolylineRenderer (so the gutters exactly hug the
    // visible street strips):
    //   1. At every junction (degree ≥ 2) compute one miter point per slot
    //      (consecutive edge pair in CCW order). Clamp the miter to
    //      miterLimitDist along its direction to avoid spikes.
    //   2. At every dead-end (degree 1) place two perpendicular corners on
    //      either side of the street, exactly at the dead-end node.
    //   3. For each street edge, draw two line segments — one per side —
    //      from its start-node corner to its end-node corner.
    //   4. For each dead-end, draw a cap line connecting its two corners.

    const r = 0.0875 / 2          // STREET_HALF_WIDTH (mirrors streetPolylines)
    const miterLimit = 0.125      // mirrors streetPolylines.miterLimitDist
    const limitSq = miterLimit * miterLimit
    const Y = 0.077

    const nodeById = new Map(nodes.map(n => [n.id, n]))
    const adj = new Map()
    for (const n of nodes) adj.set(n.id, [])
    for (const e of edges) {
      adj.get(e.nodeA)?.push({ edgeId: e.id, otherId: e.nodeB })
      adj.get(e.nodeB)?.push({ edgeId: e.id, otherId: e.nodeA })
    }

    const corners = new Map()      // `${edgeId}_${nodeId}` → { left, right }
    const deadEndEdgeByNode = new Map()  // nodeId → edgeId (degree-1 only)

    for (const [nodeId, neighbors] of adj) {
      const jPt = nodeById.get(nodeId)
      if (!jPt || !neighbors.length) continue

      if (neighbors.length === 1) {
        const { edgeId, otherId } = neighbors[0]
        const other = nodeById.get(otherId)
        if (!other) continue
        const dx = other.x - jPt.x, dy = other.y - jPt.y
        const len = Math.hypot(dx, dy)
        if (len < 1e-10) continue
        const ux = dx / len, uy = dy / len
        corners.set(`${edgeId}_${nodeId}`, {
          left:  { x: jPt.x - uy * r, y: jPt.y + ux * r },
          right: { x: jPt.x + uy * r, y: jPt.y - ux * r },
        })
        deadEndEdgeByNode.set(nodeId, edgeId)
        continue
      }

      const edgeData = []
      for (const { edgeId, otherId } of neighbors) {
        const other = nodeById.get(otherId)
        if (!other) continue
        const dx = other.x - jPt.x, dy = other.y - jPt.y
        const len = Math.hypot(dx, dy)
        if (len < 1e-10) continue
        edgeData.push({ edgeId, ux: dx / len, uy: dy / len })
      }
      if (edgeData.length < 2) continue
      edgeData.sort((a, b) => Math.atan2(a.uy, a.ux) - Math.atan2(b.uy, b.ux))
      const n = edgeData.length

      const slotMiters = new Array(n)
      for (let i = 0; i < n; i++) {
        const A = edgeData[i], B = edgeData[(i + 1) % n]
        const q1x = jPt.x - A.uy * r, q1y = jPt.y + A.ux * r
        const q2x = jPt.x + B.uy * r, q2y = jPt.y - B.ux * r
        const denom = A.ux * B.uy - A.uy * B.ux
        let px, py
        if (Math.abs(denom) < 1e-8) {
          px = (q1x + q2x) / 2; py = (q1y + q2y) / 2
        } else {
          const t = ((q2x - q1x) * B.uy - (q2y - q1y) * B.ux) / denom
          px = q1x + t * A.ux; py = q1y + t * A.uy
          const mdx = px - jPt.x, mdy = py - jPt.y
          const distSq = mdx * mdx + mdy * mdy
          if (distSq > limitSq) {
            const scale = miterLimit / Math.sqrt(distSq)
            px = jPt.x + mdx * scale
            py = jPt.y + mdy * scale
          }
        }
        slotMiters[i] = { x: px, y: py }
      }
      for (let i = 0; i < n; i++) {
        corners.set(`${edgeData[i].edgeId}_${nodeId}`, {
          left:  slotMiters[i],
          right: slotMiters[(i - 1 + n) % n],
        })
      }
    }

    const verts = []
    for (const e of edges) {
      const cA = corners.get(`${e.id}_${e.nodeA}`)
      const cB = corners.get(`${e.id}_${e.nodeB}`)
      if (!cA || !cB) continue
      // At nodeB, the edge's outward direction is reversed, so the override's
      // "left" maps to the strip's right and vice versa.
      verts.push(cA.left.x,  Y, cA.left.y,  cB.right.x, Y, cB.right.y)
      verts.push(cA.right.x, Y, cA.right.y, cB.left.x,  Y, cB.left.y)
    }
    for (const [nodeId, edgeId] of deadEndEdgeByNode) {
      const c = corners.get(`${edgeId}_${nodeId}`)
      if (!c) continue
      verts.push(c.left.x, Y, c.left.y, c.right.x, Y, c.right.y)
    }

    if (verts.length === 0) return
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0x00ffff }))
    this.scene.add(lines)
    this.gutterMeshes.push(lines)
  }

  renderBlocks(blocks) {
    this.clearBlockLayer()
    if (!RENDER_BLOCKS) return
    if (!blocks?.length) return

    const blockLineVerts = []
    for (const block of blocks) {
      const poly = block.vertices
      if (!poly?.length) continue
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length]
        blockLineVerts.push(a.x, 0.08, a.y, b.x, 0.08, b.y)
      }
    }
    if (blockLineVerts.length === 0) return
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(blockLineVerts), 3))
    const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xff8800 }))
    this.scene.add(lines)
    this.blockMeshes.push(lines)
  }

  renderPlots(plots, districtData) {
    this.clearPlotLayer()
    if (!RENDER_PLOTS) return
    if (!plots?.length) return

    const districtById = new Map((districtData?.districts || []).map(d => [d.id, d]))
    const getColor = (districtId) => {
      const d = districtById.get(districtId)
      if (!d?.assignedType) return TerrainColors.Neutral
      const key = d.assignedType === 'Residential' && d.residentialClass ? d.residentialClass
        : d.assignedType === 'Leadership' && d.LeadershipClass ? d.LeadershipClass
        : d.assignedType
      return TerrainColors.get(key) || TerrainColors.Neutral
    }

    for (const plot of plots) {
      const mesh = this._makeFill(plot.vertices, getColor(plot.districtId), 0.072)
      if (mesh) {
        if (this.showDebug) {
          this.originalMaterials.set(mesh, mesh.material)
          mesh.material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.7, 0.6) })
        }
        this.scene.add(mesh)
        this.plotMeshes.push(mesh)
      }
    }

    const lineVerts = []
    for (const plot of plots) {
      const poly = plot.vertices
      if (!poly?.length) continue
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length]
        lineVerts.push(a.x, 0.073, a.y, b.x, 0.073, b.y)
      }
    }
    if (lineVerts.length > 0) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lineVerts), 3))
      const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0x00cc44 }))
      this.scene.add(lines)
      this.plotMeshes.push(lines)
    }
  }

  toggleDebugVisualization() {
    this.clearHover()
    this.showDebug = !this.showDebug
    this.debugObjects.forEach(obj => { obj.visible = this.showDebug })

    if (this.showDebug) {
      this.scene.children.forEach((child) => {
        if (child.isMesh && child.material && !this.debugObjects.includes(child) && child.visible) {
          this.originalMaterials.set(child, child.material)
          const hue = Math.random()
          const color = new THREE.Color().setHSL(hue, 0.7, 0.6)
          child.material = new THREE.MeshBasicMaterial({ color })
        }
      })
    } else {
      this.scene.children.forEach((child) => {
        if (this.originalMaterials.has(child)) {
          child.material = this.originalMaterials.get(child)
        }
      })
      this.originalMaterials.clear()
    }

    console.log(`Debug mode ${this.showDebug ? 'ON' : 'OFF'}`)
  }

  drawVoronoiCenters(regions) {
    this._clearDebugGroup(this._terrainDebugMeshes)

    const seedGeo = new THREE.SphereGeometry(0.075, 8, 8)
    const seedMat = new THREE.MeshBasicMaterial({ color: 0xff0000 })
    regions.forEach(region => {
      const seed = new THREE.Mesh(seedGeo, seedMat)
      seed.position.set(region.seedPoint.x, 0.1, region.seedPoint.y)
      seed.visible = this.showDebug
      this.scene.add(seed)
      this.debugObjects.push(seed)
      this._terrainDebugMeshes.push(seed)
    })

    const vertGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05)
    const vertMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 })
    regions.forEach(region => {
      region.polygon.forEach(vertex => {
        const vert = new THREE.Mesh(vertGeo, vertMat)
        vert.position.set(vertex.x, 0.1, vertex.y)
        vert.visible = this.showDebug
        this.scene.add(vert)
        this.debugObjects.push(vert)
        this._terrainDebugMeshes.push(vert)
      })
    })
  }

  drawDistrictCenters(districts) {
    this._clearDebugGroup(this._districtDebugMeshes)
    const geo = new THREE.SphereGeometry(0.075, 8, 8)
    const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 })
    for (const d of (districts || [])) {
      const sp = d.seedPoint || this._centroid(d.polygon || d.boundary || [])
      if (!sp) continue
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(sp.x, 0.15, sp.y)
      mesh.visible = this.showDebug
      this.scene.add(mesh)
      this.debugObjects.push(mesh)
      this._districtDebugMeshes.push(mesh)
    }
  }

  drawBlockAndPlotCenters(blocks, plots) {
    this._clearDebugGroup(this._blockDebugMeshes)
    this._clearDebugGroup(this._plotDebugMeshes)

    const blockGeo = new THREE.SphereGeometry(0.0375, 6, 6)
    const blockMat = new THREE.MeshBasicMaterial({ color: 0xff0000 })
    for (const b of (blocks || [])) {
      const c = this._centroid(b.vertices)
      if (!c) continue
      const mesh = new THREE.Mesh(blockGeo, blockMat)
      mesh.position.set(c.x, 0.09, c.y)
      mesh.userData = { kind: 'block', id: b.id, blockType: b.blockType, districtId: b.districtId }
      mesh.visible = this.showDebug
      this.scene.add(mesh)
      this.debugObjects.push(mesh)
      this._blockDebugMeshes.push(mesh)
    }

    const plotGeo = new THREE.SphereGeometry(0.0375, 6, 6)
    const plotMat = new THREE.MeshBasicMaterial({ color: 0xff69b4 })
    for (const p of (plots || [])) {
      const c = this._centroid(p.vertices)
      if (!c) continue
      const mesh = new THREE.Mesh(plotGeo, plotMat)
      mesh.position.set(c.x, 0.09, c.y)
      mesh.userData = { kind: 'plot', id: p.id, blockId: p.blockId, districtId: p.districtId }
      mesh.visible = this.showDebug
      this.scene.add(mesh)
      this.debugObjects.push(mesh)
      this._plotDebugMeshes.push(mesh)
    }
  }

  getBlockOrPlotCenterAtWorldPos(worldX, worldY, threshold = 0.2) {
    const rSq = threshold * threshold
    for (const mesh of this._blockDebugMeshes) {
      if (!mesh.visible) continue
      const dx = worldX - mesh.position.x, dy = worldY - mesh.position.z
      if (dx * dx + dy * dy < rSq) return mesh.userData
    }
    for (const mesh of this._plotDebugMeshes) {
      if (!mesh.visible) continue
      const dx = worldX - mesh.position.x, dy = worldY - mesh.position.z
      if (dx * dx + dy * dy < rSq) return mesh.userData
    }
    return null
  }

  // Hit-test the cursor against every street edge by point-to-segment distance.
  // Returns the closest edge within `threshold` world units, or null.
  getStreetEdgeAtWorldPos(worldX, worldY, threshold = 0.0875) {
    const sg = this.cityDistrictData?.streetGraph
    const nodes = sg?.nodes, edges = sg?.edges
    if (!nodes?.length || !edges?.length) return null
    const byId = new Map(nodes.map(n => [n.id, n]))
    const thrSq = threshold * threshold
    let bestEdge = null, bestDistSq = Infinity, bestT = 0
    for (const e of edges) {
      const a = byId.get(e.nodeA), b = byId.get(e.nodeB)
      if (!a || !b) continue
      const dx = b.x - a.x, dy = b.y - a.y
      const lenSq = dx * dx + dy * dy
      if (lenSq < 1e-12) continue
      let t = ((worldX - a.x) * dx + (worldY - a.y) * dy) / lenSq
      t = Math.max(0, Math.min(1, t))
      const px = a.x + t * dx, py = a.y + t * dy
      const distSq = (worldX - px) ** 2 + (worldY - py) ** 2
      if (distSq < thrSq && distSq < bestDistSq) {
        bestDistSq = distSq; bestEdge = e; bestT = t
      }
    }
    if (!bestEdge) return null
    const a = byId.get(bestEdge.nodeA), b = byId.get(bestEdge.nodeB)
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    return {
      kind: 'streetEdge',
      id: bestEdge.id ?? null,
      type: bestEdge.type ?? null,
      districtId: bestEdge.districtId ?? null,
      nodeA: bestEdge.nodeA,
      nodeB: bestEdge.nodeB,
      length,
      tipDist: Math.sqrt(bestDistSq),
      t: bestT,
    }
  }

  _centroid(poly) {
    if (!poly?.length) return null
    return {
      x: poly.reduce((s, v) => s + v.x, 0) / poly.length,
      y: poly.reduce((s, v) => s + v.y, 0) / poly.length
    }
  }

  _clearDebugGroup(arr) {
    for (const obj of arr) this.scene.remove(obj)
    const toRemove = new Set(arr)
    this.debugObjects = this.debugObjects.filter(o => !toRemove.has(o))
    arr.length = 0
  }

  clearAllDebugObjects() {
    this._clearDebugGroup(this._terrainDebugMeshes)
    this._clearDebugGroup(this._districtDebugMeshes)
    this._clearDebugGroup(this._blockDebugMeshes)
    this._clearDebugGroup(this._plotDebugMeshes)
    this._clearDebugGroup(this._streetSeedMeshes)
    for (const obj of this.debugObjects) this.scene.remove(obj)
    this.debugObjects = []
  }

  drawStreetSeeds(streetGraph) {
    this._clearDebugGroup(this._streetSeedMeshes)
    const seeds = streetGraph?.seeds
    if (!seeds?.length) return
    const geo = new THREE.SphereGeometry(0.035, 8, 8)
    const matInterior     = new THREE.MeshBasicMaterial({ color: 0x2244ff })
    const matPerimeter    = new THREE.MeshBasicMaterial({ color: 0x66ccff })
    const matDropBoundary = new THREE.MeshBasicMaterial({ color: 0x884444 })
    const matDropPerim    = new THREE.MeshBasicMaterial({ color: 0xff8800 })
    for (const s of seeds) {
      const mat = s.kind === 'perimeter'     ? matPerimeter
                : s.kind === 'dropped'       ? matDropBoundary
                : s.kind === 'dropped-perim' ? matDropPerim
                : matInterior
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(s.x, 0.11, s.y)
      mesh.userData = { kind: 'streetSeed', seedKind: s.kind, districtId: s.districtId }
      mesh.visible = this.showDebug
      this.scene.add(mesh)
      this.debugObjects.push(mesh)
      this._streetSeedMeshes.push(mesh)
    }
  }

}
