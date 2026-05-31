import DelaunayTriangulator from './DelaunayTriangulator.js'
import Point from './Point.js'
import { clipToPolygon, triangleCenter, generateGridSeeds } from './VoronoiUtils.js'

const SNAP_THRESHOLD = 0.25   // world units — near-duplicate node merge
const BOUNDARY_INTERVAL = 1.0 // segment length along city boundary edges

const STREET_PRIORITY = { Stone: 2, Brick: 1, Mud: 0 }

function streetTypeForDistrict(district) {
  if (!district) return 'Mud'
  const t = district.assignedType
  if (t === 'Military') return 'Stone'
  if (t === 'Leadership' || t === 'Market') return 'Brick'
  if (t === 'Residential') {
    const cls = district.residentialClass
    if (cls === 'Noble' || cls === 'Middle') return 'Brick'
  }
  return 'Mud'
}

function betterStreetType(a, b) {
  return (STREET_PRIORITY[a] ?? 0) >= (STREET_PRIORITY[b] ?? 0) ? a : b
}

// interval: perimeter seed spacing (world units)
// density:  interior seeds per unit area  (≈ 1/spacing²; Market≈1.2, Residential≈0.4)
// xyRatio:  grid column/row spacing ratio  (1 = square, 2 = wide, 0.5 = tall)
// jitter:   max seed displacement as fraction of grid spacing  (0 = rigid, 0.5 = loose)
// metric:   Voronoi vertex style — 'euclidean' | 'chebyshev' | 'manhattan' | 'centroid'
const DISTRICT_STREET_PARAMS = {
  Leadership:           { interval: 0.5, density: 1.0, xyRatio: 2.0, jitter: 0.2, metric: 'manhattan' },
  Market:               { interval: 1.0, density: 1.0, xyRatio: 4.0, jitter: 0.1, metric: 'chebyshev' },
  'Residential-Slums':  { interval: 1.5, density: 2.0, xyRatio: 1.0, jitter: 0.9, metric: 'manhattan' },
  'Residential-Middle': { interval: 1.5, density: 0.4, xyRatio: 2.0, jitter: 0.2, metric: 'manhattan' },
  'Residential-Noble':  { interval: 1.5, density: 0.4, xyRatio: 1.0, jitter: 0.5, metric: 'manhattan' },
  Religious:            { interval: 0.5, density: 1.5, xyRatio: 1.0, jitter: 0.1, metric: 'centroid' },
  Magical:              { interval: 0.6, density: 2.0, xyRatio: 1.0, jitter: 0.5, metric: 'centroid' },
  Military:             { interval: 0.1, density: 1.0, xyRatio: 2.0, jitter: 0.1, metric: 'chebyshev' },
  Industry:             { interval: 1.2, density: 0.2, xyRatio: 2.5, jitter: 0.1, metric: 'chebyshev' },
  Entertainment:        { interval: 0.5, density: 2.0, xyRatio: 1.0, jitter: 0.9, metric: 'manhattan' },
}

const FALLBACK_STREET_PARAMS = { interval: 1.0, density: 0.5, xyRatio: 1.5, jitter: 0.3, metric: 'manhattan' }

function getStreetParams(district) {
  const type = district.assignedType
  const cls  = district.residentialClass
  let key = type
  if (type === 'Residential') {
    if      (cls === 'Noble')  key = 'Residential-Noble'
    else if (cls === 'Middle') key = 'Residential-Middle'
    else                       key = 'Residential-Slums'
  }
  return DISTRICT_STREET_PARAMS[key] ?? FALLBACK_STREET_PARAMS
}

export default class StreetVoronoiGenerator {

  generate(districts, cityEdges, edgePoints, epochSeed = 0) {
    const districtResults = []
    let nextNodeId = 0
    const edgePointById = new Map((edgePoints || []).map(p => [p.id, p]))
    const districtById = new Map(districts.map(d => [d.id, d]))

    // ── Per-district micro-Voronoi ───────────────────────────────────────────
    for (const district of districts) {
      const streetType = streetTypeForDistrict(district)
      const params = getStreetParams(district)
      const metric = params.metric ?? 'euclidean'

      const perimSeeds = this._samplePerimeter(district.polygon, params.interval)
      const intSeeds   = generateGridSeeds(district.polygon, params.density, params.xyRatio ?? 1.0, params.jitter ?? 0.3, district.id ^ epochSeed)
      const seeds = [...perimSeeds, ...intSeeds]

      if (seeds.length < 3) {
        districtResults.push({ districtId: district.id, nodes: [], edges: [], cells: [] })
        continue
      }

      const points = seeds.map(s => new Point(s.x, s.y))
      const triangulator = DelaunayTriangulator.createFromPoints(points)

      // Build vertex → triangle adjacency for Voronoi cell computation
      const vertexTris = new Map()
      for (const tri of triangulator.triangulation) {
        for (const v of tri.vertices) {
          if (!vertexTris.has(v._id)) vertexTris.set(v._id, [])
          vertexTris.get(v._id).push(tri)
        }
      }

      const edgeTriMap = new Map()
      for (const tri of triangulator.triangulation) {
        for (let i = 0; i < 3; i++) {
          const a = tri.vertices[i], b = tri.vertices[(i + 1) % 3]
          const key = a._id < b._id ? `${a._id}_${b._id}` : `${b._id}_${a._id}`
          if (!edgeTriMap.has(key)) edgeTriMap.set(key, [])
          edgeTriMap.get(key).push(tri)
        }
      }

      const nodeByKey = new Map()
      const distEdges = []

      const getOrCreateNode = (cx, cy) => {
        let x = cx, y = cy
        if (!this._pip(cx, cy, district.polygon)) {
          const p = this._projectToPolygon(cx, cy, district.polygon)
          x = p.x; y = p.y
        }
        const key = `${x.toFixed(4)},${y.toFixed(4)}`
        if (!nodeByKey.has(key)) nodeByKey.set(key, { id: nextNodeId++, x, y })
        return nodeByKey.get(key)
      }

      for (const tris of edgeTriMap.values()) {
        if (tris.length !== 2) continue
        const cA = triangleCenter(tris[0], metric), cB = triangleCenter(tris[1], metric)
        if (!cA || !cB) continue

        const mx = (cA.x + cB.x) / 2, my = (cA.y + cB.y) / 2
        if (!this._pip(mx, my, district.polygon)) continue

        const nA = getOrCreateNode(cA.x, cA.y)
        const nB = getOrCreateNode(cB.x, cB.y)
        distEdges.push({
          id: `street-${district.id}-${distEdges.length}`,
          nodeA: nA.id,
          nodeB: nB.id,
          type: streetType,
          districtId: district.id
        })
      }

      // Compute Voronoi cell for every seed, clipping to district polygon.
      // District polygons are Voronoi cells (convex), so Sutherland-Hodgman clipping is exact.
      const cells = []
      for (let i = 0; i < seeds.length; i++) {
        const seed = seeds[i]
        const point = points[i]
        const tris = vertexTris.get(point._id) || []

        const corners = []
        for (const tri of tris) {
          const c = triangleCenter(tri, metric)
          if (c) corners.push(c)
        }
        if (corners.length < 3) continue

        corners.sort((a, b) =>
          Math.atan2(a.y - seed.y, a.x - seed.x) - Math.atan2(b.y - seed.y, b.x - seed.x)
        )

        const clipped = clipToPolygon(corners, district.polygon)
        if (clipped && clipped.length >= 3) cells.push({ districtId: district.id, polygon: clipped })
      }

      districtResults.push({
        districtId: district.id,
        nodes: [...nodeByKey.values()],
        edges: distEdges,
        cells
      })
    }

    // ── Boundary nodes + edges from ALL city boundary edges ──────────────────
    // Segmented at BOUNDARY_INTERVAL so they match the interior street density.
    // Each city edge's sampled points become first-class street graph nodes,
    // and consecutive nodes become street edges — same store, same render, same pathing.
    // All edge types are processed so that the face tracer in CityBlockGenerator
    // can detect blocks that touch any district boundary, not just Mud ones.
    const boundaryNodeByPtId = new Map()   // actual edgePoint id → node
    const boundaryNodes = []
    const boundaryEdges = []
    const boundaryNodesByEdge = new Map()  // edgeId → [node, ...]  (all nodes incl. interp.)

    for (const [edgeId, cityEdge] of Object.entries(cityEdges)) {
      const pts = (cityEdge.pointIds || []).map(id => edgePointById.get(id)).filter(Boolean)
      if (pts.length < 2) continue

      // Expand each segment into nodes spaced at BOUNDARY_INTERVAL
      const ordered = []
      for (let i = 0; i < pts.length; i++) {
        // Actual edge point — reuse node if shared with another edge
        if (!boundaryNodeByPtId.has(pts[i].id)) {
          const node = { id: nextNodeId++, x: pts[i].x, y: pts[i].y }
          boundaryNodeByPtId.set(pts[i].id, node)
          boundaryNodes.push(node)
        }
        ordered.push(boundaryNodeByPtId.get(pts[i].id))

        if (i < pts.length - 1) {
          // Intermediate nodes between pts[i] and pts[i+1]
          const p1 = pts[i], p2 = pts[i + 1]
          const dx = p2.x - p1.x, dy = p2.y - p1.y
          const len = Math.sqrt(dx * dx + dy * dy)
          const steps = Math.floor(len / BOUNDARY_INTERVAL)
          for (let k = 1; k < steps; k++) {
            const t = (k * BOUNDARY_INTERVAL) / len
            if (t >= 1) break
            const node = { id: nextNodeId++, x: p1.x + dx * t, y: p1.y + dy * t }
            boundaryNodes.push(node)
            ordered.push(node)
          }
        }
      }

      // Edge type: Mud boundaries take the better adjacent street type;
      // non-Mud boundaries (Wall, MainRoad, Canal, Docks) keep their city edge type.
      let boundaryType
      if (!cityEdge.assignedType || cityEdge.assignedType === 'Mud') {
        const typeA = streetTypeForDistrict(districtById.get(cityEdge.districtA))
        const typeB = streetTypeForDistrict(districtById.get(cityEdge.districtB))
        boundaryType = betterStreetType(typeA, typeB)
      } else {
        boundaryType = cityEdge.assignedType
      }

      for (let i = 0; i < ordered.length - 1; i++) {
        boundaryEdges.push({
          id: `street-boundary-${edgeId}-${i}`,
          nodeA: ordered[i].id,
          nodeB: ordered[i + 1].id,
          type: boundaryType,
          districtId: cityEdge.districtA
        })
      }

      boundaryNodesByEdge.set(edgeId, ordered)
    }

    // ── Flatten all nodes and edges ──────────────────────────────────────────
    const voronoiNodes = districtResults.flatMap(r => r.nodes)
    const voronoiEdges = districtResults.flatMap(r => r.edges)
    const allNodes = [...voronoiNodes, ...boundaryNodes]
    const allEdges = [...voronoiEdges, ...boundaryEdges]

    // ── Union-Find for near-duplicate node merge ──────────────────────────────
    const parent = new Map()
    const find = (id) => {
      if (parent.get(id) === id) return id
      const root = find(parent.get(id))
      parent.set(id, root)
      return root
    }
    for (const n of allNodes) parent.set(n.id, n.id)

    for (let i = 0; i < allNodes.length; i++) {
      for (let j = i + 1; j < allNodes.length; j++) {
        const dx = allNodes[i].x - allNodes[j].x
        const dy = allNodes[i].y - allNodes[j].y
        if (dx * dx + dy * dy < SNAP_THRESHOLD * SNAP_THRESHOLD) {
          const ri = find(allNodes[i].id), rj = find(allNodes[j].id)
          if (ri !== rj) parent.set(rj, ri)
        }
      }
    }

    // Average merged node positions
    const rootData = new Map()
    for (const n of allNodes) {
      const root = find(n.id)
      if (!rootData.has(root)) rootData.set(root, { id: root, sumX: 0, sumY: 0, count: 0 })
      const r = rootData.get(root)
      r.sumX += n.x; r.sumY += n.y; r.count++
    }
    const finalNodes = [...rootData.values()].map(r => ({ id: r.id, x: r.sumX / r.count, y: r.sumY / r.count }))

    // Remap edges, drop degenerate / duplicate
    const finalEdges = []
    const seenEdgeKeys = new Set()
    for (const edge of allEdges) {
      const na = find(edge.nodeA), nb = find(edge.nodeB)
      if (na === nb) continue
      const eKey = na < nb ? `${na}_${nb}` : `${nb}_${na}`
      if (seenEdgeKeys.has(eKey)) continue
      seenEdgeKeys.add(eKey)
      finalEdges.push({ ...edge, nodeA: na, nodeB: nb })
    }

    const finalNodeById = new Map(finalNodes.map(n => [n.id, n]))

    // ── Connect all boundary nodes into each adjacent district's Voronoi ─────
    // Every node along the boundary (including interpolated ones) gets an edge
    // to its nearest Voronoi node in each adjacent district, bridging the gap
    // from the boundary line into the interior street network.
    const nodesByDistrict = new Map()
    for (const dr of districtResults) {
      nodesByDistrict.set(dr.districtId, dr.nodes.map(n => ({ ...n, id: find(n.id) })))
    }

    // ── Connect all boundary nodes into each adjacent district's Voronoi ─────
    // Every node along every city edge boundary gets an edge to its nearest
    // Voronoi node in each adjacent district, bridging boundary → interior.
    let connectIdx = 0
    for (const [edgeId, cityEdge] of Object.entries(cityEdges)) {
      const dA = cityEdge.districtA, dB = cityEdge.districtB
      const bNodes = boundaryNodesByEdge.get(edgeId) || []

      for (const districtId of [dA, dB]) {
        if (districtId == null) continue
        const distNodes = nodesByDistrict.get(districtId) || []
        if (!distNodes.length) continue

        for (const bn of bNodes) {
          const bId = find(bn.id)
          const bPt = finalNodeById.get(bId)
          if (!bPt) continue
          let bestDist = Infinity, bestId = null
          for (const dn of distNodes) {
            const dp = finalNodeById.get(dn.id)
            if (!dp) continue
            const d = Math.hypot(bPt.x - dp.x, bPt.y - dp.y)
            if (d < bestDist) { bestDist = d; bestId = dn.id }
          }
          if (bestId !== null && bestId !== bId) {
            const eKey = bestId < bId ? `${bestId}_${bId}` : `${bId}_${bestId}`
            if (!seenEdgeKeys.has(eKey)) {
              seenEdgeKeys.add(eKey)
              const connectType = streetTypeForDistrict(districtById.get(districtId))
              finalEdges.push({ id: `street-connect-${connectIdx++}`, nodeA: bestId, nodeB: bId, type: connectType, districtId })
            }
          }
        }
      }
    }

    const allCells = districtResults.flatMap(r => r.cells || [])

    const byType = finalEdges.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc }, {})
    const typeStr = Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(', ')
    console.log(`Street graph: ${finalNodes.length} nodes, ${finalEdges.length} edges (${typeStr}), ${allCells.length} Voronoi cells`)
    return { nodes: finalNodes, edges: finalEdges, cells: allCells }
  }

  // Perimeter seeds with canonical direction on each edge so shared district
  // boundaries produce identical intermediate seed positions in both districts.
  _samplePerimeter(polygon, interval) {
    const seeds = []
    const n = polygon.length
    for (let i = 0; i < n; i++) {
      const v1 = polygon[i]
      const v2 = polygon[(i + 1) % n]
      seeds.push({ x: v1.x, y: v1.y })

      const dx = v2.x - v1.x, dy = v2.y - v1.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < interval) continue

      const [sa, sb] = this._canonicalOrder(v1, v2)
      const cdx = sb.x - sa.x, cdy = sb.y - sa.y
      const clen = Math.sqrt(cdx * cdx + cdy * cdy)
      const steps = Math.floor(clen / interval)
      for (let k = 1; k <= steps; k++) {
        const t = (k * interval) / clen
        if (t >= 1) break
        seeds.push({ x: sa.x + cdx * t, y: sa.y + cdy * t })
      }
    }
    return seeds
  }

  _canonicalOrder(v1, v2) {
    if (v1.x < v2.x) return [v1, v2]
    if (v1.x > v2.x) return [v2, v1]
    return v1.y <= v2.y ? [v1, v2] : [v2, v1]
  }

  _projectToPolygon(px, py, polygon) {
    let bestDist = Infinity, bestX = px, bestY = py
    const n = polygon.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = polygon[j].x, ay = polygon[j].y
      const bx = polygon[i].x, by = polygon[i].y
      const dx = bx - ax, dy = by - ay
      const lenSq = dx * dx + dy * dy
      if (lenSq === 0) continue
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
      const cx = ax + t * dx, cy = ay + t * dy
      const d = Math.hypot(px - cx, py - cy)
      if (d < bestDist) { bestDist = d; bestX = cx; bestY = cy }
    }
    return { x: bestX, y: bestY }
  }

  _pip(px, py, polygon) {
    let inside = false
    const n = polygon.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y
      const xj = polygon[j].x, yj = polygon[j].y
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
        inside = !inside
    }
    return inside
  }
}
