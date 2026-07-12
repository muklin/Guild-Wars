// Manifold audit for a Groundplane snapshot (see CONTEXT_WorldTerrain.md's Groundplane
// section, ADR-0020). Answers one question directly, instead of one screenshot at a
// time: does `groundplane.surfaces` currently tile the world with no gaps and no
// overlaps? Works against ANY groundplane snapshot regardless of whether the generator
// that produced a given Surface is DCEL-native yet (Stage C isn't finished) — it
// rebuilds a throwaway DCEL from the final Surface list every run and lets DCEL.js's
// own, already-proven structural checks do most of the manifold testing:
//   - insertFace already throws when a directed edge is claimed by two faces (the
//     classic "edge two-face-limit" manifold test) -> OVERLAP / DEGENERATE findings.
//   - outgoingFan already performs the vertex-fan traversal (the classic "simple
//     vertex neighbourhood" manifold test), the same machinery the confluence-splice
//     work in SetupPhase.js relies on -> PINCH findings.
//   - any half-edge left with face:null after every Surface has been inserted is an
//     unpaired boundary segment -> HOLE findings, unless both its endpoints lie on the
//     world's own outer boundary (expected — nothing exists beyond the map edge).
// The DCEL-edge test alone is NOT sufficient, though: it only catches two Surfaces
// claiming the exact SAME directed edge. Two Surfaces that overlap in AREA without
// sharing that edge at all — e.g. a Cliff ribbon whose corner drifted past a completely
// unrelated, non-neighbouring terrain plot — pass the edge test cleanly and need a real
// geometric check (confirmed live: 46 such pairs on a real save the edge test reported
// zero overlaps for). AREA_OVERLAP findings below cover that gap.
import GroundPointRegistry from './GroundPointRegistry.js'
import DCEL, { dedupeConsecutiveIds } from './DCEL.js'

const WORLD_EPS = 1e-6
const NEAR_MISS_TOLERANCE = 0.05

function onWorldBoundary(p, worldSize) {
  if (!p || worldSize == null) return false
  return Math.abs(p.x) < WORLD_EPS || Math.abs(p.x - worldSize) < WORLD_EPS ||
         Math.abs(p.y) < WORLD_EPS || Math.abs(p.y - worldSize) < WORLD_EPS
}

function bbox(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of poly) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}
function bboxOverlap(a, b) { return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY }

// Proper (transverse-only) segment intersection — collinear/touching segments (the
// normal case for two polygons sharing a boundary) are NOT reported as crossing.
function segmentsCross(a, b, c, d) {
  const ccw = (p, q, r) => (r.x - p.x) * (q.y - p.y) - (q.x - p.x) * (r.y - p.y)
  const d1 = ccw(c, d, a), d2 = ccw(c, d, b), d3 = ccw(a, b, c), d4 = ccw(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}
function pointInPolygon(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
// True if A and B overlap in area: any boundary edges transversally cross, or one
// polygon's first vertex lies strictly inside the other (full/partial containment with
// no crossing — e.g. one polygon entirely swallowed by another).
function polygonsOverlap(polyA, polyB) {
  for (let i = 0; i < polyA.length; i++) {
    for (let j = 0; j < polyB.length; j++) {
      if (segmentsCross(polyA[i], polyA[(i + 1) % polyA.length], polyB[j], polyB[(j + 1) % polyB.length])) return true
    }
  }
  return pointInPolygon(polyA[0], polyB) || pointInPolygon(polyB[0], polyA)
}

// groundplane: {points, surfaces, terrain: {worldSize}} — the same shape saved at
// gameState.groundplane. Returns {counts, findings} — findings is a flat array, each
// tagged with a `category` ('OVERLAP' | 'DEGENERATE' | 'HOLE' | 'PINCH').
export function auditGroundplane(groundplane) {
  const { points = [], surfaces = [], terrain = {} } = groundplane || {}
  const worldSize = terrain.worldSize
  const registry = new GroundPointRegistry(points)
  const dcel = new DCEL(registry)

  const findings = []
  // Directed pair "u,v" -> surfaceId, built alongside insertion so a later HOLE finding
  // can name which Surface actually owns the real (non-void) side of that boundary.
  const directedPairToSurfaceId = new Map()

  for (const surface of surfaces) {
    const ids = dedupeConsecutiveIds(surface.pointIds || [])
    for (let i = 0; i < ids.length; i++) {
      directedPairToSurfaceId.set(`${ids[i]},${ids[(i + 1) % ids.length]}`, surface.id)
    }
    if (ids.length < 3) {
      findings.push({ category: 'DEGENERATE', surfaceId: surface.id, message: `Surface ${surface.id}: fewer than 3 distinct points after dedup (${ids.length})` })
      continue
    }
    try {
      dcel.insertFace(ids, surface.kind, { surfaceId: surface.id, type: surface.type })
    } catch (err) {
      const conflictFaceId = Number(err.message.match(/already owned by face (\d+)/)?.[1])
      const conflictFace = Number.isFinite(conflictFaceId) ? dcel.getFace(conflictFaceId) : null
      findings.push({
        category: 'OVERLAP',
        surfaceId: surface.id,
        surfaceKind: surface.kind,
        conflictSurfaceId: conflictFace?.surfaceId,
        conflictSurfaceKind: conflictFace?.kind,
        message: err.message,
      })
    }
  }

  // Edge test: every half-edge still face:null after every Surface has had a chance to
  // reclaim it is an unpaired boundary segment.
  const surfaceIdToKind = new Map(surfaces.map(s => [s.id, s.kind]))
  const holeFindings = []
  for (const he of dcel.allHalfEdges()) {
    if (he.face !== null) continue
    const twin = dcel.getHalfEdge(he.twin)
    const originId = he.origin, otherId = twin?.origin
    const originPt = registry.get(originId), otherPt = registry.get(otherId)
    if (originPt && otherPt && onWorldBoundary(originPt, worldSize) && onWorldBoundary(otherPt, worldSize)) continue
    const borderingSurfaceId = otherId != null ? directedPairToSurfaceId.get(`${otherId},${originId}`) : undefined
    const finding = {
      category: 'HOLE',
      originId, otherId,
      origin: originPt ? { x: originPt.x, y: originPt.y } : null,
      other: otherPt ? { x: otherPt.x, y: otherPt.y } : null,
      borderingSurfaceId,
      borderingSurfaceKind: borderingSurfaceId != null ? surfaceIdToKind.get(borderingSurfaceId) : undefined,
      message: `Unpaired edge ${originId}->${otherId}` + (borderingSurfaceId != null ? ` (bordering Surface ${borderingSurfaceId})` : '') +
        (!originPt || !otherPt ? ' — one endpoint missing from registry' : ''),
    }
    holeFindings.push(finding)
  }

  // Near-miss triage (secondary — doesn't change the HOLE count, only tags it):
  // does some OTHER unpaired edge's endpoint sit suspiciously close to this one's,
  // under a different id? Matches the "two independent computations almost agreeing"
  // pattern (e.g. land pullback vs. face construction landing 0.03 units apart).
  const holeEndpoints = []
  holeFindings.forEach((f, findingIndex) => {
    if (f.origin) holeEndpoints.push({ id: f.originId, x: f.origin.x, y: f.origin.y, findingIndex })
    if (f.other) holeEndpoints.push({ id: f.otherId, x: f.other.x, y: f.other.y, findingIndex })
  })
  const tol2 = NEAR_MISS_TOLERANCE * NEAR_MISS_TOLERANCE
  holeFindings.forEach((f, findingIndex) => {
    f.nearMiss = false
    for (const pt of [f.origin, f.other]) {
      if (!pt) continue
      for (const other of holeEndpoints) {
        if (other.findingIndex === findingIndex) continue
        if (other.id === f.originId || other.id === f.otherId) continue
        const dx = pt.x - other.x, dy = pt.y - other.y
        if (dx * dx + dy * dy < tol2) { f.nearMiss = true; break }
      }
      if (f.nearMiss) break
    }
  })
  findings.push(...holeFindings)

  // Vertex test: every point id actually anchoring at least one half-edge gets a fan
  // traversal — a thrown error means the faces around it don't form a simple ring.
  const seenVertexIds = new Set()
  for (const he of dcel.allHalfEdges()) seenVertexIds.add(he.origin)
  for (const vertexId of seenVertexIds) {
    try {
      dcel.outgoingFan(vertexId)
    } catch (err) {
      const p = registry.get(vertexId)
      findings.push({ category: 'PINCH', vertexId, position: p ? { x: p.x, y: p.y } : null, message: err.message })
    }
  }

  // Area-overlap test: two Surfaces can pass the DCEL edge test cleanly (never sharing
  // the same directed edge) and still overlap in area — the edge test alone can't see
  // this. Grid-bucketed by bounding box (same technique GroundPointRegistry.mintDeduped
  // uses) so this stays roughly O(n) for realistic surface counts instead of O(n^2).
  // Pairs sharing 2+ point ids share a full edge by construction (normal adjacency,
  // never flagged) — checked ids-first since it's far cheaper than the geometry test.
  const polysById = surfaces.map(s => {
    const ids = dedupeConsecutiveIds(s.pointIds || [])
    const poly = ids.map(id => registry.get(id)).filter(Boolean)
    return poly.length >= 3 ? { id: s.id, kind: s.kind, ids: new Set(ids), poly, box: bbox(poly) } : null
  }).filter(Boolean)

  const cellSize = 4
  const cellKey = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`
  const grid = new Map()
  for (const s of polysById) {
    for (let gx = Math.floor(s.box.minX / cellSize); gx <= Math.floor(s.box.maxX / cellSize); gx++) {
      for (let gy = Math.floor(s.box.minY / cellSize); gy <= Math.floor(s.box.maxY / cellSize); gy++) {
        const key = `${gx},${gy}`
        if (!grid.has(key)) grid.set(key, [])
        grid.get(key).push(s)
      }
    }
  }
  const reportedPairs = new Set()
  for (const bucket of grid.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j]
        const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
        if (reportedPairs.has(pairKey)) continue
        if (!bboxOverlap(a.box, b.box)) continue
        let shared = 0
        for (const id of a.ids) if (b.ids.has(id)) shared++
        if (shared >= 2) continue
        if (!polygonsOverlap(a.poly, b.poly)) continue
        reportedPairs.add(pairKey)
        findings.push({
          category: 'AREA_OVERLAP',
          surfaceId: a.id, surfaceKind: a.kind,
          conflictSurfaceId: b.id, conflictSurfaceKind: b.kind,
          sharedVertexCount: shared,
          message: `Surface ${a.id} (${a.kind}) overlaps Surface ${b.id} (${b.kind}) in area (shared vertices: ${shared})`,
        })
      }
    }
  }

  const counts = { OVERLAP: 0, DEGENERATE: 0, HOLE: 0, HOLE_NEAR_MISS: 0, HOLE_TRUE_VOID: 0, PINCH: 0, AREA_OVERLAP: 0 }
  for (const f of findings) {
    counts[f.category]++
    if (f.category === 'HOLE') counts[f.nearMiss ? 'HOLE_NEAR_MISS' : 'HOLE_TRUE_VOID']++
  }

  return { counts, findings }
}
