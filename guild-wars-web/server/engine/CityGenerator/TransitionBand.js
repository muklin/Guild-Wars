// Shared engine behind every ADR-0022 transition band (Shore, Cliff-edge — "one
// mechanism, two named types"). A transition band is a quad strip pulling the LAND side
// of a linear boundary inland to open room for a ramp: one edge stays exactly where the
// boundary already was (unchanged — whatever the OTHER side of that boundary is, this
// engine never touches it), the other edge is a freshly-minted "pulled inland" copy, and
// the affected land plot's own corners are swapped to those inland copies. Once merged
// into subdivideTerrain's face list this is fully welded and manifold by construction,
// same guarantee every other terrain Surface already has.
//
// This file owns the THREE hole-avoidance rules every concrete band type needs (found
// live 2026-07-26 building Shore, all three now regression-tested — see
// ShoreBands.test.mjs):
//   1. A boundary vertex that's ALSO a corner of a HIDDEN plot must not move (moving it
//      updates only the kept side, leaving the hidden neighbour's unrelated edge
//      referencing the old position — an unpaired-edge hole at the kept/hidden ring).
//   2. A boundary vertex is typically a 3-way Voronoi junction, so it's routinely ALSO a
//      corner of a second land plot that never shares a full EDGE with the boundary —
//      EVERY kept plot referencing a moved vertex must get the swap, not just the ones
//      with a direct boundary-facing edge, or the second plot's unmoved corner splits
//      what should be one shared point into two.
//   3. A segment can have ONE endpoint excluded by rule 1 while its OTHER endpoint is a
//      genuine, valid pull (a band run ending right at the kept/hidden ring). Skipping
//      the band there entirely leaves a real geometric gap, not just a topology
//      mismatch — falling back to the excluded endpoint's own unmoved id instead lets
//      the ring dedupe into a closing TRIANGLE that bridges the two correctly.

const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`)

// The perpendicular to a→b oriented toward (cx,cy) — same helper as
// GroundplaneAudit._inwardNormal (duplicated rather than cross-imported; this module has
// no other dependency on that class). Exported 2026-07-27 — TerrainExtrusion.js reuses
// this (and polygonCentroid below) for its own per-vertex inset, replacing a naive
// centroid-lerp that could swing a corner across into a neighbouring plot's own wedge on
// sufficiently irregular geometry (confirmed live: real AREA_OVERLAP findings on Hills/
// Mountains regions).
export function inwardNormal(a, b, cx, cy) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1
  let nx = -dy / L, ny = dx / L
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny }
  return { nx, ny }
}

// True area-weighted centroid (not a plain vertex average — the two differ for any
// non-regular polygon, which every Voronoi terrain plot here is).
export function polygonCentroid(poly) {
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

// Every physical (undirected) edge -> the (up to 2) plot-like entries that reference it.
// Built fresh over ALL of `terrainPlots` (kept + hidden — needed so a kept boundary
// plot's edge against a hidden neighbour is correctly recognised as "not open" rather
// than misread as a dead end) PLUS any extra plot-like entries the caller supplies (e.g.
// Cliff-edge treats each riverCliffFace as one more "plot" purely for this adjacency
// scan — it's never touched or mutated, just used to detect which land edges border it).
function buildEdgePlotMap(terrainPlots, extra) {
  const map = new Map()
  const add = (plot) => {
    const ids = plot.pointIds
    if (!ids || ids.length < 3) return
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length]
      if (a === b) continue
      const key = edgeKey(a, b)
      let e = map.get(key)
      if (!e) { e = { plots: [] }; map.set(key, e) }
      e.plots.push(plot)
    }
  }
  for (const plot of terrainPlots || []) add(plot)
  for (const plot of extra || []) add(plot)
  return map
}

// Removes consecutive-equal ids from a closed ring (including wraparound between the
// last and first entries) — turns e.g. [a, b, b, aInland] (one endpoint that fell back to
// its own original, unmoved id — rule 3 above) into the clean triangle [a, b, aInland].
function dedupeRing(ids) {
  const out = []
  for (const id of ids) {
    if (out.length && out[out.length - 1] === id) continue
    out.push(id)
  }
  if (out.length > 1 && out[0] === out[out.length - 1]) out.pop()
  return out
}

// Detects every boundary segment: a KEPT land plot's own edge (walked in ITS OWN winding
// order, so the resulting band quad pairs correctly against both sides — see
// buildTransitionBand's own doc comment) whose other side, per `isBoundaryOther`, is the
// linear feature this band type cares about. `extraPlotLikes` (optional) are non-plot
// entries (e.g. riverCliffFaces) also considered as "the other side" — never as the LAND
// side themselves. Returns [{ a, b, landPlot, other }].
export function detectBoundarySegments(terrainPlots, isBoundaryOther, extraPlotLikes = []) {
  const edgeMap = buildEdgePlotMap(terrainPlots, extraPlotLikes)
  const segments = []
  for (const plot of terrainPlots || []) {
    if (plot.hidden) continue
    const ids = plot.pointIds
    if (!ids || ids.length < 3) continue
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length]
      const e = edgeMap.get(edgeKey(a, b))
      if (!e || e.plots.length !== 2) continue
      const other = e.plots.find(p => p !== plot)
      if (!other || !isBoundaryOther(other, plot)) continue
      segments.push({ a, b, landPlot: plot, other })
    }
  }
  return segments
}

// The shared pull+swap+band-build engine. `segments`: detectBoundarySegments' output (or
// equivalent). Options:
//   splitKind    registry point 'kind' for minted inland points (caller clears this kind
//                first, same discipline as 'terrain-split' — see the concrete band
//                module's own doc comment for why THIS module doesn't own that call).
//   width        pull distance, before the per-vertex overshoot clamp.
//   zForInland(vertexId, baseZ) -> number — z for the new inland point. Shore just
//                returns baseZ (keep the water-adjacent corner's own current z,
//                unchanged); Cliff-edge returns the land plot's own "natural" (non-
//                boundary) corner average instead, so the band actually ramps.
//   makeBand(seg, pointIds, polygon, index) -> Surface object — the concrete type's own
//                id/assignedType/parentRegionId shape.
//   isImmutable(plot) -> boolean, optional — plots that must NEVER be touched even if
//                they reference a moved vertex (Shore: the water plot itself, zLocked;
//                Cliff-edge needs no equivalent — the cliff face isn't a terrainPlot).
// Mutates the affected land plots' pointIds/polygon in place — always freshly, from
// whatever `terrainPlots` currently holds, so re-running this (every sync, per ADR-0022's
// "full rebuild every edit") never compounds: callers must ensure `terrainPlots` reflects
// each plot's TRUE current footprint before calling, not an already-band-shrunk one from
// a prior call — see each concrete module's own call site in GroundplaneAudit.js for how
// that's guaranteed (always runs directly after the river/cliff pullback's own from-raw
// reset, in the same pass).
export function buildTransitionBand(registry, terrainPlots, segments, { splitKind, width, zForInland, makeBand, isImmutable = () => false }) {
  if (!segments.length) return []
  const kept = (terrainPlots || []).filter(p => !p.hidden)

  // Rule 1: vertices that are ALSO a corner of some HIDDEN plot are excluded from the
  // pull entirely.
  const hiddenVertexIds = new Set()
  for (const plot of terrainPlots || []) {
    if (!plot.hidden) continue
    for (const id of plot.pointIds || []) hiddenVertexIds.add(id)
  }

  // Per-vertex inland offset: average the inward-normal (toward ITS OWN land plot's
  // centroid) of every segment incident on that vertex. A vertex touched by only one
  // segment (the open end of a run) just uses that one segment's own normal.
  const rawByVertex = new Map()   // vertexId -> { x, y }
  for (const seg of segments) {
    const pa = registry.get(seg.a), pb = registry.get(seg.b)
    if (!pa || !pb) continue
    const centroid = polygonCentroid(registry.resolve(seg.landPlot.pointIds))
    const { nx, ny } = inwardNormal(pa, pb, centroid.x, centroid.y)
    for (const v of [seg.a, seg.b]) {
      const cur = rawByVertex.get(v) || { x: 0, y: 0 }
      cur.x += nx; cur.y += ny
      rawByVertex.set(v, cur)
    }
  }

  // Clamp magnitude against the vertex's own shortest incident LAND-plot edge (never
  // overshoot past a neighbour — same bound used elsewhere in this codebase:
  // HillsExtrusion's retired inset, GroundplaneAudit._pullBackPolygon).
  const minEdgeLenByVertex = new Map()
  for (const plot of kept) {
    const ids = plot.pointIds
    if (!ids || ids.length < 3) continue
    const pts = registry.resolve(ids)
    if (pts.length !== ids.length) continue
    for (let i = 0; i < ids.length; i++) {
      if (!rawByVertex.has(ids[i])) continue
      const prev = pts[(i - 1 + ids.length) % ids.length], next = pts[(i + 1) % ids.length]
      const len = Math.min(Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y), Math.hypot(pts[i].x - next.x, pts[i].y - next.y))
      const cur = minEdgeLenByVertex.get(ids[i])
      minEdgeLenByVertex.set(ids[i], cur == null ? len : Math.min(cur, len))
    }
  }

  const inlandIdByVertex = new Map()
  for (const [v, sum] of rawByVertex) {
    if (hiddenVertexIds.has(v)) continue
    const p = registry.get(v)
    if (!p) continue
    const len = Math.hypot(sum.x, sum.y)
    if (len < 1e-9) continue
    let dist = width
    const maxDist = 0.45 * (minEdgeLenByVertex.get(v) ?? Infinity)
    if (dist > maxDist) dist = maxDist
    if (dist <= 1e-9) continue
    const nx = (sum.x / len) * dist, ny = (sum.y / len) * dist
    const z = zForInland(v, p.z ?? 0)
    const inland = registry.create(p.x + nx, p.y + ny, z, splitKind)
    inlandIdByVertex.set(v, inland.id)
  }

  // Rule 2: swap the inland copy into EVERY kept, non-immutable plot that references a
  // moved vertex — not just the plots with an edge directly ON the boundary.
  for (const plot of kept) {
    if (isImmutable(plot)) continue
    if (!plot.pointIds?.some(id => inlandIdByVertex.has(id))) continue
    const next = plot.pointIds.map(id => inlandIdByVertex.get(id) ?? id)
    plot.pointIds = next
    plot.polygon = registry.resolve(next).map(p => ({ x: p.x, y: p.y, z: p.z }))
  }

  // Rule 3: build the band quads — [a, b, bInland, aInland], bottom edge in the land
  // plot's own original order, top edge reversed. Falling back to the segment's own
  // original id for an excluded endpoint (`?? seg.a`/`?? seg.b`) rather than skipping
  // lets the ring dedupe into a closing triangle instead of leaving a gap; both ends
  // unchanged dedupes below 3 points and is correctly skipped (nothing moved, the
  // original edge is already paired with no band needed).
  const bands = []
  let counter = 0
  for (const seg of segments) {
    const aInland = inlandIdByVertex.get(seg.a) ?? seg.a
    const bInland = inlandIdByVertex.get(seg.b) ?? seg.b
    const pointIds = dedupeRing([seg.a, seg.b, bInland, aInland])
    if (pointIds.length < 3) continue
    const polygon = registry.resolve(pointIds).map(p => ({ x: p.x, y: p.y, z: p.z }))
    if (polygon.length < 3) continue
    bands.push(makeBand(seg, pointIds, polygon, counter++))
  }
  return bands
}
