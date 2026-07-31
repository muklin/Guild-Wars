// Terrain-wide Catmull-Clark subdivision (ADR-0022, Stage 1). Replaces the per-plot Hills
// subdivision (plan "shimmering-wondering-flurry") with a SINGLE welded, subdivided
// manifold mesh over every terrain plot at once — adjacent plots already share their
// boundary Point ids in the registry (they are one connected tessellation), so subdividing
// them together makes every shared seam an INTERIOR edge Catmull-Clark averages across:
// smooth valleys by construction, instead of the hard V-crease per-plot subdivision left
// at every seam (a boundary edge pinned on both sides — confirmed live 2026-07-26).
//
// Non-mutating: the generative-layer 'terrain' Points are the edit source and must NOT be
// moved here (they are read every pass and, per ADR-0022, are the layer discarded on
// leaving Terrain mode). Every output vertex — moved original, face-point, edge-point — is
// a FRESH 'terrain-subdiv' Point, so the coarse layer stays pristine while the subdivided
// mesh is a parallel, authoritative set of Surfaces. 'terrain-subdiv' is ephemeral, cleared
// and rebuilt on every subdivide pass (same discipline as 'terrain-split').
import { TERRAIN_SUBDIVISION_PASSES } from '../../../worldConfig/terrainConfig.js'

const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`)

// Ear-clipping triangulation, returning index triples into `poly` (a [{x,y}] ring).
// Handles concave polygons — the whole reason terrain subdivision triangulates each plot
// before subdividing: a concave outer-ring Voronoi cell subdivided as a centroid-fan pushes
// its corner quads OUTSIDE the cell into a neighbour (confirmed live 2026-07-26 as real
// AREA_OVERLAP, up to ~1 unit²). Every triangle is convex, so its own subdivision never
// pokes out. Ported from the client's renderUtils.triangulatePolygon (kept a server-local
// copy rather than importing across the client/server boundary).
function triangulate(poly) {
  const origIndex = []
  const pts = []
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], prev = pts[pts.length - 1]
    if (prev && (p.x - prev.x) ** 2 + (p.y - prev.y) ** 2 < 1e-12) continue
    pts.push(p); origIndex.push(i)
  }
  if (pts.length > 1) {
    const first = pts[0], last = pts[pts.length - 1]
    if ((first.x - last.x) ** 2 + (first.y - last.y) ** 2 < 1e-12) { pts.pop(); origIndex.pop() }
  }
  const n = pts.length
  if (n < 3) return []
  if (n === 3) return [[origIndex[0], origIndex[1], origIndex[2]]]
  let area = 0
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a.x * b.y - b.x * a.y }
  const ccw = area > 0
  const cross = (o, x, y) => (x.x - o.x) * (y.y - o.y) - (x.y - o.y) * (y.x - o.x)
  const inTri = (p, a, b, c) => {
    const d1 = cross(p, a, b), d2 = cross(p, b, c), d3 = cross(p, c, a)
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
  }
  const turn = (a, b, c) => (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
  const idx = Array.from({ length: n }, (_, i) => i)
  const tris = []
  let guard = 0
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false
    for (let i = 0; i < idx.length; i++) {
      const iPrev = idx[(i - 1 + idx.length) % idx.length], iCurr = idx[i], iNext = idx[(i + 1) % idx.length]
      const a = pts[iPrev], b = pts[iCurr], c = pts[iNext]
      const cr = turn(a, b, c)
      if (!(ccw ? cr > 1e-12 : cr < -1e-12)) continue
      let any = false
      for (const j of idx) { if (j === iPrev || j === iCurr || j === iNext) continue; if (inTri(pts[j], a, b, c)) { any = true; break } }
      if (any) continue
      tris.push([iPrev, iCurr, iNext]); idx.splice(i, 1); clipped = true; break
    }
    if (!clipped) break
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]])
  return tris.map(([a, b, c]) => [origIndex[a], origIndex[b], origIndex[c]])
}

// True area-weighted centroid (not a plain vertex average — the two differ for any
// non-regular polygon, which every Voronoi terrain plot here is). Falls back to the plain
// vertex average for a degenerate (near-zero-area) polygon.
function polygonCentroid(poly) {
  let signedArea = 0, cx = 0, cy = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    const cross = p.x * q.y - q.x * p.y
    signedArea += cross
    cx += (p.x + q.x) * cross
    cy += (p.y + q.y) * cross
  }
  signedArea /= 2
  if (Math.abs(signedArea) < 1e-9) {
    let x = 0, y = 0
    for (const p of poly) { x += p.x; y += p.y }
    return { x: x / poly.length, y: y / poly.length }
  }
  return { x: cx / (6 * signedArea), y: cy / (6 * signedArea) }
}

function pointInPolygon(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y
    if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

function avgPos(pts) {
  let x = 0, y = 0, z = 0
  for (const p of pts) { x += p.x; y += p.y; z += p.z ?? 0 }
  const n = pts.length || 1
  return { x: x / n, y: y / n, z: z / n }
}

// Height-only Catmull-Clark over an arbitrary face list, producing an all-new point set
// (never mutating the input vertices). `faces` is [{ vertexIds, meta }] — meta is copied
// verbatim onto every quad that face becomes.
//
// XY is subdivided LINEARLY (vertices unchanged, edge-points at the plain midpoint, face-
// points at the centroid); only Z carries the Catmull-Clark smoothing. This is deliberate:
// full Catmull-Clark moves vertices in XY too, which at an irregular/high-valence Voronoi
// vertex folds the top-down projection and makes two adjacent plots' corner quads overlap
// in area (confirmed live 2026-07-26: a handful of AREA_OVERLAP findings between quads
// sharing a single corner). Terrain is a height field — the rolling relief we want lives
// entirely in Z, and pinning XY to a plain linear subdivision keeps the tessellation
// exactly as manifold as the coarse plots were (a linear subdivision of a simple polygon
// never self-overlaps) while Z still smooths valleys and hills across every seam. Boundary
// edges (one incident face — the world's outer rim) keep their Z pinned too, so the map
// edge never lifts/creeps. Returns [{ pointIds, polygon, meta }], every n-gon → n quads.
export function catmullClarkFresh(registry, faces, kind) {
  if (!faces.length) return []

  const edgeFaces = new Map()   // key -> { a, b, faceIdxs: [] }
  faces.forEach((f, fi) => {
    const ids = f.vertexIds, n = ids.length
    for (let i = 0; i < n; i++) {
      const a = ids[i], b = ids[(i + 1) % n]
      if (a === b) continue
      const key = edgeKey(a, b)
      let e = edgeFaces.get(key)
      if (!e) { e = { a, b, faceIdxs: [] }; edgeFaces.set(key, e) }
      e.faceIdxs.push(fi)
    }
  })

  // Face-points: xy = true area-weighted centroid (matches standard Catmull-Clark — see
  // subdivideTerrain's own doc comment for why this, not a plain vertex average, is what
  // keeps the face-point safely inside the vast majority of real (irregular) polygons).
  // z = plain average of the face's own corners.
  const facePointId = faces.map(f => {
    const pts = f.vertexIds.map(id => registry.get(id)).filter(Boolean)
    const c = polygonCentroid(pts)
    return registry.create(c.x, c.y, avgPos(pts).z, kind).id
  })

  // Edge-points: xy = plain endpoint midpoint (linear, stable). z = Catmull-Clark — interior
  // averages the two endpoints AND the two adjacent face-points; boundary is the plain
  // midpoint z (keeps the rim on its line).
  const edgePointId = new Map()
  for (const [key, e] of edgeFaces) {
    const pa = registry.get(e.a), pb = registry.get(e.b)
    if (!pa || !pb) continue
    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2
    const zPts = [pa, pb]
    if (e.faceIdxs.length === 2) {
      zPts.push(registry.get(facePointId[e.faceIdxs[0]]), registry.get(facePointId[e.faceIdxs[1]]))
    } else if (e.faceIdxs.length > 2) {
      console.warn(`[terrain-subdiv] edge ${key} touched by ${e.faceIdxs.length} faces (expected 1 or 2) — using midpoint only`)
    }
    const mz = avgPos(zPts.filter(Boolean)).z
    edgePointId.set(key, registry.create(mx, my, mz, kind).id)
  }

  // Incident-edge / incident-face indices per original vertex.
  const incidentEdgesByVertex = new Map()
  for (const [, e] of edgeFaces) {
    for (const v of [e.a, e.b]) {
      if (!incidentEdgesByVertex.has(v)) incidentEdgesByVertex.set(v, [])
      incidentEdgesByVertex.get(v).push(e)
    }
  }
  const incidentFacesByVertex = new Map()
  faces.forEach((f, fi) => {
    for (const v of f.vertexIds) {
      if (!incidentFacesByVertex.has(v)) incidentFacesByVertex.set(v, [])
      incidentFacesByVertex.get(v).push(fi)
    }
  })

  // New vertex: xy UNCHANGED (never move a vertex in the plane — see the fold note above).
  // z: boundary (any 1-face edge) pinned to its own z; interior = the standard
  // (Fz + 2Rz + (n-3)Pz)/n rule, applied to z only.
  const newVertexId = new Map()
  for (const [v, edges] of incidentEdgesByVertex) {
    const P = registry.get(v)
    if (!P) continue
    const isBoundary = edges.some(e => e.faceIdxs.length === 1)
    if (isBoundary) {
      newVertexId.set(v, registry.create(P.x, P.y, P.z ?? 0, kind).id)
      continue
    }
    const n = edges.length
    const Rz = avgPos(edges.map(e => {
      const other = e.a === v ? e.b : e.a
      const po = registry.get(other)
      return po ? { x: 0, y: 0, z: ((P.z ?? 0) + (po.z ?? 0)) / 2 } : { x: 0, y: 0, z: P.z ?? 0 }
    })).z
    const faceIdxs = incidentFacesByVertex.get(v) || []
    const Fz = avgPos(faceIdxs.map(fi => registry.get(facePointId[fi])).filter(Boolean)).z
    const nz = (Fz + 2 * Rz + (n - 3) * (P.z ?? 0)) / n
    newVertexId.set(v, registry.create(P.x, P.y, nz, kind).id)
  }

  // Emit n quads per original n-gon face: [movedVertex, nextEdgePt, facePt, prevEdgePt].
  const surfaces = []
  faces.forEach((f, fi) => {
    const ids = f.vertexIds, n = ids.length
    for (let i = 0; i < n; i++) {
      const vi = newVertexId.get(ids[i])
      const nextEdgeId = edgePointId.get(edgeKey(ids[i], ids[(i + 1) % n]))
      const prevEdgeId = edgePointId.get(edgeKey(ids[(i - 1 + n) % n], ids[i]))
      if (vi == null || nextEdgeId == null || prevEdgeId == null) continue
      const pointIds = [vi, nextEdgeId, facePointId[fi], prevEdgeId]
      const polygon = registry.resolve(pointIds).map(p => ({ x: p.x, y: p.y, z: p.z }))
      if (polygon.length < 4) continue
      surfaces.push({ pointIds, polygon, meta: f.meta })
    }
  })
  return surfaces
}

// Subdivide the WHOLE generated tessellation — kept AND hidden plots — as one welded mesh.
// Hidden (generated-but-unrendered) plots are included, tagged `hidden`, for the same
// reason the manifold audit already includes them: a kept plot's outer edge must pair
// against its real (hidden) neighbour, or that seam reads as a false hole. Subdividing kept
// and hidden together keeps the kept/hidden seam an interior edge, split consistently on
// both sides. The client filters `hidden` quads out at render time, exactly as it did the
// coarse `.hidden` plots. Each quad carries its owning plot's parentRegionId/assignedType/
// hidden (via `meta`) so the renderer and audit group/colour them like the flat plots did.
//
// Each plot is subdivided as ONE n-gon Catmull-Clark face — matching real Catmull-Clark
// exactly (verified live against Blender's own subdivision of an equivalent n-gon, 2026-07-
// 26: one face-point at the polygon's own centroid, n quads fanning out from it, no
// triangulation). An EARLIER version of this file triangulated every plot first (to dodge
// the concave-centroid-outside problem below) — that was a wrong direction: ear-clipping
// has no notion of triangle QUALITY, so it routinely produced long thin sliver triangles at
// any near-collinear vertex (common — merge-nearby-vertices and river/cliff pullback both
// produce them), which read as visible spike artifacts and, worse, were the actual source
// of new AREA_OVERLAP findings (two quads meeting at a corner but diverging by only ~0.01
// units before curving apart). Reverted.
//
// The concave case this originally existed to guard against is real but rare: an n-gon's
// face-point is its own area-weighted centroid (see catmullClarkFresh), which for a
// concave polygon can fall OUTSIDE it — pushing that face's corner quads out past the
// plot's true boundary into a neighbour (confirmed live 2026-07-26 as AREA_OVERLAP,
// entirely at concave outer-ring cells). Handled with a narrow, per-face fallback: ONLY
// when a face's own centroid tests outside its polygon, ear-clip triangulate just that one
// face instead (occasional slivers confined to that rare case, not the general rule).
//
// This guard must run on EVERY pass, not just the first (confirmed live 2026-07-29, root-
// caused after a screenshot showed 559 AREA_OVERLAP findings covering most of the map): a
// real Catmull-Clark fan-quad ([movedVertex, edgePt, facePt, edgePt]) is not guaranteed
// convex — an earlier version of this function only guarded the initial per-plot n-gon
// faces and fed every later pass's own output quads back in unprotected, so a concave
// quad produced by pass 1 (common at obtuse/high-valence Voronoi corners) folded its own
// pass-2 subdivision outside itself exactly the same way an unguarded concave PLOT once
// did. `buildProtectedFaces` below is applied uniformly to the plot n-gons AND to every
// later pass's quad list, so no face list ever skips the check.
//
// Clears and re-mints the ephemeral 'terrain-subdiv' point layer every call (full
// re-subdivide, ADR-0022 §10). Returns the quad Surface array
// ({ id, parentRegionId, assignedType, hidden, sourcePlotId, pointIds, polygon }) — caller
// stores it as worldTerrainData.terrainSurfaces.
//
// Runs TERRAIN_SUBDIVISION_PASSES total Catmull-Clark passes (worldConfig/terrainConfig.js
// — ADR-0022 shipped hardcoded at 1; ADR-0023's erosion filter needs more vertex density
// to read as more than noise). Every pass after the first just feeds the PRIOR pass's own
// output quads back in as plain 4-gon faces (catmullClarkFresh already carries `meta`
// through on its own output, so no re-tagging needed) — this is the exact technique
// validated in the synthetic-mesh prototype this was ported from, now with the same
// per-face concave guard applied at every step instead of only the first.
function buildProtectedFaces(registry, items) {
  const faces = []
  for (const item of items) {
    const ids = item.vertexIds
    if (ids.length <= 3) { faces.push({ vertexIds: ids, meta: item.meta }); continue }
    const pts = registry.resolve(ids)
    // resolve() silently drops any missing id — a length mismatch means we can't safely
    // test the centroid against the polygon. Treat as one n-gon face regardless (rare — a
    // genuinely missing registry point is already a data problem elsewhere).
    const centroidOutside = pts.length === ids.length && !pointInPolygon(polygonCentroid(pts), pts)
    if (!centroidOutside) { faces.push({ vertexIds: ids, meta: item.meta }); continue }
    const tris = triangulate(pts)
    if (!tris.length) { faces.push({ vertexIds: ids, meta: item.meta }); continue }
    for (const [a, b, c] of tris) faces.push({ vertexIds: [ids[a], ids[b], ids[c]], meta: item.meta })
  }
  return faces
}

export function subdivideTerrain(registry, terrainPlots, regionsById = null) {
  registry.clearKind('terrain-subdiv')
  const plots = (terrainPlots || []).filter(p => p.pointIds && p.pointIds.length >= 3)
  if (!plots.length) return []

  const rawFaces = plots.map(p => ({
    vertexIds: p.pointIds,
    meta: {
      parentRegionId: p.parentRegionId,
      assignedType: p.assignedType ?? regionsById?.get(p.parentRegionId)?.assignedType ?? null,
      hidden: !!p.hidden,
      sourcePlotId: p.id,
      // Undefined for an ordinary terrain plot — only riverCliffFace/cliff-edge-band
      // source objects (see _ribbonFaceToSegments/CliffEdgeBands.js) carry this, and it
      // rides straight through onto every quad it's subdivided into (see below) so the
      // client can colour a Cliff-Edge band's own ramp quads white right alongside the
      // Ice-Sheet cliff face they border, not just the face itself.
      iceSheetAdjacent: p.iceSheetAdjacent,
    },
  }))

  let quads = catmullClarkFresh(registry, buildProtectedFaces(registry, rawFaces), 'terrain-subdiv')
  for (let pass = 1; pass < TERRAIN_SUBDIVISION_PASSES; pass++) {
    const nextItems = quads.map(q => ({ vertexIds: q.pointIds, meta: q.meta }))
    quads = catmullClarkFresh(registry, buildProtectedFaces(registry, nextItems), 'terrain-subdiv')
  }
  let counter = 0
  return quads.map(q => ({
    id: `ts:${counter++}`,
    parentRegionId: q.meta.parentRegionId,
    assignedType: q.meta.assignedType,
    hidden: q.meta.hidden,
    sourcePlotId: q.meta.sourcePlotId,
    iceSheetAdjacent: q.meta.iceSheetAdjacent,
    pointIds: q.pointIds,
    polygon: q.polygon,
  }))
}
