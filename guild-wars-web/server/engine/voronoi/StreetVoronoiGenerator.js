import DelaunayTriangulator from './DelaunayTriangulator.js'
import Point from './Point.js'

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

// interval:  perimeter seed spacing (world units)
// density:   interior seeds per unit area of the district polygon
// manhattan: probability [0,1] that each interior seed snaps to the nearest grid point
const DISTRICT_STREET_PARAMS = {
  Market:      { interval: 0.9, density: .1,  manhattan: 0.99 },
  Residential: { interval: 1.5, density: 0.1, manhattan: 0.99 },
  Leadership:  { interval: 0.5, density: 0.1, manhattan: 0.99 },
  default:     { interval: 1.0, density: 0.1, manhattan: 0.99 }
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
      const params = DISTRICT_STREET_PARAMS[district.assignedType] || DISTRICT_STREET_PARAMS.default
      const area = this._polygonArea(district.polygon)
      const interiorCount = Math.max(4, Math.round(area * params.density))

      const perimSeeds = this._samplePerimeter(district.polygon, params.interval)
      const intSeeds   = this._sampleInterior(district.polygon, interiorCount, district.id, epochSeed, params.manhattan ?? 0, params.interval)
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
        const cA = tris[0].circumcenter, cB = tris[1].circumcenter
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

        // Collect raw circumcenters — no clamping, let clipping handle the boundary
        const corners = []
        for (const tri of tris) {
          if (!tri.circumcenter) continue
          corners.push({ x: tri.circumcenter.x, y: tri.circumcenter.y })
        }
        if (corners.length < 3) continue

        corners.sort((a, b) =>
          Math.atan2(a.y - seed.y, a.x - seed.x) - Math.atan2(b.y - seed.y, b.x - seed.x)
        )

        const clipped = this._clipToPolygon(corners, district.polygon)
        if (clipped && clipped.length >= 3) cells.push({ districtId: district.id, polygon: clipped })
      }

      districtResults.push({
        districtId: district.id,
        nodes: [...nodeByKey.values()],
        edges: distEdges,
        cells
      })
    }

    // ── Boundary nodes + edges from Mud city boundary edges ──────────────────
    // Segmented at BOUNDARY_INTERVAL so they match the interior street density.
    // Each city edge's sampled points become first-class street graph nodes,
    // and consecutive nodes become street edges — same store, same render, same pathing.
    const boundaryNodeByPtId = new Map()   // actual edgePoint id → node
    const boundaryNodes = []
    const boundaryEdges = []
    const boundaryNodesByEdge = new Map()  // edgeId → [node, ...]  (all nodes incl. interp.)

    for (const [edgeId, cityEdge] of Object.entries(cityEdges)) {
      if (cityEdge.assignedType !== 'Mud') continue
      const pts = (cityEdge.pointIds || []).map(id => edgePointById.get(id)).filter(Boolean)
      if (pts.length < 2) continue

      // Expand each segment into nodes spaced at BOUNDARY_INTERVAL
      const ordered = []
      for (let i = 0; i < pts.length; i++) {
        // Actual edge point — reuse node if shared with another Mud edge
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

      // Street edges along the boundary — upgrade to the better adjacent district type
      const typeA = streetTypeForDistrict(districtById.get(cityEdge.districtA))
      const typeB = streetTypeForDistrict(districtById.get(cityEdge.districtB))
      const boundaryType = betterStreetType(typeA, typeB)

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

    let connectIdx = 0
    for (const [edgeId, cityEdge] of Object.entries(cityEdges)) {
      if (cityEdge.assignedType !== 'Mud') continue
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

    // ── Cross-district connectivity for non-Mud boundaries ───────────────────
    // Mud boundaries are already bridged above; non-Mud ones (Wall, MainRoad…)
    // still need one closest-pair edge so the interior Voronoi graphs connect.
    let crossIdx = 0
    for (const cityEdge of Object.values(cityEdges)) {
      if (cityEdge.assignedType === 'Mud') continue
      const dA = cityEdge.districtA, dB = cityEdge.districtB
      if (dB == null) continue

      const nodesA = nodesByDistrict.get(dA) || []
      const nodesB = nodesByDistrict.get(dB) || []
      if (!nodesA.length || !nodesB.length) continue

      let bestDist = Infinity, bestA = null, bestB = null
      for (const ra of nodesA) {
        const pa = finalNodeById.get(ra.id)
        if (!pa) continue
        for (const rb of nodesB) {
          const pb = finalNodeById.get(rb.id)
          if (!pb) continue
          const d = Math.hypot(pa.x - pb.x, pa.y - pb.y)
          if (d < bestDist) { bestDist = d; bestA = ra.id; bestB = rb.id }
        }
      }

      if (bestA !== null && bestA !== bestB) {
        const eKey = bestA < bestB ? `${bestA}_${bestB}` : `${bestB}_${bestA}`
        if (!seenEdgeKeys.has(eKey)) {
          seenEdgeKeys.add(eKey)
          finalEdges.push({ id: `street-cross-${crossIdx++}`, nodeA: bestA, nodeB: bestB, type: 'Mud', districtId: dA })
        }
      }
    }

    const allCells = districtResults.flatMap(r => r.cells || [])

    const byType = finalEdges.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc }, {})
    const typeStr = Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(', ')
    console.log(`Street graph: ${finalNodes.length} nodes, ${finalEdges.length} edges (${typeStr}), ${allCells.length} Voronoi cells`)
    return { nodes: finalNodes, edges: finalEdges, cells: allCells }
  }

  // Shoelace formula for polygon area (unsigned)
  _polygonArea(polygon) {
    let area = 0
    const n = polygon.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      area += (polygon[j].x + polygon[i].x) * (polygon[j].y - polygon[i].y)
    }
    return Math.abs(area) / 2
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

  // Deterministic interior seeds (rejection-sampled inside polygon).
  // manhattan: probability a seed snaps to the nearest grid point (grid step = gridStep).
  _sampleInterior(polygon, count, seed, epochSeed = 0, manhattan = 0, gridStep = 1.0) {
    let s = ((seed ^ epochSeed) * 2654435761) >>> 0
    const rng = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0x100000000 }

    const xs = polygon.map(v => v.x), ys = polygon.map(v => v.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)

    const pts = []
    let attempts = 0
    while (pts.length < count && attempts < count * 30) {
      let x = minX + rng() * (maxX - minX)
      let y = minY + rng() * (maxY - minY)
      if (manhattan > 0 && rng() < manhattan) {
        x = Math.round(x / gridStep) * gridStep
        y = Math.round(y / gridStep) * gridStep
      }
      if (this._pip(x, y, polygon)) pts.push({ x, y })
      attempts++
    }
    return pts
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

  // Sutherland-Hodgman clip of `subject` polygon against convex `clip` polygon.
  // Uses centroid to determine "inside" so winding order of clip polygon doesn't matter.
  _clipToPolygon(subject, clip) {
    const n = clip.length
    const cx = clip.reduce((s, v) => s + v.x, 0) / n
    const cy = clip.reduce((s, v) => s + v.y, 0) / n

    let output = [...subject]
    for (let i = 0; i < n && output.length > 0; i++) {
      const A = clip[i], B = clip[(i + 1) % n]
      const ABx = B.x - A.x, ABy = B.y - A.y
      const centSide = ABx * (cy - A.y) - ABy * (cx - A.x)
      const inside = p => (ABx * (p.y - A.y) - ABy * (p.x - A.x)) * centSide >= 0
      const intersect = (P, Q) => {
        const dx = Q.x - P.x, dy = Q.y - P.y
        const denom = ABx * dy - ABy * dx
        if (Math.abs(denom) < 1e-10) return P
        const t = (ABy * (P.x - A.x) - ABx * (P.y - A.y)) / denom
        return { x: P.x + t * dx, y: P.y + t * dy }
      }
      const input = output
      output = []
      for (let j = 0; j < input.length; j++) {
        const cur = input[j], prev = input[(j + input.length - 1) % input.length]
        const curIn = inside(cur), prevIn = inside(prev)
        if (curIn) { if (!prevIn) output.push(intersect(prev, cur)); output.push(cur) }
        else if (prevIn) output.push(intersect(prev, cur))
      }
    }
    return output.length >= 3 ? output : null
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
