import * as THREE from 'three'
import CameraController from './CameraController.js'
import TerrainColors from './TerrainColors.js'

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
    this.edgePointsById = new Map()      // pointId → {id, x, y}
    this.cornerMeshes = new Map()
    this.districtMeshes = new Map()
    this.terrainData = null
    this.cityDistrictData = null
    this.worldSize = 50
    this.isPaused = false
    this.originalMaterials = new Map()
    this.debugObjects = []
    this.showDebug = false
    this.hoveredRegionId = null
    this.hoveredEdgeId = null
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
    window.addEventListener('resize', () => this.onWindowResize())

    this.animate()
  }

  setTerrainData(regions, edges, fineCells, edgePoints) {
    console.log('setTerrainData called with', regions.length, 'regions,', Object.keys(edges || {}).length, 'edges,', (fineCells || []).length, 'fine cells,', (edgePoints || []).length, 'edge points')
    this.edgePointsById = new Map((edgePoints || []).map(p => [p.id, p]))
    this.terrainData = { regions, edges: edges || {}, fineCells: fineCells || [] }
    this.renderTerrain(regions, fineCells || [])
    this.drawVoronoiCenters(regions)
    if (edges && Object.keys(edges).length > 0) {
      this.renderEdges(edges)
    }
    this.renderCorners(regions)
  }

  setCityDistrictData(districts) {
    console.log('setCityDistrictData called with', districts.length, 'districts')
    this.cityDistrictData = { districts }
    this.renderDistricts(districts)
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

    // Fan-triangulate from seed. Voronoi cells are star-shaped so this is always valid.
    // region.polygon is CW in 2D → fan triangles (seed, v[i], v[i+1]) yield +y normal.
    const seed = region.seedPoint
    const vertices = [seed.x, 0.05, seed.y]
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

    console.log(`Rendering ${Object.keys(edges).length} edges`)
    let edgeCount = 0
    Object.entries(edges).forEach(([id, edge]) => {
      const mesh = this.buildEdgeMesh(edge, id)
      if (mesh) {
        this.scene.add(mesh)
        this.edgeMeshes.set(id, mesh)
        edgeCount++
      }
    })
    console.log(`Successfully created ${edgeCount} edge meshes`)
  }

  buildEdgeMesh(edge, edgeId) {
    // Resolve ordered point list from the indexed edge point pool
    const points = edge.pointIds
      ? edge.pointIds.map(id => this.edgePointsById.get(id)).filter(Boolean)
      : edge.vertices   // fallback for old saves with embedded vertices
    if (!points || points.length < 2) return null

    const thickness = 0.5
    const allVerts = []
    const allIdx = []

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i]
      const p2 = points[i + 1]
      if (!p1 || !p2 || !isFinite(p1.x) || !isFinite(p2.x)) continue

      const dx = p2.x - p1.x
      const dy = p2.y - p1.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len === 0) continue

      const perpX = (-dy / len) * (thickness / 2)
      const perpY = (dx / len) * (thickness / 2)

      const base = allVerts.length / 3
      allVerts.push(
        p1.x - perpX, 0.06, p1.y - perpY,
        p1.x + perpX, 0.06, p1.y + perpY,
        p2.x + perpX, 0.06, p2.y + perpY,
        p2.x - perpX, 0.06, p2.y - perpY
      )
      // CW winding in 2D → +y normal → visible from above
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

  updateRegionColor(regionId, terrainType) {
    const color = TerrainColors.get(terrainType) || TerrainColors.unassigned
    const cellIds = this.regionFineCells.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.fineCellMeshes.get(cellId)
      if (mesh) {
        mesh.material.color.setHex(color)
        mesh.material.emissive.setHex(color)
      }
    }
    // Fallback for saves rendered without fine cells
    const regionMesh = this.regionMeshes.get(regionId)
    if (regionMesh) {
      regionMesh.material.color.setHex(color)
      regionMesh.material.emissive.setHex(color)
    }
  }

  updateEdgeColor(edgeId, terrainType) {
    const mesh = this.edgeMeshes.get(edgeId)
    if (mesh) {
      const color = TerrainColors.get(terrainType) || TerrainColors.unassigned
      mesh.material.color.setHex(color)
    }
  }

  updateDistrictColor(districtId, districtClass) {
    const mesh = this.districtMeshes.get(districtId)
    if (mesh) {
      const color = TerrainColors.get(districtClass) || TerrainColors.Neutral
      mesh.material.color.setHex(color)
    }
  }

  renderCorners(regions) {
    this.cornerMeshes.forEach(mesh => this.scene.remove(mesh))
    this.cornerMeshes.clear()

    // Find all unique corner points
    const cornerMap = new Map() // key: "x,y" -> { point, regionIds[] }

    for (let i = 0; i < regions.length; i++) {
      const region = regions[i]
      for (const vertex of region.polygon) {
        const key = `${vertex.x.toFixed(4)},${vertex.y.toFixed(4)}`
        if (!cornerMap.has(key)) {
          cornerMap.set(key, { point: vertex, regionIds: [] })
        }
        cornerMap.get(key).regionIds.push(i)
      }
    }

    // Build meshes only for corners where 3+ regions meet
    let cornerCount = 0
    for (const [key, data] of cornerMap) {
      if (data.regionIds.length >= 3) {
        const mesh = this.buildCornerMesh(data.point, data.regionIds)
        if (mesh) {
          this.scene.add(mesh)
          this.cornerMeshes.set(key, mesh)
          cornerCount++
        }
      }
    }
    console.log(`Rendered ${cornerCount} terrain corners`)
  }

  buildCornerMesh(cornerPoint, regionIds) {
    // Create a small ngon (fan-triangulated polygon) at the corner
    const radius = 0.3 // Size of corner polygon
    const vertexCount = Math.min(regionIds.length, 8) // Cap at 8-sided polygon
    const vertices = []
    const triangles = []

    // Center vertex
    vertices.push(cornerPoint.x, 0.065, cornerPoint.y)

    // Outer vertices in a circle around the corner
    for (let i = 0; i < vertexCount; i++) {
      const angle = (i / vertexCount) * Math.PI * 2
      const x = cornerPoint.x + Math.cos(angle) * radius
      const y = cornerPoint.y + Math.sin(angle) * radius
      vertices.push(x, 0.065, y)
    }

    // Fan triangulation: center to each outer edge (reversed to CW in 2D → +y normal)
    for (let i = 0; i < vertexCount; i++) {
      const next = (i + 1) % vertexCount
      triangles.push(0, next + 1, i + 1)
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(triangles), 1))
    geometry.computeVertexNormals()

    const material = new THREE.MeshStandardMaterial({
      color: 0x666666,
      roughness: 0.6,
      metalness: 0,
      emissive: 0x444444,
      emissiveIntensity: 0.3
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData = { cornerPoint }
    return mesh
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
    if (!district.boundary || district.boundary.length < 3) {
      console.warn(`District ${district.id} has invalid boundary`)
      return null
    }

    const polygon = [...district.boundary]
    polygon.reverse()
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
    geometry.computeBoundingBox()

    const color = TerrainColors.get(district.class) || TerrainColors.Neutral
    const material = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.5,
      metalness: 0,
      transparent: true,
      opacity: 0.8,
      emissive: color,
      emissiveIntensity: 0.1
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData = { districtId: district.id, districtClass: district.class }
    return mesh
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
    if (!this.cityDistrictData) return null

    for (const district of this.cityDistrictData.districts) {
      if (this.pointInPolygon(worldX, worldY, district.boundary)) {
        return district
      }
    }
    return null
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

    if (!this.isPaused) {
      this.cameraController.update()
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
      const cellIds = this.regionFineCells.get(this.hoveredRegionId) || []
      for (const cellId of cellIds) {
        const mesh = this.fineCellMeshes.get(cellId)
        if (mesh?.material?.emissiveIntensity !== undefined) mesh.material.emissiveIntensity = 0.2
      }
      // Fallback for merged-region renders
      const rm = this.regionMeshes.get(this.hoveredRegionId)
      if (rm?.material?.emissiveIntensity !== undefined) rm.material.emissiveIntensity = 0.2
      this.hoveredRegionId = null
    }
    if (this.hoveredEdgeId !== null) {
      const mesh = this.edgeMeshes.get(this.hoveredEdgeId)
      if (mesh?.material?.emissiveIntensity !== undefined) mesh.material.emissiveIntensity = 0.5
      this.hoveredEdgeId = null
    }
  }

  setRegionHover(regionId) {
    if (this.hoveredRegionId === regionId && this.hoveredEdgeId === null) return
    this.clearHover()
    this.hoveredRegionId = regionId
    const cellIds = this.regionFineCells.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.fineCellMeshes.get(cellId)
      if (mesh?.material?.emissiveIntensity !== undefined) mesh.material.emissiveIntensity = 0.6
    }
    if (cellIds.length === 0) {
      const rm = this.regionMeshes.get(regionId)
      if (rm?.material?.emissiveIntensity !== undefined) rm.material.emissiveIntensity = 0.6
    }
  }

  setEdgeHover(edgeId) {
    if (this.hoveredEdgeId === edgeId && this.hoveredRegionId === null) return
    this.clearHover()
    this.hoveredEdgeId = edgeId
    const mesh = this.edgeMeshes.get(edgeId)
    if (mesh?.material?.emissiveIntensity !== undefined) mesh.material.emissiveIntensity = 0.9
  }

  toggleDebugVisualization() {
    this.clearHover() // reset hover before swapping materials to avoid stale emissive state
    this.showDebug = !this.showDebug
    this.debugObjects.forEach(obj => {
      obj.visible = this.showDebug
    })

    if (this.showDebug) {
      this.scene.children.forEach((child) => {
        if (child.material && !this.debugObjects.includes(child) && !this.cornerMeshes.has(this.getMapKeyForMesh(child))) {
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

  getMapKeyForMesh(mesh) {
    for (const [key, val] of this.cornerMeshes) {
      if (val === mesh) return key
    }
    return null
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
