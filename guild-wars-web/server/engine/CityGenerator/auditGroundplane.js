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
import { organicOuterRadius } from './TerrainVoronoiGenerator.js'

const WORLD_EPS = 1e-6
const NEAR_MISS_TOLERANCE = 0.05
// A real terrain quad's 2D footprint is orders of magnitude above this even at the finest
// subdivision level (~1e-3 or larger) — only a genuinely vertical/degenerate surface (a
// River-Bank wall) or a truly degenerate sliver lands below it. See signedArea2D's own doc
// comment for why such a surface is exempted from the AREA_OVERLAP test entirely.
const AREA_OVERLAP_MIN_AREA = 1e-6
// Tolerance INSIDE organicOuterRadius (the outer ring's seed-selection cutoff) to start
// treating a point as "possibly boundary". Buffer-zone follow-up (2026-07-13, "sunburst"
// screenshot): the outer ring's rim cells are now naturally bounded by a throwaway
// buffer-seed annulus (generate()'s bufferRadius) instead of an artificial clip circle —
// which is what makes the boundary genuinely rough/jagged rather than a smooth circle,
// but a genuinely rough boundary has real radial variance, not just clipPolygon's
// sub-pixel sagitta. Empirically (10 live generations, worldSize=50, organicOuterRadius
// ~28.2): the naturally-bounded rim's own polygon corners ranged as low as ~25.6 from
// centre — a fixed 0.5 slack left dozens of perfectly normal rim edges below the
// threshold, misreported as HOLE findings every single run. Proportional to worldSize
// (not a fixed absolute) so the same ratio holds at any world size/density.
const BOUNDARY_INNER_SLACK_RATIO = 0.15

// Fixed 2026-07-13 (user-confirmed, prompted by a live-observed hole), REVISED same day
// (outer-ring rewrite): the world's real boundary used to be a single organic clip
// CIRCLE at organicClipRadius (the old single-ring design) — every rim point sat within
// a tight tolerance of that one radius. Now that the inner ring's own rim clip has been
// removed entirely (an inner-ring cell's real neighbours are ordinary outer-ring cells,
// not void — see TerrainVoronoiGenerator.js generate()'s Step 5.5 doc comment) and the
// outer ring's own clip was deliberately loosened (0.4×worldSize margin, so it only
// catches genuinely wild spikes instead of forcing a smooth silhouette — user-confirmed
// 2026-07-13, "just clipping the outer ring to a circle"), the true boundary is no
// longer one exact circle: a genuine outer-rim edge can sit anywhere from
// organicOuterRadius (the outer ring's seed-selection cutoff) out to
// organicOuterClipRadius (the loose safety clip's max reach) — a BAND, not a rim. Any
// point at or beyond organicOuterRadius-BOUNDARY_INNER_SLACK is treated as an expected
// unpaired half-edge (nothing reliably exists beyond it), same role the literal world
// edge / old single clip circle used to play.
function onWorldBoundary(p, worldSize, minBoundaryRadius) {
  if (!p || worldSize == null) return false
  const onSquare = Math.abs(p.x) < WORLD_EPS || Math.abs(p.x - worldSize) < WORLD_EPS ||
                    Math.abs(p.y) < WORLD_EPS || Math.abs(p.y - worldSize) < WORLD_EPS
  if (onSquare) return true
  if (minBoundaryRadius == null) return false
  const cx = worldSize / 2, cy = worldSize / 2
  const dist = Math.hypot(p.x - cx, p.y - cy)
  return dist >= minBoundaryRadius
}

// Exact outer-ring membership (undirected — a HOLE's two directions are the same
// physical edge). Computed once, right after a hole-free New Game generation (see
// SetupPhase._generateWorldWithHoleCheck), and persisted for the rest of the game —
// this is the primary boundary test from then on; the radius heuristic above only
// matters for the very first, ring-computing pass (and as a fallback for an old save
// from before the ring existed). An exact set means a genuinely NEW stray gap that
// happens to land near the map edge is no longer silently masked by the radius band.
function edgeKey(a, b) { return a < b ? `${a},${b}` : `${b},${a}` }
function onOuterRing(originId, otherId, outerRingEdgeKeys) {
  return !!outerRingEdgeKeys && outerRingEdgeKeys.has(edgeKey(originId, otherId))
}

// Shoelace, absolute value — a Surface's own 2D (x,y) footprint area, ignoring z entirely.
// Used only to exempt a genuinely VERTICAL surface (e.g. RiverBankWall.js's River-Bank walls —
// two corners directly below/above the other two, same x,y, only z differs, by design — see
// CONTEXT_WorldTerrain.md's own River-Bank entry) from the AREA_OVERLAP test below: a surface
// with ~zero 2D footprint cannot have a real AREA overlap with anything by definition, so
// flagging one is always a false positive of this specific (inherently 2D-projection) test,
// not a real geometric defect — confirmed live: a real River-Bank wall's own two x,y-coincident
// corner pairs collapsed its shoelace area to ~0, and it was still being flagged as overlapping
// the very land/river surfaces it exists to sit flush against.
function signedArea2D(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
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
// Plain vertex average — NOT the true area-weighted centroid (see TerrainSubdivision.js's
// own polygonCentroid for that). Only used as a sample point for the containment check
// below, where all that matters is "safely interior for a convex-ish quad", not precise
// weighting.
function roughCentroid(poly) {
  let x = 0, y = 0
  for (const p of poly) { x += p.x; y += p.y }
  return { x: x / poly.length, y: y / poly.length }
}
// True if A and B overlap in area: any boundary edges transversally cross, or one
// polygon's centroid lies strictly inside the other (full/partial containment with no
// crossing — e.g. one polygon entirely swallowed by another).
//
// Deliberately NOT polyA[0]/polyB[0] (confirmed live 2026-07-29, root cause of 559 false
// AREA_OVERLAP findings after enabling multi-pass subdivision): two quads that share
// exactly one vertex — a completely ordinary "several quads meet at a point" mesh
// junction, common in this fan-quad topology — reach this fallback with shared===1, and
// testing a polygon's OWN first vertex for containment in its neighbour is a guaranteed
// on-boundary degenerate case whenever that vertex IS the shared one, since ray-casting
// point-in-polygon has no reliable answer for a point exactly equal to one of the
// polygon's own vertices. A centroid is generically far from any boundary and doesn't
// hit this case.
function polygonsOverlap(polyA, polyB) {
  for (let i = 0; i < polyA.length; i++) {
    for (let j = 0; j < polyB.length; j++) {
      if (segmentsCross(polyA[i], polyA[(i + 1) % polyA.length], polyB[j], polyB[(j + 1) % polyB.length])) return true
    }
  }
  return pointInPolygon(roughCentroid(polyA), polyB) || pointInPolygon(roughCentroid(polyB), polyA)
}

// groundplane: {points, surfaces, terrain: {worldSize}, outerRingEdgeKeys}. The last
// is optional — an array of `edgeKey(id,id)` strings, SetupPhase._generateWorldWithHoleCheck's
// exact outer-ring capture (see edgeKey/onOuterRing above) — when present, THIS is the
// boundary test; onWorldBoundary's radius heuristic only fills in for anything the exact
// set doesn't cover (an old save from before the ring existed). Returns {counts,
// findings, boundaryEdgeKeys} — findings is a flat array, each tagged with a `category`
// ('OVERLAP' | 'DEGENERATE' | 'HOLE' | 'PINCH' | 'AREA_OVERLAP'); boundaryEdgeKeys is
// every unpaired edge classified as "on the world boundary" this run (by whichever
// test applied) — the caller captures this on a clean New Game generation to seed
// outerRingEdgeKeys for every audit for the rest of the game.
export function auditGroundplane(groundplane) {
  const { points = [], surfaces = [], terrain = {}, outerRingEdgeKeys = null } = groundplane || {}
  const worldSize = terrain.worldSize
  // The world's real boundary band (see onWorldBoundary's doc comment) — computed
  // straight from worldSize so every caller gets this for free, no groundplane shape
  // change needed. Only load-bearing until outerRingEdgeKeys exists (or for an id the
  // exact ring doesn't recognise, e.g. an old save).
  const minBoundaryRadius = worldSize != null ? organicOuterRadius(worldSize) - worldSize * BOUNDARY_INNER_SLACK_RATIO : null
  const ringKeys = outerRingEdgeKeys instanceof Set ? outerRingEdgeKeys : (outerRingEdgeKeys ? new Set(outerRingEdgeKeys) : null)
  const registry = new GroundPointRegistry(points)
  const dcel = new DCEL(registry)

  const findings = []
  const boundaryEdgeKeys = new Set()
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
    // Exact ring first (once computed, this is authoritative for the rest of the game);
    // the radius heuristic only ever fires for ids the ring doesn't recognise.
    const onRing = otherId != null && onOuterRing(originId, otherId, ringKeys)
    const onHeuristicBoundary = !onRing && originPt && otherPt &&
      onWorldBoundary(originPt, worldSize, minBoundaryRadius) && onWorldBoundary(otherPt, worldSize, minBoundaryRadius)
    if (onRing || onHeuristicBoundary) {
      if (otherId != null) boundaryEdgeKeys.add(edgeKey(originId, otherId))
      continue
    }
    // A River-Bank wall (RiverBankWall.js) is a single-sided vertical quad, by design —
    // its own "top" edge (between its two freshly-minted, kind='river-bank-wall' outer
    // corners) and its edges at a river's true open end have no "other side" to pair
    // against, the same structural reason the world's own outer rim is exempted above.
    // Confirmed live: every one of these is at wall-quad indices [1,2] (the minted pair),
    // never a real gap in the land/river/wall stitching itself.
    const onWallOpenEdge = originPt?.kind === 'river-bank-wall' || otherPt?.kind === 'river-bank-wall'
    if (onWallOpenEdge) continue
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
    return poly.length >= 3 ? { id: s.id, kind: s.kind, ids: new Set(ids), poly, box: bbox(poly), area2D: signedArea2D(poly) } : null
  }).filter(Boolean)

  // Adaptive, not a fixed constant — this was `cellSize = 4` (tuned for an era before
  // ADR-0022's terrain-wide subdivision, when Surfaces meant coarse terrain
  // plots/districts/blocks: hundreds, not tens of thousands). Once subdivision made the
  // mesh ~100x denser, a fixed cellSize=4 put ~500 tiny quads in every bucket — the
  // bucket-pairwise loop below is O(bucket^2), so that alone cost 1.17s of a real save's
  // 1.6s total audit time (confirmed via direct profiling: cellSize=4 -> 1175ms pair-loop
  // vs cellSize=0.5 -> 215ms, identical overlap count both ways). Scaling to the current
  // Surface set's own median width keeps bucket occupancy roughly constant whether this
  // runs against a sparse coarse-plot-only audit (early Terrain Setup) or a fully-
  // subdivided one (tens of thousands of fine quads) — a fixed constant is only ever
  // correctly tuned for one of those.
  const widths = polysById
    .map(s => Math.max(s.box.maxX - s.box.minX, s.box.maxY - s.box.minY))
    .filter(w => w > 0)
    .sort((a, b) => a - b)
  const medianWidth = widths.length ? widths[Math.floor(widths.length / 2)] : 4
  const cellSize = Math.max(0.1, medianWidth * 2)
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
        // A near-zero-2D-area surface (a vertical wall — see signedArea2D's own doc comment)
        // structurally cannot have a real area overlap; skip rather than false-positive.
        if (a.area2D < AREA_OVERLAP_MIN_AREA || b.area2D < AREA_OVERLAP_MIN_AREA) continue
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

  return { counts, findings, boundaryEdgeKeys: [...boundaryEdgeKeys] }
}
