import DelaunayTriangulator from './DelaunayTriangulator.js'
import Point from './Point.js'
import { clipToPolygon, triangleCenter, generateGridSeeds } from './VoronoiUtils.js'
import { CALC_GUTTERS } from '../pipelineFlags.js'

const SNAP_THRESHOLD = 0.25   // world units — near-duplicate node merge
const BOUNDARY_INTERVAL = 1.0 // segment length along city boundary edges
export const STREET_HALF_WIDTH = 0.04375  // half road width — must match WorldRenderer thickness / 2
const MIN_STUB_ANGLE_DEG = 30  // dead-end stubs at <this angle to a neighbor are pruned
const MIN_COMPONENT_NODES = 3  // disconnected components below this many nodes are deleted
const COLLINEAR_NODE_MARGIN = 0.2  // a node within this perpendicular distance of an edge interior is absorbed onto that edge

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
  Market:               { interval: 1.0, density: 1.0, xyRatio: 4.0, jitter: 0.1, metric: 'manhattan' },
  'Residential-Slums':  { interval: 1.5, density: 2.0, xyRatio: 1.0, jitter: 0.9, metric: 'manhattan' },
  'Residential-Middle': { interval: 1.0, density: 2.0, xyRatio: 2.0, jitter: 0.2, metric: 'manhattan' },
  'Residential-Noble':  { interval: 1.0, density: 1.2, xyRatio: 1.0, jitter: 0.5, metric: 'euclidean' },
  Religious:            { interval: 0.5, density: 1.5, xyRatio: 1.0, jitter: 0.1, metric: 'centroid' },
  Magical:              { interval: 0.6, density: 2.0, xyRatio: 1.0, jitter: 0.5, metric: 'centroid' },
  Military:             { interval: 0.1, density: 1.0, xyRatio: 2.0, jitter: 0.1, metric: 'manhattan' },
  Industry:             { interval: 1.2, density: 0.2, xyRatio: 2.5, jitter: 0.1, metric: 'manhattan' },
  Entertainment:        { interval: 0.5, density: 2.0, xyRatio: 1.0, jitter: 0.9, metric: 'centroid' },
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

// Strictly-interior segment intersection. Returns {x, y, t, s} where t is the
// parameter along AB and s along CD, both in (eps, 1-eps); null if parallel,
// collinear, or the intersection is at/beyond either endpoint.
function _segIntersect(a, b, c, d) {
  const r1x = b.x - a.x, r1y = b.y - a.y
  const r2x = d.x - c.x, r2y = d.y - c.y
  const denom = r1x * r2y - r1y * r2x
  if (Math.abs(denom) < 1e-12) return null
  const sx = c.x - a.x, sy = c.y - a.y
  const t = (sx * r2y - sy * r2x) / denom
  const s = (sx * r1y - sy * r1x) / denom
  const eps = 1e-6
  if (t < eps || t > 1 - eps || s < eps || s > 1 - eps) return null
  return { x: a.x + t * r1x, y: a.y + t * r1y, t, s }
}

// Repeatedly find a pair of non-incident crossing edges and delete the shorter
// of the two. Non-Euclidean triangle-center metrics (manhattan, chebyshev,
// centroid) produce a Delaunay dual that isn't a true planar Voronoi, so
// unrelated edges can cross — keeping the longer of each pair preserves the
// main street while pruning the cross-cutting offender.
// Mutates `edges` in place. Returns the number of edges deleted.
function resolveStreetCrossings(nodes, edges) {
  if (edges.length < 2) return 0
  const nodeById = new Map(nodes.map(n => [n.id, n]))
  const edgeLen = (e) => {
    const a = nodeById.get(e.nodeA), b = nodeById.get(e.nodeB)
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0
  }

  let removed = 0
  for (let iter = 0; iter < 10000; iter++) {
    let cutI = -1, cutJ = -1
    outer: for (let i = 0; i < edges.length; i++) {
      const e1 = edges[i]
      const a = nodeById.get(e1.nodeA), b = nodeById.get(e1.nodeB)
      if (!a || !b) continue
      for (let j = i + 1; j < edges.length; j++) {
        const e2 = edges[j]
        if (e1.nodeA === e2.nodeA || e1.nodeA === e2.nodeB
         || e1.nodeB === e2.nodeA || e1.nodeB === e2.nodeB) continue
        const c = nodeById.get(e2.nodeA), d = nodeById.get(e2.nodeB)
        if (!c || !d) continue
        if (!_segIntersect(a, b, c, d)) continue
        cutI = i; cutJ = j
        break outer
      }
    }
    if (cutI === -1) break
    const dropIdx = edgeLen(edges[cutI]) < edgeLen(edges[cutJ]) ? cutI : cutJ
    edges.splice(dropIdx, 1)
    removed++
  }
  if (removed > 0) console.log(`resolveStreetCrossings: removed ${removed} shorter crossing edges`)
  return removed
}

// For each edge A→B, find every other node N (≠ A, ≠ B) whose perpendicular
// distance to the segment A→B is ≤ `margin` and whose projection lies in the
// segment interior. Absorb those nodes onto the edge by replacing A→B with
// the chain A→N₁→N₂…→Nₖ→B, skipping any segment that already exists. This
// eliminates near-collinear duplicate paths (high-aspect triangle slivers
// where one vertex sits almost on the opposite side) and makes the absorbed
// nodes proper junctions on the absorbing edge.
// Mutates `edges` in place. Returns the number of edges that were chained.
function absorbCollinearNodes(nodes, edges, margin = COLLINEAR_NODE_MARGIN) {
  if (edges.length === 0 || nodes.length < 3) return 0
  const nodeById = new Map(nodes.map(n => [n.id, n]))
  const edgeKey = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`
  const existing = new Set()
  for (const e of edges) existing.add(edgeKey(e.nodeA, e.nodeB))

  const marginSq = margin * margin
  const newEdges = []
  let chained = 0

  for (const e of edges) {
    const a = nodeById.get(e.nodeA), b = nodeById.get(e.nodeB)
    if (!a || !b) { newEdges.push(e); continue }
    const dx = b.x - a.x, dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    if (lenSq < 1e-12) { newEdges.push(e); continue }

    const inside = []
    for (const n of nodes) {
      if (n.id === e.nodeA || n.id === e.nodeB) continue
      const t = ((n.x - a.x) * dx + (n.y - a.y) * dy) / lenSq
      if (t <= 0.05 || t >= 0.95) continue
      const cx = a.x + t * dx, cy = a.y + t * dy
      const ddx = n.x - cx, ddy = n.y - cy
      if (ddx * ddx + ddy * ddy <= marginSq) inside.push({ id: n.id, t })
    }

    if (inside.length === 0) { newEdges.push(e); continue }
    inside.sort((u, v) => u.t - v.t)

    const chain = [e.nodeA, ...inside.map(x => x.id), e.nodeB]
    for (let i = 0; i < chain.length - 1; i++) {
      const nA = chain[i], nB = chain[i + 1]
      if (nA === nB) continue
      const k = edgeKey(nA, nB)
      if (existing.has(k)) continue
      existing.add(k)
      newEdges.push({ ...e, id: `${e.id}-c${i}`, nodeA: nA, nodeB: nB })
    }
    chained++
  }

  if (chained > 0) {
    edges.length = 0
    edges.push(...newEdges)
    console.log(`absorbCollinearNodes: chained ${chained} edges through interior nodes (margin=${margin})`)
  }
  return chained
}

// Delete any connected component with fewer than `minSize` nodes. Catches
// isolated singleton edges (both ends degree-1) that pruneAcuteStubs can't
// touch — its angle test needs an anchor with at least one other neighbor.
// Mutates `nodes` and `edges` in place.
function removeOrphanComponents(nodes, edges, minSize = MIN_COMPONENT_NODES) {
  if (nodes.length === 0) return 0

  const adj = new Map()
  for (const n of nodes) adj.set(n.id, [])
  for (const e of edges) {
    adj.get(e.nodeA)?.push(e.nodeB)
    adj.get(e.nodeB)?.push(e.nodeA)
  }

  const compOf = new Map()
  let nextComp = 0
  for (const n of nodes) {
    if (compOf.has(n.id)) continue
    const stack = [n.id]
    compOf.set(n.id, nextComp)
    while (stack.length) {
      const cur = stack.pop()
      for (const nb of (adj.get(cur) || [])) {
        if (!compOf.has(nb)) { compOf.set(nb, nextComp); stack.push(nb) }
      }
    }
    nextComp++
  }

  const compSize = new Array(nextComp).fill(0)
  for (const c of compOf.values()) compSize[c]++

  const dropNodes = new Set()
  for (const n of nodes) {
    if (compSize[compOf.get(n.id)] < minSize) dropNodes.add(n.id)
  }
  if (dropNodes.size === 0) return 0

  const keptNodes = nodes.filter(n => !dropNodes.has(n.id))
  const keptEdges = edges.filter(e => !dropNodes.has(e.nodeA) && !dropNodes.has(e.nodeB))
  const droppedEdges = edges.length - keptEdges.length
  const droppedComps = compSize.filter(s => s > 0 && s < minSize).length

  nodes.length = 0; nodes.push(...keptNodes)
  edges.length = 0; edges.push(...keptEdges)
  console.log(`removeOrphanComponents: dropped ${droppedComps} components <${minSize} nodes (${dropNodes.size} nodes, ${droppedEdges} edges)`)
  return droppedComps
}

// Iteratively remove degree-1 "sliver" stubs whose edge meets a neighboring
// street at the anchor node at less than `minAngleDeg`. Pruning a stub may
// expose a new degree-1 node, so we loop until stable.
// Mutates `nodes` and `edges` in place.
function pruneAcuteStubs(nodes, edges, minAngleDeg = MIN_STUB_ANGLE_DEG) {
  const minAngle = minAngleDeg * Math.PI / 180
  let pruned = 0
  for (let iter = 0; iter < 100; iter++) {
    const nodeById = new Map(nodes.map(n => [n.id, n]))
    const adj = new Map()
    for (const n of nodes) adj.set(n.id, [])
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      adj.get(e.nodeA)?.push({ edgeIdx: i, otherId: e.nodeB })
      adj.get(e.nodeB)?.push({ edgeIdx: i, otherId: e.nodeA })
    }

    const removeEdges = new Set()
    const removeNodes = new Set()

    for (const [tipId, neighbors] of adj) {
      if (neighbors.length !== 1) continue
      const { edgeIdx, otherId } = neighbors[0]
      const tip = nodeById.get(tipId)
      const anchor = nodeById.get(otherId)
      if (!tip || !anchor) continue

      const tdx = tip.x - anchor.x, tdy = tip.y - anchor.y
      const tlen = Math.hypot(tdx, tdy)
      if (tlen < 1e-10) continue
      const tux = tdx / tlen, tuy = tdy / tlen

      const anchorNbrs = adj.get(otherId) || []
      let minAng = Infinity
      for (const an of anchorNbrs) {
        if (an.edgeIdx === edgeIdx) continue
        const o = nodeById.get(an.otherId)
        if (!o) continue
        const odx = o.x - anchor.x, ody = o.y - anchor.y
        const olen = Math.hypot(odx, ody)
        if (olen < 1e-10) continue
        const oux = odx / olen, ouy = ody / olen
        const dot = Math.max(-1, Math.min(1, tux * oux + tuy * ouy))
        const ang = Math.acos(dot)
        if (ang < minAng) minAng = ang
      }

      if (minAng < minAngle) {
        removeEdges.add(edgeIdx)
        removeNodes.add(tipId)
      }
    }

    if (removeEdges.size === 0) break
    const keptEdges = edges.filter((_, i) => !removeEdges.has(i))
    const keptNodes = nodes.filter(n => !removeNodes.has(n.id))
    edges.length = 0; edges.push(...keptEdges)
    nodes.length = 0; nodes.push(...keptNodes)
    pruned += removeNodes.size
  }
  if (pruned > 0) console.log(`pruneAcuteStubs: removed ${pruned} dead-end stubs at <${minAngleDeg}°`)
}

// Build the gutter graph: nodes are miter-corner points at every junction,
// edges run along the sides of each road and around each junction perimeter.
// Mirrors the geometry computed by PolylineRenderer._computeJunctionData().
function buildGutterGraph(streetNodes, streetEdges) {
  const r = STREET_HALF_WIDTH
  const nodeById = new Map(streetNodes.map(n => [n.id, n]))

  const adj = new Map()
  for (const n of streetNodes) adj.set(n.id, [])
  for (const edge of streetEdges) {
    adj.get(edge.nodeA)?.push({ edgeId: edge.id, otherId: edge.nodeB })
    adj.get(edge.nodeB)?.push({ edgeId: edge.id, otherId: edge.nodeA })
  }

  let nextGId = 0
  const gutterNodes = []
  const gutterEdges = []
  // edgeCorners[`${edgeId}_${nodeId}`] = { left: node, right: node }
  const edgeCorners = new Map()

  for (const [nodeId, neighbors] of adj) {
    const jPt = nodeById.get(nodeId)
    if (!jPt) continue

    const edgeData = []
    for (const { edgeId, otherId } of neighbors) {
      const other = nodeById.get(otherId)
      if (!other) continue
      const dx = other.x - jPt.x, dy = other.y - jPt.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < 1e-10) continue
      edgeData.push({ edgeId, ux: dx / len, uy: dy / len })
    }
    if (!edgeData.length) continue

    edgeData.sort((a, b) => Math.atan2(a.uy, a.ux) - Math.atan2(b.uy, b.ux))
    const n = edgeData.length

    if (n === 1) {
      // Dead-end cap: two perpendicular corners joined by a cap edge.
      const { edgeId, ux, uy } = edgeData[0]
      const left  = { id: nextGId++, x: jPt.x - uy * r, y: jPt.y + ux * r }
      const right = { id: nextGId++, x: jPt.x + uy * r, y: jPt.y - ux * r }
      gutterNodes.push(left, right)
      gutterEdges.push({ nodeA: left.id, nodeB: right.id })
      edgeCorners.set(`${edgeId}_${nodeId}`, { left, right })
    } else {
      // Multi-edge junction: one "slot" per consecutive edge pair (A, B).
      // Normal case: single miter-corner node (intersection of gutter lines).
      // Blown-out case (near-parallel roads or denom≈0): two separate nodes —
      //   q1Node on A's gutter line, q2Node on B's gutter line — plus a short
      //   bridge edge between them.  This keeps along-road gutter edges exactly
      //   parallel to the road (no bending toward the junction center).
      const slots = []  // { q1Node, q2Node }
      for (let i = 0; i < n; i++) {
        const A = edgeData[i], B = edgeData[(i + 1) % n]
        const q1x = jPt.x - A.uy * r, q1y = jPt.y + A.ux * r
        const q2x = jPt.x + B.uy * r, q2y = jPt.y - B.ux * r
        const denom = A.ux * B.uy - A.uy * B.ux
        let blown = false, px = 0, py = 0
        if (Math.abs(denom) < 1e-8) {
          blown = true
        } else {
          const t = ((q2x - q1x) * B.uy - (q2y - q1y) * B.ux) / denom
          px = q1x + t * A.ux; py = q1y + t * A.uy
          const mdx = px - jPt.x, mdy = py - jPt.y
          // Blow threshold = half the minimum inter-junction spacing so the miter
          // corner can never reach a neighbouring junction's perimeter.
          if (mdx * mdx + mdy * mdy > (SNAP_THRESHOLD / 2) * (SNAP_THRESHOLD / 2)) blown = true
        }
        if (blown) {
          const gnQ1 = { id: nextGId++, x: q1x, y: q1y }
          const gnQ2 = { id: nextGId++, x: q2x, y: q2y }
          gutterNodes.push(gnQ1, gnQ2)
          gutterEdges.push({ nodeA: gnQ1.id, nodeB: gnQ2.id })  // bridge across the gap
          slots.push({ q1Node: gnQ1, q2Node: gnQ2 })
        } else {
          const gn = { id: nextGId++, x: px, y: py }
          gutterNodes.push(gn)
          slots.push({ q1Node: gn, q2Node: gn })
        }
      }
      // Perimeter: connect q2 of slot[i] to q1 of slot[(i+1)%n].
      // For non-blown slots q1Node===q2Node so the connection is slot[i]→slot[i+1].
      for (let i = 0; i < n; i++) {
        const curr = slots[i], next = slots[(i + 1) % n]
        if (curr.q2Node.id !== next.q1Node.id) {
          gutterEdges.push({ nodeA: curr.q2Node.id, nodeB: next.q1Node.id })
        }
      }
      // Edge corners: left = q1 of slot[i] (on edge[i]'s gutter line),
      //               right = q2 of slot[(i-1+n)%n] (also on edge[i]'s gutter line).
      for (let i = 0; i < n; i++) {
        edgeCorners.set(`${edgeData[i].edgeId}_${nodeId}`, {
          left:  slots[i].q1Node,
          right: slots[(i - 1 + n) % n].q2Node,
        })
      }
    }
  }

  // Along-road gutter edges: left side = cA.left ↔ cB.right, right side = cA.right ↔ cB.left
  for (const edge of streetEdges) {
    const cA = edgeCorners.get(`${edge.id}_${edge.nodeA}`)
    const cB = edgeCorners.get(`${edge.id}_${edge.nodeB}`)
    if (!cA || !cB) continue
    gutterEdges.push({ nodeA: cA.left.id,  nodeB: cB.right.id })
    gutterEdges.push({ nodeA: cA.right.id, nodeB: cB.left.id  })
  }

  // ── Post-process: remove collinear degree-2 gutter nodes ────────────────
  // A degree-2 node whose two neighbors are collinear through it (angle between
  // incoming directions ≈ π) is a redundant intermediate point on a straight
  // gutter edge.  Keeping it creates collinear triples that break _traceFaces.
  // Replace the two edges A-M and M-B with a single edge A-B and drop node M.
  {
    const gAdj = new Map(gutterNodes.map(n => [n.id, new Set()]))
    for (const e of gutterEdges) {
      gAdj.get(e.nodeA)?.add(e.nodeB)
      gAdj.get(e.nodeB)?.add(e.nodeA)
    }
    const gNodeById = new Map(gutterNodes.map(n => [n.id, n]))
    const removedNodes = new Set()
    const COLLINEAR_ANGLE_TOL = 1e-4  // radians (≈ 0.006°)

    for (const [mid, nbSet] of gAdj) {
      if (removedNodes.has(mid)) continue
      if (nbSet.size !== 2) continue
      const [na, nb] = [...nbSet]
      const mPt  = gNodeById.get(mid)
      const aPt  = gNodeById.get(na)
      const bPt  = gNodeById.get(nb)
      if (!mPt || !aPt || !bPt) continue
      const angA = Math.atan2(aPt.y - mPt.y, aPt.x - mPt.x)
      const angB = Math.atan2(bPt.y - mPt.y, bPt.x - mPt.x)
      let angleDiff = Math.abs(Math.abs(angA - angB) - Math.PI)
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff
      if (angleDiff > COLLINEAR_ANGLE_TOL) continue

      // Collapse: drop mid, connect na ↔ nb
      removedNodes.add(mid)
      gAdj.get(na)?.delete(mid)
      gAdj.get(nb)?.delete(mid)
      gAdj.get(na)?.add(nb)
      gAdj.get(nb)?.add(na)
    }

    if (removedNodes.size > 0) {
      // Rebuild gutterNodes and gutterEdges from the modified adjacency
      const keptNodes = gutterNodes.filter(n => !removedNodes.has(n.id))
      const seenEdge  = new Set()
      const keptEdges = []
      for (const [na, nbSet] of gAdj) {
        if (removedNodes.has(na)) continue
        for (const nb of nbSet) {
          if (removedNodes.has(nb)) continue
          const key = na < nb ? `${na}_${nb}` : `${nb}_${na}`
          if (!seenEdge.has(key)) {
            seenEdge.add(key)
            keptEdges.push({ nodeA: na, nodeB: nb })
          }
        }
      }
      gutterNodes.length = 0; gutterNodes.push(...keptNodes)
      gutterEdges.length = 0; gutterEdges.push(...keptEdges)
      console.log(`buildGutterGraph: collapsed ${removedNodes.size} collinear degree-2 nodes`)
    }
  }
    

  return { gutterNodes, gutterEdges }
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
      // Two-stage interior filter:
      //   1. Drop seeds within `minClearance` of the polygon boundary line —
      //      near-boundary seeds produce streets nearly parallel to the
      //      boundary, which create degenerate junction geometry (blown-out
      //      miters, crossing gutter edges).
      //   2. Drop seeds within `params.interval` of any perimeter seed — they
      //      produce tiny slivers next to boundary streets.
      const minClearance = Math.max(STREET_HALF_WIDTH * 2, params.interval * 0.5)
      const perimDistSq = params.interval * params.interval
      const filteredIntSeeds = []
      const droppedByBoundary = []
      const droppedByPerim = []
      for (const s of intSeeds) {
        if (this._distToPolygonBoundary(s.x, s.y, district.polygon) < minClearance) {
          droppedByBoundary.push(s); continue
        }
        let tooClose = false
        for (const p of perimSeeds) {
          const dx = s.x - p.x, dy = s.y - p.y
          if (dx * dx + dy * dy < perimDistSq) { tooClose = true; break }
        }
        if (tooClose) droppedByPerim.push(s)
        else filteredIntSeeds.push(s)
      }
      const seeds = [...perimSeeds, ...filteredIntSeeds]
      const seedsForDebug = [
        ...perimSeeds.map(s => ({ x: s.x, y: s.y, districtId: district.id, kind: 'perimeter' })),
        ...filteredIntSeeds.map(s => ({ x: s.x, y: s.y, districtId: district.id, kind: 'interior' })),
        ...droppedByBoundary.map(s => ({ x: s.x, y: s.y, districtId: district.id, kind: 'dropped' })),
        ...droppedByPerim.map(s => ({ x: s.x, y: s.y, districtId: district.id, kind: 'dropped-perim' })),
      ]

      if (seeds.length < 3) {
        districtResults.push({ districtId: district.id, nodes: [], edges: [], cells: [], seeds: seedsForDebug })
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
        cells,
        seeds: seedsForDebug,
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
    const allSeeds = districtResults.flatMap(r => r.seeds || [])

    resolveStreetCrossings(finalNodes, finalEdges)
    absorbCollinearNodes(finalNodes, finalEdges)
    pruneAcuteStubs(finalNodes, finalEdges)
    removeOrphanComponents(finalNodes, finalEdges)

    let gutterNodes = [], gutterEdges = []
    if (CALC_GUTTERS) {
      ({ gutterNodes, gutterEdges } = buildGutterGraph(finalNodes, finalEdges))
    }

    const byType = finalEdges.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc }, {})
    const typeStr = Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(', ')
    const gutterStr = CALC_GUTTERS ? `${gutterNodes.length} gutter nodes, ${gutterEdges.length} gutter edges` : 'gutter calc DISABLED'
    console.log(`Street graph: ${finalNodes.length} nodes, ${finalEdges.length} edges (${typeStr}), ${allCells.length} Voronoi cells, ${gutterStr}`)
    return { nodes: finalNodes, edges: finalEdges, cells: allCells, seeds: allSeeds, gutterNodes, gutterEdges }
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

  _distToPolygonBoundary(px, py, polygon) {
    let best = Infinity
    const n = polygon.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = polygon[j].x, ay = polygon[j].y
      const bx = polygon[i].x, by = polygon[i].y
      const dx = bx - ax, dy = by - ay
      const lenSq = dx * dx + dy * dy
      if (lenSq === 0) continue
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy)
      if (d < best) best = d
    }
    return best
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
