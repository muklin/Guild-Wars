import * as THREE from 'three'
import PolylineRenderer from './utils/PolylineRenderer.js'
import FeatureManager from './utils/FeatureManager.js'
import { pointInPolygon, distanceToLineSegment, centroid } from './utils/renderUtils.js'
import { DISTRICTS, DEFAULTS } from '../../shared/districtConfig.js'

// Sub-class colours ('Noble', 'Monarchy', etc., as looked up via DISTRICT_COLORS.get())
// and plain district-type colours ('Market', 'Military', ...) are derived from
// shared/districtConfig.js, so a district's colour only needs editing in one place
// alongside its generation/building tuning. A few entries here are NOT per-district
// game data at all — city edge kinds (Wall/MainRoad/Canal/Docks), Agricultural (a
// terrain region type, not a city district), and the Neutral/unassigned/generic-
// Residential/generic-Leadership fallbacks (used before a sub-class is chosen) — those
// stay defined locally.
export const DISTRICT_COLORS = {
  Neutral:       DEFAULTS.color,
  Market:        DISTRICTS.Market.color,
  Military:      DISTRICTS.Military.color,
  Magical:       DISTRICTS.Magical.color,
  Religious:     DISTRICTS.Religious.color,
  Residential:   0xb8956a,   // generic/fallback — no sub-class chosen yet
  Noble:         DISTRICTS['Residential-Noble'].color,
  Middle:        DISTRICTS['Residential-Middle'].color,
  Slums:         DISTRICTS['Residential-Slums'].color,
  Entertainment: DISTRICTS.Entertainment.color,
  Industry:      DISTRICTS.Industry.color,
  Agricultural:  0x228b22,
  Leadership:    0x4a1a6a,   // generic/fallback — no ruling body chosen yet
  Monarchy:      DISTRICTS['Leadership-Monarchy'].color,
  Republic:      DISTRICTS['Leadership-Republic'].color,
  Tyrant:        DISTRICTS['Leadership-Tyrant'].color,
  Oligarchy:     DISTRICTS['Leadership-Oligarchy'].color,
  Theocracy:     DISTRICTS['Leadership-Theocracy'].color,
  Anarchist:     DISTRICTS['Leadership-Anarchist'].color,
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
    this._districtCentersVisible = true

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
    for (const m of this._districtDebugMeshes) m.visible = show && this._districtCentersVisible
  }

  setDistrictCentersVisible(on) {
    this._districtCentersVisible = on
    for (const m of this._districtDebugMeshes) m.visible = this.showDebug && on
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
    this._districtById = null
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

    for (const district of districts) {
      if (district.assignedType) continue   // assigned districts are covered by streets + plots; no polygon needed
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
    const vertices = polygon.map(v => [v.x, 0, v.y]).flat()

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

  // Returns true if either adjacent district has been locked (assignedType set),
  // meaning boundary junctions for this edge now exist in the street graph.
  _edgeHasDefinedDistrict(edge) {
    const districts = this.cityDistrictData?.districts || []
    const districtById = this._districtById || (this._districtById = new Map(districts.map(d => [d.id, d])))
    return !!(districtById.get(edge.districtA)?.assignedType || districtById.get(edge.districtB)?.assignedType)
  }

  // Extract an ordered polyline from street graph junctions for the boundary between
  // districtA and districtB with the given edgeKind ('Wall', 'Canal', 'MainRoad').
  // Returns null if no boundary junctions for this pair exist yet.
  // Uses per-connection edgeKind/left/right (not junction-level) so that corner
  // junctions shared with other boundary edges are handled correctly.
  _extractBoundaryChain(districtA, districtB, edgeKind) {
    const junctions = this.cityDistrictData?.streetGraph?.junctions
    if (!junctions?.length) return null

    const matchesConn = (c) =>
      c.edgeKind === edgeKind &&
      ((c.left === districtA && c.right === districtB) ||
       (c.left === districtB && c.right === districtA))

    // A junction is in the chain if it has at least one connection along this boundary.
    const matches = junctions.filter(j => (j.connections || []).some(matchesConn))
    if (matches.length < 2) return null

    const jMap = new Map(matches.map(j => [j.id, j]))
    const adj = new Map()
    for (const j of matches) {
      adj.set(j.id, (j.connections || []).filter(c => matchesConn(c) && jMap.has(c.toId)).map(c => c.toId))
    }

    // Start from an endpoint (degree 1 within the chain) or any node if it's a loop
    const start = matches.find(j => (adj.get(j.id) || []).length <= 1) ?? matches[0]
    const chain = [start]
    const visited = new Set([start.id])
    let curr = start
    while (true) {
      const next = (adj.get(curr.id) || []).find(id => !visited.has(id))
      if (next == null) break
      const nj = jMap.get(next)
      if (!nj) break
      chain.push(nj)
      visited.add(nj.id)
      curr = nj
    }
    return chain.length >= 2 ? chain : null
  }

  renderCityEdges(edges) {
    this.cityPolylines?.dispose()
    this.cityPolylines = null
    this.cityEdgeMeshes.forEach(mesh => this.scene.remove(mesh))
    this.cityEdgeMeshes.clear()
    this.wallAnimations.clear()
    this.selectedCityEdgeIds.clear()
    this._districtById = null  // invalidate cached map

    // Guild Setup: suppress non-wall boundary polylines (tan caps, district edge
    // highlights) but keep Wall meshes and their towers — they are physical structures.
    if (this.hideCityEdges) {
      for (const [edgeId, edge] of Object.entries(edges)) {
        if (edge.assignedType === 'Wall') {
          const chain = this._extractBoundaryChain(edge.districtA, edge.districtB, 'Wall')
          const poly = chain ?? null
          const mesh = this.buildWallMesh(edge, edgeId, poly)
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
        // Settled: chain junctions from street graph. Pending: fall back to pointIds (null → buildWallMesh uses edge.pointIds).
        const chain = this._extractBoundaryChain(edge.districtA, edge.districtB, 'Wall')
        const mesh = this.buildWallMesh(edge, edgeId, chain ?? null)
        if (mesh) { this.scene.add(mesh); this.cityEdgeMeshes.set(edgeId, mesh) }
      } else if (edge.assignedType === 'Canal') {
        const chain = this._extractBoundaryChain(edge.districtA, edge.districtB, 'Canal')
        if (chain) {
          const mesh = this.buildCanalMesh(chain, edgeId)
          if (mesh) { this.scene.add(mesh); this.cityEdgeMeshes.set(edgeId, mesh) }
        } else {
          // Pending — show placeholder polyline until 1st adjacent district locks.
          nonWallEdges[edgeId] = edge
        }
      } else {
        const defined = this._edgeHasDefinedDistrict(edge)
        if (!defined) {
          // Show polyline while no district is defined yet.
          nonWallEdges[edgeId] = edge
        }
        // else: defined + untyped/MainRoad → suppress old polyline;
        // the street renderer already shows the boundary streets.
      }
    }

    this.cityPolylines = new PolylineRenderer(this.scene, { thickness: 0.0875, stripY: 0.002, fillY: 0.003 })
    this.cityPolylines.render(nonWallEdges, this.cityEdgePointsById,
      (edge) => edge.assignedType ? DISTRICT_COLORS.get(edge.assignedType) : DISTRICT_COLORS.unassigned
    )

    this._renderWallTowers(edges)
  }

  // Towers only at the two boundary endpoints (the district corner points where
  // multiple edges meet). Intermediate junctions along the wall get arches later.
  _renderWallTowers(edges) {
    this.wallTowers.clear()
    const districtById = new Map((this.cityDistrictData?.districts || []).map(d => [d.id, d]))
    // posKey → { x, y, nx, ny, feature: 'gate'|'barbican'|null }
    const towers = new Map()

    const accumulate = (T, seed, neighbours, feature) => {
      const key = `${Math.round(T.x * 100)},${Math.round(T.y * 100)}`
      let e = towers.get(key)
      if (!e) { e = { x: T.x, y: T.y, nx: 0, ny: 0, feature: feature ?? null }; towers.set(key, e) }
      // Named features (barbican > gate > null) win over plain towers at the same spot.
      if (feature === 'barbican') e.feature = 'barbican'
      else if (feature === 'gate' && e.feature !== 'barbican') e.feature = 'gate'
      for (const Q of neighbours) {
        const dx = Q.x - T.x, dy = Q.y - T.y
        const len = Math.hypot(dx, dy)
        if (len < 1e-9) continue
        let nx = -dy / len, ny = dx / len
        if (seed) {
          const mx = (T.x + Q.x) / 2, my = (T.y + Q.y) / 2
          if (nx * (mx - seed.x) + ny * (my - seed.y) < 0) { nx = -nx; ny = -ny }
        }
        e.nx += nx; e.ny += ny
      }
    }

    const TOWER_ANGLE = Math.PI / 18  // 10 degrees — direction change threshold for a corner tower

    for (const edge of Object.values(edges || {})) {
      const isWall = edge.assignedType === 'Wall'
      const isMainRoad = edge.assignedType === 'MainRoad'
      if (!isWall && !isMainRoad) continue

      const chain = this._extractBoundaryChain(edge.districtA, edge.districtB, edge.assignedType)
      // Wall falls back to raw pointIds for the placeholder (before any district locks).
      // MainRoad has no placeholder — skip if no chain yet.
      const pts = chain ?? (isWall ? (edge.pointIds || []).map(i => this.cityEdgePointsById.get(i)).filter(Boolean) : null)
      if (!pts || pts.length < 2) continue
      const seed = districtById.get(edge.districtA)?.seedPoint

      for (let k = 0; k < pts.length; k++) {
        const p = pts[k]
        if (!p) continue
        const isEndpoint = k === 0 || k === pts.length - 1

        const feature = p.wallFeature ?? null  // 'gate', 'barbican', or null

        if (isMainRoad) {
          // Barbicans only at MainRoad endpoints that sit on a Wall.
          if (!isEndpoint) continue
          if (feature !== 'barbican') continue
        } else {
          // Walls: always place at endpoints and explicitly-featured junctions (gates,
          // barbicans). For plain intermediate nodes, only place a tower if the wall
          // turns by more than TOWER_ANGLE (polygon corners). Collinear interpolated
          // nodes have ~0° direction change and are always skipped.
          if (!isEndpoint && !feature) {
            const prev = pts[k - 1], next = pts[k + 1]
            if (!prev || !next) continue
            const dx1 = p.x - prev.x, dy1 = p.y - prev.y
            const dx2 = next.x - p.x,  dy2 = next.y - p.y
            let da = Math.abs(Math.atan2(dy2, dx2) - Math.atan2(dy1, dx1))
            if (da > Math.PI) da = 2 * Math.PI - da
            if (da <= TOWER_ANGLE) continue
          }
        }
        const neighbours = []
        if (pts[k - 1]) neighbours.push(pts[k - 1])
        if (pts[k + 1]) neighbours.push(pts[k + 1])
        accumulate(p, seed, neighbours, feature)
      }
    }

    const towerPositions = [], gatePositions = [], barbicanPositions = []
    for (const e of towers.values()) {
      const rotY = Math.hypot(e.nx, e.ny) > 1e-9 ? Math.atan2(e.nx, e.ny) : 0
      const pos = { x: e.x, y: e.y, rotY }
      if (e.feature === 'barbican') barbicanPositions.push(pos)
      else if (e.feature === 'gate') gatePositions.push(pos)
      else towerPositions.push(pos)
    }
    if (towerPositions.length)   this.wallTowers.spawnTowers(towerPositions, 0)
    if (gatePositions.length)    this.wallTowers.spawnFeature('wallGate', gatePositions, 0)
    if (barbicanPositions.length) this.wallTowers.spawnFeature('barbican', barbicanPositions, 0)
  }

  // Compute mitered left/right corner points for a polyline at a given half-width.
  // Handles first/last points (simple perpendicular) and interior points (bisector miter).
  _getMiteredCorners(pts, halfWidth) {
    const left = [], right = []
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], prev = pts[i - 1], next = pts[i + 1]
      let mx = 0, my = 0
      if (prev && next) {
        const l1 = Math.hypot(p.x - prev.x, p.y - prev.y)
        const l2 = Math.hypot(next.x - p.x, next.y - p.y)
        const n1x = -(p.y - prev.y) / l1, n1y = (p.x - prev.x) / l1
        const n2x = -(next.y - p.y) / l2, n2y = (next.x - p.x) / l2
        const bx = n1x + n2x, by = n1y + n2y
        const bl = Math.hypot(bx, by)
        if (bl < 1e-6) { mx = n1x; my = n1y }
        else { const s = 1 / Math.max(0.15, (bx * n1x + by * n1y) / bl); mx = bx / bl * s; my = by / bl * s }
      } else {
        const ref = next ?? prev
        const len = Math.hypot(ref.x - p.x, ref.y - p.y)
        if (len > 1e-9) { mx = -(ref.y - p.y) / len; my = (ref.x - p.x) / len }
      }
      left.push({ x: p.x + mx * halfWidth, y: p.y + my * halfWidth })
      right.push({ x: p.x - mx * halfWidth, y: p.y - my * halfWidth })
    }
    return { left, right }
  }

  // Build a recessed water channel mesh along `polyline` [{x,y}].
  // Rendered at Y just above the district mesh so it overrides the district colour;
  // stone-lining strips sit slightly higher on each side.
  buildCanalMesh(polyline, edgeId) {
    if (!polyline || polyline.length < 2) return null
    const W          = 0.0875   // normal full street width
    const halfWater  = W          // canal water half-width (total = 2W)
    const halfStone  = W * 1.25  // stone lining extends 0.25W beyond water on each side
    const stoneY     = 0.002     // stone banks just above ground (Y=0)
    const waterY     = 0.006     // water above stone so it shows through in the centre
    const stoneColor = 0x888888
    const waterColor = DISTRICT_COLORS.Canal

    const buildStrip = (hw, Y) => {
      const { left, right } = this._getMiteredCorners(polyline, hw)
      const verts = [], idx = []
      for (let i = 0; i < polyline.length - 1; i++) {
        const b = verts.length / 3
        verts.push(right[i].x, Y, right[i].y,  left[i].x, Y, left[i].y,
                   left[i+1].x, Y, left[i+1].y,  right[i+1].x, Y, right[i+1].y)
        idx.push(b, b+1, b+2,  b, b+2, b+3)
      }
      return { verts, idx }
    }

    const makeGroup = () => {
      const group = new THREE.Group()
      group.userData = { cityEdgeId: edgeId }

      const stone = buildStrip(halfStone, stoneY)
      if (stone.verts.length) {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(stone.verts), 3))
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(stone.idx), 1))
        geo.computeVertexNormals()
        group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: stoneColor, roughness: 0.8, metalness: 0, side: THREE.DoubleSide })))
      }

      const water = buildStrip(halfWater, waterY)
      if (water.verts.length) {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(water.verts), 3))
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(water.idx), 1))
        geo.computeVertexNormals()
        group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: waterColor, roughness: 0.1, metalness: 0.4, emissive: waterColor, emissiveIntensity: 0.3, side: THREE.DoubleSide })))
      }

      return group.children.length ? group : null
    }

    return makeGroup()
  }

  // Build a wall mesh with proper mitered corners and alley floor strips.
  // Internal wall (districts on both sides): 0.6W wide, half-height, alleys on both sides.
  // External wall (one side empty): 1.8W wide, full-height, alley on district side only.
  buildWallMesh(edge, edgeId, overridePolyline = null) {
    const pts = (overridePolyline?.length >= 2 ? overridePolyline
      : (edge.pointIds || []).map(id => this.cityEdgePointsById.get(id)).filter(Boolean))
    if (!pts || pts.length < 2) return null

    // G = STREET_HALF_WIDTH = the gutter distance from street centre where blocks start.
    // Wall body + alley must fit within G to avoid extending into building territory.
    const G = 0.04375
    const districts = this.cityDistrictData?.districts || []
    const districtById = new Map(districts.map(d => [d.id, d]))
    const bothSides = !!(districtById.get(edge.districtA)?.assignedType
                      && districtById.get(edge.districtB)?.assignedType)

    const halfWall  = bothSides ? G * 0.45 : G * 0.70   // internal narrower; external fills gutter
    const wallH     = bothSides ? G * 3.0  : G * 4.5    // internal 2×; external 1.5× original heights
    const alleyW    = bothSides ? G * 0.20 : G * 0.30   // alley strip; total stays ≤ G per side
    // group.position.y = 0 (ground level) is the scale-animation pivot.
    // All local Y coords are relative to that base.
    const wallBase  = 0        // local Y where wall body starts (world 0)
    const alleyLY   = 0.002    // local Y for alley floor — just above ground

    const { left: wallL, right: wallR } = this._getMiteredCorners(pts, halfWall)
    const { left: alleyL, right: alleyR } = this._getMiteredCorners(pts, halfWall + alleyW)

    // ── Wall body (extruded strip, local Y 0..wallH, world Y 0..wallH) ──
    // At gate/barbican junctions the wall body is inset by half the gate footprint so the
    // wall ends exactly at the edge of the gate model.  All segments still render — no gaps.
    const gateInset = (p) =>
      p?.wallFeature === 'barbican' ? 0.08:   // footprint 0.30 / 2
      p?.wallFeature === 'gate'     ? 0.08: 0  // footprint 0.22 / 2

    const wv = [], wi = []
    for (let i = 0; i < pts.length - 1; i++) {
      const insetA = gateInset(pts[i]), insetB = gateInset(pts[i + 1])
      const dx = pts[i+1].x - pts[i].x, dy = pts[i+1].y - pts[i].y
      const segLen = Math.hypot(dx, dy)
      if (segLen < 1e-9) continue
      if (insetA + insetB >= segLen) continue  // gate consumes whole segment — skip
      const ux = dx / segLen, uy = dy / segLen
      const px = -uy, py = ux  // left perpendicular

      // Gate-inset positions along the segment (use straight perp, not miter)
      const ax = pts[i].x   + ux * insetA, ay = pts[i].y   + uy * insetA
      const bx = pts[i+1].x - ux * insetB, by = pts[i+1].y - uy * insetB

      const aL = insetA > 0 ? { x: ax + px*halfWall, y: ay + py*halfWall } : wallL[i]
      const aR = insetA > 0 ? { x: ax - px*halfWall, y: ay - py*halfWall } : wallR[i]
      const bL = insetB > 0 ? { x: bx + px*halfWall, y: by + py*halfWall } : wallL[i+1]
      const bR = insetB > 0 ? { x: bx - px*halfWall, y: by - py*halfWall } : wallR[i+1]

      const B = wv.length / 3
      wv.push(
        aL.x, wallBase,       aL.y,  aR.x, wallBase,       aR.y,
        bR.x, wallBase,       bR.y,  bL.x, wallBase,       bL.y,
        aL.x, wallBase+wallH, aL.y,  aR.x, wallBase+wallH, aR.y,
        bR.x, wallBase+wallH, bR.y,  bL.x, wallBase+wallH, bL.y,
      )
      wi.push(B+4, B+5, B+6, B+4, B+6, B+7)                                // top
      wi.push(B+3, B+0, B+4, B+3, B+4, B+7)                                // left face
      wi.push(B+1, B+2, B+6, B+1, B+6, B+5)                                // right face
      if (i === 0 || insetA > 0)              wi.push(B+0, B+1, B+5, B+0, B+5, B+4)  // start cap
      if (i === pts.length - 2 || insetB > 0) wi.push(B+2, B+3, B+7, B+2, B+7, B+6) // end cap
    }

    // ── Alley floor strips (local Y = alleyLY ≈ -0.022, world Y ≈ 0.053) ────
    const av = [], ai = []
    for (let i = 0; i < pts.length - 1; i++) {
      const B = av.length / 3
      av.push(
        wallL[i].x,    alleyLY, wallL[i].y,    alleyL[i].x,    alleyLY, alleyL[i].y,
        alleyL[i+1].x, alleyLY, alleyL[i+1].y, wallL[i+1].x,  alleyLY, wallL[i+1].y
      )
      ai.push(B, B+1, B+2, B, B+2, B+3)
      if (bothSides) {
        const C = av.length / 3
        av.push(
          wallR[i].x,    alleyLY, wallR[i].y,    alleyR[i].x,    alleyLY, alleyR[i].y,
          alleyR[i+1].x, alleyLY, alleyR[i+1].y, wallR[i+1].x,  alleyLY, wallR[i+1].y
        )
        ai.push(C, C+1, C+2, C, C+2, C+3)
      }
    }

    const wallColor  = DISTRICT_COLORS.Wall
    const alleyColor = 0x8B7355   // mud

    const makeMesh = (verts, idx, color, roughness = 0.7) => {
      if (!verts.length) return null
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1))
      geo.computeVertexNormals()
      return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color, roughness, metalness: 0, emissive: color, emissiveIntensity: 0.15, side: THREE.DoubleSide
      }))
    }

    const group = new THREE.Group()
    group.position.y = 0   // scale-animation pivot at ground level
    group.userData = { cityEdgeId: edgeId }
    const wallMesh  = makeMesh(wv, wi, wallColor)
    const alleyMesh = makeMesh(av, ai, alleyColor, 0.9)
    if (wallMesh)  group.add(wallMesh)
    if (alleyMesh) group.add(alleyMesh)
    return group.children.length ? group : null
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
      const chain = this._extractBoundaryChain(edge.districtA, edge.districtB, 'Wall')
      const group = this.buildWallMesh(edge, edgeId, chain ?? null)
      if (group) {
        group.scale.y = 0
        this.scene.add(group)
        this.cityEdgeMeshes.set(edgeId, group)
        this.wallAnimations.set(edgeId, { object: group, frame: 0 })
      }
      this._renderWallTowers(this.cityDistrictData?.edges)
      return
    }
    if (type === 'Canal') {
      const edge = this.cityDistrictData?.edges?.[edgeId]
      const chain = edge ? this._extractBoundaryChain(edge.districtA, edge.districtB, 'Canal') : null
      if (chain) {
        const polyMesh = this.cityPolylines?.getEdgeMesh(edgeId)
        if (polyMesh) polyMesh.visible = false
        const old = this.cityEdgeMeshes.get(edgeId)
        if (old) this.scene.remove(old)
        const mesh = this.buildCanalMesh(chain, edgeId)
        if (mesh) { this.scene.add(mesh); this.cityEdgeMeshes.set(edgeId, mesh) }
        return
      }
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
    const edge = this.cityDistrictData?.edges?.[edgeId]
    // Typed edges (Wall/Canal/MainRoad) are not hoverable — they're rendered as
    // geometry and boundary-street chain selection isn't yet supported for re-typing.
    if (edge?.assignedType) return
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
      mesh.position.set(sp.x, 0.075, sp.y)
      mesh.visible = this.showDebug && this._districtCentersVisible
      mesh.userData = { kind: 'districtCenter', id: d.id, assignedType: d.assignedType, residentialClass: d.residentialClass }
      this.scene.add(mesh)
      this.debugObjects.push(mesh)
      this._districtDebugMeshes.push(mesh)
    }
  }

  getDistrictCenterAtWorldPos(worldX, worldY, threshold = 0.3) {
    const rSq = threshold * threshold
    for (const mesh of this._districtDebugMeshes) {
      if (!mesh.visible) continue
      const dx = worldX - mesh.position.x, dy = worldY - mesh.position.z
      if (dx * dx + dy * dy < rSq) return mesh.userData
    }
    return null
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
