const DISTRICT_BUILDING_PARAMS = {
  Market:              { setback: 0.06, lotWidth: 0.25, lotDepth: 0.35, alleyWidth: 0.15 },
  Military:            { setback: 0.08, lotWidth: 0.40, lotDepth: 0.55, alleyWidth: 0.20 },
  Residential:         { setback: 0.04, lotWidth: 0.20, lotDepth: 0.30, alleyWidth: 0.12 },
  'Residential-Noble': { setback: 0.08, lotWidth: 0.30, lotDepth: 0.45, alleyWidth: 0.18 },
  'Residential-Slums': { setback: 0.02, lotWidth: 0.15, lotDepth: 0.22, alleyWidth: 0.10 },
  Leadership:          { setback: 0.10, lotWidth: 0.35, lotDepth: 0.55, alleyWidth: 0.25 },
  Entertainment:       { setback: 0.07, lotWidth: 0.28, lotDepth: 0.38, alleyWidth: 0.16 },
  default:             { setback: 0.05, lotWidth: 0.22, lotDepth: 0.32, alleyWidth: 0.14 },
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

function signedArea(poly) {
  let a = 0
  const n = poly.length
  for (let i = 0, j = n - 1; i < n; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y)
  return a / 2
}

function lineIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const r0x = bx - ax, r0y = by - ay
  const r1x = dx - cx, r1y = dy - cy
  const denom = r0x * r1y - r0y * r1x
  if (Math.abs(denom) < 1e-10) return null
  const t = ((cx - ax) * r1y - (cy - ay) * r1x) / denom
  return { x: ax + t * r0x, y: ay + t * r0y }
}

// Nearest forward intersection of ray (ox,oy)+(dx,dy)*t with any polygon edge.
function rayPolygonIntersect(ox, oy, dx, dy, polygon) {
  let bestT = Infinity, bestPt = null
  const n = polygon.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = polygon[j].x, ay = polygon[j].y
    const bx = polygon[i].x, by = polygon[i].y
    const ex = bx - ax, ey = by - ay
    const denom = dx * ey - dy * ex
    if (Math.abs(denom) < 1e-10) continue
    const t = ((ax - ox) * ey - (ay - oy) * ex) / denom
    const s = ((ax - ox) * dy - (ay - oy) * dx) / denom
    if (t > 1e-6 && s >= -1e-6 && s <= 1 + 1e-6 && t < bestT) {
      bestT = t
      bestPt = { x: ox + t * dx, y: oy + t * dy }
    }
  }
  return bestPt
}

/**
 * Inset a polygon inward by d. Coordinates use screen/map convention (y down).
 * Positive-area = CCW-in-screen. Inward perpendicular = (dy, -dx)/len.
 */
function insetPolygon(polygon, d) {
  const origArea = signedArea(polygon)
  if (Math.abs(origArea) < 1e-6) return null
  const poly = origArea < 0 ? [...polygon].reverse() : [...polygon]
  const n = poly.length
  if (n < 3) return null

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
  if (resultArea <= 0) return null
  if (resultArea < Math.abs(origArea) * 0.10) return null
  return result
}

function pointInPolygon(px, py, polygon) {
  let inside = false
  const n = polygon.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// Extract closed interior block polygons from the planar street sub-graph.
function extractBlocks(districtEdges, nodeById) {
  if (!districtEdges.length) return []

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

  const nextHalfEdge = (u, v) => {
    const neighbors = adj.get(v)
    if (!neighbors) return null
    const idx = neighbors.findIndex(n => n.to === u)
    if (idx === -1) return null
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

      if (face.length >= 3 && signedArea(face) > 0) {
        blocks.push(face)
      }
    }
  }

  return blocks
}

/**
 * Place lot quads by stepping along innerRing edges and ray-casting outward to outerBoundary.
 * Each lot quad: [ring_t, ring_t+w, outer_t+w, outer_t].
 * Outward from CCW-in-screen ring edge direction (ux,uy) = (-uy, ux).
 */
function generateRingLots(innerRing, outerBoundary, districtId, lotWidth, maxDepth, nextId, buildings) {
  const n = innerRing.length
  let count = 0
  for (let i = 0; i < n; i++) {
    const a = innerRing[i], b = innerRing[(i + 1) % n]
    const edgeDx = b.x - a.x, edgeDy = b.y - a.y
    const len = Math.hypot(edgeDx, edgeDy)
    if (len < lotWidth * 0.5) continue
    const ux = edgeDx / len, uy = edgeDy / len
    const nx = -uy, ny = ux   // outward perpendicular

    let t = 0
    while (t + lotWidth <= len + 1e-6) {
      const t0 = t, t1 = Math.min(t + lotWidth, len)
      const r0 = { x: a.x + ux * t0, y: a.y + uy * t0 }
      const r1 = { x: a.x + ux * t1, y: a.y + uy * t1 }
      let q0 = rayPolygonIntersect(r0.x, r0.y, nx, ny, outerBoundary)
      let q1 = rayPolygonIntersect(r1.x, r1.y, nx, ny, outerBoundary)
      if (q0 && q1) {
        // cap depth so lots don't span entire large blocks
        const d0 = Math.hypot(q0.x - r0.x, q0.y - r0.y)
        const d1 = Math.hypot(q1.x - r1.x, q1.y - r1.y)
        if (d0 > maxDepth) q0 = { x: r0.x + nx * maxDepth, y: r0.y + ny * maxDepth }
        if (d1 > maxDepth) q1 = { x: r1.x + nx * maxDepth, y: r1.y + ny * maxDepth }
        buildings.push({ id: nextId[0]++, districtId, vertices: [r0, r1, q1, q0] })
        count++
      }
      t += lotWidth
    }
  }
  return count
}

export default class BuildingGenerator {
  generate(districts, streetGraph) {
    const nodeById = new Map(streetGraph.nodes.map(n => [n.id, n]))
    const buildings = []
    const alleys = []
    const nextId = [0]
    let totalBlocks = 0, totalLots = 0

    for (const district of districts) {
      const params = getParams(district)
      const districtEdges = streetGraph.edges.filter(e => e.districtId === district.id)
      const blocks = extractBlocks(districtEdges, nodeById)
      const districtArea = Math.abs(signedArea(district.polygon))
      const validBlocks = blocks.filter(block => {
        const blockArea = Math.abs(signedArea(block))
        if (blockArea > districtArea * 0.4) return false
        const cx = block.reduce((s, v) => s + v.x, 0) / block.length
        const cy = block.reduce((s, v) => s + v.y, 0) / block.length
        return pointInPolygon(cx, cy, district.polygon)
      })
      totalBlocks += validBlocks.length

      for (const block of validBlocks) {
        // Ring 0: lots between block boundary and poly0 (street-facing)
        const d0 = params.setback + params.lotDepth / 2
        const poly0 = insetPolygon(block, d0)
        if (poly0) {
          totalLots += generateRingLots(poly0, block, district.id, params.lotWidth, params.lotDepth, nextId, buildings)
        }

        // Alley line
        const dA = params.setback + params.lotDepth + params.alleyWidth / 2
        const polyA = insetPolygon(block, dA)
        if (polyA) {
          const m = polyA.length
          for (let i = 0; i < m; i++) {
            const a = polyA[i], b = polyA[(i + 1) % m]
            alleys.push({ districtId: district.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y })
          }

          // Ring 1: lots between poly1 and polyA (alley-facing)
          const d1 = params.setback + params.lotDepth + params.alleyWidth + params.lotDepth / 2
          const poly1 = insetPolygon(block, d1)
          if (poly1) {
            totalLots += generateRingLots(poly1, polyA, district.id, params.lotWidth, params.lotDepth, nextId, buildings)
          }
        }
      }
    }

    console.log(`District plots: ${totalLots} lots, ${alleys.length} alley segments across ${totalBlocks} blocks`)
    return { buildings, alleys }
  }
}
