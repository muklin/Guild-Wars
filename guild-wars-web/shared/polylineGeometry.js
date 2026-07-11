// Pure geometry for a constant-half-width stroke along a chain of points, with proper
// miter/bevel joints at interior vertices and at shared junction endpoints (2+ edges
// meeting at the same point, fan-capped when 3+). No THREE.js/DOM dependency — safe to
// import from both client (PolylineRenderer.js, which owns turning this into meshes)
// and server (SetupPhase.js's river/cliff pullback, see plan "typed-giggling-giraffe":
// using this SAME computation to place terrain-plot split vertices, instead of pullback
// independently re-deriving its own miter/width math, is what guarantees the pulled-back
// terrain data and the rendered stroke agree by construction — no separate width-
// reconciliation pass needed, and junctions with 3+ incident edges are handled the same
// mature way here as they already are for rendering).
//
// edges format: { [edgeId]: { pointIds: [id, ...], ... } }
// pointsById: Map<id, {x, y}> (or anything with a matching .get(id) -> {x,y})

// For every junction point shared by 2+ edges, compute each incident edge's own
// left/right boundary point AT that junction — mitered to a single point when the two
// adjacent edges' miter intersection stays within miterLimitDist of the joint, beveled
// (two distinct boundary points) otherwise. Also collects fan-cap data (a star-shaped
// polygon around the junction centre) for every 3+-way junction, via fillsOut.
//
// r: half-width. miterLimitDist: world-distance ceiling for the miter point's distance
// from the joint — beyond it, the corner bevels instead of spiking arbitrarily far (an
// unbounded miter distance was confirmed as the direct cause of black-spike rendering
// bugs at narrow-angle junctions).
// fillsOut: a Map this function populates (ptId -> {boundaryPts, edgeIds, center}) for
// every 3+-way junction — pass a fresh Map if you need fan-cap data, or omit/reuse a
// throwaway Map if you only need the per-edge boundary overrides.
//
// Returns: Map<`${edgeId}_${ptId}`, {trueLeft:{x,y}, trueRight:{x,y}}>
export function computeJunctionData(edges, pointsById, r, miterLimitDist, fillsOut = new Map()) {
  const result = new Map()

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
    if (edgeList.length < 2) continue

    const jPt = pointsById.get(ptId)
    if (!jPt || !isFinite(jPt.x)) continue

    const edgeData = []
    for (const { edgeId, edge, atStart } of edgeList) {
      const pts = edge.pointIds.map(id => pointsById.get(id)).filter(Boolean)
      if (pts.length < 2) continue
      let dx, dy
      if (atStart) {
        dx = pts[1].x - pts[0].x; dy = pts[1].y - pts[0].y
      } else {
        const n = pts.length - 1
        dx = pts[n - 1].x - pts[n].x; dy = pts[n - 1].y - pts[n].y
      }
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < 1e-10) continue
      edgeData.push({ edgeId, ux: dx / len, uy: dy / len })
    }
    if (edgeData.length < 2) continue

    edgeData.sort((a, b) => Math.atan2(a.uy, a.ux) - Math.atan2(b.uy, b.ux))
    const n = edgeData.length
    const limitSq = miterLimitDist * miterLimitDist

    const slots = new Array(n)
    for (let i = 0; i < n; i++) {
      const A = edgeData[i], B = edgeData[(i + 1) % n]
      const q1 = { x: jPt.x - A.uy * r, y: jPt.y + A.ux * r }
      const q2 = { x: jPt.x + B.uy * r, y: jPt.y - B.ux * r }
      const denom = A.ux * B.uy - A.uy * B.ux
      if (Math.abs(denom) < 1e-8) {
        const capPt = { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 }
        slots[i] = { q1, q2, capPt }
        continue
      }
      const t = ((q2.x - q1.x) * B.uy - (q2.y - q1.y) * B.ux) / denom
      const px = q1.x + t * A.ux, py = q1.y + t * A.uy
      const mdx = px - jPt.x, mdy = py - jPt.y
      if (mdx * mdx + mdy * mdy <= limitSq) {
        const miter = { x: px, y: py }
        slots[i] = { q1: miter, q2: miter, capPt: miter }
      } else {
        slots[i] = { q1, q2, capPt: { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 } }
      }
    }

    for (let i = 0; i < n; i++) {
      result.set(`${edgeData[i].edgeId}_${ptId}`, {
        trueLeft: slots[i].q1,
        trueRight: slots[(i - 1 + n) % n].q2,
      })
    }

    if (n >= 3) fillsOut.set(ptId, {
      boundaryPts: slots.map(s => s.capPt),
      edgeIds: new Set(edgeData.map(e => e.edgeId)),
      center: { x: jPt.x, y: jPt.y },
    })
  }

  return result
}

// Per-vertex left/right boundary corners along ONE edge's own point chain. Endpoints
// (i===0, i===n-1) use the junction override from computeJunctionData when available
// (so they agree exactly with however that shared joint was resolved — mitered or
// beveled — rather than each edge independently computing its own simple perpendicular
// offset there); interior vertices always use a local two-segment miter, clamped to
// miterLimitDist same as the junction case (see that function's doc comment for why an
// unbounded miter is a real, confirmed bug).
//
// edge: { pointIds: [id, ...] } (or { vertices: [{x,y},...] } as a fallback — no
// junction-override support in that shape, since overrides are keyed by point id).
// overrides: the Map computeJunctionData returned (or an empty Map if this edge's own
// endpoints aren't shared junctions).
//
// Returns: Array<{left:{x,y}, right:{x,y}} | null> — one entry per input vertex, in
// order; null wherever the corner couldn't be computed (missing/coincident point).
export function computeEdgeCorners(edge, edgeId, overrides, pointsById, r, miterLimitDist) {
  const points = edge.pointIds
    ? edge.pointIds.map(id => pointsById.get(id)).filter(Boolean)
    : edge.vertices
  if (!points || points.length < 2) return null

  const ptIds = edge.pointIds || []
  const startOvr = overrides.get(`${edgeId}_${ptIds[0]}`)
  const endOvr = overrides.get(`${edgeId}_${ptIds[ptIds.length - 1]}`)
  const n = points.length

  const lineIsect = (q1x, q1y, d1x, d1y, q2x, q2y, d2x, d2y) => {
    const denom = d1x * d2y - d1y * d2x
    if (Math.abs(denom) < 1e-8) return { x: (q1x + q2x) / 2, y: (q1y + q2y) / 2 }
    const t = ((q2x - q1x) * d2y - (q2y - q1y) * d2x) / denom
    return { x: q1x + t * d1x, y: q1y + t * d1y }
  }

  const clampToLimit = (p, cx, cy) => {
    const ddx = p.x - cx, ddy = p.y - cy
    const d = Math.hypot(ddx, ddy)
    if (d <= miterLimitDist || d < 1e-10) return p
    const s = miterLimitDist / d
    return { x: cx + ddx * s, y: cy + ddy * s }
  }

  const corners = []
  for (let i = 0; i < n; i++) {
    const pt = points[i]
    if (!pt || !isFinite(pt.x)) { corners.push(null); continue }

    if (i === 0) {
      if (startOvr) {
        corners.push({ left: startOvr.trueLeft, right: startOvr.trueRight })
      } else {
        const p2 = points[1]
        if (!p2 || !isFinite(p2.x)) { corners.push(null); continue }
        const dx = p2.x - pt.x, dy = p2.y - pt.y, len = Math.sqrt(dx * dx + dy * dy)
        if (len < 1e-10) { corners.push(null); continue }
        const ux = dx / len, uy = dy / len
        corners.push({ left: { x: pt.x - uy * r, y: pt.y + ux * r }, right: { x: pt.x + uy * r, y: pt.y - ux * r } })
      }
    } else if (i === n - 1) {
      if (endOvr) {
        corners.push({ left: endOvr.trueRight, right: endOvr.trueLeft })
      } else {
        const p0 = points[n - 2]
        if (!p0 || !isFinite(p0.x)) { corners.push(null); continue }
        const dx = pt.x - p0.x, dy = pt.y - p0.y, len = Math.sqrt(dx * dx + dy * dy)
        if (len < 1e-10) { corners.push(null); continue }
        const ux = dx / len, uy = dy / len
        corners.push({ left: { x: pt.x - uy * r, y: pt.y + ux * r }, right: { x: pt.x + uy * r, y: pt.y - ux * r } })
      }
    } else {
      const p0 = points[i - 1], p2 = points[i + 1]
      if (!p0 || !p2 || !isFinite(p0.x) || !isFinite(p2.x)) { corners.push(null); continue }
      const dx1 = pt.x - p0.x, dy1 = pt.y - p0.y, len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1)
      const dx2 = p2.x - pt.x, dy2 = p2.y - pt.y, len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2)
      if (len1 < 1e-10 || len2 < 1e-10) { corners.push(null); continue }
      const ux1 = dx1 / len1, uy1 = dy1 / len1
      const ux2 = dx2 / len2, uy2 = dy2 / len2
      const rawLeft = lineIsect(pt.x - uy1 * r, pt.y + ux1 * r, ux1, uy1, pt.x - uy2 * r, pt.y + ux2 * r, ux2, uy2)
      const rawRight = lineIsect(pt.x + uy1 * r, pt.y - ux1 * r, ux1, uy1, pt.x + uy2 * r, pt.y - ux2 * r, ux2, uy2)
      corners.push({
        left: clampToLimit(rawLeft, pt.x, pt.y),
        right: clampToLimit(rawRight, pt.x, pt.y),
      })
    }
  }

  return corners
}
