// Generic per-plot extrude+inset (re-added 2026-07-26 as Hills-only "this got lost
// somewhere" — ADR-0022 had retired the original extrude/inset/wall version in favour of a
// plain rolling height field, which never actually reads as "a hill"/"a mountain" in play;
// generalized 2026-07-27 to any terrain type on TERRAIN_TYPES' 'deltaandextterrainplots'
// mode, not just Hills — see that config's own doc comment for TOP_INSET_RANGE/
// EXTRUDE_HEIGHT_RATIO). Reintegrated the way Shore/Cliff-Edge already are (ADR-0022 "one
// mechanism, many named types"): NOT a separate mesh/render path, just more ordinary n-gon
// Surfaces fed into the SAME welded terrain-wide subdivision pass everything else goes
// through.
//
// The old version's whole reason for a bespoke client-side wall renderer (see git history,
// TerrainRenderer.buildHillsWallMesh) was that a pure VERTICAL extrude's two side-edges
// share the same (x,y), a degenerate zero-area quad under XY-plane ear-clipping. INSETTING
// the top instead of extruding it straight up sidesteps that entirely: every skirt quad
// below has real XY footprint, so it welds through subdivideTerrain like any other terrain
// face — no special-case renderer needed.
//
// PER-VERTEX SHARED tops (current design, 2026-07-27 — SHIPPED because it's the only one
// of four attempts that actually passes every test in this file's own suite, including a
// full 3x3 block of adjacent plots, not just an isolated 3-plot pinwheel). Every extruding
// plot's own PROPOSED inset+raised position per corner is computed first (own centroid,
// own randomized insetFraction/height — still genuinely per-PLOT, so a region's plots
// still step independently in HEIGHT and how far they pull in), then every vertex touched
// by 2+ extruding plots gets ONE shared point — the AVERAGE of those plots' own proposals
// — instead of each plot minting its own private copy. Two adjacent extruding plots
// therefore always weld exactly at a shared vertex, no gap possible; skirts are skipped
// entirely on an INTERNAL edge (both sides extruding), since the two plots' tops already
// meet directly there once the shared vertex exists.
//
// KNOWN LIMITATION, not silently hidden: in a densely-packed region (the ordinary case —
// nearly every boundary vertex between two same-type plots IS a shared junction), this
// welds large contiguous areas into one mass rather than reading as separate peaks —
// confirmed live 2026-07-27 ("aaaaaaannd you've regressed to the merged extrusions
// again"). A proper fix needs each plot to keep a fully independent top while still
// closing the gap at shared junctions with a correctly-wound cap face — attempted twice
// (see below) and NOT yet achieved; left for a focused follow-up rather than shipped
// half-working.
//
// Design journey (four tried, in order):
//   1. Independent tops (every plot mints its OWN private corner, "each plot its own
//      mound" — user-confirmed 2026-07-27) — passed every SQUARE-grid synthetic test
//      (plain and jittered), but a square grid's internal vertices are always 4-valent by
//      construction. Real Voronoi terrain is generically 3-valent (exactly 3 cells meet at
//      almost every vertex) — confirmed live ("hills have the same, actually" — real
//      screenshots of both Hills and Mountains showing thin dark sliver holes) and
//      reproduced in a minimal, non-jittered 3-plot pinwheel test: three plots' own
//      independent proposals for the SAME original shared vertex landed nowhere near each
//      other, leaving the small triangular patch between them uncovered.
//   2. Independent tops + a junction-cap fan, FIRST attempt (angle-sorted, not reversed)
//      — wrong winding, unpaired-edge HOLEs and AREA_OVERLAPs against its own neighbouring
//      skirts.
//   3. Per-vertex SHARED tops — fixes the hole, but merges large areas (see KNOWN
//      LIMITATION above). What ships here.
//   4. Independent tops + a junction-cap fan, SECOND attempt — revisited (2) after finding
//      _buildRiverCliffJunctionCaps/polylineGeometry.js's own already-working solution to
//      the identical class of problem and its documented fix (reverse the angle-sorted cap
//      polygon). Fixed the original 3-plot pinwheel (zero HOLE), but the FULLER 3x3-block
//      test — 4-valent square-grid junctions, denser topology — still produced real HOLE
//      and DEGENERATE findings ("fewer than 3 distinct points after dedup" at some
//      junctions). Reverted rather than shipped failing its own test suite; the reversal
//      fix from the Cliff/River case is necessary but evidently not sufficient here — a
//      general N-valent fan cap that's robust against BOTH 3-valent (real Voronoi) and
//      4-valent (and denser) topology needs more focused work than fit in this pass.
//
// PINNED corners (added 2026-07-27, found live via a real save — "Cliff:8-11" HOLE
// findings traced to a Hills region on the OTHER side of that Cliff): a corner already
// owned by a Cliff ribbon (riverCliffFaces), a Cliff-Edge band, or a Shore band must NEVER
// be moved here. Hills/Mountains are CLIFF_HIGH_TYPES (terrainConfig.js) — a Hills/
// Mountains plot bordering a Cliff is the ordinary case, not an edge case — and insetting
// that shared corner away, same as any other, orphaned it from the exact position the
// Cliff-Edge band/ribbon already pinned there, leaving a genuine gap neither side's own
// geometry covers. A pinned corner keeps its CURRENT position and z exactly (no inset, no
// height raise, and it never contributes to or receives a shared-vertex average) — every
// other, non-pinned corner of the same plot still insets/raises normally, so the
// resulting top is an irregular polygon, not a uniform shrink.
//
// PER-VERTEX INWARD-NORMAL inset (each plot's own PROPOSAL, before averaging, replaced a
// naive centroid-lerp 2026-07-27): moving a corner STRAIGHT toward the plot's own centroid
// has no relationship to that corner's own LOCAL edge geometry — for a thin/acute cell,
// "toward centroid" can point almost ALONG one of the plot's own edges rather than across
// it. Reuses TransitionBand.js's own proven approach instead (inwardNormal/
// polygonCentroid, exported from there 2026-07-27 for this): each corner's own proposal
// moves along the AVERAGE of its two incident edges' own inward normals, by
// (1 - insetFraction) × its own distance to centroid — a real polygon-offset direction,
// not a blind lerp. NOT clamped against incident edge length (TransitionBand.js's own
// fixed-WIDTH band clamp, tried and reverted 2026-07-27 — "Mountains TOP_INSET_RANGE is
// not being respected": that clamp is tuned for a fixed-width band, not a fraction-based
// self-inset, and bound on EVERY ordinary cell shape for Mountains' own aggressive range).
import { TERRAIN_TYPES } from '../../../worldConfig/terrainConfig.js'
import { inwardNormal, polygonCentroid } from './TransitionBand.js'

const EXTRUDE_MODE = 'deltaandextterrainplots'

// Cheap deterministic hash, not cryptographic — same per-position-not-per-call jitter
// spirit as the client's own posHash (renderUtils.js), just self-contained here rather
// than importing a client-only util into server code.
function hash01(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return s - Math.floor(s)
}

function polygonArea(pts) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % pts.length]
    a += p1.x * p2.y - p2.x * p1.y
  }
  return Math.abs(a) / 2
}

// Builds extrusion skirt bands for every kept plot whose own type is on
// 'deltaandextterrainplots' mode, and insets+raises each such plot's own top in place
// (per-vertex shared with any other extruding plot touching the same vertex — see doc
// comment above). `pinnedSurfaceArrays`: riverCliffFaces/cliffEdgeBands/shoreBands (or any
// subset) — every point id any of them reference is left completely untouched here (see
// PINNED doc comment above). Returns the skirt band Surface array ({ id, assignedType,
// parentRegionId, hidden, pointIds, polygon }) — caller stores it (e.g.
// worldTerrainData.extrusionSkirts) and merges it into subdivideTerrain's face list, same
// as shoreBands/cliffEdgeBands.
export function buildTerrainExtrusion(registry, terrainPlots, pinnedSurfaceArrays = []) {
  registry.clearKind('terrain-extrude-split')

  const plots = terrainPlots || []

  const pinnedIds = new Set()
  for (const arr of pinnedSurfaceArrays) {
    for (const surf of arr || []) {
      for (const id of surf.pointIds || []) pinnedIds.add(id)
    }
  }

  // Physical-edge -> bordering plot(s), from the CURRENT (pre-mutation) footprints of
  // EVERY plot, not just candidates — used below to answer "is the plot on the other side
  // of THIS specific edge also extruding" (an internal edge between two extruding plots
  // needs no skirt at all, once their shared vertices below make their tops meet there
  // directly).
  const plotsByPhysicalEdge = new Map()   // "idLo,idHi" -> plot[]
  for (const plot of plots) {
    const ids = plot.pointIds
    if (!ids || ids.length < 2) continue
    for (let i = 0; i < ids.length; i++) {
      const p1 = ids[i], p2 = ids[(i + 1) % ids.length]
      if (p1 === p2) continue
      const key = p1 < p2 ? `${p1},${p2}` : `${p2},${p1}`
      if (!plotsByPhysicalEdge.has(key)) plotsByPhysicalEdge.set(key, [])
      plotsByPhysicalEdge.get(key).push(plot)
    }
  }

  const candidates = []
  const isCandidate = new Set()
  for (const plot of plots) {
    if (plot.hidden) continue
    const rule = TERRAIN_TYPES[plot.assignedType]
    if (!rule || rule.mode !== EXTRUDE_MODE) continue
    const ids = plot.pointIds
    if (!ids || ids.length < 3) continue
    const pts = registry.resolve(ids)
    if (pts.length !== ids.length) continue
    const { x: cx, y: cy } = polygonCentroid(pts)
    const size = Math.sqrt(polygonArea(pts))
    if (size < 1e-6) continue
    const [minInset, maxInset] = rule.TOP_INSET_RANGE
    const insetFraction = minInset + hash01(cx, cy) * (maxInset - minInset)
    const height = rule.EXTRUDE_HEIGHT_RATIO * size
    candidates.push({ plot, ids, pts, cx, cy, insetFraction, height })
    isCandidate.add(plot)
  }
  if (!candidates.length) return []

  // Pass 1: every candidate's own PROPOSED per-corner target (pinned corners propose
  // nothing — they're handled separately, always resolving to themselves), averaged per
  // shared vertex.
  const sumByVertex = new Map()   // vertexId -> { x, y, z, count }
  for (const c of candidates) {
    const { pts, ids, cx, cy, insetFraction, height } = c
    const n = ids.length
    for (let i = 0; i < n; i++) {
      if (pinnedIds.has(ids[i])) continue
      const p = pts[i]
      const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n]
      const n1 = inwardNormal(prev, p, cx, cy)
      const n2 = inwardNormal(p, next, cx, cy)
      let dx = n1.nx + n2.nx, dy = n1.ny + n2.ny
      const dirLen = Math.hypot(dx, dy)
      let nx = p.x, ny = p.y
      if (dirLen > 1e-9) {
        dx /= dirLen; dy /= dirLen
        const distToCentroid = Math.hypot(p.x - cx, p.y - cy)
        const dist = (1 - insetFraction) * distToCentroid
        nx = p.x + dx * dist
        ny = p.y + dy * dist
      }
      const nz = (p.z ?? 0) + height
      const cur = sumByVertex.get(ids[i]) || { x: 0, y: 0, z: 0, count: 0 }
      cur.x += nx; cur.y += ny; cur.z += nz; cur.count++
      sumByVertex.set(ids[i], cur)
    }
  }

  // Pass 2: mint ONE shared top point per non-pinned vertex (the averaged proposal) —
  // this is what guarantees two extruding plots sharing a vertex always reassign to the
  // identical id, closing the gap a 3+-valent junction would otherwise leave.
  const topIdByVertex = new Map()
  for (const [vid, { x, y, z, count }] of sumByVertex) {
    const top = registry.create(x / count, y / count, z / count, 'terrain-extrude-split')
    topIdByVertex.set(vid, top.id)
  }

  // Pass 3: skirt ring per plot — quad [a, b, bTop, aTop] per edge, bottom edge is the
  // plot's own UNTOUCHED original boundary, top edge is the shared per-vertex top (or the
  // original id itself for a pinned corner). Skipped entirely on an edge whose OTHER side
  // is ALSO an extruding candidate (their tops already meet directly there via the shared
  // vertex — a skirt there would duplicate/overlap that connection) or fully pinned (no
  // ramp needed at all). A HALF-pinned edge (one end pinned, one not) still needs a ramp,
  // but the naive 4-point quad would be degenerate (a repeated vertex) — explicitly
  // collapsed to a clean triangle (dedupe consecutive-equal, same convention
  // _ribbonFaceToSegments already uses for its own pinch case).
  const bands = []
  let counter = 0
  for (const c of candidates) {
    const { plot, ids } = c
    const topIds = ids.map(id => pinnedIds.has(id) ? id : topIdByVertex.get(id))

    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length]
      if (a === b) continue
      const key = a < b ? `${a},${b}` : `${b},${a}`
      const borderingPlots = plotsByPhysicalEdge.get(key) || []
      const otherSideExtrudes = borderingPlots.some(p => p !== plot && isCandidate.has(p))
      if (otherSideExtrudes) continue

      const aTop = topIds[i], bTop = topIds[(i + 1) % ids.length]
      if (aTop === a && bTop === b) continue   // fully pinned — no ramp needed at all
      const raw = [a, b, bTop, aTop]
      const pointIds = []
      for (const id of raw) { if (pointIds[pointIds.length - 1] !== id) pointIds.push(id) }
      if (pointIds.length > 1 && pointIds[0] === pointIds[pointIds.length - 1]) pointIds.pop()
      if (pointIds.length < 3) continue
      const polygon = registry.resolve(pointIds).map(p => ({ x: p.x, y: p.y, z: p.z }))
      if (polygon.length < 3) continue
      bands.push({
        id: `terrain-extrude-skirt:${counter++}`,
        assignedType: plot.assignedType,
        parentRegionId: plot.parentRegionId,
        hidden: false,
        pointIds,
        polygon,
      })
    }

    // The plot's own top surface: reassign to the new (shared, where applicable)
    // inset+raised points.
    plot.pointIds = topIds
    plot.polygon = registry.resolve(topIds).map(p => ({ x: p.x, y: p.y, z: p.z }))
  }

  return bands
}
