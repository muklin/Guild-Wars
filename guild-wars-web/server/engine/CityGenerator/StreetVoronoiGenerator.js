import DelaunayTriangulator from '../voronoi/DelaunayTriangulator.js'
import Point from '../voronoi/Point.js'
import { clipToPolygon, triangleCenter, generateGridSeeds, pip, distToSegSq, distToPolygonBoundary, projectToPolygon, segIntersect } from '../voronoi/VoronoiUtils.js'
import { getDistrictConfig } from '../../../shared/districtConfig.js'

// Stable deterministic [0,1) value based on world position — used for gate/bridge probability.
function posHash(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return h - Math.floor(h)
}

const SNAP_THRESHOLD = 0.25   // world units — near-duplicate node merge
const BOUNDARY_INTERVAL = 1.0 // segment length along city boundary edges
export const STREET_HALF_WIDTH = 0.04375  // half road width — must match WorldRenderer thickness / 2
const MIN_STUB_ANGLE_DEG = 30  // dead-end stubs at <this angle to a neighbor are pruned
const MIN_COMPONENT_NODES = 3  // disconnected components below this many nodes are deleted
const COLLINEAR_NODE_MARGIN = 0.4  // a node within this perpendicular distance of an edge interior is absorbed onto that edge

const STREET_PRIORITY = { Wall: 4, Canal: 3, Stone: 2, Brick: 1, Mud: 0 }

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

// Per-district street/block/plot generation tuning now lives in
// shared/districtConfig.js (DISTRICTS[key].params), alongside every other
// per-district-type table (building styles, townhouse probability, landmarks, UI
// colour) — see that file's header for the full field-by-field breakdown and the
// rationale for consolidating them. getDistrictParams() stays as a thin wrapper so
// this file's many internal call sites don't all need to change.
export function getDistrictParams(district) {
  return getDistrictConfig(district).params
}

// Half road width for a district's streets — STREET_HALF_WIDTH scaled by that
// district's street_width factor (1.0 = STREET_HALF_WIDTH, the previous fixed width
// every street used). Falls back to 1.0 for districts/params with no street_width set.
// Exported for CityBlockGenerator's notch-simplification threshold, which needs to
// scale with a district's ACTUAL street width too — see its own comment.
export function halfWidthForDistrict(district) {
  return STREET_HALF_WIDTH * (getDistrictParams(district)?.street_width ?? 1.0)
}

// Snap interior "perimeter" junctions onto the district boundary. A junction
// bridged to a boundary by a street-connect edge but pulled inward (within the
// boundary-seed clearance) leaves a thin uncovered strip between the perimeter
// street and the interior network. Merge each such junction into the boundary
// node it connects to, so its interior streets reach the edge and the strip
// closes. Runs before gutter miters so gutters recompute correctly. Along-edge
// connectivity is handled by the boundary street, so the merged junction's other
// streets radiate inward — no boundary-parallel streets are created.
// Mutates `nodes` and `edges` in place.
function snapPerimeterJunctionsToBoundary(nodes, edges, districts) {
  const ON_BOUNDARY = 0.05
  const nodeById = new Map(nodes.map(n => [n.id, n]))
  const nearestDist = (n) => {
    let best = Infinity, bd = null
    for (const d of districts) {
      const v = distToPolygonBoundary(n.x, n.y, d.polygon)
      if (v < best) { best = v; bd = d }
    }
    return { d: best, district: bd }
  }

  // Collect interior→boundary merge pairs from connect edges.
  const pairs = []
  for (const e of edges) {
    if (!/^street-connect/.test(e.id)) continue
    const a = nodeById.get(e.nodeA), b = nodeById.get(e.nodeB)
    if (!a || !b) continue
    const da = nearestDist(a), db = nearestDist(b)
    let inr, bnd, inrDist, district
    if (da.d < ON_BOUNDARY && db.d >= ON_BOUNDARY) { bnd = a; inr = b; inrDist = db.d; district = da.district }
    else if (db.d < ON_BOUNDARY && da.d >= ON_BOUNDARY) { bnd = b; inr = a; inrDist = da.d; district = db.district }
    else continue
    const clearance = Math.max(STREET_HALF_WIDTH * 2, (getDistrictParams(district).street_spacing ?? 1) * 0.5)
    if (inrDist < clearance) pairs.push({ inr: inr.id, bnd: bnd.id, d: inrDist })
  }
  if (pairs.length === 0) return

  // Merge each interior node into its nearest boundary partner (nearest first;
  // never merge a node twice, never merge two boundary nodes together).
  pairs.sort((p, q) => p.d - q.d)
  const parent = new Map(nodes.map(n => [n.id, n.id]))
  const find = (id) => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id) } return id }
  const merged = new Set()
  for (const p of pairs) {
    if (merged.has(p.inr) || find(p.inr) !== p.inr) continue
    parent.set(p.inr, find(p.bnd))
    merged.add(p.inr)
  }

  // Remap edges in place: redirect endpoints, drop self-loops and duplicates.
  const seen = new Set()
  for (let i = edges.length - 1; i >= 0; i--) {
    const a = find(edges[i].nodeA), b = find(edges[i].nodeB)
    if (a === b) { edges.splice(i, 1); continue }
    const k = a < b ? `${a}_${b}` : `${b}_${a}`
    if (seen.has(k)) { edges.splice(i, 1); continue }
    seen.add(k)
    edges[i] = { ...edges[i], nodeA: a, nodeB: b }
  }
  // Remove merged (non-root) nodes.
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (find(nodes[i].id) !== nodes[i].id) nodes.splice(i, 1)
  }
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
        if (!segIntersect(a, b, c, d)) continue
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

  // Nodes touched by a street-boundary edge are pinned (see the per-edge skip below) —
  // but a NON-boundary edge could still get re-routed THROUGH one of these nodes here,
  // creating a new edge that runs geometrically alongside the (untouched, still-present)
  // boundary edge without being a literal node-pair duplicate of it — escaping the
  // dedup in generate() entirely and rendering as two coincident, z-fighting street
  // meshes. Exclude boundary nodes from absorption candidacy so this can't happen.
  const boundaryNodeIds = new Set()
  for (const e of edges) {
    if (String(e.id).startsWith('street-boundary')) { boundaryNodeIds.add(e.nodeA); boundaryNodeIds.add(e.nodeB) }
  }

  const marginSq = margin * margin
  const newEdges = []
  let chained = 0

  for (const e of edges) {
    // Boundary edges trace the city perimeter and must stay pinned to it. With a
    // wide margin they would otherwise absorb a near-boundary interior node and
    // re-route a→n→b, bulging the boundary street inward (junctions "float inside").
    if (String(e.id).startsWith('street-boundary')) { newEdges.push(e); continue }
    const a = nodeById.get(e.nodeA), b = nodeById.get(e.nodeB)
    if (!a || !b) { newEdges.push(e); continue }
    const dx = b.x - a.x, dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    if (lenSq < 1e-12) { newEdges.push(e); continue }

    const inside = []
    for (const n of nodes) {
      if (n.id === e.nodeA || n.id === e.nodeB) continue
      if (boundaryNodeIds.has(n.id)) continue
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

// Append trade-route roads onto the finished street graph. Each route is a list
// of centreline waypoints in destination→city order (the same fine-cell path the
// client draws). One node is created per waypoint and consecutive nodes are
// joined by Mud edges whose ids start with `trade-` so CityBlockGenerator excludes
// them from blocks/plots. The city end is linked to the nearest existing junction
// (merged onto it when they coincide) so the road joins the network.
// Mutates `nodes` and `edges` in place.
function addTradeRoads(nodes, edges, tradeRoutes, districts = []) {
  if (!tradeRoutes?.length) return
  let nextId = nodes.reduce((m, n) => Math.max(m, n.id), -1) + 1
  const existing = nodes.slice()   // graph nodes present before any trade road
  const MERGE_DIST = 0.3
  let added = 0

  // Only allow waypoints inside the city (inside any district polygon).
  // Routes run destination→city, so external waypoints are at the start.
  const districtPolys = districts.map(d => d.polygon || d.boundary || [])
  const inCity = (p) => !districtPolys.length || districtPolys.some(poly => pip(p.x, p.y, poly))

  for (let ri = 0; ri < tradeRoutes.length; ri++) {
    const route = tradeRoutes[ri]
    if (!route || route.length < 2) continue

    // Clip: keep only the city-interior portion plus the boundary entry point (last wp).
    const boundary = route[route.length - 1]
    const interior = route.slice(0, -1).filter(wp => inCity(wp))
    const clipped = [...interior, boundary]

    // Nearest existing junction to the city end (last clipped waypoint).
    const cityPt = clipped[clipped.length - 1]
    let link = null, bestSq = Infinity
    for (const n of existing) {
      const d = (n.x - cityPt.x) ** 2 + (n.y - cityPt.y) ** 2
      if (d < bestSq) { bestSq = d; link = n }
    }
    const mergeEnd = link && bestSq <= MERGE_DIST * MERGE_DIST

    // One node per clipped waypoint; terminate on the existing junction if it coincides.
    const wpNodes = []
    const count = mergeEnd ? clipped.length - 1 : clipped.length
    for (let i = 0; i < count; i++) {
      const node = { id: nextId++, x: clipped[i].x, y: clipped[i].y }
      nodes.push(node)
      wpNodes.push(node)
    }
    if (mergeEnd) wpNodes.push(link)

    for (let i = 0; i < wpNodes.length - 1; i++) {
      edges.push({ id: `trade-${ri}-${i}`, nodeA: wpNodes[i].id, nodeB: wpNodes[i + 1].id, type: 'Mud' })
    }
    if (!mergeEnd && link) {
      edges.push({ id: `trade-${ri}-link`, nodeA: wpNodes[wpNodes.length - 1].id, nodeB: link.id, type: 'Mud' })
    }
    added++
  }
  if (added > 0) console.log(`addTradeRoads: appended ${added} trade road(s) to the street graph`)
}

// Build junction-centric street graph with mitered gutter corners.
// Each junction stores its centerpoint, type, districtId, and a connection
// per adjacent road. Each connection stores the mitered gutterLeft/gutterRight
// corners at THIS junction's end of that road — the exact points where this
// road's parallel offset lines intersect the adjacent roads' offset lines.
//
// This is a server-side port of PolylineRenderer._computeJunctionData (lines
// 150–241). The miter geometry is stored here so CityBlockGenerator can trace
// block faces from gutter corners without any client-side math.
// Beyond a pair's miter limit (8x the wider of the two streets' half-width), bevel
// instead of spiking — see the per-pair computation below.

function buildJunctions(streetNodes, streetEdges) {
  const nodeById = new Map(streetNodes.map(n => [n.id, n]))

  // Build adjacency: nodeId → [{ roadId, toId, type, halfWidth, districtId, left?, right?, edgeKind? }]
  const adj = new Map(streetNodes.map(n => [n.id, []]))
  for (const e of streetEdges) {
    const base = { roadId: e.id, type: e.type, halfWidth: e.halfWidth ?? STREET_HALF_WIDTH }
    if (e.left !== undefined) {
      // Boundary edge — carries left/right district ids and optional edgeKind
      adj.get(e.nodeA)?.push({ ...base, toId: e.nodeB, left: e.left, right: e.right, edgeKind: e.edgeKind })
      adj.get(e.nodeB)?.push({ ...base, toId: e.nodeA, left: e.left, right: e.right, edgeKind: e.edgeKind })
    } else {
      adj.get(e.nodeA)?.push({ ...base, toId: e.nodeB, districtId: e.districtId })
      adj.get(e.nodeB)?.push({ ...base, toId: e.nodeA, districtId: e.districtId })
    }
  }

  const junctions = []

  for (const node of streetNodes) {
    const neighbors = adj.get(node.id) || []

    // Junction type = highest-priority adjacent edge.
    // Boundary info (left/right/edgeKind) is collected separately — it must not be
    // overwritten when a higher-priority interior edge wins the type contest.
    let jType = 'Mud', jDistrictId = null, jLeft, jRight, jEdgeKind
    for (const nb of neighbors) {
      if ((STREET_PRIORITY[nb.type] ?? 0) >= (STREET_PRIORITY[jType] ?? 0)) {
        jType = nb.type
        jDistrictId = nb.districtId
      }
      if (nb.left !== undefined && jLeft === undefined) {
        jLeft = nb.left
        jRight = nb.right
        jEdgeKind = nb.edgeKind
      }
    }

    const junction = { id: node.id, x: node.x, y: node.y, type: jType, connections: [] }
    if (jLeft !== undefined) {
      junction.left = jLeft
      junction.right = jRight ?? null
      if (jEdgeKind !== undefined) junction.edgeKind = jEdgeKind
    } else {
      junction.districtId = jDistrictId
    }

    // Compute unit outgoing vectors for each neighbor
    const edgeData = []
    for (const nb of neighbors) {
      const other = nodeById.get(nb.toId)
      if (!other) continue
      const dx = other.x - node.x, dy = other.y - node.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < 1e-10) continue
      const ed = { roadId: nb.roadId, toId: nb.toId, type: nb.type, halfWidth: nb.halfWidth, ux: dx / len, uy: dy / len }
      if (nb.left !== undefined) {
        ed.left = nb.left; ed.right = nb.right ?? null
        if (nb.edgeKind !== undefined) ed.edgeKind = nb.edgeKind
      } else {
        ed.districtId = nb.districtId
      }
      edgeData.push(ed)
    }

    // Sort by angle (matches PolylineRenderer._computeJunctionData sort)
    edgeData.sort((a, b) => Math.atan2(a.uy, a.ux) - Math.atan2(b.uy, b.ux))
    const n = edgeData.length

    // All gutter offsets at THIS junction use the WIDEST connecting street's half-width,
    // not each edge's own — per-edge widths sounded right in isolation, but at a
    // junction where streets of different widths meet, offsetting each by its own width
    // puts adjacent gutter points at wildly different distances from the junction
    // centre, so the gutter ring connecting them zigzags instead of forming a clean
    // loop. CityBlockGenerator traces block polygons directly from that ring, so every
    // zigzag became a real notch baked into block/plot boundaries — thin streets not
    // "connecting" cleanly and buildings overlapping the street. Real road junctions
    // widen to match their busiest connecting road anyway; each street still tapers
    // back to its own true width away from the junction (the OTHER end uses that
    // junction's own widest-edge width, which can be different/narrower).
    //
    // KNOWN REMAINING ISSUE: that taper happens over the road's whole length (this
    // junction's width at one end, a DIFFERENT junction's width at the other), with no
    // gradual interpolation in between — just two different-width quad ends. At extreme
    // width ratios (e.g. a Residential-Noble junction at 2.5x next to a Slums junction
    // at 0.8x on a SHORT connecting segment) the two offset lines can cross before
    // reaching the far end, producing a self-intersecting "bowtie" road quad — visible
    // as roads that appear to cross each other. The cap below bounds the worst case
    // (a single very-wide outlier district can no longer drag a junction's width past
    // 4x baseline) but doesn't fully solve it — a real fix needs the segment mesh itself
    // to taper gradually along its length, not just pick one width per end.
    const widest = Math.max(...edgeData.map(e => e.halfWidth), STREET_HALF_WIDTH)
    const junctionHalfWidth = Math.min(widest, STREET_HALF_WIDTH * 4)

    // Compute miter slots for each consecutive edge pair (A, B), both offset by the
    // shared junctionHalfWidth above. If the A-left / B-right lines intersect within
    // the miter limit (8x junctionHalfWidth): use that miter point. Otherwise bevel:
    // keep q1 and q2 separate.
    const slots = new Array(n)
    const miterLimit = junctionHalfWidth * 8
    const limitSq = miterLimit * miterLimit
    for (let i = 0; i < n; i++) {
      const A = edgeData[i], B = edgeData[(i + 1) % n]
      const q1 = { x: node.x - A.uy * junctionHalfWidth, y: node.y + A.ux * junctionHalfWidth }  // A left
      const q2 = { x: node.x + B.uy * junctionHalfWidth, y: node.y - B.ux * junctionHalfWidth }  // B right
      const denom = A.ux * B.uy - A.uy * B.ux
      if (Math.abs(denom) < 1e-8) {
        slots[i] = { q1, q2 }
        continue
      }
      const t = ((q2.x - q1.x) * B.uy - (q2.y - q1.y) * B.ux) / denom
      const px = q1.x + t * A.ux, py = q1.y + t * A.uy
      const mdx = px - node.x, mdy = py - node.y
      if (mdx * mdx + mdy * mdy <= limitSq) {
        const miter = { x: px, y: py }
        slots[i] = { q1: miter, q2: miter }
      } else {
        slots[i] = { q1, q2 }
      }
    }

    // Assign gutterLeft/gutterRight to each connection.
    // trueLeft  of edge i = slots[i].q1         (left offset at this node along edge i)
    // trueRight of edge i = slots[(i-1+n)%n].q2 (right offset, from the previous slot)
    for (let i = 0; i < n; i++) {
      const conn = {
        toId:        edgeData[i].toId,
        roadId:      edgeData[i].roadId,
        type:        edgeData[i].type,
        gutterLeft:  slots[i].q1,
        gutterRight: slots[(i - 1 + n) % n].q2,
      }
      if (edgeData[i].left !== undefined) {
        conn.left = edgeData[i].left
        conn.right = edgeData[i].right ?? null
        if (edgeData[i].edgeKind !== undefined) conn.edgeKind = edgeData[i].edgeKind
      } else {
        conn.districtId = edgeData[i].districtId
      }
      junction.connections.push(conn)
    }

    junctions.push(junction)
  }

  return junctions
}

export default class StreetVoronoiGenerator {

  // `districts` may be a subset of the city's districts (e.g. only the locked ones
  // during per-district City Subdivision). City edges touching no district in the
  // subset are skipped, so boundaries to not-yet-generated districts are deferred.
  generate(districts, cityEdges, edgePoints, epochSeed = 0, tradeRoutes = []) {
    const districtResults = []
    let nextNodeId = 0
    const edgePointById = new Map((edgePoints || []).map(p => [p.id, p]))
    const districtById = new Map(districts.map(d => [d.id, d]))
    const districtIdSet = new Set(districts.map(d => d.id))

    // ── Per-district micro-Voronoi ───────────────────────────────────────────
    for (const district of districts) {
      const streetType = streetTypeForDistrict(district)
      const params = getDistrictParams(district)
      const metric = params.metric ?? 'euclidean'

      // Collect Wall/Canal/MainRoad boundary segments adjacent to this district so
      // _samplePerimeter skips intermediate seeds on them. The boundary-node loop
      // already places fixed nodes there at BOUNDARY_INTERVAL; extra perimeter seeds
      // would add unintended junctions on the boundary chain.
      const fixedBoundarySegments = []
      for (const cityEdge of Object.values(cityEdges || {})) {
        const isTypedBoundary = cityEdge.assignedType === 'Wall' || cityEdge.assignedType === 'Canal' || cityEdge.assignedType === 'MainRoad'
        if (!isTypedBoundary) continue
        if (cityEdge.districtA !== district.id && cityEdge.districtB !== district.id) continue
        const pts = (cityEdge.pointIds || []).map(id => edgePointById.get(id)).filter(Boolean)
        for (let i = 0; i < pts.length - 1; i++) {
          fixedBoundarySegments.push([pts[i], pts[i + 1]])
        }
      }

      const perimSeeds = this._samplePerimeter(district.polygon, params.street_spacing, fixedBoundarySegments)
      // Per-district street seed (frozen at lock); falls back to the legacy global form.
      const districtSeed = district.streetSeed ?? (district.id ^ epochSeed)
      const intSeeds   = generateGridSeeds(district.polygon, params.block_density, params.xyRatio ?? 1.0, 0.3, districtSeed)
      // Two-stage interior filter:
      //   1. Drop seeds within `minClearance` of the polygon boundary line —
      //      near-boundary seeds produce streets nearly parallel to the
      //      boundary, which create degenerate junction geometry (blown-out
      //      miters, crossing gutter edges).
      //   2. Drop seeds within `params.street_spacing` of any perimeter seed — they
      //      produce tiny slivers next to boundary streets.
      const minClearance = Math.max(STREET_HALF_WIDTH * 2, params.street_spacing * 0.5)
      const perimDistSq = params.street_spacing * params.street_spacing
      const filteredIntSeeds = []
      const droppedByBoundary = []
      const droppedByPerim = []
      for (const s of intSeeds) {
        if (distToPolygonBoundary(s.x, s.y, district.polygon) < minClearance) {
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
        if (!pip(cx, cy, district.polygon)) {
          const p = projectToPolygon(cx, cy, district.polygon)
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
        if (!pip(mx, my, district.polygon)) continue

        const nA = getOrCreateNode(cA.x, cA.y)
        const nB = getOrCreateNode(cB.x, cB.y)
        distEdges.push({
          id: `street-${district.id}-${distEdges.length}`,
          nodeA: nA.id,
          nodeB: nB.id,
          type: streetType,
          districtId: district.id,
          halfWidth: halfWidthForDistrict(district),
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
    // Segmented at BOUNDARY_INTERVAL so they match the interior street block_density.
    // Each city edge's sampled points become first-class street graph nodes,
    // and consecutive nodes become street edges — same store, same render, same pathing.
    // All edge types are processed so that the face tracer in CityBlockGenerator
    // can detect blocks that touch any district boundary, not just Mud ones.
    const boundaryNodeByPtId = new Map()   // actual edgePoint id → node
    const boundaryNodes = []
    const boundaryEdges = []
    const boundaryNodesByEdge = new Map()  // edgeId → [node, ...]  (all nodes incl. interp.)

    for (const [edgeId, cityEdge] of Object.entries(cityEdges)) {
      // Skip boundaries touching no generated district — defer them until a side joins.
      if (!districtIdSet.has(cityEdge.districtA) && !districtIdSet.has(cityEdge.districtB)) continue
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

      // Edge type: Mud/untyped → better of the two adjacent district street types.
      // Wall → 'Wall' type (rendered as wall mesh, not a road).
      // MainRoad → 'Stone' (it is a road).
      // Canal/Docks and any other named type → keep their city edge type.
      let boundaryType
      if (!cityEdge.assignedType || cityEdge.assignedType === 'Mud') {
        const typeA = streetTypeForDistrict(districtById.get(cityEdge.districtA))
        const typeB = streetTypeForDistrict(districtById.get(cityEdge.districtB))
        boundaryType = betterStreetType(typeA, typeB)
      } else if (cityEdge.assignedType === 'Wall') {
        boundaryType = 'Wall'
      } else if (cityEdge.assignedType === 'MainRoad') {
        boundaryType = 'Stone'
      } else {
        boundaryType = cityEdge.assignedType
      }

      // Wall/Canal/MainRoad boundaries carry left/right district ids and edgeKind
      // so the renderer and pathfinder can identify them without cityDistrictData.edges.
      const edgeKind = (cityEdge.assignedType === 'Wall' || cityEdge.assignedType === 'Canal' || cityEdge.assignedType === 'MainRoad')
        ? cityEdge.assignedType : undefined

      // Boundary streets sit between two districts (or one district and the city
      // edge, when districtB is unset) — average each side's street_width so a
      // wide-streets district and a narrow-streets district meet at a sensible
      // shared gutter width instead of jumping at the boundary.
      const leftHalfWidth = halfWidthForDistrict(districtById.get(cityEdge.districtA))
      const rightHalfWidth = cityEdge.districtB != null ? halfWidthForDistrict(districtById.get(cityEdge.districtB)) : leftHalfWidth
      const boundaryHalfWidth = (leftHalfWidth + rightHalfWidth) / 2

      for (let i = 0; i < ordered.length - 1; i++) {
        const edge = {
          id: `street-boundary-${edgeId}-${i}`,
          nodeA: ordered[i].id,
          nodeB: ordered[i + 1].id,
          type: boundaryType,
          left: cityEdge.districtA,
          right: cityEdge.districtB ?? null,
          halfWidth: boundaryHalfWidth,
        }
        if (edgeKind !== undefined) edge.edgeKind = edgeKind
        boundaryEdges.push(edge)
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
      // Skip the first and last nodes — those are the corner vertices where two
      // city edges meet. Connecting interior streets to corner nodes causes
      // streets to exit at polygon corners, creating high-aspect-ratio blocks.
      const connectNodes = bNodes.slice(1, -1)

      for (const districtId of [dA, dB]) {
        if (districtId == null) continue
        const distNodes = nodesByDistrict.get(districtId) || []
        if (!distNodes.length) continue

        for (const bn of connectNodes) {
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
              finalEdges.push({ id: `street-connect-${connectIdx++}`, nodeA: bestId, nodeB: bId, type: connectType, districtId, halfWidth: halfWidthForDistrict(districtById.get(districtId)) })
            }
          }
        }
      }
    }

    const allCells = districtResults.flatMap(r => r.cells || [])
    const allSeeds = districtResults.flatMap(r => r.seeds || [])

    snapPerimeterJunctionsToBoundary(finalNodes, finalEdges, districts)
    resolveStreetCrossings(finalNodes, finalEdges)
    absorbCollinearNodes(finalNodes, finalEdges)
    pruneAcuteStubs(finalNodes, finalEdges)
    removeOrphanComponents(finalNodes, finalEdges)

    // Trade roads are appended after cleanup so the long external run isn't pruned
    // as a stub/orphan; they link into the finished graph at the nearest junction.
    addTradeRoads(finalNodes, finalEdges, tradeRoutes, districts)

    const junctions = buildJunctions(finalNodes, finalEdges)

    // ── Mark wall/canal features on boundary junctions ───────────────────────
    // Barbican: junction where MainRoad meets Wall (endpoint of a MainRoad through a Wall).
    // Gate:     Wall junction, probability based on district types on each side.
    // Bridge:   Canal junction, same probability logic.
    for (const j of junctions) {
      const connKinds = new Set((j.connections || []).map(c => c.edgeKind).filter(Boolean))
      if (!connKinds.size) continue

      if (connKinds.has('MainRoad') && connKinds.has('Wall')) {
        j.wallFeature = 'barbican'
        continue
      }
      if (connKinds.has('Wall')) {
        const wc = j.connections.find(c => c.edgeKind === 'Wall')
        const leftType  = districtById.get(wc?.left  ?? j.left)?.assignedType
        const right     = wc?.right  ?? j.right
        const rightType = right != null ? districtById.get(right)?.assignedType : null
        const chance    = right === null ? 0.01 : (leftType && leftType === rightType ? 0.80 : 0.30)
        if (posHash(j.x, j.y) < chance) j.wallFeature = 'gate'
      }
      if (connKinds.has('Canal')) {
        const cc = j.connections.find(c => c.edgeKind === 'Canal')
        const leftType  = districtById.get(cc?.left  ?? j.left)?.assignedType
        const right     = cc?.right  ?? j.right
        const rightType = right != null ? districtById.get(right)?.assignedType : null
        const chance    = right === null ? 0.01 : (leftType && leftType === rightType ? 0.80 : 0.30)
        if (posHash(j.x, j.y) < chance) j.canalFeature = 'bridge'
      }
    }

    const byType = finalEdges.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc }, {})
    const typeStr = Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(', ')
    console.log(`Street graph: ${junctions.length} junctions (${typeStr}), ${allCells.length} Voronoi cells`)
    return { junctions, cells: allCells, seeds: allSeeds }
  }

  // Perimeter seeds with canonical direction on each edge so shared district
  // boundaries produce identical intermediate seed positions in both districts.
  // fixedBoundarySegments: [[ptA, ptB], ...] — Wall/Canal/MainRoad boundary segments
  // where intermediate seeding is suppressed (boundary-node loop handles those).
  _samplePerimeter(polygon, street_spacing, fixedBoundarySegments = []) {
    const seeds = []
    const n = polygon.length
    for (let i = 0; i < n; i++) {
      const v1 = polygon[i]
      const v2 = polygon[(i + 1) % n]

      // Always seed each polygon CORNER, regardless of street_spacing/edge length — a
      // small or oddly-shaped district can have every edge shorter than street_spacing,
      // which used to mean zero perimeter seeds (and, combined with interior seeds also
      // getting filtered out near such a tight boundary, zero seeds overall): generate()
      // silently skips a district once its seed count drops below 3, leaving it with no
      // streets/blocks/plots at all — a flat district-coloured polygon and nothing else.
      // The polygon always has >=3 vertices, so seeding every corner guarantees this
      // floor is never hit purely from being small, while leaving normal-sized
      // districts' street layout unaffected (these corner seeds collapse into the
      // existing boundary nodes via the SNAP_THRESHOLD merge later in generate()).
      seeds.push({ x: v1.x, y: v1.y })

      // Skip intermediate seeds on Wall/Canal/MainRoad boundary segments — those
      // already have fixed boundary nodes from the boundary-expansion loop.
      const isFixed = fixedBoundarySegments.some(([fa, fb]) => {
        const dFwd = Math.hypot(v1.x - fa.x, v1.y - fa.y) + Math.hypot(v2.x - fb.x, v2.y - fb.y)
        const dRev = Math.hypot(v1.x - fb.x, v1.y - fb.y) + Math.hypot(v2.x - fa.x, v2.y - fa.y)
        return Math.min(dFwd, dRev) < 0.01
      })
      if (isFixed) continue

      const dx = v2.x - v1.x, dy = v2.y - v1.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < street_spacing) continue

      const [sa, sb] = this._canonicalOrder(v1, v2)
      const cdx = sb.x - sa.x, cdy = sb.y - sa.y
      const clen = Math.sqrt(cdx * cdx + cdy * cdy)
      const steps = Math.floor(clen / street_spacing)
      for (let k = 1; k <= steps; k++) {
        const t = (k * street_spacing) / clen
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

}
