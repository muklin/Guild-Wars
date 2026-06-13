import * as THREE from 'three'
import PolylineRenderer from './utils/PolylineRenderer.js'
import FeatureManager from './utils/FeatureManager.js'
import { pointInPolygon, distanceToLineSegment, centroid } from './utils/renderUtils.js'

export const DISTRICT_COLORS = {
  Neutral:       0xDAD2AC,
  Market:        0xffd700,
  Military:      0x8b0000,
  Magical:       0xc39bef,
  Religious:     0xffff00,
  Residential:   0xb8956a,
  Noble:         0x9C62CC,
  Middle:        0xFFF385,
  Slums:         0xa08860,
  Entertainment: 0xff69b4,
  Industry:      0xbdb76b,
  Agricultural:  0x228b22,
  Leadership:    0x4a1a6a,
  Monarchy:      0xdaa520,
  Republic:      0x2878b5,
  Tyrant:        0x8b1515,
  Oligarchy:     0x4b7c59,
  Theocracy:     0xd4c17f,
  Anarchist:     0xcc4400,
  Wall:          0x555555,
  MainRoad:      0x70717C,
  Canal:         0x3399cc,
  Docks:         0x2a7a9e,
  unassigned:    0xb8a680,
  get(type) {
    return this[type] ?? null
  }
}

export default class DistrictRenderer {
  constructor(scene) {
    this.scene = scene
    this.showDebug = false
    this.debugObjects = []
    this._districtDebugMeshes = []

    this.cityDistrictData = null
    this.cityEdgePointsById = new Map()

    this.districtMeshes = new Map()
    this.cityEdgeMeshes = new Map()
    this.cityPolylines = null
    this.hideCityEdges = false   // Guild Setup: city is final, hide the City-Edge overlay
    this.wallTowers = new FeatureManager(scene)   // wallTower.glb at wall corners
    this.wallAnimations = new Map()
    this.selectedCityEdgeIds = new Set()
    this.selectedDistrictId = null

    this.hoveredDistrictId = null
    this.hoveredCityEdgeId = null
  }

  setDebugVisible(show) {
    this.showDebug = show
    for (const obj of this.debugObjects) obj.visible = show
  }

  clearDebugObjects() {
    this._clearDebugGroup(this._districtDebugMeshes)
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
    if (this.hoveredDistrictId !== null) {
      if (this.hoveredDistrictId !== this.selectedDistrictId) {
        const hd = this.cityDistrictData?.districts?.find(d => d.id === this.hoveredDistrictId)
        const colorKey = hd?.assignedType || (hd?.isLeadershipDistrict ? 'Leadership' : null)
        const baseColor = colorKey ? DISTRICT_COLORS.get(colorKey) : DISTRICT_COLORS.Neutral
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
  }

  // ── District data ───────────────────────────────────────────────────────────

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

  renderDistricts(districts) {
    this.districtMeshes.forEach(mesh => this.scene.remove(mesh))
    this.districtMeshes.clear()

    console.log(`renderDistricts: ${districts.length} districts`, new Error().stack.split('\n')[2]?.trim())
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
    const vertices = polygon.map(v => [v.x, 0.05, v.y]).flat()   // flush with terrain (see TerrainRenderer)

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
    const color = colorKey ? DISTRICT_COLORS.get(colorKey) : DISTRICT_COLORS.Neutral
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

    // Guild Setup: suppress non-wall boundary polylines (tan caps, district edge
    // highlights) but keep Wall meshes and their towers — they are physical structures.
    if (this.hideCityEdges) {
      for (const [edgeId, edge] of Object.entries(edges)) {
        if (edge.assignedType === 'Wall') {
          const mesh = this.buildWallMesh(edge, edgeId)
          if (mesh) { this.scene.add(mesh); this.cityEdgeMeshes.set(edgeId, mesh) }
        }
      }
      this._renderWallTowers(edges)
      return
    }

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

    this.cityPolylines = new PolylineRenderer(this.scene, { thickness: 0.0875, stripY: 0.077, fillY: 0.08 })
    this.cityPolylines.render(nonWallEdges, this.cityEdgePointsById,
      (edge) => edge.assignedType ? DISTRICT_COLORS.get(edge.assignedType) : DISTRICT_COLORS.unassigned
    )

    this._renderWallTowers(edges)
  }

  // Place a wallTower.glb at each end of a wall and at every district corner /
  // junction along its length (wall-polyline endpoints and real bends; collinear
  // samples are skipped). Each tower is rotated to face the AVERAGE of the
  // outward normals of the wall segments meeting at it — one wall → perpendicular
  // to that wall; two walls → the bisector. Shared corners dedupe to one tower.
  _renderWallTowers(edges) {
    this.wallTowers.clear()
    const districtById = new Map((this.cityDistrictData?.districts || []).map(d => [d.id, d]))
    const towers = new Map()   // posKey → { x, y, nx, ny }  (accumulated outward normals)

    const accumulate = (T, seed, neighbours) => {
      const key = `${Math.round(T.x * 100)},${Math.round(T.y * 100)}`
      let e = towers.get(key)
      if (!e) { e = { x: T.x, y: T.y, nx: 0, ny: 0 }; towers.set(key, e) }
      for (const Q of neighbours) {
        const dx = Q.x - T.x, dy = Q.y - T.y
        const len = Math.hypot(dx, dy)
        if (len < 1e-9) continue
        let nx = -dy / len, ny = dx / len               // wall normal (perpendicular)
        if (seed) {                                      // orient away from the district interior
          const mx = (T.x + Q.x) / 2, my = (T.y + Q.y) / 2
          if (nx * (mx - seed.x) + ny * (my - seed.y) < 0) { nx = -nx; ny = -ny }
        }
        e.nx += nx; e.ny += ny
      }
    }

    for (const edge of Object.values(edges || {})) {
      if (edge.assignedType !== 'Wall') continue
      const ids = edge.pointIds || []
      if (ids.length < 2) continue
      const seed = districtById.get(edge.districtA)?.seedPoint
      const pts = ids.map(i => this.cityEdgePointsById.get(i))
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k], prev = pts[k - 1], next = pts[k + 1]
        if (!p) continue
        let isTower = (k === 0 || k === pts.length - 1)
        if (!isTower && prev && next) {
          const d1x = p.x - prev.x, d1y = p.y - prev.y, d2x = next.x - p.x, d2y = next.y - p.y
          const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y)
          if (l1 > 1e-6 && l2 > 1e-6 && (d1x * d2x + d1y * d2y) / (l1 * l2) <= 0.97) isTower = true
        }
        if (!isTower) continue
        const neighbours = []
        if (prev) neighbours.push(prev)
        if (next) neighbours.push(next)
        accumulate(p, seed, neighbours)
      }
    }

    const positions = []
    for (const e of towers.values()) {
      const rotY = (Math.hypot(e.nx, e.ny) > 1e-9) ? Math.atan2(e.nx, e.ny) : 0  // local +Z → avg normal
      positions.push({ x: e.x, y: e.y, rotY })
    }
    if (positions.length) this.wallTowers.spawnTowers(positions, 0.075)   // wall base height
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

      allVerts.push(
        p1.x - px, 0,          p1.y - py,
        p1.x + px, 0,          p1.y + py,
        p2.x + px, 0,          p2.y + py,
        p2.x - px, 0,          p2.y - py,
        p1.x - px, wallHeight, p1.y - py,
        p1.x + px, wallHeight, p1.y + py,
        p2.x + px, wallHeight, p2.y + py,
        p2.x - px, wallHeight, p2.y - py
      )

      allIdx.push(b+4, b+5, b+6,  b+4, b+6, b+7)
      allIdx.push(b+1, b+2, b+6,  b+1, b+6, b+5)
      allIdx.push(b+3, b+0, b+4,  b+3, b+4, b+7)
      allIdx.push(b+0, b+1, b+5,  b+0, b+5, b+4)
      allIdx.push(b+2, b+3, b+7,  b+2, b+7, b+6)
    }
    if (allVerts.length === 0) return null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVerts), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(allIdx), 1))
    geometry.computeVertexNormals()

    const color = DISTRICT_COLORS.Wall
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

  updateWallAnimations() {
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

  setModeVisibility(inStreets) {
    // District boundary polylines are replaced by the street graph in street mode.
    this.cityPolylines?.edgeMeshes.forEach(m => { m.visible = !inStreets })
    this.cityPolylines?.junctionMeshes.forEach(m => { m.visible = !inStreets })
    // Walls (and their towers) are physical structures — they stay visible in
    // street mode, sitting on the road generated at their base.
  }

  clearDistrictLayer() {
    console.log(`clearDistrictLayer: removing ${this.districtMeshes.size} meshes`)
    this.districtMeshes.forEach(m => this.scene.remove(m))
    this.districtMeshes.clear()
  }

  updateDistrictColor(districtId, districtType) {
    const district = this.cityDistrictData?.districts?.find(d => d.id === districtId)
    const colorType = districtType === 'Residential' && district?.residentialClass
      ? district.residentialClass
      : districtType === 'Leadership' && district?.LeadershipClass
        ? district.LeadershipClass
        : districtType
    const color = DISTRICT_COLORS.get(colorType) || DISTRICT_COLORS.Neutral
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
    const color = colorType ? DISTRICT_COLORS.get(colorType) : DISTRICT_COLORS.Neutral
    const mesh = this.districtMeshes.get(districtId)
    if (mesh) { mesh.material.color.setHex(color); mesh.material.emissive?.setHex(color); mesh.material.emissiveIntensity = 0.1 }
  }

  previewDistrictType(districtId, type) {
    const color = type ? DISTRICT_COLORS.get(type) : DISTRICT_COLORS.Neutral
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
    this._applyCityEdgeColor(edgeId, type ? DISTRICT_COLORS.get(type) : 0xffffff)
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
      this._renderWallTowers(this.cityDistrictData?.edges)
      return
    }
    this.cityPolylines?.updateBaseColor(edgeId, DISTRICT_COLORS.get(type) || DISTRICT_COLORS.unassigned)
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

  // Faction-hover highlight of a district. Uses its OWN state (not hoveredDistrictId)
  // so transient map-hover clearing (clearHover) never wipes it — only
  // clearFactionDistrict() reverts it.
  highlightFactionDistrict(districtId) {
    this.clearFactionDistrict()
    const mesh = this.districtMeshes.get(districtId)
    if (!mesh) return
    this._factionDistrictId = districtId
    this._factionDistrictPrev = {
      color: mesh.material.color.getHex(),
      emissive: mesh.material.emissive?.getHex(),
      ei: mesh.material.emissiveIntensity,
    }
    mesh.material.color.setHex(0xffffff)
    mesh.material.emissive?.setHex(0xffffff)
    mesh.material.emissiveIntensity = 0.35
  }

  clearFactionDistrict() {
    if (this._factionDistrictId == null) return
    const mesh = this.districtMeshes.get(this._factionDistrictId)
    const prev = this._factionDistrictPrev
    if (mesh && prev) {
      mesh.material.color.setHex(prev.color)
      mesh.material.emissive?.setHex(prev.emissive ?? prev.color)
      mesh.material.emissiveIntensity = prev.ei
    }
    this._factionDistrictId = null
    this._factionDistrictPrev = null
  }

  // ── Hit testing ─────────────────────────────────────────────────────────────

  getDistrictAtWorldPos(worldX, worldY) {
    if (!this.cityDistrictData?.districts) return null
    for (const district of this.cityDistrictData.districts) {
      const poly = district.polygon || district.boundary
      if (poly && pointInPolygon(worldX, worldY, poly)) return district
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
        const d = distanceToLineSegment(worldX, worldY, p1.x, p1.y, p2.x, p2.y)
        if (d < closestDist) { closestDist = d; closestEdge = { ...edge, id: edgeId } }
      }
    }
    return closestEdge
  }

  // ── Debug ───────────────────────────────────────────────────────────────────

  drawDistrictCenters(districts) {
    this._clearDebugGroup(this._districtDebugMeshes)
    const geo = new THREE.SphereGeometry(0.075, 8, 8)
    const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 })
    for (const d of (districts || [])) {
      const sp = d.seedPoint || centroid(d.polygon || d.boundary || [])
      if (!sp) continue
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(sp.x, 0.15, sp.y)
      mesh.visible = this.showDebug
      this.scene.add(mesh)
      this.debugObjects.push(mesh)
      this._districtDebugMeshes.push(mesh)
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _applyCityEdgeColor(edgeId, color) {
    const wallMesh = this.cityEdgeMeshes.get(edgeId)
    if (wallMesh?.material) { wallMesh.material.color.setHex(color); wallMesh.material.emissive?.setHex(color) }
    else this.cityPolylines?.setEdgeColor(edgeId, color)
  }

  _cityEdgeBaseColor(edgeId) {
    const edge = this.cityDistrictData?.edges?.[edgeId]
    return edge?.assignedType ? DISTRICT_COLORS.get(edge.assignedType) : DISTRICT_COLORS.unassigned
  }
}
