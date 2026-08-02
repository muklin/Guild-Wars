// River-Bank vertical wall (plan "splendid-beaming-narwhal", 2026-08-01) — the vertical grey
// face resolving a mismatch between a River's own flat bank z (see flattenRiverBankZ below and
// RiverZHeight.js) and the neighbouring land's natural height, replacing what would otherwise be
// the terrain sloping straight into the water. Deliberately NOT a TransitionBand.js-style sloped
// ramp (CONTEXT_WorldTerrain.md's Shore/Cliff-edge entries) — one edge of this wall sits at the
// river's own flat bank height, the other at the land's real natural height nearby, reading as a
// small retaining wall rather than a graded ramp.
//
// This is also what satisfies the "never subdivided along their length, but may conform to the
// mesh along the banks" rule: a River ribbon segment is excluded from the generic
// `subdivideTerrain` Catmull-Clark pass entirely (see GroundplaneAudit._syncGroundplaneSurfaces),
// so it never gains extra points between its own original chain vertices — the LAND plot
// bordering it is subdivided completely normally, and this wall's land-facing edge conforms to
// its own fine geometry there.
//
// DESIGN NOTE — why the wall's land-side reference is NOT "the fine points along the shared
// boundary edge" (an earlier version of this file tried exactly that, via position-bisection —
// confirmed live in this session's own manifold-audit integration test: it produced ZERO wall
// geometry, always, on every river): TerrainSubdivision.js's own edge-point formula is "boundary
// (any 1-face edge) = the PLAIN MIDPOINT z of its two endpoints" (no face-centroid/interior
// influence at all). Excluding the river from subdivideTerrain turns the land plot's shared
// boundary edge into exactly that — a 1-face boundary edge — so EVERY point recovered by
// bisecting it is mathematically just a straight line between its two coarse endpoints. Combined
// with flattenRiverBankZ forcing those two endpoints to the SAME flat centreline z, that line is
// always perfectly flat: there is structurally nothing for a wall to find there, ever.
//
// The fix: use the finest LAND quads that actually touch the river boundary (from the ALREADY-
// subdivided `terrainSurfaces`, not the boundary edge in isolation). Each such quad's boundary
// edge (b1, b2 — flat, on the river line, same degenerate values as above) is USELESS as a
// height reference on its own, but that SAME quad's other two corners (i1, i2 — one edge away
// from b1/b2 respectively) sit on an edge that is INTERIOR to the original land face (shared
// between two adjacent sub-quads produced from splitting one n-gon), which DOES get real
// Catmull-Clark face-centroid blending from the plot's whole shape — i1.z/i2.z is real land
// height. i1/i2 THEMSELVES can't be reused directly as wall corners, though (tried first, live-
// confirmed as a second bug via this file's own manifold-audit test): the edge between them is
// that SAME already-interior, already-twinned Catmull-Clark edge, not a free boundary — a wall
// trying to claim it as one of its own four sides collides with the land mesh's own existing
// claim. Instead, buildBankWallQuads mints two NEW points per touched edge, directly below/
// above b1/b2 (same x,y, i1.z/i2.z for height — matching CONTEXT_WorldTerrain.md's River-Bank
// definition: "both edges of the wall sit at (nearly) the same x,y with different z"), deduped
// by position so two adjacent touched quads sharing one coarse boundary point land on the same
// new wall point there.
import { RIVER_BANK_WALL_MIN_STEP } from '../../../worldConfig/terrainConfig.js'

const posKey = (x, y) => `${x.toFixed(6)},${y.toFixed(6)}`
const undirectedEdgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`)

// Built ONCE per buildRiverBankWalls call — NOT per segment/bank/face — and reused for
// every lookup below. This is what fixes a real, confirmed-live performance bug: the
// original version of this file rescanned the ENTIRE terrainSurfaces list from scratch for
// every single coarse segment (a plain O(quads) linear search each time), which measured
// ~790ms on a real save's ~28k-quad mesh — most of what a "river add is slow" complaint
// traced back to. positionIndex (x,y -> id) lets a coarse segment be bisected down to its
// own fine chain directly (Catmull-Clark XY subdivision is purely linear — the same
// coarse-to-fine correspondence technique this session already validated elsewhere);
// edgeToQuadCorners (undirected fine edge -> that quad's own {b1,b2,i1,i2}, in ITS OWN
// winding order) turns "which quad touches this fine edge" into an O(1) lookup instead of
// a scan.
function buildWallIndexes(registry, quads) {
  const positionIndex = new Map()
  const edgeToQuadCorners = new Map()
  for (const q of quads || []) {
    const ids = q.pointIds || []
    const n = ids.length
    if (n < 3) continue
    for (const id of ids) {
      const p = registry.get(id)
      if (p) positionIndex.set(posKey(p.x, p.y), id)
    }
    for (let k = 0; k < n; k++) {
      const b1 = ids[k], b2 = ids[(k + 1) % n]
      const i1 = ids[(k - 1 + n) % n], i2 = ids[(k + 2) % n]
      if (i1 === b1 || i2 === b2) continue   // degenerate (triangle-ish quad) — skip
      edgeToQuadCorners.set(undirectedEdgeKey(b1, b2), { b1, b2, i1, i2 })
    }
  }
  return { positionIndex, edgeToQuadCorners }
}

function bisectChain(a, b, positionIndex, registry, out, depth) {
  if (depth > 14) return
  const pa = registry.get(a), pb = registry.get(b)
  if (!pa || !pb) return
  const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2
  const midId = positionIndex.get(posKey(mx, my))
  if (midId == null || midId === a || midId === b) return
  bisectChain(a, midId, positionIndex, registry, out, depth + 1)
  out.push(midId)
  bisectChain(midId, b, positionIndex, registry, out, depth + 1)
}

// Every finest-subdivided quad edge lying on the coarse segment apexId->nextId, as
// {b1, b2, i1, i2} — b1/b2 in that SAME quad's OWN stored winding order (deliberately NOT
// remapped to the apex->next walk direction — tried first, live-confirmed as a real winding
// bug via this file's own manifold-audit test: forcing b1/b2 to match the walk direction
// regardless of the quad's own order made the wall's own closing edge run the SAME direction
// as the land quad's edge on any segment where the two directions happened to disagree,
// instead of the required opposite. Every quad along one bank stretch shares one original
// land face's own consistently-preserved Catmull-Clark winding, so leaving b1/b2 exactly as
// each quad stored them still produces a correctly-stitching sequence — just not necessarily
// literally in apex-to-next reading order for a bank whose land happens to wind the other way,
// which nothing downstream depends on). `indexes`: buildWallIndexes' own output — pass it in
// (built once by the caller) for the real, performance-critical path; omit for a one-off/test
// call, where it's built fresh here.
export function findBoundaryQuadEdges(registry, quads, apexId, nextId, indexes = null) {
  const { positionIndex, edgeToQuadCorners } = indexes || buildWallIndexes(registry, quads)
  const mid = []
  bisectChain(apexId, nextId, positionIndex, registry, mid, 0)
  const chain = [apexId, ...mid, nextId]
  const found = []
  for (let i = 0; i < chain.length - 1; i++) {
    const entry = edgeToQuadCorners.get(undirectedEdgeKey(chain[i], chain[i + 1]))
    if (entry) found.push(entry)
  }
  return found
}

// One bank's worth of wall quads for one River face. For each finest land quad touching the
// bank, the quad's OWN "far" edge (i1,i2 — the one opposite the river boundary) is NOT free to
// reuse: it's already an interior Catmull-Clark edge, twinned between that quad and its own
// neighbouring sub-quad (confirmed live while building this — reusing it directly produced
// OVERLAP findings, the classic "same edge claimed twice" conflict). Instead, this mints TWO
// NEW points per touched edge, directly below/above the river boundary's own b1/b2 (same x,y,
// only z differs — CONTEXT_WorldTerrain.md's own River-Bank definition: "both edges of the wall
// sit at (nearly) the same x,y with different z"), each at the land's own real height (i1.z /
// i2.z) read off that quad. mintDeduped (position-tolerance, `reuseExisting: true`) is what
// lets two ADJACENT touched quads sharing one coarse boundary point land on the SAME new wall
// point there instead of two merely-coincident-but-differently-id'd ones — confirmed by this
// file's own manifold-audit test: adjacent finest quads sharing a boundary vertex also share
// that vertex's own Catmull-Clark face-point as their "inner" reference, so their two candidate
// wall positions already agree exactly, and position-dedup turns that agreement into one id.
// Skips a touched edge whose height difference is below `minStep` — a stretch already flush
// with the land needs no wall there. `indexes`: buildWallIndexes' own output — pass it in
// (built once by the caller, across every bank/face) for the real path; omit for a one-off/
// test call.
export function buildBankWallQuads(registry, coarseChainIds, terrainSurfaces, minStep, indexes = null) {
  const idx = indexes || buildWallIndexes(registry, terrainSurfaces)
  const candidates = []
  const perEdge = []
  for (let i = 0; i < coarseChainIds.length - 1; i++) {
    const apex = coarseChainIds[i], next = coarseChainIds[i + 1]
    if (apex === next) continue
    for (const e of findBoundaryQuadEdges(registry, terrainSurfaces, apex, next, idx)) {
      const b1 = registry.get(e.b1), b2 = registry.get(e.b2), i1 = registry.get(e.i1), i2 = registry.get(e.i2)
      if (!b1 || !b2 || !i1 || !i2) continue
      // Terrain below the river's own bank is no longer handled here — raiseGroundplaneNearRiverBanks
      // (run earlier, before this) already raised any genuinely-low terrain up to the local
      // river height, so by the time this runs, a remaining height difference only ever
      // means the land is ABOVE the bank (the case a wall is actually for).
      const bankZ = (b1.z + b2.z) / 2
      const maxZ = Math.max(bankZ, i1.z, i2.z), minZ = Math.min(bankZ, i1.z, i2.z)
      if (maxZ - minZ < minStep) continue
      const w1Idx = candidates.push({ x: b1.x, y: b1.y, z: i1.z }) - 1
      const w2Idx = candidates.push({ x: b2.x, y: b2.y, z: i2.z }) - 1
      perEdge.push({ b1: e.b1, b2: e.b2, w1Idx, w2Idx })
    }
  }
  if (!perEdge.length) return []
  const wallIds = registry.mintDeduped(candidates, 'river-bank-wall', 0.01, { reuseExisting: true })
  // Winding: [b1, w1, w2, b2] — the only edge here that reuses an existing one is (b2, b1)
  // (reversed from the land quad's own b1->b2), matching this codebase's universal adjacent-
  // face convention; the other three edges (b1-w1, w1-w2, w2-b2) are all freshly minted, so
  // there is nothing else for them to conflict with.
  return perEdge.map(pe => [pe.b1, wallIds[pe.w1Idx], wallIds[pe.w2Idx], pe.b2])
}

// Point adjacency over the fine subdivided mesh — every quad's own edges, both directions.
// The "hop" structure raiseGroundplaneNearRiverBanks walks.
function buildAdjacency(quads) {
  const adj = new Map()
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a).add(b)
  }
  for (const q of quads || []) {
    const ids = q.pointIds || []
    const n = ids.length
    for (let i = 0; i < n; i++) {
      const a = ids[i], b = ids[(i + 1) % n]
      if (a === b) continue
      link(a, b); link(b, a)
    }
  }
  return adj
}

// Raises every subdivided-mesh point within `hops` graph-steps of a River bank point up to
// that bank point's own z, wherever it's currently lower (user-confirmed 2026-08-02 process:
// "hop out 3 steps from the river bank points, all subdivided groundplane half edges. Any
// points that aren't on the river get raised to the height of the river."). Run BEFORE
// buildBankWallQuads/buildRiverBankWalls — this is now the SOLE mechanism for the "terrain
// below the river" direction (replacing an earlier, much narrower version that only ever
// raised the ONE touching land quad's own inner corner), so a wall only ever needs building
// for terrain that's genuinely ABOVE the bank once this has already run.
//
// A single GLOBAL visited set — never reconsider a point once any bank point's own search has
// already reached it, regardless of which bank point (or which hop) got there first — is both
// what "do not process any point on the river more than once" asks for and what keeps this
// cheap on a long multi-Edge river: total work is bounded by the mesh's own point count once,
// not by (bank points x quads) the way the wall's own boundary-edge scan is.
export function raiseGroundplaneNearRiverBanks(registry, terrainSurfaces, riverCliffFaces, hops = 3) {
  const riverPointIds = new Set()
  for (const face of riverCliffFaces || []) {
    if (face.assignedType !== 'River') continue
    for (const id of face.pointIds || []) riverPointIds.add(id)
  }
  if (!riverPointIds.size) return

  const adj = buildAdjacency(terrainSurfaces)
  const visited = new Set(riverPointIds)   // a river's own bank/centreline points are never "raised"

  for (const face of riverCliffFaces || []) {
    if (face.assignedType !== 'River' || String(face.id).startsWith('junction-')) continue
    for (const startId of face.pointIds || []) {
      const start = registry.get(startId)
      if (!start) continue
      let frontier = [startId]
      for (let hop = 0; hop < hops && frontier.length; hop++) {
        const next = []
        for (const id of frontier) {
          for (const nbId of adj.get(id) || []) {
            if (visited.has(nbId)) continue
            visited.add(nbId)
            const p = registry.get(nbId)
            if (p && !p.zLocked && p.z < start.z) p.z = start.z
            next.push(nbId)
          }
        }
        frontier = next
      }
    }
  }
}

// Force a River face's left/right bank z to match its own centreline at every chain point —
// closes a real gap in the existing pullback: _dcelPullbackMaterialize's posFor overrides a
// split point's z with a Cliff's own high/low targetAvg wherever vertexCliffSides has an entry,
// but _buildRiverCliffFacesDirect mints a River ribbon's bank corners via mintDeduped's
// reuseExisting, which can silently reuse a HIGH-side split copy for one bank and a LOW-side
// copy for the other at a Cliff/River crossing — breaking flat-cross-section exactly at a
// Waterfall, the one place it matters most. Position-matched (nearest centreline point by x,y)
// rather than index-matched: _computeRiverCliffBoundaryData/computeEdgeCorners can skip a null
// boundary corner, so a bank point's own index doesn't always line up with edge.pointIds'.
// River faces only — Cliff faces are untouched (their own high/low split is intentional).
export function flattenRiverBankZ(registry, riverCliffFaces, edges) {
  for (const face of riverCliffFaces || []) {
    // Junction caps (id `junction-*`) are a compact fan polygon, not a [...lefts,
    // ...reversed(rights)] bank strip — no left/right structure to flatten here.
    if (face.assignedType !== 'River' || String(face.id).startsWith('junction-')) continue
    const edge = edges?.[face.sourceEdgeId]
    if (!edge) continue
    const centrelinePts = (edge.pointIds || []).map(id => registry.get(id)).filter(Boolean)
    if (!centrelinePts.length) continue
    const n = face.pointIds.length / 2
    for (let k = 0; k < n; k++) {
      const leftId = face.pointIds[k]
      const rightId = face.pointIds[face.pointIds.length - 1 - k]
      const left = registry.get(leftId), right = registry.get(rightId)
      if (!left || !right) continue
      let nearest = null, nearestD = Infinity
      for (const p of centrelinePts) {
        const d = (p.x - left.x) ** 2 + (p.y - left.y) ** 2
        if (d < nearestD) { nearestD = d; nearest = p }
      }
      if (!nearest) continue
      if (!left.zLocked) left.z = nearest.z
      if (!right.zLocked) right.z = nearest.z
    }
  }
}

// Builds every River-Bank wall quad across every River face, reading fine land-side
// subdivision off the ALREADY-subdivided `terrainSurfaces` (must be called after
// subdivideTerrain has run, and after River ribbon segments — coarse, unsubdivided — have been
// appended to it). Returns a flat Surface array matching subdivideTerrain's own quad shape
// ({id, parentRegionId, assignedType, hidden, sourcePlotId, pointIds, polygon}), assignedType
// 'River-Bank'. Two of each wall quad's four corners are the river's own existing bank ids;
// the other two are freshly minted, ephemeral 'river-bank-wall' points (see
// buildBankWallQuads' own doc comment for why they can't just reuse the land's own corners) —
// callers that rebuild the whole pipeline from scratch each pass (this codebase's own
// convention for every other split/band point kind) should clear that kind first.
export function buildRiverBankWalls(registry, terrainSurfaces, riverCliffFaces, minStep = RIVER_BANK_WALL_MIN_STEP) {
  const walls = []
  // Land quads only — River/Cliff ribbon segments (unsubdivided, appended straight into
  // terrainSurfaces earlier in the same sync pass — see GroundplaneAudit._syncGroundplaneSurfaces)
  // and any already-built wall quads from an earlier bank in this same call would otherwise
  // ALSO match findBoundaryQuadEdges' own scan: a river ribbon segment's own edge IS exactly
  // (leftIds[i], leftIds[i+1]), the same coarse span this function is searching for — so an
  // unfiltered scan finds the ribbon itself as a spurious "finest touching quad" spanning the
  // ENTIRE coarse segment (confirmed live: a real wall built this way had two corners ~4 units
  // apart, `i1`/`i2` sourced from the RIVER's own opposite bank, not real land height at all —
  // the cause of a real AREA_OVERLAP explosion against every actual fine land quad along that
  // whole span). Filtering to plain land keeps the search scoped to genuine finest quads only.
  const landQuadsOnly = (terrainSurfaces || []).filter(q => q.assignedType !== 'River' && q.assignedType !== 'Cliff' && q.assignedType !== 'River-Bank')
  // Built ONCE for every face/bank in this call — see buildWallIndexes' own doc comment for
  // why this (not a per-segment rescan) is what makes this function cheap on a real map.
  const indexes = buildWallIndexes(registry, landQuadsOnly)
  let counter = 0
  for (const face of riverCliffFaces || []) {
    // Junction caps have no left/right bank structure — see flattenRiverBankZ's matching guard.
    if (face.assignedType !== 'River' || String(face.id).startsWith('junction-')) continue
    const n = face.pointIds.length / 2
    if (n < 2) continue
    const leftIds = face.pointIds.slice(0, n)
    const rightIds = face.pointIds.slice(n).reverse()
    for (const [bankIds, bankName] of [[leftIds, 'left'], [rightIds, 'right']]) {
      const quads = buildBankWallQuads(registry, bankIds, landQuadsOnly, minStep, indexes)
      for (const quadIds of quads) {
        const polygon = registry.resolve(quadIds).map(p => ({ x: p.x, y: p.y, z: p.z }))
        if (polygon.length < 4) continue
        walls.push({
          id: `riverbank:${face.id}:${bankName}:${counter++}`,
          parentRegionId: undefined,
          assignedType: 'River-Bank',
          hidden: false,
          sourcePlotId: face.id,
          pointIds: quadIds,
          polygon,
        })
      }
    }
  }
  return walls
}
