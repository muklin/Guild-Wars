const DISTRICT_BUILDING_PARAMS = {
  Market:              { setback: 0.06, lotWidth: 0.25, lotDepth: 0.35, lotSpacing: 0.05, alleyWidth: 0.15, rotJitter: 0.03, placeJitter: 0.02 },
  Military:            { setback: 0.08, lotWidth: 0.40, lotDepth: 0.55, lotSpacing: 0.07, alleyWidth: 0.20, rotJitter: 0.01, placeJitter: 0.01 },
  Residential:         { setback: 0.04, lotWidth: 0.20, lotDepth: 0.30, lotSpacing: 0.04, alleyWidth: 0.12, rotJitter: 0.06, placeJitter: 0.03 },
  'Residential-Noble': { setback: 0.08, lotWidth: 0.30, lotDepth: 0.45, lotSpacing: 0.08, alleyWidth: 0.18, rotJitter: 0.04, placeJitter: 0.04 },
  'Residential-Slums': { setback: 0.02, lotWidth: 0.15, lotDepth: 0.22, lotSpacing: 0.03, alleyWidth: 0.10, rotJitter: 0.10, placeJitter: 0.05 },
  Leadership:          { setback: 0.10, lotWidth: 0.35, lotDepth: 0.55, lotSpacing: 0.10, alleyWidth: 0.25, rotJitter: 0.01, placeJitter: 0.02 },
  Entertainment:       { setback: 0.07, lotWidth: 0.28, lotDepth: 0.38, lotSpacing: 0.06, alleyWidth: 0.16, rotJitter: 0.08, placeJitter: 0.04 },
  default:             { setback: 0.05, lotWidth: 0.22, lotDepth: 0.32, lotSpacing: 0.05, alleyWidth: 0.14, rotJitter: 0.05, placeJitter: 0.03 },
}

export { DISTRICT_BUILDING_PARAMS }

function getParams(district) {
  const type = district.assignedType
  const cls = district.residentialClass
  let key = type
  if (type === 'Residential' && cls === 'Noble') key = 'Residential-Noble'  
  else if (type === 'Residential' && cls === 'Slums') key = 'Residential-Slums'
  return DISTRICT_BUILDING_PARAMS[key] ?? DISTRICT_BUILDING_PARAMS.default
}

function makePrng(seed) {
  let s = ((seed + 1) * 2654435761) >>> 0
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0x100000000 }
}

function signedArea(poly) {
  let a = 0
  const n = poly.length
  for (let i = 0, j = n - 1; i < n; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y)
  return a / 2
}

function pointInPolygon(px, py, polygon) {
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

function obbCorners(cx, cy, width, depth, rot) {
  const hw = width / 2, hd = depth / 2
  const cos = Math.cos(rot), sin = Math.sin(rot)
  return [
    [cx + cos * hw - sin * hd, cy + sin * hw + cos * hd],
    [cx - cos * hw - sin * hd, cy - sin * hw + cos * hd],
    [cx - cos * hw + sin * hd, cy - sin * hw - cos * hd],
    [cx + cos * hw + sin * hd, cy + sin * hw - cos * hd],
  ]
}

function lineIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const r0x = bx - ax, r0y = by - ay
  const r1x = dx - cx, r1y = dy - cy
  const denom = r0x * r1y - r0y * r1x
  if (Math.abs(denom) < 1e-10) return null
  const t = ((cx - ax) * r1y - (cy - ay) * r1x) / denom
  return { x: ax + t * r0x, y: ay + t * r0y }
}

/**
 * Inset a polygon inward by d. Returns new vertex array or null if degenerate.
 * Input polygon is normalised to CCW before processing.
 */
function insetPolygon(polygon, d) {
  const origArea = signedArea(polygon)
  if (Math.abs(origArea) < 1e-6) return null
  // Normalise to CCW (positive area)
  const poly = origArea < 0 ? [...polygon].reverse() : [...polygon]
  const n = poly.length
  if (n < 3) return null

  // Offset each edge inward. Coordinates use screen/map convention (y increases downward),
  // so positive-area polygons are CCW-in-screen. Inward perpendicular = right-hand rule in
  // screen space = (dy, -dx)/len (NOT (-dy, dx) which would expand outward).
  const offEdges = []
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n]
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-10) { offEdges.push(null); continue }
    const nx = dy / len * d, ny = -dx / len * d
    offEdges.push({ ax: a.x + nx, ay: a.y + ny, bx: b.x + nx, by: b.y + ny })
  }

  const result = []
  for (let i = 0; i < n; i++) {
    const e0 = offEdges[(i + n - 1) % n]
    const e1 = offEdges[i]
    if (!e0 || !e1) continue
    const pt = lineIntersect(e0.ax, e0.ay, e0.bx, e0.by, e1.ax, e1.ay, e1.bx, e1.by)
    if (!pt) {
      result.push({ x: (e0.bx + e1.ax) / 2, y: (e0.by + e1.ay) / 2 })
      continue
    }
    // Cap miter to 3*d
    const orig = poly[i]
    const moved = Math.hypot(pt.x - orig.x, pt.y - orig.y)
    if (moved > 3 * d) {
      const scale = (3 * d) / moved
      result.push({ x: orig.x + (pt.x - orig.x) * scale, y: orig.y + (pt.y - orig.y) * scale })
    } else {
      result.push(pt)
    }
  }

  if (result.length < 3) return null
  const resultArea = signedArea(result)
  if (resultArea <= 0) return null                              // collapsed or inverted
  if (resultArea < Math.abs(origArea) * 0.10) return null      // too small
  return result
}

/**
 * Extract closed interior block polygons from a planar street sub-graph.
 * Uses half-edge face traversal: for directed edge u→v, the next half-edge
 * is v→w where w is the neighbor of v just BEFORE u in CCW-sorted order.
 * Interior faces have positive signed area (CCW winding).
 */
function extractBlocks(districtEdges, nodeById) {
  if (!districtEdges.length) return []

  // Build per-node outgoing edge lists sorted CCW by angle
  const adj = new Map()
  for (const e of districtEdges) {
    const a = nodeById.get(e.nodeA), b = nodeById.get(e.nodeB)
    if (!a || !b) continue
    if (!adj.has(e.nodeA)) adj.set(e.nodeA, [])
    if (!adj.has(e.nodeB)) adj.set(e.nodeB, [])
    adj.get(e.nodeA).push({ to: e.nodeB, angle: Math.atan2(b.y - a.y, b.x - a.x) })
    adj.get(e.nodeB).push({ to: e.nodeA, angle: Math.atan2(a.y - b.y, a.x - b.x) })
  }
  for (const neighbors of adj.values()) neighbors.sort((a, b) => a.angle - b.angle)

  // Given directed edge u→v, find next half-edge v→w for left-face traversal
  const nextHalfEdge = (u, v) => {
    const neighbors = adj.get(v)
    if (!neighbors) return null
    const idx = neighbors.findIndex(n => n.to === u)
    if (idx === -1) return null
    // w = neighbor just BEFORE u in CCW order (= CW turn = traces interior/left face)
    return { from: v, to: neighbors[(idx - 1 + neighbors.length) % neighbors.length].to }
  }

  const visited = new Set()
  const blocks = []

  for (const e of districtEdges) {
    for (const [start, end] of [[e.nodeA, e.nodeB], [e.nodeB, e.nodeA]]) {
      const startKey = `${start}→${end}`
      if (visited.has(startKey)) continue

      const face = []
      let cur = { from: start, to: end }
      let guard = 0

      while (guard++ < 200) {
        const key = `${cur.from}→${cur.to}`
        if (visited.has(key)) break
        visited.add(key)
        const node = nodeById.get(cur.from)
        if (node) face.push({ x: node.x, y: node.y })
        const next = nextHalfEdge(cur.from, cur.to)
        if (!next) break
        cur = next
      }

      // Only keep interior faces (CCW = positive signed area) with enough vertices
      if (face.length >= 3 && signedArea(face) > 0) {
        blocks.push(face)
      }
    }
  }

  return blocks
}

export default class BuildingGenerator {
  generate(districts, streetGraph) {
    const nodeById = new Map(streetGraph.nodes.map(n => [n.id, n]))
    const buildings = []
    const alleys = []
    let nextId = 0
    let totalBlocks = 0

    for (const district of districts) {
      const params = getParams(district)
      const districtEdges = streetGraph.edges.filter(e => e.districtId === district.id)
      const blocks = extractBlocks(districtEdges, nodeById)
      totalBlocks += blocks.length
      const rng = makePrng(district.id)
      const placed = []   // shared across all blocks in this district for overlap guard
      const minSep = Math.min(params.lotWidth, params.lotDepth) * 0.7

      const tryPlace = (cx, cy, rot, blockPoly) => {
        const jx = (rng() - 0.5) * 2 * params.placeJitter
        const jy = (rng() - 0.5) * 2 * params.placeJitter
        const x = cx + jx, y = cy + jy
        const finalRot = rot + (rng() - 0.5) * 2 * params.rotJitter
        const corners = obbCorners(x, y, params.lotWidth, params.lotDepth, finalRot)
        if (!corners.every(([cx2, cy2]) => pointInPolygon(cx2, cy2, blockPoly))) return
        if (placed.some(p => Math.hypot(p.x - x, p.y - y) < minSep)) return
        placed.push({ x, y })
        buildings.push({ id: nextId++, districtId: district.id, x, y, width: params.lotWidth, depth: params.lotDepth, rotation: finalRot })
      }

      const placeLotRing = (ringPoly, blockPoly) => {
        const n = ringPoly.length
        for (let i = 0; i < n; i++) {
          const a = ringPoly[i], b = ringPoly[(i + 1) % n]
          const dx = b.x - a.x, dy = b.y - a.y
          const len = Math.hypot(dx, dy)
          if (len < params.lotWidth) continue
          const ux = dx / len, uy = dy / len
          const rot = Math.atan2(dy, dx)
          for (let t = params.lotWidth / 2; t <= len - params.lotWidth / 2; t += params.lotWidth + params.lotSpacing) {
            tryPlace(a.x + ux * t, a.y + uy * t, rot, blockPoly)
          }
        }
      }

      let dbgAttempted = 0, dbgFailedCorner = 0, dbgFailedOverlap = 0
      const _tryPlace = tryPlace
      const tryPlaceDbg = (cx, cy, rot, blockPoly) => {
        dbgAttempted++
        const jx = (rng() - 0.5) * 2 * params.placeJitter
        const jy = (rng() - 0.5) * 2 * params.placeJitter
        const x = cx + jx, y = cy + jy
        const finalRot = rot + (rng() - 0.5) * 2 * params.rotJitter
        const corners = obbCorners(x, y, params.lotWidth, params.lotDepth, finalRot)
        if (!corners.every(([cx2, cy2]) => pointInPolygon(cx2, cy2, blockPoly))) { dbgFailedCorner++; return }
        if (placed.some(p => Math.hypot(p.x - x, p.y - y) < minSep)) { dbgFailedOverlap++; return }
        placed.push({ x, y })
        buildings.push({ id: nextId++, districtId: district.id, x, y, width: params.lotWidth, depth: params.lotDepth, rotation: finalRot })
      }

      for (const block of blocks) {
        const blockArea = Math.abs(signedArea(block))
        const d0 = params.setback + params.lotDepth / 2
        const poly0 = insetPolygon(block, d0)
        const dA = params.setback + params.lotDepth + params.alleyWidth / 2
        const polyA = insetPolygon(block, dA)
        const d1 = params.setback + params.lotDepth + params.alleyWidth + params.lotDepth / 2
        const poly1 = insetPolygon(block, d1)
        const edgeLens = poly0 ? poly0.map((v, i) => Math.hypot(poly0[(i+1)%poly0.length].x-v.x, poly0[(i+1)%poly0.length].y-v.y)) : []
        console.log(`  block area=${blockArea.toFixed(3)} d0=${d0.toFixed(3)} poly0=${poly0?`ok(${poly0.length}v maxEdge=${Math.max(0,...edgeLens).toFixed(3)})`:'null'} polyA=${polyA?'ok':'null'} poly1=${poly1?'ok':'null'}`)

        if (poly0) {
          const before = buildings.length
          const placeLotRingDbg = (ringPoly, blockPoly) => {
            const n = ringPoly.length
            for (let i = 0; i < n; i++) {
              const a = ringPoly[i], b = ringPoly[(i + 1) % n]
              const dx = b.x - a.x, dy = b.y - a.y
              const len = Math.hypot(dx, dy)
              if (len < params.lotWidth) continue
              const ux = dx / len, uy = dy / len
              const rot = Math.atan2(dy, dx)
              for (let t = params.lotWidth / 2; t <= len - params.lotWidth / 2; t += params.lotWidth + params.lotSpacing)
                tryPlaceDbg(a.x + ux * t, a.y + uy * t, rot, blockPoly)
            }
          }
          placeLotRingDbg(poly0, block)
          console.log(`    ring0: placed ${buildings.length - before} lots`)
        }

        if (polyA) {
          const m = polyA.length
          for (let i = 0; i < m; i++) {
            const a = polyA[i], b = polyA[(i + 1) % m]
            alleys.push({ districtId: district.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y })
          }
          if (poly1) {
            const before = buildings.length
            placeLotRing(poly1, block)
            console.log(`    ring1: placed ${buildings.length - before} lots`)
          }
        }
      }
      if (dbgAttempted > 0) console.log(`  district ${district.id}: ${dbgAttempted} attempts, ${dbgFailedCorner} failed corner, ${dbgFailedOverlap} failed overlap`)
    }

    console.log(`District plots: ${buildings.length} lots, ${alleys.length} alley segments across ${totalBlocks} blocks`)
    return { buildings, alleys }
  }
}
