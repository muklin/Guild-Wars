import * as THREE from 'three'
import CameraController from './CameraController.js'

// Offset each edge of poly inward by `offset`, then intersect adjacent offset lines at
// corners (miter joint). Bevels corners where the miter would exceed 3× the offset.
// Returns a new polygon (array of {x,y}) or null if the result is degenerate.
function insetBlockOutline(poly, offset) {
  const n = poly.length
  if (n < 3) return null
  const cx = poly.reduce((s, v) => s + v.x, 0) / n
  const cy = poly.reduce((s, v) => s + v.y, 0) / n
  const edges = []
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n]
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-10) continue
    let nx = -dy / len, ny = dx / len
    if (nx * (cx - a.x) + ny * (cy - a.y) < 0) { nx = -nx; ny = -ny }
    edges.push({
      px: a.x + nx * offset, py: a.y + ny * offset,
      ex: b.x + nx * offset, ey: b.y + ny * offset,
      dx, dy
    })
  }
  if (edges.length < 3) return null
  const verts = []
  const m = edges.length
  for (let i = 0; i < m; i++) {
    const L1 = edges[i], L2 = edges[(i + 1) % m]
    const denom = L1.dx * L2.dy - L1.dy * L2.dx
    if (Math.abs(denom) < 1e-9) {
      verts.push({ x: L1.ex, y: L1.ey })
    } else {
      const t = ((L2.px - L1.px) * L2.dy - (L2.py - L1.py) * L2.dx) / denom
      const ix = L1.px + t * L1.dx, iy = L1.py + t * L1.dy
      if (Math.hypot(ix - L1.ex, iy - L1.ey) > 3 * offset) {
        verts.push({ x: L1.ex, y: L1.ey })  // bevel: two endpoints instead of spike
        verts.push({ x: L2.px, y: L2.py })
      } else {
        verts.push({ x: ix, y: iy })
      }
    }
  }
  return verts.length >= 3 ? verts : null
}
// Appends a filled circle fan into allVerts/allIdx at (x, Y, z) with given radius.
// Winding order: reversed so the cross-product AB×AC points +Y (visible from above).
function addCircleFan(allVerts, allIdx, x, Y, z, r, segs = 10) {
  const base = allVerts.length / 3
  allVerts.push(x, Y, z)
  for (let s = 0; s < segs; s++) {
    const a = (s / segs) * Math.PI * 2
    allVerts.push(x + Math.cos(a) * r, Y, z + Math.sin(a) * r)
  }
  for (let s = 0; s < segs; s++) {
    allIdx.push(base, base + 1 + (s + 1) % segs, base + 1 + s)
  }
}

import TerrainColors from './TerrainColors.js'
import TerrainFeatureManager from './TerrainFeatureManager.js'
import BuildingRenderer from './BuildingRenderer.js'


export default class WorldRenderer {
  constructor() {
    this.scene = null
    this.camera = null
    this.renderer = null
    this.cameraController = null
    this.regionMeshes = new Map()
    this.fineCellMeshes = new Map()      // fineCellId  → mesh
    this.regionFineCells = new Map()     // parentRegionId → [fineCellId, ...]
    this.edgeMeshes = new Map()
    this.junctionMeshes = new Map()      // ptId → mesh (fills gap where 3+ edges meet)
    this.junctionEdgeIds = new Map()     // ptId → Set<edgeId>
    this.junctionFills = new Map()       // ptId → { boundaryPts:[{x,y}], edgeIds:Set }
    this.edgePointsById = new Map()      // pointId → {id, x, y}
    this.districtMeshes = new Map()
    this.cityEdgeMeshes = new Map()
    this.cityEdgePointsById = new Map()
    this.selectedCityEdgeIds = new Set()
    this.threatMeshes = []
    this.tradeMeshes = []
    this.roadMeshes = []
    this.streetMeshes = []
    this.buildingMeshes = []
    this.buildingRenderer = new BuildingRenderer()
    this.featureManager = null
    this.spawnedFeatureRegions = new Map()  // regionId → Set<featureName>
    this.clock = new THREE.Clock()
    this.terrainData = null
    this.cityDistrictData = null
    this.worldSize = 50
    this.isPaused = false
    this.originalMaterials = new Map()
    this.debugObjects = []
    this.showDebug = false
    this.hoveredRegionId = null
    this.hoveredEdgeId = null
    this.hoveredDistrictId = null
    this.hoveredCityEdgeId = null
    this.selectedDistrictId = null
    this.wallAnimations = new Map()  // edgeId → { object: Group, frame }
    this.mode = 'terrain'  // 'terrain' | 'city'
  }

  setMode(mode) {
    this.clearHover()
    this.mode = mode
  }

  hideUndefinedEdges() {
    const edges = this.terrainData?.edges || {}
    for (const [edgeId, edge] of Object.entries(edges)) {
      if (!edge.assignedType) {
        const mesh = this.edgeMeshes.get(edgeId)
        if (mesh) mesh.visible = false
      }
    }
  }

  init() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x1a1a1a)

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
      return
    }
    this.cityDistrictData = data
    this.cityEdgePointsById = new Map((data.edgePoints || []).map(p => [p.id, p]))
    this.renderDistricts(data.districts || [])
    this.renderCityEdges(data.edges || {})
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
    for (const m of this.streetMeshes) this.scene.remove(m)
    this.streetMeshes = []
  }

  renderStreetGraph(streetGraph) {
    this.clearStreetLayer()
    if (!streetGraph) return
    if (!streetGraph.nodes?.length || !streetGraph.edges?.length) return

    const nodeById = new Map(streetGraph.nodes.map(n => [n.id, n]))
    const thickness = 0.0875
    const r = thickness / 2
    const Y = 0.075

    // Group edges by type
    const byType = new Map()
    for (const edge of streetGraph.edges) {
      const type = edge.type || 'Mud'
      if (!byType.has(type)) byType.set(type, [])
      byType.get(type).push(edge)
    }

    // Assign highest-priority street type to each node (fills intersection gaps)
    const typePriority = { Stone: 2, Brick: 1, Mud: 0 }
    const nodeType = new Map()
    for (const edge of streetGraph.edges) {
      const type = edge.type || 'Mud'
      const pri = typePriority[type] ?? 0
      for (const nid of [edge.nodeA, edge.nodeB]) {
        if (!nodeType.has(nid) || pri > (typePriority[nodeType.get(nid)] ?? 0)) {
          nodeType.set(nid, type)
        }
      }
    }
    const nodesByType = new Map()
    for (const [nid, type] of nodeType) {
      if (!nodesByType.has(type)) nodesByType.set(type, [])
      nodesByType.get(type).push(nid)
    }

    const CIRCLE_SEGS = 8
    const allTypes = new Set([...byType.keys(), ...nodesByType.keys()])
    for (const type of allTypes) {
      const allVerts = [], allIdx = []

      for (const edge of (byType.get(type) || [])) {
        const nA = nodeById.get(edge.nodeA), nB = nodeById.get(edge.nodeB)
        if (!nA || !nB) continue
        const dx = nB.x - nA.x, dy = nB.y - nA.y
        const len = Math.sqrt(dx * dx + dy * dy)
        if (len === 0) continue
        const perpX = (-dy / len) * r, perpY = (dx / len) * r
        const base = allVerts.length / 3
        allVerts.push(
          nA.x - perpX, Y, nA.y - perpY,
          nA.x + perpX, Y, nA.y + perpY,
          nB.x + perpX, Y, nB.y + perpY,
          nB.x - perpX, Y, nB.y - perpY
        )
        allIdx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      }

      // Filled circle at each node to close gaps between quads
      for (const nid of (nodesByType.get(type) || [])) {
        const node = nodeById.get(nid)
        if (!node) continue
        addCircleFan(allVerts, allIdx, node.x, Y, node.y, r, CIRCLE_SEGS)
      }

      if (allVerts.length === 0) continue
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVerts), 3))
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(allIdx), 1))
      geometry.computeVertexNormals()
      const color = TerrainColors.get(type)
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, emissive: color, emissiveIntensity: 0.5 })
      const mesh = new THREE.Mesh(geometry, mat)
      this.scene.add(mesh)
      this.streetMeshes.push(mesh)
    }
  }

  clearBuildingLayer() {
    for (const m of this.buildingMeshes) this.scene.remove(m)
    this.buildingMeshes = []
    this.buildingRenderer.clear(this.scene)
  }

  renderBuildings(blocks, buildings, buildingTemplates, textureTemplates) {
    this.clearBuildingLayer()
    if (!blocks?.length) return

    const Y_CURB = 0.078
    const CURB_OFFSET = 0.0875 / 2
    const LOT_COLOR = new THREE.Color(0x00ffcc)
    const lineVerts = []

    // Count how many blocks reference each edge — interior (street-facing) edges appear twice
    const edgeRefCount = new Map()
    for (const block of blocks) {
      if (!block.vertices || block.vertices.length < 3 || block.blockType === 'square') continue
      const poly = block.vertices, n = poly.length
      for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n]
        const ka = `${a.x.toFixed(4)},${a.y.toFixed(4)}`, kb = `${b.x.toFixed(4)},${b.y.toFixed(4)}`
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
        edgeRefCount.set(key, (edgeRefCount.get(key) || 0) + 1)
      }
    }

    function edgeKey(a, b) {
      const ka = `${a.x.toFixed(4)},${a.y.toFixed(4)}`, kb = `${b.x.toFixed(4)},${b.y.toFixed(4)}`
      return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
    }

    for (const block of blocks) {
      const poly = block.vertices
      if (!poly || poly.length < 3) continue
      if (block.blockType === 'square') continue
      const n = poly.length

      const sharedMask = Array.from({ length: n }, (_, i) =>
        (edgeRefCount.get(edgeKey(poly[i], poly[(i + 1) % n])) || 0) >= 2
      )
      const allShared = sharedMask.every(Boolean)

      if (allShared) {
        // All edges face streets — draw clean miter-joined inset ring, fallback to raw polygon
        const ring = insetBlockOutline(poly, CURB_OFFSET) || poly
        const m = ring.length
        for (let i = 0; i < m; i++) {
          const a = ring[i], b = ring[(i + 1) % m]
          lineVerts.push(a.x, Y_CURB, a.y, b.x, Y_CURB, b.y)
        }
      } else {
        // Boundary block — only draw per-edge segments on street-facing edges
        const cx = poly.reduce((s, v) => s + v.x, 0) / n
        const cy = poly.reduce((s, v) => s + v.y, 0) / n
        for (let i = 0; i < n; i++) {
          if (!sharedMask[i]) continue
          const a = poly[i], b = poly[(i + 1) % n]
          const dx = b.x - a.x, dy = b.y - a.y
          const len = Math.hypot(dx, dy)
          if (len < 1e-10) continue
          let nx = -dy / len, ny = dx / len
          if (nx * (cx - a.x) + ny * (cy - a.y) < 0) { nx = -nx; ny = -ny }
          nx *= CURB_OFFSET; ny *= CURB_OFFSET
          lineVerts.push(a.x + nx, Y_CURB, a.y + ny, b.x + nx, Y_CURB, b.y + ny)
        }
      }
    }

    if (lineVerts.length > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lineVerts), 3))
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: LOT_COLOR, depthTest: true }))
      lines.renderOrder = 10
      this.scene.add(lines)
      this.buildingMeshes.push(lines)
    }
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

  insetPolygon(polygon, inset) {
    if (polygon.length < 3 || inset <= 0) return polygon

    let centroidX = 0, centroidY = 0
    polygon.forEach(v => {
      centroidX += v.x
      centroidY += v.y
    })
    centroidX /= polygon.length
    centroidY /= polygon.length

    return polygon.map(v => {
      const dx = centroidX - v.x
      const dy = centroidY - v.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist === 0) return { x: v.x, y: v.y }
      const nx = dx / dist
      const ny = dy / dist
      return { x: v.x + nx * inset, y: v.y + ny * inset }
    })
  }

  renderEdges(edges) {
    this.edgeMeshes.forEach(mesh => this.scene.remove(mesh))
    this.edgeMeshes.clear()
    this.junctionMeshes.forEach(mesh => this.scene.remove(mesh))
    this.junctionMeshes.clear()
    this.junctionEdgeIds.clear()
    this.junctionFills.clear()

    console.log(`Rendering ${Object.keys(edges).length} edges`)
    const junctionOverrides = this._computeJunctionData(edges)
    let edgeCount = 0
    Object.entries(edges).forEach(([id, edge]) => {
      const mesh = this.buildEdgeMesh(edge, id, junctionOverrides)
      if (mesh) {
        this.scene.add(mesh)
        this.edgeMeshes.set(id, mesh)
        edgeCount++
      }
    })
    console.log(`Successfully created ${edgeCount} edge meshes`)
    this._renderJunctionFills(edges)
  }

  buildEdgeMesh(edge, edgeId, junctionOverrides = null) {
    // Resolve ordered point list from the indexed edge point pool
    const points = edge.pointIds
      ? edge.pointIds.map(id => this.edgePointsById.get(id)).filter(Boolean)
      : edge.vertices   // fallback for old saves with embedded vertices
    if (!points || points.length < 2) return null

    const thickness = 0.5
    const r = thickness / 2
    const Y = 0.06
    const allVerts = []
    const allIdx = []

    const ptIds = edge.pointIds || []
    const startOvr = junctionOverrides?.get(`${edgeId}_${ptIds[0]}`)
    const endOvr   = junctionOverrides?.get(`${edgeId}_${ptIds[ptIds.length - 1]}`)
    const n = points.length

    // Line intersection helper
    const lineIsect = (q1x, q1y, d1x, d1y, q2x, q2y, d2x, d2y) => {
      const denom = d1x * d2y - d1y * d2x
      if (Math.abs(denom) < 1e-8) return { x: (q1x + q2x) / 2, y: (q1y + q2y) / 2 }
      const t = ((q2x - q1x) * d2y - (q2y - q1y) * d2x) / denom
      return { x: q1x + t * d1x, y: q1y + t * d1y }
    }

    // Precompute per-point {left, right} strip corners.
    // "left" = CCW side, "right" = CW side, both relative to segment travel direction.
    const corners = []
    for (let i = 0; i < n; i++) {
      const pt = points[i]
      if (!pt || !isFinite(pt.x)) { corners.push(null); continue }

      if (i === 0) {
        if (startOvr) {
          // outgoing dir = segment dir: trueLeft/Right align with segment-left/right
          corners.push({ left: startOvr.trueLeft, right: startOvr.trueRight })
        } else {
          const p2 = points[1]
          if (!p2 || !isFinite(p2.x)) { corners.push(null); continue }
          const dx = p2.x - pt.x, dy = p2.y - pt.y, len = Math.sqrt(dx*dx + dy*dy)
          if (len < 1e-10) { corners.push(null); continue }
          const ux = dx/len, uy = dy/len
          const sx = pt.x + ux*r, sy = pt.y + uy*r  // inset dead-end
          corners.push({ left: {x: sx - uy*r, y: sy + ux*r}, right: {x: sx + uy*r, y: sy - ux*r} })
        }
      } else if (i === n - 1) {
        if (endOvr) {
          // Segment arrives at junction: segment-left = outgoing-right (direction flipped)
          corners.push({ left: endOvr.trueRight, right: endOvr.trueLeft })
        } else {
          const p0 = points[n - 2]
          if (!p0 || !isFinite(p0.x)) { corners.push(null); continue }
          const dx = pt.x - p0.x, dy = pt.y - p0.y, len = Math.sqrt(dx*dx + dy*dy)
          if (len < 1e-10) { corners.push(null); continue }
          const ux = dx/len, uy = dy/len
          const sx = pt.x - ux*r, sy = pt.y - uy*r  // inset dead-end
          corners.push({ left: {x: sx - uy*r, y: sy + ux*r}, right: {x: sx + uy*r, y: sy - ux*r} })
        }
      } else {
        // Interior bend: miter intersection of adjacent segment rails
        const p0 = points[i - 1], p2 = points[i + 1]
        if (!p0 || !p2 || !isFinite(p0.x) || !isFinite(p2.x)) { corners.push(null); continue }
        const dx1 = pt.x - p0.x, dy1 = pt.y - p0.y, len1 = Math.sqrt(dx1*dx1 + dy1*dy1)
        const dx2 = p2.x - pt.x, dy2 = p2.y - pt.y, len2 = Math.sqrt(dx2*dx2 + dy2*dy2)
        if (len1 < 1e-10 || len2 < 1e-10) { corners.push(null); continue }
        const ux1 = dx1/len1, uy1 = dy1/len1
        const ux2 = dx2/len2, uy2 = dy2/len2
        const left  = lineIsect(pt.x - uy1*r, pt.y + ux1*r, ux1, uy1,
                                 pt.x - uy2*r, pt.y + ux2*r, ux2, uy2)
        const right = lineIsect(pt.x + uy1*r, pt.y - ux1*r, ux1, uy1,
                                 pt.x + uy2*r, pt.y - ux2*r, ux2, uy2)
        corners.push({ left, right })
      }
    }

    const numSegs = n - 1
    for (let i = 0; i < numSegs; i++) {
      const c1 = corners[i], c2 = corners[i + 1]
      if (!c1 || !c2) continue
      const base = allVerts.length / 3
      allVerts.push(c1.right.x, Y, c1.right.y, c1.left.x, Y, c1.left.y,
                    c2.left.x,  Y, c2.left.y,  c2.right.x, Y, c2.right.y)
      allIdx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }

    if (allVerts.length === 0) return null

    let geometry
    try {
      geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVerts), 3))
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(allIdx), 1))
      geometry.computeVertexNormals()
    } catch (e) {
      console.error(`Error creating edge geometry ${edgeId}:`, e)
      return null
    }

    const color = edge.assignedType ? TerrainColors.get(edge.assignedType) : TerrainColors.unassigned
    const material = new THREE.MeshStandardMaterial({
      color, roughness: 0.6, metalness: 0, emissive: color, emissiveIntensity: 0.5
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData = { edgeId }
    return mesh
  }

  _computeJunctionData(edges) {
    // Returns Map: `${edgeId}_${ptId}` → { trueLeft:{x,y}, trueRight:{x,y} }
    // trueLeft/Right are the miter-calculated corner positions at that endpoint,
    // where "left" = CCW side and "right" = CW side of the outgoing edge direction.
    const result = new Map()
    const r = 0.25  // half-thickness

    // Build endpoint → edge list
    const endpointEdges = new Map()
    for (const [edgeId, edge] of Object.entries(edges)) {
      const pts = edge.pointIds
      if (!pts || pts.length < 2) continue
      for (const [idx, ptId] of [[0, pts[0]], [1, pts[pts.length - 1]]]) {
        if (!endpointEdges.has(ptId)) endpointEdges.set(ptId, [])
        endpointEdges.get(ptId).push({ edgeId, edge, atStart: idx === 0 })
      }
    }

    for (const [ptId, edgeList] of endpointEdges) {
      if (edgeList.length < 2) continue  // dead ends get no override

      const jPt = this.edgePointsById.get(ptId)
      if (!jPt || !isFinite(jPt.x)) continue

      // Compute outgoing unit direction for each edge at this junction
      const edgeData = []
      for (const { edgeId, edge, atStart } of edgeList) {
        const pts = edge.pointIds.map(id => this.edgePointsById.get(id)).filter(Boolean)
        if (pts.length < 2) continue
        let dx, dy
        if (atStart) {
          dx = pts[1].x - pts[0].x; dy = pts[1].y - pts[0].y
        } else {
          const n = pts.length - 1
          dx = pts[n - 1].x - pts[n].x; dy = pts[n - 1].y - pts[n].y  // AWAY from junction
        }
        const len = Math.sqrt(dx * dx + dy * dy)
        if (len < 1e-10) continue
        edgeData.push({ edgeId, ux: dx / len, uy: dy / len })
      }
      if (edgeData.length < 2) continue

      // Sort CCW by outgoing angle
      edgeData.sort((a, b) => Math.atan2(a.uy, a.ux) - Math.atan2(b.uy, b.ux))
      const n = edgeData.length

      // Compute n miter boundary points.
      // P_i = intersection of edgeData[i]'s left rail with edgeData[(i+1)%n]'s right rail.
      // Left rail of A: through (J - A.uy*r, J + A.ux*r) in direction (A.ux, A.uy)
      // Right rail of B: through (J + B.uy*r, J - B.ux*r) in direction (B.ux, B.uy)
      const boundaryPts = []
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
        }
        boundaryPts.push({ x: px, y: py })
      }

      // Assign: edgeData[i] trueLeft = boundaryPts[i], trueRight = boundaryPts[(i-1+n)%n]
      for (let i = 0; i < n; i++) {
        const { edgeId } = edgeData[i]
        result.set(`${edgeId}_${ptId}`, {
          trueLeft:  boundaryPts[i],
          trueRight: boundaryPts[(i - 1 + n) % n]
        })
      }

      // Store fill polygon for junctions with 3+ edges
      if (n >= 3) {
        this.junctionFills.set(ptId, {
          boundaryPts,
          edgeIds: new Set(edgeData.map(e => e.edgeId))
        })
      }
    }

    return result
  }

  _renderJunctionFills(edges) {
    // Map each endpoint vertex to all edges that terminate there
    const endpointMap = new Map()  // ptId → [edgeId, ...]
    for (const [edgeId, edge] of Object.entries(edges)) {
      const pts = edge.pointIds
      if (!pts || pts.length < 2) continue
      for (const ptId of [pts[0], pts[pts.length - 1]]) {
        if (!endpointMap.has(ptId)) endpointMap.set(ptId, [])
        endpointMap.get(ptId).push(edgeId)
      }
    }

    // Store adjacency for ALL endpoints so _refreshJunctionColor can update them
    for (const [ptId, edgeIds] of endpointMap) {
      this.junctionEdgeIds.set(ptId, new Set(edgeIds))
    }

    const Y = 0.065  // slightly above edge strips (0.06) to avoid z-fighting

    for (const [ptId, { boundaryPts, edgeIds }] of this.junctionFills) {
      if (boundaryPts.length < 3) continue

      const floatVerts = new Float32Array(boundaryPts.length * 3)
      for (let i = 0; i < boundaryPts.length; i++) {
        floatVerts[i * 3]     = boundaryPts[i].x
        floatVerts[i * 3 + 1] = Y
        floatVerts[i * 3 + 2] = boundaryPts[i].y
      }

      // Fan triangulation; reversed winding ([0,i+1,i]) so normal faces +Y
      const tris = []
      for (let i = 1; i < boundaryPts.length - 1; i++) {
        tris.push(0, i + 1, i)
      }

      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(floatVerts, 3))
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1))
      geo.computeVertexNormals()

      const color = TerrainColors.unassigned
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.6, metalness: 0, emissive: color, emissiveIntensity: 0.5
      })
      const mesh = new THREE.Mesh(geo, mat)
      this.scene.add(mesh)
      this.junctionMeshes.set(ptId, mesh)
    }
  }

  _refreshJunctionColor(ptId) {
    const mesh = this.junctionMeshes.get(ptId)
    if (!mesh) return
    const adjEdgeIds = this.junctionEdgeIds.get(ptId)
    if (!adjEdgeIds) return

    let color = TerrainColors.unassigned
    for (const adjEdgeId of adjEdgeIds) {
      const adjMesh = this.edgeMeshes.get(adjEdgeId)
      if (!adjMesh) continue
      const c = adjMesh.material.color.getHex()
      if (c === 0xffffff) { color = 0xffffff; break }
      const adjEdge = this.terrainData?.edges?.[adjEdgeId]
      if (adjEdge?.assignedType) color = TerrainColors.get(adjEdge.assignedType)
    }
    mesh.material.color.setHex(color)
    mesh.material.emissive?.setHex(color)
  }

  _updateJunctionFromEdge(edgeId) {
    const edge = this.terrainData?.edges?.[edgeId]
    const pts = edge?.pointIds
    if (!pts || pts.length < 2) return
    this._refreshJunctionColor(pts[0])
    this._refreshJunctionColor(pts[pts.length - 1])
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
    this._applyRegionColor(regionId, 0xffffff)
  }

  deselectRegion(regionId) {
    this._applyRegionColor(regionId, this._regionBaseColor(regionId))
  }

  previewRegionType(regionId, terrainType) {
    const color = terrainType ? TerrainColors.get(terrainType) : 0xffffff
    this._applyRegionColor(regionId, color)
  }

  _applyEdgeColor(edgeId, color) {
    const mesh = this.edgeMeshes.get(edgeId)
    if (mesh) { mesh.material.color.setHex(color); mesh.material.emissive?.setHex(color) }
  }

  _edgeBaseColor(edgeId) {
    const edge = this.terrainData?.edges?.[edgeId]
    return edge?.assignedType ? TerrainColors.get(edge.assignedType) : TerrainColors.unassigned
  }

  selectEdge(edgeId) {
    this._applyEdgeColor(edgeId, 0xffffff)
    this._updateJunctionFromEdge(edgeId)
  }

  deselectEdge(edgeId) {
    this._applyEdgeColor(edgeId, this._edgeBaseColor(edgeId))
    this._updateJunctionFromEdge(edgeId)
  }

  previewEdgeType(edgeId, edgeType) {
    const color = edgeType ? TerrainColors.get(edgeType) : 0xffffff
    this._applyEdgeColor(edgeId, color)
  }

  updateEdgeColor(edgeId, terrainType) {
    const mesh = this.edgeMeshes.get(edgeId)
    if (mesh) {
      const color = TerrainColors.get(terrainType) || TerrainColors.unassigned
      mesh.material.color.setHex(color)
    }
    this._updateJunctionFromEdge(edgeId)
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
    this._applyCityEdgeColor(edgeId, this._cityEdgeBaseColor(edgeId))
  }
  previewCityEdgeType(edgeId, type) {
    this._applyCityEdgeColor(edgeId, type ? TerrainColors.get(type) : 0xffffff)
  }
  updateCityEdgeColor(edgeId, type) {
    if (type === 'Wall') {
      const edge = this.cityDistrictData?.edges?.[edgeId]
      if (!edge) return
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
    this._applyCityEdgeColor(edgeId, TerrainColors.get(type) || TerrainColors.unassigned)
  }
  _applyCityEdgeColor(edgeId, color) {
    const mesh = this.cityEdgeMeshes.get(edgeId)
    if (mesh?.material) { mesh.material.color.setHex(color); mesh.material.emissive?.setHex(color) }
  }
  _cityEdgeBaseColor(edgeId) {
    const edge = this.cityDistrictData?.edges?.[edgeId]
    return edge?.assignedType ? TerrainColors.get(edge.assignedType) : TerrainColors.unassigned
  }

  renderDistricts(districts) {
    this.districtMeshes.forEach(mesh => this.scene.remove(mesh))
    this.districtMeshes.clear()

    console.log(`Rendering ${districts.length} city districts`)
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
      transparent: true, opacity: 0.85, depthWrite: false,
      emissive: color, emissiveIntensity: 0.1,
      side: THREE.DoubleSide
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData = { districtId: district.id }
    return mesh
  }

  renderCityEdges(edges) {
    this.cityEdgeMeshes.forEach(mesh => this.scene.remove(mesh))
    this.cityEdgeMeshes.clear()
    this.wallAnimations.clear()
    this.selectedCityEdgeIds.clear()

    for (const [edgeId, edge] of Object.entries(edges)) {
      if (edge.assignedType === 'Mud') continue  // rendered as part of street graph
      const mesh = edge.assignedType === 'Wall'
        ? this.buildWallMesh(edge, edgeId)
        : this.buildCityEdgeMesh(edge, edgeId)
      if (mesh) {
        this.scene.add(mesh)
        this.cityEdgeMeshes.set(edgeId, mesh)
      }
    }
  }

  buildCityEdgeMesh(edge, edgeId) {
    const ids = edge.pointIds
    if (!ids || ids.length < 2) return null

    const thickness = 0.0875
    const r = thickness / 2
    const Y = 0.075
    const allVerts = []
    const allIdx = []

    for (let i = 0; i < ids.length - 1; i++) {
      const p1 = this.cityEdgePointsById.get(ids[i])
      const p2 = this.cityEdgePointsById.get(ids[i + 1])
      if (!p1 || !p2) continue
      const dx = p2.x - p1.x, dy = p2.y - p1.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len === 0) continue
      const perpX = (-dy / len) * r
      const perpY = (dx / len) * r
      const base = allVerts.length / 3
      allVerts.push(
        p1.x - perpX, Y, p1.y - perpY,
        p1.x + perpX, Y, p1.y + perpY,
        p2.x + perpX, Y, p2.y + perpY,
        p2.x - perpX, Y, p2.y - perpY
      )
      allIdx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }

    // Circle fills at every vertex close the angular gaps between consecutive segments
    for (const id of ids) {
      const pt = this.cityEdgePointsById.get(id)
      if (!pt) continue
      addCircleFan(allVerts, allIdx, pt.x, Y, pt.y, r)
    }

    if (allVerts.length === 0) return null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVerts), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(allIdx), 1))
    geometry.computeVertexNormals()

    const assigned = !!edge.assignedType
    const color = assigned ? TerrainColors.get(edge.assignedType) : TerrainColors.unassigned
    const material = new THREE.MeshStandardMaterial({
      color, roughness: 0.6, metalness: 0,
      emissive: color, emissiveIntensity: assigned ? 0.5 : 0.3,
      transparent: false, opacity: 1.0
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData = { cityEdgeId: edgeId }
    return mesh
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

  // startPoint/endPoint are vertex IDs that index into edge.vertices.
  // (Falls back to treating them as embedded objects for old saves.)
  resolveEdgeVertex(edge, ref) {
    if (ref && typeof ref === 'object') return ref
    if (!edge.vertices) return null
    return edge.vertices.find(v => v.id === ref) || null
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
      const baseColor = this._regionBaseColor(this.hoveredRegionId)
      const cellIds = this.regionFineCells.get(this.hoveredRegionId) || []
      for (const cellId of cellIds) {
        const mesh = this.fineCellMeshes.get(cellId)
        if (mesh?.material) {
          mesh.material.color.setHex(baseColor)
          mesh.material.emissive?.setHex(baseColor)
          mesh.material.emissiveIntensity = 0.2
        }
      }
      if (cellIds.length === 0) {
        const rm = this.regionMeshes.get(this.hoveredRegionId)
        if (rm?.material) {
          rm.material.color.setHex(baseColor)
          rm.material.emissive?.setHex(baseColor)
          rm.material.emissiveIntensity = 0.2
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
      const mesh = this.cityEdgeMeshes.get(this.hoveredCityEdgeId)
      if (mesh?.material) {
        const isSelected = this.selectedCityEdgeIds.has(this.hoveredCityEdgeId)
        const baseColor = isSelected ? 0xffffff : this._cityEdgeBaseColor(this.hoveredCityEdgeId)
        mesh.material.color.setHex(baseColor)
        mesh.material.emissive?.setHex(baseColor)
        mesh.material.emissiveIntensity = isSelected ? 0.5 : 0.3
      }
      this.hoveredCityEdgeId = null
    }
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
        mesh.material.color.setHex(lightenedHex)
        mesh.material.emissive?.setHex(lightenedHex)
        mesh.material.emissiveIntensity = 0.45
      }
    }
    if (cellIds.length === 0) {
      const rm = this.regionMeshes.get(regionId)
      if (rm?.material) {
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
    const mesh = this.cityEdgeMeshes.get(edgeId)
    if (mesh?.material) {
      mesh.material.color.setHex(0xdddddd)
      mesh.material.emissive?.setHex(0xdddddd)
      mesh.material.emissiveIntensity = 0.9
      mesh.material.opacity = 0.9
    }
  }

  toggleDebugVisualization() {
    this.clearHover() // reset hover before swapping materials to avoid stale emissive state
    this.showDebug = !this.showDebug
    this.debugObjects.forEach(obj => {
      obj.visible = this.showDebug
    })

    if (this.showDebug) {
      this.scene.children.forEach((child) => {
        if (child.material && !this.debugObjects.includes(child)) {
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
    // Remove old debug objects
    this.debugObjects.forEach(obj => this.scene.remove(obj))
    this.debugObjects = []

    // Draw seed points as small spheres
    const seedGeometry = new THREE.SphereGeometry(0.3, 8, 8)
    const seedMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 })
    regions.forEach(region => {
      const seed = new THREE.Mesh(seedGeometry, seedMaterial)
      seed.position.set(region.seedPoint.x, 0.0, region.seedPoint.y)
      seed.visible = this.showDebug
      this.scene.add(seed)
      this.debugObjects.push(seed)
    })

    // Draw polygon vertices as small cubes
    const vertGeometry = new THREE.BoxGeometry(0.2, 0.2, 0.2)
    const vertMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 })
    regions.forEach(region => {
      region.polygon.forEach((vertex) => {
        const vert = new THREE.Mesh(vertGeometry, vertMaterial)
        vert.position.set(vertex.x, 0.2, vertex.y)
        vert.visible = this.showDebug
        this.scene.add(vert)
        this.debugObjects.push(vert)
      })
    })

    console.log(`Drew ${regions.length} seed points and ${regions.reduce((sum, r) => sum + r.polygon.length, 0)} vertices`)
  }

}
