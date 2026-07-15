import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Assembles a Parametric Building from a Building Spec using a PartLibrary (theme).
// PURE + DETERMINISTIC: all variation comes from spec.seed — NO Math.random() here.
//
// Spec: { seed, floors, footprint:{type:'wings', wings:[{vertices,front,floors,jetty?}]},
//         roof:{shape:'gable',material,pitch,overhang?}, neighborWings?, suppressedFaces? }
// A wing's `vertices`/`front` are in model space; a single rectangle (free-standing house)
// is the degenerate one-wing case of the same polygon-wing shape townhouses use — see
// BuildingRenderer.js's `_buildSpec`/`_buildTownhouseSpec`.
// `wing.floors` is a per-wing floor list: [{ zHeight, height, material }, …] in
// floor-height units (zHeight=0 is the true ground plane) — replaces the old
// floors-count + spec-level wallMaterial array, so wings can each have their own floor
// count, per-floor height, and a raised ground floor (a Foundation gap below it).
// After the roof is built, a trailing { type:'roof', zHeight, height, riseHalfUnits }
// entry is appended to the same list (see addBuildingRoof / the per-wing roof loop below).
// Material rules (enforced by the spec producer): ≤2 materials/building; stone ONLY on
// the ground floor; wood roof only if every floor is wood.

const WINDOWS = ['window', 'window-short', 'window-single', 'window-shutter', 'window-closed']
const STONE_MATS = new Set(['stone', 'granite', 'brick'])
// Material priority for lean-to party walls — only the higher-priority side draws.
const MAT_PRIO = { stone: 3, granite: 3, brick: 3, plaster: 2, wood: 1 }
const matPrio = m => MAT_PRIO[m] ?? 1
const RENDER_ROOFS = true   // set false to hide roofs while testing walls
const RENDER_DORMERS = true // dormers are the last roof feature to add — off for now
// TEMPORARY roof debug flags — revert when done comparing roof shapes.
const DEBUG_FORCE_GABLE_ROOFS = true   // disable Dutch-gable hip ends; every roof end is a plain gable
const DEBUG_UNIFORM_RIDGE = true       // ignore per-wing/per-spec pitch & ridge height, use the constants below
const DEBUG_RIDGE_PITCH  = 0.6
const DEBUG_RIDGE_HEIGHT = 1.0
// Roof rise is quantized to whole half-floor-height units (decision #7 — "Per-floor
// building data model" plan) so a roof can sit in the same per-wing floor list as the
// walls and the top-down floor-scroll can step onto it uniformly. 0–4 units = 0–2.0
// floor-heights.
const ROOF_RISE_MAX_HALF_UNITS = 4

function makeRng(seed) {
  let s = (Math.floor(seed) * 2654435761) >>> 0
  if (s === 0) s = 0x9e3779b9
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296 }
}
// Param t where segment p→q crosses segment a→b (strictly interior to both); null otherwise.
function segCrossT(p, q, a, b) {
  const rx = q.x - p.x, ry = q.y - p.y, sx = b.x - a.x, sy = b.y - a.y
  const d = rx * sy - ry * sx
  if (Math.abs(d) < 1e-12) return null
  const t = ((a.x - p.x) * sy - (a.y - p.y) * sx) / d
  const u = ((a.x - p.x) * ry - (a.y - p.y) * rx) / d
  return (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) ? t : null
}
function pointInPoly(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y
    if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}
// Unit normal of edge a→b pointing OUTWARD from `wingPoly` (away from the wing interior).
function edgeOutwardNormal(a, b, wingPoly) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1
  let nx = -dy / L, ny = dx / L
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  if (pointInPoly({ x: mx + nx * 1e-3, y: my + ny * 1e-3 }, wingPoly)) { nx = -nx; ny = -ny }
  return { nx, ny }
}
// Sub-intervals of edge a→b, split at crossings with (and collinear vertex projections of)
// EITHER `siblingWings` (other wings of this SAME building) or `neighborWings` (other
// buildings' wings) — combined, so boundaries land in the right place regardless of which
// set caused them — then each sub-interval is classified by probing a point just OUTSIDE it
// (away from this wing) against the two sets SEPARATELY:
//   - covered by a SIBLING  → genuinely interior/shared within one building; dropped entirely.
//   - covered by a NEIGHBOUR building only → a true party wall; kept, returned with
//     interbuilding=true so the caller can render it hidden by default, shown only in
//     top-down (see BuildingRenderer.setInterbuildingWallsVisible).
//   - covered by neither → ordinary exterior wall.
// Returns [t0, t1, interbuilding].
const WALL_STEP = 0.1   // model units stepped outward to probe for an adjoining wing
function boundaryIntervals(a, b, wingPoly, siblingWings, neighborWings, tol, currentZHeight, currentZHeightEnd) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy, L = Math.sqrt(L2) || 1
  const ts = [0, 1]
  for (const w of [...siblingWings, ...neighborWings]) {
    const poly = w.poly
    for (let k = 0; k < poly.length; k++) {
      const c = poly[k], d = poly[(k + 1) % poly.length]
      const t = segCrossT(a, b, c, d); if (t != null) ts.push(t)
      for (const p of [c, d]) {                                  // collinear overlap endpoints
        if (Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L < tol) {
          const tp = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2
          if (tp > 1e-6 && tp < 1 - 1e-6) ts.push(tp)
        }
      }
    }
  }
  ts.sort((x, y) => x - y)
  const { nx, ny } = edgeOutwardNormal(a, b, wingPoly)
  const out = []
  for (let s = 0; s < ts.length - 1; s++) {
    const t0 = ts[s], t1 = ts[s + 1]
    if (t1 - t0 < 1e-6) continue
    const mt = (t0 + t1) / 2
    const ox = a.x + dx * mt + nx * WALL_STEP, oy = a.y + dy * mt + ny * WALL_STEP
    const pt = { x: ox, y: oy }
    const matchingSiblings = siblingWings.filter(w => pointInPoly(pt, w.poly))
    if (matchingSiblings.length > 0) {
      // Sibling wings at the SAME z-height share an open passage — no wall between them.
      // Sibling wings at a DIFFERENT z-height produce a lean-to wall (no windows/doors).
      // Only the higher-priority material draws; return sibMat so the caller can decide.
      const sameLevel = matchingSiblings.some(w =>
        w.floors.some(fe => fe.type !== 'roof' && Math.abs(fe.zHeight - currentZHeight) < 1e-6))
      if (sameLevel) continue
      // Find the best material of the sibling floors that overlap this floor's Y range.
      let sibMat = null
      for (const w of matchingSiblings) {
        for (const fe of w.floors) {
          if (fe.type === 'roof') continue
          if (fe.zHeight < currentZHeightEnd - 1e-6 && currentZHeight < fe.zHeight + fe.height - 1e-6) {
            if (matPrio(fe.material) > matPrio(sibMat)) sibMat = fe.material
          }
        }
      }
      out.push([t0, t1, 'sibling', sibMat])
    } else {
      const isInterbuilding = neighborWings.some(w => pointInPoly(pt, w.poly))
      out.push([t0, t1, isInterbuilding ? 'interbuilding' : 'free'])
    }
  }
  return out
}

// Index of the wing-polygon edge that is the street frontage (collinear & aligned with the
// stored front segment), or -1. Survives clipping because the street edge stays on the plot
// boundary. Used to guarantee a door on the frontage.
function frontEdgeIndex(poly, front) {
  if (!front) return -1
  const a = { x: front[0][0], y: front[0][1] }, b = { x: front[1][0], y: front[1][1] }
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1
  let best = -1, bestScore = Infinity
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    const ex = q.x - p.x, ey = q.y - p.y, eL = Math.hypot(ex, ey) || 1
    const align = Math.abs((ex * dx + ey * dy) / (eL * L))                          // 1 = parallel
    const perp = Math.abs(((p.x + q.x) / 2 - a.x) * dy - ((p.y + q.y) / 2 - a.y) * dx) / L
    const score = perp + (1 - align)
    if (align > 0.9 && score < bestScore) { bestScore = score; best = i }
  }
  return best
}

// Jetty: returns a copy of `poly` with ONLY the two vertices of `edgeIdx` pushed `amount`
// along `dir` — the rest of the polygon (sides, back) is untouched. Used to derive an
// upper floor's wider footprint from the ground floor's, pushing just the front wall
// toward the street without re-deriving the whole wing shape.
function pushFrontEdge(poly, edgeIdx, dir, amount) {
  if (edgeIdx < 0 || amount <= 0) return poly
  const j = (edgeIdx + 1) % poly.length
  const out = poly.map((p) => ({ x: p.x, y: p.y }))
  out[edgeIdx] = { x: poly[edgeIdx].x + dir[0] * amount, y: poly[edgeIdx].y + dir[1] * amount }
  out[j] = { x: poly[j].x + dir[0] * amount, y: poly[j].y + dir[1] * amount }
  return out
}

// Height (topY, world Y of the wall-plate) of a wing from its OWN floor list — filters
// out a trailing roof entry (assemble() may have already appended one to a sibling wing
// processed earlier in the SAME roof loop) so height comparisons stay correct regardless
// of wing processing order.
function wingTopYFromFloors(floors, floorHeight) {
  const fl = (floors ?? []).filter(e => e.type !== 'roof')
  if (!fl.length) return 0
  const last = fl[fl.length - 1]
  return (last.zHeight + last.height) * floorHeight
}

// A cheap, deterministic per-wing tiebreak score (no two distinct polygons should ever
// produce the same value) — used when two+ wings converge at EQUAL height (decision:
// "the overlap is not what I expect... exactly one wing should win any disputed area").
// Without this, equal-height wings never satisfy a strict "taller than" test against
// each other, so NONE of them would ever subtract their shared overlap, and a 3-way
// (or more) wing junction draws every wing's full footprint there — double- or
// triple-roofed, not cleanly partitioned.
function wingTieScore(poly) {
  let s = 0
  for (const v of (poly ?? [])) s += v.x * 7 + v.y * 13
  return s
}
// True if the "other" wing (topY/score) outranks "mine" — strictly taller wins
// outright; equal height falls back to the tiebreak score. Exactly one of
// wingOutranks(A,B) / wingOutranks(B,A) is true for any two distinct wings, so footprint
// subtraction (the loser subtracts its overlap with the winner) always nets to a clean
// partition with no double-counting, regardless of how many wings meet at one point.
function wingOutranks(otherTopY, otherScore, myTopY, myScore) {
  if (otherTopY > myTopY + 1e-6) return true
  if (otherTopY < myTopY - 1e-6) return false
  return otherScore > myScore
}

// Sutherland-Hodgman half-plane clip of a TAGGED polygon ([{x,y,cutBefore}], where
// cutBefore flags "the edge from the previous vertex to this one came from an earlier
// footprint-subtraction clip"). Keeps the side where (p-p0)·nrm >= 0. The new edge this
// clip introduces (between the two freshly-created intersection points) gets cutBefore
// set on its destination vertex, so callers can tell a "real" wing-boundary edge from a
// "the roof stops here because a taller neighbour's footprint was subtracted" edge.
function clipHalfPlaneTagged(poly, p0, nrm) {
  const side = (p) => (p.x - p0.x) * nrm.x + (p.y - p0.y) * nrm.y
  const out = [], isNew = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n]
    const da = side(a), db = side(b)
    if (da >= -1e-9) { out.push({ x: a.x, y: a.y, cutBefore: a.cutBefore }); isNew.push(false) }
    if ((da >= -1e-9) !== (db >= -1e-9)) {
      const t = da / (da - db)
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, cutBefore: false })
      isNew.push(true)
    }
  }
  const m = out.length
  for (let i = 0; i < m; i++) {
    const prev = (i - 1 + m) % m
    if (isNew[i] && isNew[prev]) out[i].cutBefore = true
  }
  return out
}

// Roof-footprint subtraction ("avoid double roofing"): clips `wingPoly` against every
// TALLER neighbour polygon that actually overlaps it, removing the overlapping area so
// two wings never both claim to roof the same ground. Returns null if `wingPoly` is
// entirely covered by a taller neighbour (no roof at all for this wing — the taller
// one's roof already covers it). For wings that merely sit NEXT TO a taller neighbour
// (the common case — a shared party wall, no actual footprint overlap) this is a no-op;
// the per-edge free/suppressed check in addBuildingRoof handles that case instead.
function subtractTallerFootprints(wingPoly, tallerPolys) {
  let poly = wingPoly.map(p => ({ x: p.x, y: p.y, cutBefore: false }))
  for (const tp of tallerPolys) {
    if (poly.every(v => pointInPoly(v, tp))) return null
    for (let i = 0; i < tp.length; i++) {
      const p0 = tp[i], p1 = tp[(i + 1) % tp.length]
      let crosses = false
      for (let j = 0; j < poly.length; j++) {
        const a = poly[j], b = poly[(j + 1) % poly.length]
        if (segCrossT(a, b, p0, p1) != null) { crosses = true; break }
      }
      if (!crosses) continue
      const { nx, ny } = edgeOutwardNormal(p0, p1, tp)
      const clipped = clipHalfPlaneTagged(poly, p0, { x: nx, y: ny })
      if (clipped.length >= 3) poly = clipped
    }
  }
  return poly
}

export function assemble(spec, lib) {
  const group = new THREE.Group()
  const rand = makeRng(spec.seed ?? 1)
  const { bayWidth: B, floorHeight: H } = lib.grid

  // building-level params (drawn first so the rand stream is stable)
  const ovMin = spec.roof?.overhangMin ?? 0.14
  const overhang = ovMin + rand() * ((spec.roof?.overhangMax ?? 0.48) - ovMin)
  const braceSlot = rand() < 0.4 ? 'brace-double' : 'brace'   // consistent knee style per house
  // Gable decoration, consistent per house: ⅓ king post to the apex, ⅓ chevron braces,
  // ⅓ double horizontal bracing (the latter two stop the centre pole at the story plank).
  // A king post is only used when a wall post lines up under the gable centre; otherwise
  // it falls back to `gableBrace`.
  const gableStyle = ['kingpost', 'angled', 'horizontal'][Math.floor(rand() * 3)]
  const gableBrace = rand() < 0.5 ? 'angled' : 'horizontal'
  // One non-stone window style for the whole building — mixing window-short/single/shutter/
  // closed bay-to-bay on the same house reads as noise, not variety. Stone walls are exempt:
  // they always use the dedicated stone-framed window regardless of this pick.
  const windowType = WINDOWS[Math.floor(rand() * WINDOWS.length)]

  // Each wing has `vertices: [[x,z],…]` + a `front` street edge in model space, processed
  // independently. Group sits at world origin with scale=PARA_SCALE and rotation=0 for
  // townhouses; free-standing houses are the degenerate one-wing case, placed by the caller.
  if (spec.footprint?.type === 'wings' && spec.footprint.wings?.some(w => w.vertices)) {
    const fwings = spec.footprint.wings
    const specSF = spec.suppressedFaces ?? []
    const roofSpec = spec.roof ?? { material: 'slate' }
    let doorPlaced = false   // building-level: guarantee at least one door on a frontage
    let doorPos = null       // building-level world position of the placed door — keeps a
                              // window from ever landing on/right next to it, even across
                              // different wings (e.g. two wing edges meeting at a corner)
    // Building-level window budget — across ALL wings, never let windowed bays exceed 40%
    // of decided (non-door, non-braced) bays. Checked as a running ratio at decision time.
    const WINDOW_FRACTION_CAP = 0.4
    let winCount = 0, winTotal = 0
    // Roofs (+ dormers/chimneys/gable trim) go into their own group, merged separately
    // and tagged so callers can hide just the roof at runtime (e.g. top-down camera mode)
    // — see BuildingRenderer.setRoofsVisible.
    const roofGroup = new THREE.Group()
    const wallsGroup = new THREE.Group()
    // Party walls shared with a NEIGHBOUR BUILDING (not a sibling wing of this same
    // building) are kept rather than suppressed, but routed here instead of wallsGroup —
    // hidden by default, shown only in top-down (see BuildingRenderer.setInterbuildingWallsVisible).
    const interbuildingGroup = new THREE.Group()
    // place() always targets whichever group is "current" — the per-interval loop below
    // swaps this to interbuildingGroup for intervals classified interbuilding, and restores
    // it to wallsGroup afterward, so every helper that already calls place()/adds directly
    // (posts, panels, windows, doors, braces) is automatically routed correctly with no
    // per-call-site changes.
    let currentWallGroup = wallsGroup
    const place = (mesh, px, pz, y, rotY, scaleX = 1, sign = 1, scaleY = 1) => {
      if (!mesh) return
      mesh.position.set(px, y, pz); mesh.rotation.y = rotY; mesh.scale.x = scaleX * sign; mesh.scale.y = scaleY; currentWallGroup.add(mesh)
    }

    for (const [wi, wing] of fwings.entries()) {
      // Per-wing floor list: [{ zHeight, height, material }] in floor-height units —
      // zHeight is already absolute (includes any Foundation gap below the ground
      // floor), so unlike the old floors-count model nothing needs lifting afterward.
      const wingFloorList = wing.floors
      const wingFloorCount = wingFloorList.length
      const wingPoly = wing.vertices.map(([x, z]) => ({ x, y: z }))
      const frontEdge = frontEdgeIndex(wingPoly, wing.front)
      // Archway (see Archway, CONTEXT_BuildingsRoofs.md): every wing BuildingRenderer
      // gives an archway is a plain 4-vertex rectangle [front, front+1, back, back+1],
      // so the opposite (back) edge is always 2 steps around. `startT/endT` are
      // fractions along `wing.front` (frontEdge's own A→B direction); the back edge
      // runs the opposite winding direction, so the same span there is [1-endT,1-startT].
      const archEdges = (wing.archway && wingPoly.length === 4)
        ? { [frontEdge]: [wing.archway.startT, wing.archway.endT], [(frontEdge + 2) % 4]: [1 - wing.archway.endT, 1 - wing.archway.startT] }
        : null
      const matTop = wingFloorList[wingFloorCount - 1].material
      const suppRoof = new Set(specSF.filter(sf => sf.wingIndex === wi && sf.upToFloor >= wingFloorCount - 1).map(sf => sf.edgeIndex))

      // Jetty: floors at/above `fromFloor` use a wider polygon, its front wall pushed
      // FORWARD into the street by `amount` (the wing's front sits on the street edge — no
      // setback — so this overhangs past it; `amount` is capped server-side at jettyProjection).
      const jettyPoly = wing.jetty ? pushFrontEdge(wingPoly, frontEdge, wing.jettyDir ?? [0, 0], wing.jetty.amount) : null
      const polyAt = (f) => (jettyPoly && f >= wing.jetty.fromFloor) ? jettyPoly : wingPoly

      // This wing's own (frontage, depth) axes + which is the long one — used to align
      // floor-texture sampling to the wing's own orientation (see addFloor) instead of
      // the building's shared model-space axes.
      let floorAxes = null
      if (wing.front) {
        const fdx = wing.front[1][0] - wing.front[0][0], fdz = wing.front[1][1] - wing.front[0][1]
        const fL = Math.hypot(fdx, fdz) || 1
        const ux = fdx / fL, uz = fdz / fL, nx = -uz, nz = ux
        let uMin = Infinity, uMax = -Infinity, nMin = Infinity, nMax = -Infinity
        for (const p of wingPoly) {
          const pu = p.x * ux + p.y * uz, pn = p.x * nx + p.y * nz
          if (pu < uMin) uMin = pu; if (pu > uMax) uMax = pu
          if (pn < nMin) nMin = pn; if (pn > nMax) nMax = pn
        }
        floorAxes = { ux, uz, nx, nz, longIsU: (uMax - uMin) >= (nMax - nMin) }
      }

      // Walls draw ONLY along the building's merged outline: per edge, the sub-segments
      // not interior to another wing — but SIBLING wings (other wings of this same
      // building) and NEIGHBOUR buildings' wings (spec.neighborWings) are treated
      // differently below: sibling overlap is genuinely interior and removed entirely;
      // neighbour-building overlap is a real party wall, kept but tagged interbuilding.
      // Suppression is Y-RANGE based, not floor-index based: a sibling/neighbour only
      // suppresses this wing's wall at floor f if one of ITS OWN floor entries actually
      // overlaps floor f's [zHeight, zHeight+height) interval — floor index alone no
      // longer means the same vertical slice once wings can have independent floor lists.
      const WALL_TOL = 0.08   // model units: collinear/coincidence tolerance for shared walls
      const toWingPolys = (ws) => ws.map(w => ({ poly: w.vertices.map(([x, z]) => ({ x, y: z })), floors: w.floors }))
      const siblingWingsAll = toWingPolys(fwings.filter((_, j) => j !== wi))
      const neighborWingsAll = toWingPolys(spec.neighborWings ?? [])
      const yOverlaps = (entry, floorList) => floorList.some(fe =>
        entry.zHeight < fe.zHeight + fe.height - 1e-6 && fe.zHeight < entry.zHeight + entry.height - 1e-6)
      // Drawable sub-intervals of edge a→b (of `poly`) at floor f: exterior parts not
      // covered by a sibling/neighbour whose own floor list reaches this floor's Y-range.
      // So a taller wing/building keeps its wall above a shorter one. Returns [t0,t1,interbuilding].
      const drawIntervals = (poly, i, a, b, f) => {
        const entry = wingFloorList[f]
        return boundaryIntervals(
          a, b, poly,
          siblingWingsAll.filter(w => yOverlaps(entry, w.floors)),
          neighborWingsAll.filter(w => yOverlaps(entry, w.floors)),
          WALL_TOL,
          entry.zHeight,
          entry.zHeight + entry.height,
        )
      }

      // Foundation: half-height stone footing filling the gap between true ground (y=0)
      // and the ground floor's zHeight — derived straight from the floor list (decision
      // #5), so it exists exactly when BuildingRenderer raised the ground floor's
      // zHeight. Always the ground floor's own (stone/granite/brick) material, and
      // always uses the wing's base (non-jettied) polygon.
      const groundGap = wingFloorList[0].zHeight * H
      if (groundGap > 1e-4) addFoundationForWing(wallsGroup, lib, wingPoly, drawIntervals, groundGap, wingFloorList[0].material, B, archEdges)

      // Window presence per (edge, bay) — decided once (whichever floor reaches that bay
      // first) and reused on every other floor, so windows stack directly above/below each
      // other instead of each floor rolling independently. Within one edge's first pass,
      // a bay also checks its mirror bay (k vs nBays-1-k) so left/right read as symmetric.
      const bayWindowCache = new Map()

      for (let f = 0; f < wingFloorCount; f++) {
        const entry = wingFloorList[f]
        const yBase = entry.zHeight * H, floorH = entry.height * H, mat = entry.material, poly = polyAt(f)
        // Floor surfaces sit at clean half-floor-height multiples (yBase itself — no
        // fudge offset) so the floor-scroll clip plane (set just above each 0.5
        // multiple, see WorldRenderer._applyFloorScrollClip) reliably includes them
        // instead of clipping the floor away along with the wall above it. The one
        // exception is the true ground floor (zHeight=0), which gets a tiny lift so its
        // surface doesn't z-fight the exterior ground-plane mesh it sits flush against.
        addFloor(wallsGroup, poly, yBase + (entry.zHeight === 0 ? 0.05 : 0), mat, lib, floorAxes)
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length]
          const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy)
          if (L < 1e-6) continue
          const ux = dx / L, uy = dy / L, rotY = Math.atan2(uy, -ux)
          // Knee braces at this edge's true corners (plaster only), rolled once per
          // floor+edge like the rest of the bay layout. Only placed where a drawn interval
          // actually reaches the corner (t0===0 / t1===1) — a corner hidden behind a
          // party-wall suppression gets no floating brace.
          const braceA = mat === 'plaster' && rand() < 0.5
          const braceB = mat === 'plaster' && rand() < 0.5
          for (const [t0, t1, wallType, sibMat] of drawIntervals(poly, i, a, b, f)) {
            const segL = L * (t1 - t0)
            if (segL < 1e-4) continue
            // Lean-to sibling wall: skip if the sibling has higher material priority — it draws this face.
            if (wallType === 'sibling' && matPrio(sibMat) > matPrio(mat)) continue
            currentWallGroup = wallsGroup
            const isPartyWall = wallType === 'sibling' || wallType === 'interbuilding'
            // Pull party walls slightly inward so coplanar faces from both sides don't fight.
            let pox = 0, poz = 0
            if (isPartyWall) {
              const { nx: onx, ny: ony } = edgeOutwardNormal(a, b, poly)
              pox = -onx * 0.02; poz = -ony * 0.02
            }
            const s0x = a.x + ux * L * t0 + pox, s0y = a.y + uy * L * t0 + poz
            const nBays = Math.max(1, Math.round(segL / B)), pitch = segL / nBays
            // Archway (Archway, CONTEXT_BuildingsRoofs.md): if this interval overlaps the
            // ground-floor front/back span BuildingRenderer picked for this wing's
            // archway, clip that span to THIS interval's own [t0,t1] sub-range and convert
            // to bay-index units — bays whose centre falls inside get no wall panel below.
            let archBayRange = null
            if (f === 0 && archEdges?.[i]) {
              const [aStart, aEnd] = archEdges[i]
              const clipStart = Math.max(aStart, t0), clipEnd = Math.min(aEnd, t1)
              if (clipEnd > clipStart) archBayRange = [((clipStart - t0) / (t1 - t0)) * nBays, ((clipEnd - t0) / (t1 - t0)) * nBays]
            }
            // Uprights snapped to bay boundaries (both ends + up to 4 interior, ≤6 total),
            // so windows/doors at bay CENTRES always sit between uprights, never on one.
            const postKs = new Set([0, nBays])
            const interior = Math.min(nBays - 1, 4)
            for (let p = 1; p <= interior; p++) postKs.add(Math.round(p * nBays / (interior + 1)))
            for (const pk of postKs) {
              const ppx = s0x + ux * pk * pitch, ppz = s0y + uy * pk * pitch
              // Ground floor: a stone column (matching the ground floor's own stone type)
              // when that floor is stone/granite/brick; every other floor keeps the normal
              // wood post. The column continues as a wood post above, same as any other floor.
              // The post kit part is authored at the standard floor height H — stretch it
              // to floorH so a 1.5-floor's posts still reach the plank above (decision #2,
              // per-floor height) instead of stopping 2/3 of the way up.
              if (f === 0 && STONE_MATS.has(mat)) addStoneColumn(currentWallGroup, lib, mat, ppx, ppz, yBase, rotY, floorH - 0.02)
              else place(lib.get('post'), ppx, ppz, yBase, rotY, 1, 1, (floorH - 0.02) / H)
            }
            // A door is forced on the ground floor of the frontage edge (first visible
            // segment), centred in its middle bay — guaranteeing one front door per building.
            let doorBay = (f === 0 && i === frontEdge && !doorPlaced && !isPartyWall) ? Math.floor(nBays / 2) : -1
            // An Archway spanning the building's centre (the common case) would otherwise
            // steal the forced door's own bay — shift it just outside the archway instead
            // of losing the building's only guaranteed frontage door.
            if (doorBay >= 0 && archBayRange && doorBay + 0.5 >= archBayRange[0] && doorBay + 0.5 <= archBayRange[1]) {
              const leftBay = Math.floor(archBayRange[0]) - 1
              const rightBay = Math.ceil(archBayRange[1])
              doorBay = leftBay >= 0 ? leftBay : (rightBay < nBays ? rightBay : -1)
            }
            const hasBraceA = braceA && t0 === 0, hasBraceB = braceB && t1 === 1
            const shortWall = nBays < 2   // too narrow a run to read as a "wall" — never window it
            for (let k = 0; k < nBays; k++) {
              const t = (k + 0.5) * pitch, px = s0x + ux * t, pz = s0y + uy * t
              // Archway opening — no wall panel, no door/window, but the posts framing it
              // (placed above, at bay boundaries) stay exactly as they would either side.
              if (archBayRange && k + 0.5 >= archBayRange[0] && k + 0.5 <= archBayRange[1]) continue
              place(makeFlatPanel(pitch, floorH, lib.regions[mat] ?? lib.regions.plaster, lib.materialFor(mat)), px, pz, yBase, rotY)
              const bracedHere = (hasBraceA && k === 0) || (hasBraceB && k === nBays - 1)   // no window where a knee is
              let slot = null
              if (k === doorBay) {
                slot = 'door'; doorPlaced = true; doorPos = { x: px, y: pz }
                // Entrance stairs: any door whose floor sits above true ground (behind a
                // Foundation) needs a staircase rising to its threshold (decision #9).
                if (entry.zHeight > 0) {
                  const { nx: outNx, ny: outNz } = edgeOutwardNormal(a, b, poly)
                  // entry.material here is the ground floor's own material, which is
                  // always the Foundation's material too (decision #5) — steps match it.
                  addEntranceStairs(wallsGroup, lib, px, pz, yBase, outNx, outNz, entry.material)
                }
              } else if (!isPartyWall && !bracedHere && !shortWall) {
                // Never a window on or right next to the door — checked by world distance
                // (not bay index) so it also holds across a corner, where the door's wing
                // and this bay's wing are different edges that just happen to sit close.
                const tooCloseToDoor = doorPos && Math.hypot(px - doorPos.x, pz - doorPos.y) < B
                const key = `${i}:${k}`
                let hasWindow = bayWindowCache.get(key)
                if (hasWindow === undefined) {
                  const mirrorKey = `${i}:${nBays - 1 - k}`
                  let want = bayWindowCache.has(mirrorKey)
                    ? bayWindowCache.get(mirrorKey)
                    : rand() < (STONE_MATS.has(mat) ? 0.5 : 0.6)
                  // No more than 2 contiguous windowed bays — also what keeps the spread even.
                  if (want && bayWindowCache.get(`${i}:${k - 1}`) && bayWindowCache.get(`${i}:${k - 2}`)) want = false
                  if (want && tooCloseToDoor) want = false
                  winTotal++
                  // Hard building-wide cap wins over the random roll, symmetry, and the run-length check.
                  if (want && (winCount + 1) > winTotal * WINDOW_FRACTION_CAP) want = false
                  if (want) winCount++
                  hasWindow = want
                  bayWindowCache.set(key, hasWindow)
                }
                if (hasWindow && !tooCloseToDoor) {
                  if (STONE_MATS.has(mat)) addStoneWindow(currentWallGroup, lib, mat, px, pz, yBase, rotY, floorH)
                  else slot = windowType
                }
              }
              if (slot) place(lib.get(slot), px, pz, yBase, rotY)
            }
            if (hasBraceA) place(lib.get(braceSlot), a.x, a.y, yBase, rotY, 1, 1)
            if (hasBraceB) place(lib.get(braceSlot), b.x, b.y, yBase, rotY, 1, -1)
          }
        }
        // Floor beams: one flexed beam per boundary segment, sized to the floor ABOVE
        // (so a jetty's transition beam spans its wider, pushed-forward polygon).
        if (f < wingFloorCount - 1) {
          const nextEntry = wingFloorList[f + 1]
          const beamPoly = polyAt(f + 1)
          for (let i = 0; i < beamPoly.length; i++) {
            const a = beamPoly[i], b = beamPoly[(i + 1) % beamPoly.length]
            const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy)
            if (L < 1e-6) continue
            const ux = dx / L, uy = dy / L, rotY = Math.atan2(uy, -ux)
            for (const [t0, t1] of drawIntervals(beamPoly, i, a, b, f)) {
              const segL = L * (t1 - t0); if (segL < 1e-4) continue
              const mt = (t0 + t1) / 2, beam = lib.get('beam'); if (!beam) continue
              beam.position.set(a.x + ux * L * mt, nextEntry.zHeight * H, a.y + uy * L * mt)
              beam.rotation.y = rotY; beam.scale.x = segL / B; wallsGroup.add(beam)
            }
          }
        }
      }
      currentWallGroup = wallsGroup   // defensive reset — nothing below should land in interbuildingGroup
      // Archway tunnel side walls (Archway, CONTEXT_BuildingsRoofs.md): two interior
      // walls closing the passage's sides, from the front edge's archway boundary to
      // the corresponding point on the back edge, 0 to 1.5 floor-heights tall. The
      // ceiling above (floor 1's slab, already drawn by the loop above) stays
      // undressed for now — wood ceiling + knee braces are explicit future work.
      if (wing.archway && wingPoly.length === 4) {
        const { startT, endT } = wing.archway
        const backEdge = (frontEdge + 2) % 4
        const fA = wingPoly[frontEdge], fB = wingPoly[(frontEdge + 1) % 4]
        const bA = wingPoly[backEdge], bB = wingPoly[(backEdge + 1) % 4]
        const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
        // Back edge runs the opposite winding direction from front, so front's t pairs
        // with back's (1-t) — see the archEdges comment above.
        const pairs = [
          [lerp(fA, fB, startT), lerp(bA, bB, 1 - startT)],
          [lerp(fA, fB, endT), lerp(bA, bB, 1 - endT)],
        ]
        const archH = 1.5 * H
        const region = lib.regions.plaster ?? lib.regions.wood
        for (const [p, q] of pairs) {
          wallsGroup.add(trisMesh(quadTris(
            [p.x, 0, p.y], [q.x, 0, q.y], [q.x, archH, q.y], [p.x, archH, p.y],
          ), region, lib.material, true))
        }
      }
      // Jetty support poles: one at each of the jettied front corners, true ground (y=0)
      // to the underside of the jettied floor. Always wood — historically a jetty's
      // overhang is carried on timber posts even when the ground floor below is stone/
      // granite/brick (the jetty gate only requires the GROUND FLOOR be stone, not the
      // posts holding the overhang up).
      if (jettyPoly && frontEdge >= 0) {
        const jettyBaseTopH = wingFloorList[wing.jetty.fromFloor].zHeight * H
        const j = (frontEdge + 1) % jettyPoly.length
        for (const c of [jettyPoly[frontEdge], jettyPoly[j]]) {
          place(lib.get('post'), c.x, c.y, 0, 0, 1, 1, jettyBaseTopH / H)
        }

        // Jetty gap fill: the push only moves the front two vertices, opening (1) a bare
        // shelf where the jettied floor now overhangs past the floor below, and (2) a short
        // open step at each side corner where the lower wall's edge doesn't line up with the
        // jettied wall's pushed-forward edge — both read as a hole if left uncovered.
        const A = wingPoly[frontEdge], Bw = wingPoly[j], Aj = jettyPoly[frontEdge], Bj = jettyPoly[j]
        const shelfY = jettyBaseTopH - 0.02
        const floorReg = lib.regions.wood ?? lib.regions.bridge.glb 
        const stepReg = lib.regions.woodtrim
        wallsGroup.add(trisMesh(quadTris(
          [A.x, shelfY, A.y], [Bw.x, shelfY, Bw.y], [Bj.x, shelfY, Bj.y], [Aj.x, shelfY, Aj.y],
        ), floorReg, lib.material, true))
        const stepH = 0.11
        for (const [p0, p1] of [[A, Aj], [Bw, Bj]]) {
          wallsGroup.add(trisMesh(quadTris(
            [p0.x, shelfY, p0.y], [p1.x, shelfY, p1.y], [p1.x, shelfY - stepH, p1.y], [p0.x, shelfY - stepH, p0.y],
          ), stepReg, lib.material, true))
        }
      }
    }
    // `isSibling` distinguishes wings of THIS SAME building from a NEIGHBOUR building's
    // wings — addBuildingRoof only runs full footprint subtraction (the 3-way-junction
    // tiebreak fix) against siblings, where genuine polygon overlap from pass1/pass2's
    // corner construction is expected. Two DIFFERENT buildings' wings are independently
    // constructed and aren't supposed to overlap at all if their setbacks are right, so
    // subtracting between them papers over tiny cross-building gaps/slivers with a
    // jagged notched seam instead of the clean flush line the simpler free/suppressed
    // overhang check (no polygon clipping) already gave at that shared edge.
    const neighborPolys = (spec.neighborWings ?? []).map(w => ({
      poly: w.vertices.map(([x, z]) => ({ x, y: z })),
      floors: w.floors,
      isSibling: false,
    }))
    if (RENDER_ROOFS) {
      // One independent gable roof PER WING (not one merged roof for the whole building):
      // each wing's ridge spans only its own footprint + overhang. Sibling wings of the
      // same building are passed in as neighbours too, so an edge shared with a sibling
      // still suppresses that end's gable/overhang (flush party roof) exactly like walls do.
      // `.floors` carries each neighbour's own height, for addBuildingRoof's taller-only
      // footprint-subtraction (avoid double-roofing) and overhang suppression.
      const allWingPolys = fwings.map(w => ({ poly: w.vertices.map(([x, z]) => ({ x, y: z })), floors: w.floors, isSibling: true }))
      for (const [wi, wing] of fwings.entries()) {
        const wingFloorCount = wing.floors.length
        const roofMatTop = wing.floors[wingFloorCount - 1].material
        const siblingPolys = allWingPolys.filter((_, j) => j !== wi)
        const wingNeighbors = [...neighborPolys, ...siblingPolys]
        // A jettied wing's roof sits above its wider (jettied) top floor, not the ground
        // floor's footprint — rebuild the wing with the pushed-forward front for roofing.
        let roofWing = wing
        if (wing.jetty) {
          const basePoly = wing.vertices.map(([x, z]) => ({ x, y: z }))
          const fEdge = frontEdgeIndex(basePoly, wing.front)
          const jPoly = pushFrontEdge(basePoly, fEdge, wing.jettyDir ?? [0, 0], wing.jetty.amount)
          if (jPoly !== basePoly) {
            const j = (fEdge + 1) % jPoly.length
            roofWing = { ...wing, vertices: jPoly.map(p => [p.x, p.y]), front: [[jPoly[fEdge].x, jPoly[fEdge].y], [jPoly[j].x, jPoly[j].y]] }
          }
        }
        // A wooden ridge beam (poking out past the gable peak) on ~30% of ridgelines.
        const ridgeBeam = rand() < 0.3
        const frame = addBuildingRoof(roofGroup, [roofWing], wingFloorCount, roofSpec, overhang, roofMatTop, wingNeighbors, lib, { gableStyle, gableBrace, B, ridgeBeam })
        addWingRoofFeatures(roofGroup, roofWing, wingFloorCount, roofSpec, overhang, wingNeighbors, lib, rand)
        // Roof joins the same per-wing floor list (decision #7) — lets the top-down
        // floor-scroll step straight from the top floor onto the roof.
        if (frame) {
          wing.floors.push({ type: 'roof', zHeight: frame.topY / H, height: frame.riseHalfUnits * 0.5, riseHalfUnits: frame.riseHalfUnits })
        }
      }
    }
    if (spec.tint) {
      const tintedMat = lib.material.clone()
      tintedMat.color.copy(spec.tint)
      const retint = (o) => { if (o.isMesh && o.material === lib.material) o.material = tintedMat }
      wallsGroup.traverse(retint)
      roofGroup.traverse(retint)
      interbuildingGroup.traverse(retint)
    }
    const built = mergeBuilding(wallsGroup)
    const builtRoof = mergeBuilding(roofGroup)
    builtRoof.userData.isRoof = true
    built.add(builtRoof)
    const builtInterbuilding = mergeBuilding(interbuildingGroup)
    builtInterbuilding.userData.interbuilding = true
    built.add(builtInterbuilding)
    return built
  }

  // No wing had a usable polygon — nothing to build.
  return mergeBuilding(group)
}

// ── Generated geometry helpers ───────────────────────────────────────────────────
function regionUV(r, u, v) { return [r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0)] }
// Flat (PlaneGeometry) wall panel: zero thickness, atlas-textured. Sized exactly bw×h so no
// scale needed. Geometry base at y=0, face +Z, so place() with rotY handles orientation.
function makeFlatPanel(bw, h, reg, material) {
  const g = new THREE.PlaneGeometry(bw, h)
  g.translate(0, h / 2, 0)
  const uv = g.attributes.uv
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i)
    uv.setXY(i, reg.u0 + u * (reg.u1 - reg.u0), reg.v0 + v * (reg.v1 - reg.v0))
  }
  return new THREE.Mesh(g, material)
}
function quadTris(p0, p1, p2, p3) { return [[p0, p1, p2, [0, 0], [1, 0], [1, 1]], [p0, p2, p3, [0, 0], [1, 1], [0, 1]]] }
// Subdivides a planar quad into ~tileSize-world-unit cells, each mapped to a FULL atlas
// tile (UV 0..1 via quadTris) instead of stretching one tile across the whole quad — keeps
// roof texel scale consistent regardless of roof size. p0→p1 and p3→p2 are the parallel
// edges (e.g. ridge and eave); p0→p3 and p1→p2 the cross edges (the slope direction).
function tiledQuad(p0, p1, p2, p3, tileSize) {
  const along = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
  const cross = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]]
  const nAlong = Math.max(1, Math.round(Math.hypot(...along) / tileSize))
  const nCross = Math.max(1, Math.round(Math.hypot(...cross) / tileSize))
  const corner = (i, j) => [
    p0[0] + along[0] * (i / nAlong) + cross[0] * (j / nCross),
    p0[1] + along[1] * (i / nAlong) + cross[1] * (j / nCross),
    p0[2] + along[2] * (i / nAlong) + cross[2] * (j / nCross),
  ]
  const tris = []
  for (let i = 0; i < nAlong; i++) {
    for (let j = 0; j < nCross; j++) {
      tris.push(...quadTris(corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1)))
    }
  }
  return tris
}
// A quad whose UVs span only [0,uvS] of the atlas tile — used to match texel density
// across differently-sized roof faces (e.g. a small dormer roof vs. the main roof).
function texQuad(p0, p1, p2, p3, region, material, uvS) {
  return trisMesh([[p0, p1, p2, [0, 0], [uvS, 0], [uvS, uvS]], [p0, p2, p3, [0, 0], [uvS, uvS], [0, uvS]]], region, material, true)
}
function trisMesh(tris, region, material, doubleSided = false) {
  const pos = [], uv = []
  const addUV = region
    ? (u, v) => uv.push(...regionUV(region, u, v))
    : (u, v) => uv.push(u, v)
  const add = (t) => {
    pos.push(...t[0], ...t[1], ...t[2])
    addUV(t[3][0], t[3][1]); addUV(t[4][0], t[4][1]); addUV(t[5][0], t[5][1])
  }
  for (const t of tris) { add(t); if (doubleSided) add([t[0], t[2], t[1], t[3], t[5], t[4]]) }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.computeVertexNormals()
  return new THREE.Mesh(g, material)
}
// A flat board p0→p1: length along the run, `width` across (in the plane whose
// outward `normal` is given), `thick` out of plane. Atlas-textured with `region`.
function flatBoard(p0, p1, width, thick, normal, region, material) {
  const dir = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
  const len = dir.length(); if (len < 1e-6) return null
  dir.normalize()
  // Build a RIGHT-HANDED basis (X=dir along the run, Y=side in-plane, Z=board normal):
  // side = nrm × dir, then z = dir × side ⇒ dir×side=z (det +1). A left-handed basis
  // here makes setFromRotationMatrix emit a garbage quaternion (boards fly off-axis).
  const nrm = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize()
  const side = new THREE.Vector3().crossVectors(nrm, dir).normalize()
  const zAxis = new THREE.Vector3().crossVectors(dir, side).normalize()
  const g = new THREE.BoxGeometry(len, width, thick)
  for (let i = 0; i < g.attributes.uv.count; i++) { const u = g.attributes.uv.getX(i), v = g.attributes.uv.getY(i); g.attributes.uv.setXY(i, ...regionUV(region, u, v)) }
  const m = new THREE.Mesh(g, material)
  m.position.set((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2)
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(dir, side, zAxis))
  return m
}

// Gable-end decoration: a top-of-story plank (always) plus one of three timber-frame
// gable fillings — king post, chevron braces, or double horizontal bracing — chosen once
// per building (gableStyle) with a per-end fallback to gableBrace when no wall post lines
// up under the gable centre to carry a king post to the apex. `pF`/`pB` are the gable
// wall's two world-space top-of-story corners, `nOut` its outward-facing normal.
function addGableDecoration(group, pF, pB, topY, apexY, ht, nOut, gableStyle, gableBrace, B, lib) {
  const region = lib.regions.woodtrim
  const dx = pB[0] - pF[0], dz = pB[2] - pF[2], L = Math.hypot(dx, dz); if (L < 1e-6) return
  const ux = dx / L, uz = dz / L
  const proud = [nOut[0] * 0.04, 0, nOut[2] * 0.04]   // sit just proud of the gable infill
  const mx = (pF[0] + pB[0]) / 2, mz = (pF[2] + pB[2]) / 2
  // A king post can only reach the apex if a wall post lines up under the gable centre
  // (an even bay count puts a post at the midpoint); otherwise fall back to a brace.
  const centrePole = Math.max(1, Math.round(L / B)) % 2 === 0
  const style = gableStyle === 'kingpost' ? (centrePole ? 'kingpost' : gableBrace) : gableStyle
  // Top-of-story plank: always, horizontal across the gable base.
  group.add(flatBoard([pF[0] + proud[0], topY, pF[2] + proud[2]], [pB[0] + proud[0], topY, pB[2] + proud[2]], 0.13, 0.05, nOut, region, lib.material))
  if (style === 'kingpost') {                             // single king post to the apex
    group.add(flatBoard([mx + proud[0], topY, mz + proud[2]], [mx + proud[0], apexY, mz + proud[2]], 0.12, 0.05, nOut, region, lib.material))
  } else if (style === 'angled') {                        // chevron braces from base centre
    const fr = 0.5, hw = (L / 2) * fr                      // tip lands ON the rake (height ht·(1−fr))
    for (const s of [-1, 1]) {
      group.add(flatBoard([mx + proud[0], topY, mz + proud[2]], [mx + s * ux * hw + proud[0], topY + ht * (1 - fr), mz + s * uz * hw + proud[2]], 0.1, 0.05, nOut, region, lib.material))
    }
  } else {                                                // double horizontal bracing
    for (const fr of [0.34, 0.66]) {
      const y = topY + ht * fr, hw = (L / 2) * (1 - fr)
      group.add(flatBoard([mx - ux * hw + proud[0], y, mz - uz * hw + proud[2]], [mx + ux * hw + proud[0], y, mz + uz * hw + proud[2]], 0.1, 0.05, nOut, region, lib.material))
    }
  }
}

// Verge along a gable rake p0→p1. Tile/wood roofs get a real wooden bargeboard sitting
// proud above the rake; thatch/reed roofs instead get a band HANGING down from the rake,
// in the roof's own material, to simulate the thick cut edge of the thatch/reed.
function addVergeBoard(group, p0, p1, nOut, roofMat, lib, roofMaterial) {
  if (roofMat === 'thatch' || roofMat === 'reed') {
    const hang = 0.16
    const b0 = [p0[0], p0[1] - hang, p0[2]], b1 = [p1[0], p1[1] - hang, p1[2]]
    group.add(trisMesh(quadTris(p0, p1, b1, b0), null, roofMaterial ?? lib.material, true))
  } else {
    group.add(flatBoard(p0, p1, 0.15, 0.05, nOut, lib.regions.woodtrim, lib.material))
  }
}

// Pure geometry for one (or several merged) wings' roof: local UV frame, footprint
// extents, and the ridge-run endpoints — INCLUDING which ends are pulled in for a free
// gable vs. left flush against a neighbour wing/building. Exported so a debug overlay can
// call the exact same function the mesh builder uses below, instead of re-deriving the
// ridge position with its own (drift-prone) copy of this math.
// `fwings` here may carry the new per-wing `floors` list (preferred — topY comes from the
// last floor entry's zHeight+height) or fall back to `buildingFloors` (a plain floor
// count) for callers (e.g. the debug overlay) that don't have the full list handy.
export function computeWingRoofFrame(fwings, buildingFloors, roofSpec, floorHeight, overhang, neighborPolys = []) {
  const primaryWing = fwings.find(w => w.front && w.vertices?.length)
  if (!primaryWing) return null

  // Local frame: u along street frontage, n perpendicular into building interior.
  const front = primaryWing.front
  const A = { x: front[0][0], z: front[0][1] }
  const du = front[1][0] - front[0][0], dv = front[1][1] - front[0][1], uL = Math.hypot(du, dv) || 1
  const u = { x: du / uL, z: dv / uL }
  let n = { x: -u.z, z: u.x }

  // Centroid of all vertices; ensure n points inward
  let cx = 0, cz = 0, vCount = 0
  for (const wing of fwings) for (const [vx, vz] of (wing.vertices ?? [])) { cx += vx; cz += vz; vCount++ }
  if (!vCount) return null
  cx /= vCount; cz /= vCount
  if ((cx - A.x) * n.x + (cz - A.z) * n.z < 0) n = { x: -n.x, z: -n.z }

  // Project all wing vertices into the local frame
  let uMin = Infinity, uMax = -Infinity, nMin = Infinity, nMax = -Infinity
  for (const wing of fwings) {
    for (const [vx, vz] of (wing.vertices ?? [])) {
      const uc = (vx - A.x) * u.x + (vz - A.z) * u.z
      const nc = (vx - A.x) * n.x + (vz - A.z) * n.z
      uMin = Math.min(uMin, uc); uMax = Math.max(uMax, uc)
      nMin = Math.min(nMin, nc); nMax = Math.max(nMax, nc)
    }
  }
  if (!isFinite(uMin)) return null

  // Local → world
  const toW = (uc, nc, y) => [A.x + u.x * uc + n.x * nc, y, A.z + u.z * uc + n.z * nc]

  const pitch = DEBUG_UNIFORM_RIDGE ? DEBUG_RIDGE_PITCH
    : Math.max(Math.tan(20 * Math.PI / 180), Math.min(Math.tan(60 * Math.PI / 180), roofSpec.pitch ?? 0.7))
  // topY = top of the highest wing's walls — the last entry of its per-wing floor list
  // (zHeight already includes any Foundation gap), falling back to a plain floor count
  // for callers (e.g. the debug overlay) that don't carry the full list handy.
  const topY = Math.max(...fwings.map(w => {
    const hasFloors = (w.floors ?? []).some(e => e.type !== 'roof')
    return hasFloors ? wingTopYFromFloors(w.floors, floorHeight) : Math.max(1, buildingFloors) * floorHeight
  }))
  // Probe a UV point against neighbour wing polygons (in world space) — only ones that
  // OUTRANK this wing (strictly taller, or equal height + tiebreak score — see
  // wingOutranks) suppress this wing's own gable/eave; a wing that loses a tie still
  // gets normal overhang from a wing that's about to subtract that exact same area away
  // from it, which would otherwise double the visible overhang there.
  const STEP = 0.1
  const myScore = wingTieScore(primaryWing.vertices.map(([x, z]) => ({ x, y: z })))
  const outrankingNeighborPolys = neighborPolys.filter(w =>
    wingOutranks(wingTopYFromFloors(w.floors, floorHeight), wingTieScore(w.poly), topY, myScore))
  const inNeighbor = (uc, nc) => {
    const wx = A.x + u.x * uc + n.x * nc, wz = A.z + u.z * uc + n.z * nc
    return outrankingNeighborPolys.some(w => pointInPoly({ x: wx, y: wz }, w.poly))
  }

  // Ridge always runs parallel to the street (the wing's own frontage), regardless of
  // which way the footprint happens to be longer.
  const frontageW = uMax - uMin, depth = nMax - nMin
  const ridgeAlongU = true
  const halfSpan = (ridgeAlongU ? depth : frontageW) / 2
  const htRaw = DEBUG_UNIFORM_RIDGE ? DEBUG_RIDGE_HEIGHT : halfSpan * pitch
  // Quantize the roof rise to half-floor-height units so the roof can sit in the same
  // per-wing floor list as the walls (decision #7). A Building Spec with an explicit
  // riseHalfUnits (district-configurable roof ridge height — districtConfig.js
  // buildingStyle.roofRidgeHeight) uses that directly instead of deriving rise from
  // footprint span; it's a district-level creative choice, not a structural constraint.
  const riseHalfUnits = roofSpec.riseHalfUnits != null
    ? Math.max(0, Math.min(ROOF_RISE_MAX_HALF_UNITS, roofSpec.riseHalfUnits))
    : Math.max(0, Math.min(ROOF_RISE_MAX_HALF_UNITS, Math.round(htRaw / (floorHeight * 0.5))))
  const ht = riseHalfUnits * 0.5 * floorHeight
  const apexY = topY + ht

  const midN = (nMin + nMax) / 2, midU = (uMin + uMax) / 2
  const freeUMin = !inNeighbor(uMin - STEP, midN), freeUMax = !inNeighbor(uMax + STEP, midN)
  const freeNMin = !inNeighbor(midU, nMin - STEP), freeNMax = !inNeighbor(midU, nMax + STEP)

  // The ridge run itself. A plain gable's ridge runs the FULL eave length (overhang
  // included) — only a hip/Dutch-gable end pulls the ridge in by halfSpan and slopes the
  // roof down to the eave corner instead. Since DEBUG_FORCE_GABLE_ROOFS forces every free
  // end to a plain gable, the ridge always reaches the eave there; flush (neighbour-abutting)
  // ends are unaffected either way. This is THE canonical ridge position — the mesh builder
  // below and any debug overlay both read it from here.
  let ridgeP0, ridgeP1
  if (ridgeAlongU) {
    const uA = freeUMin ? (DEBUG_FORCE_GABLE_ROOFS ? uMin - overhang : uMin + halfSpan) : uMin
    const uB = freeUMax ? (DEBUG_FORCE_GABLE_ROOFS ? uMax + overhang : uMax - halfSpan) : uMax
    ridgeP0 = toW(uA, midN, apexY); ridgeP1 = toW(uB, midN, apexY)
  } else {
    const nA = freeNMin ? (DEBUG_FORCE_GABLE_ROOFS ? nMin - overhang : nMin + halfSpan) : nMin
    const nB = freeNMax ? (DEBUG_FORCE_GABLE_ROOFS ? nMax + overhang : nMax - halfSpan) : nMax
    ridgeP0 = toW(midU, nA, apexY); ridgeP1 = toW(midU, nB, apexY)
  }

  return {
    A, u, n, cx, cz, uMin, uMax, nMin, nMax, midU, midN, pitch, topY, ridgeAlongU, halfSpan, ht, apexY, riseHalfUnits,
    freeUMin, freeUMax, freeNMin, freeNMax, toW, ridgeP0, ridgeP1,
  }
}

// Roof for ONE wing, following that wing's ACTUAL polygon footprint — not its bounding
// box. Walks every edge of the wing polygon and classifies it by how much it moves along
// the ridge axis (L) vs across it (W):
//   - EAVE edge (|dL| >= |dW|, roughly parallel to the ridge): a sloped roof face from
//     the ridge (apex) down to this edge, offset outward by `overhang` when the edge is
//     free of a neighbour wing/building (flush, no overhang, when it isn't).
//   - GABLE edge (|dW| > |dL|, roughly perpendicular to the ridge): a vertical triangular
//     gable-wall infill from the wall-plate up to the apex above its midpoint, pushed out
//     by `overhang` and decorated when free; suppressed entirely (no infill, no overhang —
//     "the roof ends at the footprint edge") when flush against a neighbour, since the
//     main eave/ridge geometry above already seals that end without it.
// The ridge itself stays a single straight line at a constant apex height (computeWingRoofFrame
// already quantizes the rise — see decision #7), so this does not yet build true hip/valley
// joins between DIFFERENT wings whose ridges meet (that's a separate follow-up); within one
// wing's own footprint, though, eaves and gables now trace the real (possibly notched or
// angled) polygon instead of a rectangle that ignores it.
// Returns the computed roof frame (so the caller can append a `{type:'roof',…}` entry to
// the wing's floor list).
function addBuildingRoof(group, fwings, buildingFloors, roofSpec, overhang, matTop, neighborPolys, lib, gableDeco) {
  const H = lib.grid.floorHeight
  const frame = computeWingRoofFrame(fwings, buildingFloors, roofSpec, H, overhang, neighborPolys)
  if (!frame) return null
  const {
    A, u, n, topY, apexY, ht, ridgeAlongU, uMin, uMax, nMin, nMax, midU, midN,
    freeUMin, freeUMax, freeNMin, freeNMax, toW, ridgeP0, ridgeP1,
  } = frame

  const roofMat = roofSpec.material ?? 'slate'
  const roofColor = roofSpec.color
  const isProceduralRoof = roofMat === 'slate' || roofMat === 'thatch' || roofMat === 'reed'
  const region = isProceduralRoof ? null : (lib.regions[roofMat] || lib.regions.slate)
  const roofMaterial = isProceduralRoof ? lib.getRoofMaterial(roofMat, roofColor) : lib.material
  const wallReg = lib.regions[matTop] || lib.regions.plaster
  const wallMat = lib.materialFor(matTop)
  const eaveDrop = H * 0.06
  const eaveY = topY - eaveDrop
  // Roof tile repeats at the same physical size as a wall bay, so texel scale stays
  // consistent across small and large roofs instead of one tile stretching to fit.
  const roofTile = lib.grid.bayWidth

  const addEaveFascia = (p0, p1) => {
    if (roofMat !== 'thatch' && roofMat !== 'reed') return
    const hang = 0.22
    group.add(trisMesh(quadTris(p0, p1, [p1[0], p1[1] - hang, p1[2]], [p0[0], p0[1] - hang, p0[2]]), null, roofMaterial, true))
  }

  // Roof-footprint subtraction (avoid double-roofing): remove the area of any
  // OUTRANKING SIBLING's footprint from this wing's own before roofing it at all — a
  // strictly taller sibling always outranks; at EQUAL height, a deterministic tiebreak
  // score decides (see wingOutranks) so exactly one of two converging wings claims any
  // disputed area instead of both (double-roofed) or neither. Scoped to SIBLINGS only
  // (same building) — genuine polygon overlap is expected there from pass1/pass2's
  // corner construction. A NEIGHBOUR BUILDING's wing is independently constructed and
  // isn't supposed to overlap this one at all; subtracting against it would paper over
  // any tiny cross-building gap/overlap with a jagged notched seam instead of the clean
  // flush line the simpler free/suppressed overhang check below already gives that edge.
  const wing = fwings[0]
  const rawWingPoly = wing.vertices.map(([x, z]) => ({ x, y: z }))
  const myScore = wingTieScore(rawWingPoly)
  const outrankingNeighborPolys = neighborPolys
    .filter(nb => wingOutranks(wingTopYFromFloors(nb.floors, H), wingTieScore(nb.poly), topY, myScore))
    .map(nb => nb.poly)
  const outrankingSiblingPolys = neighborPolys
    .filter(nb => nb.isSibling && wingOutranks(wingTopYFromFloors(nb.floors, H), wingTieScore(nb.poly), topY, myScore))
    .map(nb => nb.poly)
  const wingPoly = subtractTallerFootprints(rawWingPoly, outrankingSiblingPolys)
  if (!wingPoly) return frame   // entirely covered by an outranking sibling — no roof here at all
  const nV = wingPoly.length

  // Ridge beam: a wooden timber laid along the ridge, poking out past the gable peak at
  // each end — only on a randomised fraction of ridgelines (gableDeco.ridgeBeam, rolled
  // once per wing at the call site).
  if (gableDeco?.ridgeBeam) {
    const beamOv = 0.18
    const dx = ridgeP1[0] - ridgeP0[0], dz = ridgeP1[2] - ridgeP0[2], dLen = Math.hypot(dx, dz) || 1
    const ux2 = dx / dLen, uz2 = dz / dLen
    const rb0 = [ridgeP0[0] - ux2 * beamOv, ridgeP0[1], ridgeP0[2] - uz2 * beamOv]
    const rb1 = [ridgeP1[0] + ux2 * beamOv, ridgeP1[1], ridgeP1[2] + uz2 * beamOv]
    group.add(flatBoard(rb0, rb1, 0.14, 0.14, [0, 1, 0], lib.regions.woodtrim, lib.material))
  }

  // (L,W) = (along-ridge, across-ridge) coordinates — whichever of u/n is the ridge axis.
  const midW = ridgeAlongU ? midN : midU
  const Lmin = ridgeAlongU ? uMin : nMin, Lmax = ridgeAlongU ? uMax : nMax
  const freeLMin = ridgeAlongU ? freeUMin : freeNMin, freeLMax = ridgeAlongU ? freeUMax : freeNMax
  const Lhat = ridgeAlongU ? { x: u.x, y: u.z } : { x: n.x, y: n.z }   // world-space unit vector for +L
  const toLW = (p) => {
    const uc = (p.x - A.x) * u.x + (p.y - A.z) * u.z
    const nc = (p.x - A.x) * n.x + (p.y - A.z) * n.z
    return ridgeAlongU ? { L: uc, W: nc } : { L: nc, W: uc }
  }
  const fromLW = (L, W, y) => ridgeAlongU ? toW(L, W, y) : toW(W, L, y)
  // Push a world point further out along the ridge axis, past a FREE L-extreme, by
  // `overhang` — matches the gable's own outward push so eave/ridge lines stay flush
  // with it ("place the roof to extend beyond the gables").
  const lExtend = (pt, Lval) => {
    let e = 0
    if (Lval <= Lmin + 1e-3 && freeLMin) e = -overhang
    else if (Lval >= Lmax - 1e-3 && freeLMax) e = overhang
    return e === 0 ? pt : [pt[0] + Lhat.x * e, pt[1], pt[2] + Lhat.y * e]
  }
  const STEP = 0.08
  // "free" now means "not adjacent to an OUTRANKING neighbour" — a neighbour that LOSES
  // the tiebreak doesn't suppress this wing's overhang (the footprint subtraction above
  // is what handles actual overlap; this is for the ordinary case of two wings just
  // sitting side by side, including two equal-height ones where this wing is the winner).
  const isFree = (mx, my, onx, ony) => !outrankingNeighborPolys.some(p => pointInPoly({ x: mx + onx * STEP, y: my + ony * STEP }, p))

  for (let i = 0; i < nV; i++) {
    const a = wingPoly[i], b = wingPoly[(i + 1) % nV]
    const dx = b.x - a.x, dy = b.y - a.y, segL = Math.hypot(dx, dy)
    if (segL < 1e-6) continue
    const La = toLW(a), Lb = toLW(b)
    const dL = Lb.L - La.L, dW = Lb.W - La.W
    const { nx: onx, ny: ony } = edgeOutwardNormal(a, b, wingPoly)
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    // A "cut" edge — introduced by subtracting a taller neighbour's footprint — always
    // stops flush, no overhang/infill, regardless of the ordinary proximity check: the
    // taller neighbour's own wall sits right there and seals it.
    const free = b.cutBefore ? false : isFree(mx, my, onx, ony)

    if (Math.abs(dL) >= Math.abs(dW)) {
      // EAVE edge.
      const off = free ? overhang : 0
      const ea = { x: a.x + onx * off, y: a.y + ony * off }
      const eb = { x: b.x + onx * off, y: b.y + ony * off }
      const ridgeA = lExtend(fromLW(La.L, midW, apexY), La.L)
      const ridgeB = lExtend(fromLW(Lb.L, midW, apexY), Lb.L)
      const eaveA = lExtend([ea.x, eaveY, ea.y], La.L)
      const eaveB = lExtend([eb.x, eaveY, eb.y], Lb.L)
      group.add(trisMesh(tiledQuad(ridgeA, ridgeB, eaveB, eaveA, roofTile), region, roofMaterial, true))
      addEaveFascia(eaveA, eaveB)
    } else {
      // GABLE edge — suppressed (no infill, roof ends flush at the footprint edge) when
      // flush against a taller neighbour; the eave geometry above already seals that end.
      if (!free) continue
      const ga = { x: a.x + onx * overhang, y: a.y + ony * overhang }
      const gb = { x: b.x + onx * overhang, y: b.y + ony * overhang }
      const midL = Math.max(Lmin, Math.min(Lmax, (La.L + Lb.L) / 2))
      const apex = fromLW(midL, (La.W + Lb.W) / 2, apexY)
      const pA = [ga.x, topY, ga.y], pB = [gb.x, topY, gb.y]
      const nVec = [onx, 0, ony]
      group.add(trisMesh([[pA, pB, apex, [0, 0], [1, 0], [0.5, 1]]], wallReg, wallMat, true))
      addVergeBoard(group, apex, pA, nVec, roofMat, lib, roofMaterial)
      addVergeBoard(group, apex, pB, nVec, roofMat, lib, roofMaterial)
      if (gableDeco) addGableDecoration(group, pA, pB, topY, apexY, ht, nVec, gableDeco.gableStyle, gableDeco.gableBrace, gableDeco.B, lib)
    }
  }

  return frame
}

// A dormer is a single-width gabled "house" embedded in the roof: flat plaster front wall
// + window + bargeboards (with full overhang past window corners) + corner poles, facing
// down-slope. Roof runs back at the same pitch, truncated at the main roofline.
// Returns array of {x,z} world positions so chimneys can avoid them.
function addDormers(group, R, roof, rand, lib) {
  const { minX, maxX, minZ, maxZ, ridgeAlongX, apexY, ht, halfSpan, topY, floorLevel } = R
  const isProceduralDormer = ['slate', 'thatch', 'reed'].includes(roof.material)
  const region = isProceduralDormer ? null : (lib.regions[roof.material] || lib.regions.slate)
  const dormerRoofMat = isProceduralDormer ? lib.getRoofMaterial(roof.material, roof.color) : lib.material
  const ridgeSpan = ridgeAlongX ? maxX - minX : maxZ - minZ
  const pitch = ht / halfSpan
  const onMinSide = R.dormersOnMinSide !== false   // which slope to use
  const n = 1 + (rand() < 0.4 ? 1 : 0)
  const winMode = rand() < 0.5 ? 'frame' : 'closed'
  const slot = ridgeSpan / (n + 1)
  const dw = Math.min(1.4, slot * 0.7), uvS = Math.min(1, (dw / 2) / halfSpan)
  const ov = 0.15, gap = 0.14, fz = 0.5, eaveZ = fz + ov, slopeT = 0.62
  const H = lib.grid.floorHeight
  const baseY = apexY - slopeT * ht                  // dormer foot sits ON the roof surface here
  // A dormer is exactly ONE FLOOR tall (front wall = H) plus a small gablet — its height does
  // NOT grow to fill a taller roof. peakY is measured up from the dormer foot (baseY).
  const wallTop = H
  const peakY = wallTop + pitch * (dw / 2)
  // Omit the dormer entirely if a one-floor dormer won't fit below the ridge (gap clearance).
  const positions = []
  if (baseY + peakY > apexY - gap) return positions
  // Clamp front-wall base so the window never dips below the top of the wall story.
  const fBase = Math.max(-pitch * fz, topY - baseY)
  const backRidge = -peakY / pitch, backEave = -wallTop / pitch
  for (let s = 0; s < n; s++) {
    const u = (s + 1) / (n + 1)
    let cx, cz
    if (ridgeAlongX) { cx = minX + u * (maxX - minX); cz = (minZ + maxZ) / 2 + (onMinSide ? -1 : 1) * slopeT * halfSpan }
    else { cz = minZ + u * (maxZ - minZ); cx = (minX + maxX) / 2 + (onMinSide ? -1 : 1) * slopeT * halfSpan }
    positions.push({ x: cx, z: cz })
    const g = new THREE.Group()
    // A dormer sits on the roof, one level above the wing's top floor — tagged so a
    // future "isolate selected floor" pass can associate it with that level (decision #8).
    g.userData.floorLevel = floorLevel
    // flat plaster front wall (no thickness → no gap with window frame)
    g.add(texQuad([-dw / 2, fBase, fz], [dw / 2, fBase, fz], [dw / 2, wallTop, fz], [-dw / 2, wallTop, fz], lib.regions.plaster, lib.material, 1))
    g.add(trisMesh([[[-dw / 2, wallTop, fz], [dw / 2, wallTop, fz], [0, peakY, fz], [0, 0], [1, 0], [0.5, 1]]], lib.regions.plaster, lib.material, true))
    addDormerWindow(g, lib, dw, fBase, wallTop, peakY, fz, winMode)
    for (const sx of [-dw / 2, dw / 2]) {
      g.add(boxAt(0.07, wallTop - fBase, 0.07, lib.regions.woodtrim, lib.material, sx, (fBase + wallTop) / 2, fz))
      g.add(trisMesh([[[sx, fBase, fz], [sx, wallTop, fz], [sx, wallTop, backEave], [0, 0], [0, 1], [1, 1]]], lib.regions.plaster, lib.material, true))
    }
    const eaveX = dw / 2 + ov, eaveY = wallTop - pitch * ov
    // Panels extend FORWARD (eaveZ past the front face) AND laterally (eaveX past window corners).
    g.add(texQuad([0, peakY, fz], [0, peakY, backRidge], [-eaveX, eaveY, backEave], [-eaveX, eaveY, eaveZ], region, dormerRoofMat, uvS))
    g.add(texQuad([0, peakY, backRidge], [0, peakY, fz], [eaveX, eaveY, eaveZ], [eaveX, eaveY, backEave], region, dormerRoofMat, uvS))
    // Verge boards run along the actual rake edge: eave corner (forward) up to ridge (back at fz)
    addVergeBoard(g, [-eaveX, eaveY, eaveZ ], [0, peakY, fz ], [0, 0, 1], roof.material, lib, dormerRoofMat)
    addVergeBoard(g, [eaveX, eaveY, eaveZ ], [0, peakY, fz ], [0, 0, 1], roof.material, lib, dormerRoofMat)
    g.position.set(cx, baseY + 0.01, cz)
    if (ridgeAlongX) g.rotation.y = onMinSide ? Math.PI : 0
    else g.rotation.y = onMinSide ? -Math.PI / 2 : Math.PI / 2
    group.add(g)
  }
  return positions
}

// A full-height dormer window rising into the gable: glass + horizontal mullions + a wood
// frame (jambs/lintel/sill). `mode` 'closed' adds shut shutters over it; 'frame' leaves it open.
function addDormerWindow(g, lib, dw, fBase, wallTop, peakY, fz, mode) {
  const z = fz + 0.04, winW = dw * 0.42
  const bottom = fBase + 0.06, top = wallTop + (peakY - wallTop) * 0.5   // up into the gable
  const winH = top - bottom, cy = (bottom + top) / 2
  g.add(boxAt(winW, winH, 0.02, lib.regions.glass, lib.material, 0, cy, z))
  for (const fr of [1 / 3, 2 / 3]) g.add(boxAt(winW, 0.03, 0.04, lib.regions.woodtrim, lib.material, 0, bottom + winH * fr, z + 0.01))  // mullions
  g.add(boxAt(winW + 0.08, 0.05, 0.05, lib.regions.woodtrim, lib.material, 0, top + 0.03, z))            // lintel
  g.add(boxAt(winW + 0.12, 0.06, 0.08, lib.regions.woodtrim, lib.material, 0, bottom - 0.03, fz + 0.06)) // sill (proud)
  for (const sx of [-1, 1]) g.add(boxAt(0.04, winH + 0.06, 0.05, lib.regions.woodtrim, lib.material, sx * (winW / 2 + 0.02), cy, z))  // jambs
  if (mode === 'closed') {                                       // shut shutters cover the glass
    for (const sx of [-1, 1]) g.add(boxAt(winW / 2 - 0.006, winH, 0.03, lib.regions.doorwood, lib.material, sx * winW / 4, cy, z + 0.02))
  }
}

// Small rectangular stone window with thick frame (jambs, lintel, sill + glass).
// Used for stone and granite walls instead of the kit's timber-framed window slots.
function addStoneWindow(group, lib, mat, px, pz, yBase, rotY, floorH) {
  const isGranite = mat === 'granite'
  const winW = 0.36, winH = Math.min(0.50, floorH * 0.62), frameT = 0.09, front = 0.03
  const mkFrame = (w, h, d, x, y, z) => isGranite
    ? boxAt(w, h, d, lib.regions.granite, lib.material, x, y, z)
    : plainBox(w, h, d, lib.materialFor(mat), x, y, z)
  const g = new THREE.Group()
  g.add(mkFrame(winW + frameT * 2, frameT, frameT * 2, 0, winH / 2 + frameT / 2, front))     // lintel
  g.add(mkFrame(winW + frameT * 2, frameT, frameT * 2, 0, -(winH / 2 + frameT / 2), front))   // sill
  g.add(mkFrame(frameT, winH, frameT * 2, -(winW / 2 + frameT / 2), 0, front))                // left jamb
  g.add(mkFrame(frameT, winH, frameT * 2, winW / 2 + frameT / 2, 0, front))                   // right jamb
  g.add(boxAt(winW, winH, 0.01, lib.regions.glass, lib.material, 0, 0, front + 0.015))        // glass
  // Sill at a believable waist-ish height (~38% up the floor) rather than dead centre —
  // clamped so the lintel still clears the floor plank above.
  const winCenterY = Math.min(floorH - frameT - winH / 2, floorH * 0.38 + winH / 2)
  g.position.set(px, yBase + winCenterY, pz)
  g.rotation.y = rotY
  group.add(g)
}

// One floor's surface, shaped like the wing's OWN polygon at that floor (not a blanket
// rectangle — follows jetty/notches exactly like the walls do). Stone-floored when that
// floor's wall material is stone/granite, dark wood otherwise. `axes` (see call site)
// rotates the texture-sampling coordinate into the WING's own frame — long axis along
// the shader's seam axis, so wood planks run perpendicular to the wing's long axis
// regardless of the wing's orientation within the building's shared model space (see
// stoneMaterial.makeFloorMaterial's `floorSample` attribute).
function addFloor(group, poly, y, mat, lib, axes) {
  if (!poly || poly.length < 3) return
  const contour = poly.map(v => new THREE.Vector2(v.x, v.y))
  let triangles
  try { triangles = THREE.ShapeUtils.triangulateShape(contour, []) } catch { return }
  if (!triangles?.length) return
  const verts = [], sample = []
  for (const v of poly) {
    verts.push(v.x, y, v.y)
    if (axes) {
      const pu = v.x * axes.ux + v.y * axes.uz, pn = v.x * axes.nx + v.y * axes.nz
      if (axes.longIsU) { sample.push(pn, pu) } else { sample.push(pu, pn) }
    } else {
      sample.push(v.x, v.y)
    }
  }
  const indices = []
  for (const [a, b, c] of triangles) indices.push(a, b, c)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
  geometry.setAttribute('floorSample', new THREE.BufferAttribute(new Float32Array(sample), 2))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1))
  geometry.computeVertexNormals()
  const floorMat = STONE_MATS.has(mat) ? lib.floorStoneMaterial : lib.floorWoodMaterial
  group.add(new THREE.Mesh(geometry, floorMat))
}

// A stone column post — ground floor only, and only where the ground floor itself is
// stone/granite/brick (uses that SAME stone type). Built procedurally like addStoneWindow
// (atlas-textured for granite, the shared procedural Voronoi material for plain stone)
// rather than a kit part, since its material depends on the building's stone variant.
// Roughly 2x a wood post's width (lib.grid.postThickness); above the ground floor the
// column continues as a normal wood post, same as every other floor.
function addStoneColumn(group, lib, mat, px, pz, yBase, rotY, floorH) {
  const isGranite = mat === 'granite'
  const w = (lib.grid.postThickness ?? 0.12) * 2
  let g
  if (isGranite) g = boxAt(w, floorH, w, lib.regions.granite, lib.material, 0, floorH / 2, 0)
  else if (mat === 'brick') g = plainBox(w, floorH, w, lib.brickColumnMaterial ?? lib.brickMaterial, 0, floorH / 2, 0)
  else g = plainBox(w, floorH, w, lib.stoneColumnMaterial ?? lib.stoneMaterial, 0, floorH / 2, 0)
  g.position.x += px; g.position.z += pz; g.position.y += yBase
  g.rotation.y = rotY
  group.add(g)
}

// How far a Foundation's base projects outward (beyond the wall line above) at true
// ground — a "battered" stone footing, sloping out for visual stability instead of
// rising sheer from the ground (decision: "project at the base of the floor, and then
// proceed to the ground at an angle").
const FOUNDATION_BATTER = 0.06

// A battered foundation panel, in two parts:
//   1. A flat "wall base" shelf at the floor-plate height (topH) — the true wall-line
//      edge offset OUTWARD by the post width `postW` ("offset the floor footprint by
//      the width of the posts; fill this area as a wall base").
//   2. A sloped face from that shelf's outer edge down to true ground (y=0), pushed out
//      further by FOUNDATION_BATTER — "run from that edge to the ground, at the
//      FOUNDATION_BATTER angle."
// Piers (addBatteredPier) instead start at the TRUE wall-line corner and taper at 2x
// this angle, so they read as more substantial than the thinner wall base between them.
function addBatteredPanel(group, p0, p1, topH, nx, ny, postW, region, material) {
  // Offset the panel's outer face by half the post width so it's flush with the pier
  // outer faces (which are centred on the wall line with hw = postW/2). Before this
  // fix the panel pushed out a full postW, sticking past the posts.
  const halfW = postW / 2
  const w0 = [p0.x, topH, p0.y], w1 = [p1.x, topH, p1.y]
  const s0x = p0.x + nx * halfW, s0y = p0.y + ny * halfW
  const s1x = p1.x + nx * halfW, s1y = p1.y + ny * halfW
  group.add(trisMesh(quadTris(w0, w1, [s1x, topH, s1y], [s0x, topH, s0y]), region, material, true))
  const b0 = [s0x + nx * FOUNDATION_BATTER, 0, s0y + ny * FOUNDATION_BATTER]
  const b1 = [s1x + nx * FOUNDATION_BATTER, 0, s1y + ny * FOUNDATION_BATTER]
  group.add(trisMesh(quadTris([s0x, topH, s0y], [s1x, topH, s1y], b1, b0), region, material, true))
}

// A battered foundation pier: a frustum (4 sloped side faces) whose footprint widens
// uniformly from the post width at the TRUE wall-line junction (y=foundationH) to
// post-width + 2×(2×FOUNDATION_BATTER) at true ground (y=0) — twice the wall base's
// batter angle, so piers visibly flare out more than the panels between them.
function addBatteredPier(group, lib, mat, px, pz, h, rotY) {
  const w = (lib.grid.postThickness ?? 0.12) * 2
  const isGranite = mat === 'granite'
  const material = isGranite ? lib.material : (mat === 'brick' ? (lib.brickColumnMaterial ?? lib.brickMaterial) : (lib.stoneColumnMaterial ?? lib.stoneMaterial))
  const region = isGranite ? lib.regions.granite : { u0: 0, v0: 0, u1: 1, v1: 1 }
  const hw = w / 2, hwB = hw + FOUNDATION_BATTER * 2
  const top = [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]]
  const bot = [[-hwB, -hwB], [hwB, -hwB], [hwB, hwB], [-hwB, hwB]]
  const cosR = Math.cos(rotY), sinR = Math.sin(rotY)
  const toWorld = ([x, z], y) => [px + x * cosR + z * sinR, y, pz - x * sinR + z * cosR]
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    const t0 = toWorld(top[i], h), t1 = toWorld(top[j], h)
    const b0 = toWorld(bot[i], 0), b1 = toWorld(bot[j], 0)
    group.add(trisMesh(quadTris(t0, t1, b1, b0), region, material, true))
  }
}

// Half-height stone footing under one wing's ground floor — same bay layout and the same
// exterior/interior wall determination (`drawIntervals` at floor 0) as the ground floor
// itself, but unconditionally stone: battered panels (no windows/doors/braces) plus a
// battered pier at every bay boundary. Always uses the wing's base (non-jettied) polygon.
function addFoundationForWing(group, lib, wingPoly, drawIntervals, foundationH, foundationMat, B, archEdges) {
  for (let i = 0; i < wingPoly.length; i++) {
    const a = wingPoly[i], b = wingPoly[(i + 1) % wingPoly.length]
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy)
    if (L < 1e-6) continue
    const ux = dx / L, uy = dy / L, rotY = Math.atan2(uy, -ux)
    const { nx, ny } = edgeOutwardNormal(a, b, wingPoly)
    const postW = (lib.grid.postThickness ?? 0.12) * 2
    for (const [t0, t1] of drawIntervals(wingPoly, i, a, b, 0)) {
      const segL = L * (t1 - t0)
      if (segL < 1e-4) continue
      const s0x = a.x + ux * L * t0, s0y = a.y + uy * L * t0
      const nBays = Math.max(1, Math.round(segL / B)), pitch = segL / nBays
      // Archway (Archway, CONTEXT_BuildingsRoofs.md): the ground floor's own wall panel
      // already skips this span (see the main wall loop) — the Foundation footing below
      // it must skip the same bays, or a raised-ground-floor building would still have a
      // solid stone footing blocking its passage at true-ground level.
      let archBayRange = null
      if (archEdges?.[i]) {
        const [aStart, aEnd] = archEdges[i]
        const clipStart = Math.max(aStart, t0), clipEnd = Math.min(aEnd, t1)
        if (clipEnd > clipStart) archBayRange = [((clipStart - t0) / (t1 - t0)) * nBays, ((clipEnd - t0) / (t1 - t0)) * nBays]
      }
      const postKs = new Set([0, nBays])
      const interior = Math.min(nBays - 1, 4)
      for (let p = 1; p <= interior; p++) postKs.add(Math.round(p * nBays / (interior + 1)))
      for (const pk of postKs) {
        addBatteredPier(group, lib, foundationMat, s0x + ux * pk * pitch, s0y + uy * pk * pitch, foundationH, rotY)
      }
      const region = lib.regions[foundationMat] ?? lib.regions.granite
      const material = lib.materialFor(foundationMat)
      for (let k = 0; k < nBays; k++) {
        if (archBayRange && k + 0.5 >= archBayRange[0] && k + 0.5 <= archBayRange[1]) continue
        const p0 = { x: s0x + ux * k * pitch, y: s0y + uy * k * pitch }
        const p1 = { x: s0x + ux * (k + 1) * pitch, y: s0y + uy * (k + 1) * pitch }
        addBatteredPanel(group, p0, p1, foundationH, nx, ny, postW, region, material)
      }
    }
  }
}

// A simple stepped stone stair from true ground (y=0) up to a raised door's threshold —
// any door whose floor sits above true ground (behind a Foundation) needs one (decision
// #9), since the Foundation gap would otherwise leave the door stranded mid-air. Each
// step is a SOLID box reaching from y=0 up to its own tread (not a thin floating slab),
// and from the door (dist=0) out to its own reach — so consecutive steps fully overlap
// and nest into each other, giving a backed/supported stepped-wedge profile with no gaps
// underneath or between treads:
//      __
//    _|   |
//  _|     |
// _|       |
// |______|
// Boxes are explicitly rotated to the door's own outward direction (outNx/outNz) rather
// than left world-axis-aligned, so the stair projects straight out from the door even
// when the wall it's on doesn't run parallel to the world X/Z axes.
function addEntranceStairs(group, lib, px, pz, totalH, outNx, outNz, mat) {
  if (totalH <= 1e-4) return
  // Same material as the Foundation (granite/brick/plain stone), and 20% wider than a
  // standard door bay so the stair reads as a substantial, deliberately-built feature.
  const isGranite = mat === 'granite'
  const material = isGranite ? lib.material : (mat === 'brick' ? (lib.brickColumnMaterial ?? lib.brickMaterial) : lib.stoneMaterial)
  const region = isGranite ? lib.regions.granite : { u0: 0, v0: 0, u1: 1, v1: 1 }
  const stepD = 0.16, stepW = 0.5 * 1.2
  const nSteps = Math.max(1, Math.round(totalH / 0.12))
  const stepH = totalH / nSteps
  const rotY = Math.atan2(outNx, outNz)
  for (let s = 0; s < nSteps; s++) {
    const h = stepH * (s + 1)                // cumulative height — tallest (=totalH) right at the door
    const depth = stepD * (nSteps - s)        // cumulative reach — deepest (farthest out) at the bottom step
    const cx = px + outNx * (depth / 2), cz = pz + outNz * (depth / 2)
    const m = boxAt(stepW, h, depth, region, material, 0, 0, 0)
    m.position.set(cx, h / 2, cz)
    m.rotation.y = rotY
    group.add(m)
  }
}

// Generated stone chimneys: procedural-stone walls (no cap) with a shallow dark flue.
// ONE building-level count (constant whatever the footprint), each placed on a chosen
// wing — either ON its ridge (peak) or flush against the inside face of any wall (gable
// end or eave side). Each emerges from the roof surface at its spot and rises randomly.
function addChimneys(group, wings, floors, rand, lib, dormerPositions = []) {
  const W = 0.3, rimH = 0.34, hole = 0.16, rimT = (W - hole) / 2, inset = W / 2 + 0.03
  const n = Math.min(floors, 1 + (rand() < 0.5 ? 1 : 0))
  for (let i = 0; i < n; i++) {
    const R = wings[Math.floor(rand() * wings.length)]
    const { minX, maxX, minZ, maxZ, ridgeAlongX, apexY, ht, halfSpan } = R
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
    const roofYAt = (x, z) => apexY - Math.min(1, (ridgeAlongX ? Math.abs(z - cz) : Math.abs(x - cx)) / halfSpan) * ht
    let x, z
    if (rand() < 0.4) {
      const t = 0.2 + rand() * 0.6
      x = ridgeAlongX ? minX + t * (maxX - minX) : cx
      z = ridgeAlongX ? cz : minZ + t * (maxZ - minZ)
    } else {
      const t = 0.25 + rand() * 0.5
      switch (Math.floor(rand() * 4)) {
        case 0: x = minX + inset; z = minZ + t * (maxZ - minZ); break
        case 1: x = maxX - inset; z = minZ + t * (maxZ - minZ); break
        case 2: z = minZ + inset; x = minX + t * (maxX - minX); break
        default: z = maxZ - inset; x = minX + t * (maxX - minX)
      }
    }
    // Skip this chimney position if it would overlap a dormer
    if (dormerPositions.some((d) => Math.hypot(x - d.x, z - d.z) < 0.6)) continue
    const surfY = roofYAt(x, z), rootY = surfY - 0.3
    const top = surfY + 0.45 + rand() * 0.7                 // rise above the roof, varied
    const base = Math.max(0.3, top - rimH - rootY)
    const g = new THREE.Group()
    g.add(plainBox(W, base, W, lib.stoneMaterial, 0, base / 2, 0))                          // solid lower
    const ry = base + rimH / 2                                                              // rim walls (hole between)
    g.add(plainBox(W, rimH, rimT, lib.stoneMaterial, 0, ry, (hole + rimT) / 2))
    g.add(plainBox(W, rimH, rimT, lib.stoneMaterial, 0, ry, -(hole + rimT) / 2))
    g.add(plainBox(rimT, rimH, hole, lib.stoneMaterial, (hole + rimT) / 2, ry, 0))
    g.add(plainBox(rimT, rimH, hole, lib.stoneMaterial, -(hole + rimT) / 2, ry, 0))
    g.add(plainBox(hole + 0.01, rimH - 0.02, hole + 0.01, lib.darkMaterial, 0, ry - 0.01, 0))  // dark flue
    g.position.set(x, rootY, z)
    group.add(g)
  }
}

// Adapter: wraps one wing's (u,n) roof frame as a rotated/positioned THREE.Group so the
// world-axis-aligned addDormers/addChimneys can be reused as-is — local x→u, local z→n,
// local origin at (uMin,nMin). Y passes straight through rotation.y unchanged, so
// apexY/topY/ht/halfSpan carry over directly from the frame. Dormer/chimney avoidance is
// scoped to this one wing (each wing's roof is already fully independent post-refactor).
function addWingRoofFeatures(group, wing, wingFloors, roofSpec, overhang, neighborPolys, lib, rand) {
  const H = lib.grid.floorHeight
  const frame = computeWingRoofFrame([wing], wingFloors, roofSpec, H, overhang, neighborPolys)
  if (!frame) return
  const { u, uMin, uMax, nMin, nMax, ridgeAlongU, halfSpan, ht, apexY, topY, toW } = frame

  const origin = toW(uMin, nMin, 0)
  const frameGroup = new THREE.Group()
  frameGroup.position.set(origin[0], 0, origin[2])
  frameGroup.rotation.y = -Math.atan2(u.z, u.x)
  group.add(frameGroup)

  const R = {
    minX: 0, maxX: uMax - uMin, minZ: 0, maxZ: nMax - nMin,
    ridgeAlongX: ridgeAlongU, apexY, ht, halfSpan, topY,
    dormersOnMinSide: true, noDormers: false,
    roofAngle: Math.atan2(ht, halfSpan) * 180 / Math.PI,
    // The level a roof feature (e.g. a dormer) sits at, one above the wing's top floor
    // (decision #8 — lets the top-down floor-scroll associate dormers with a level).
    floorLevel: wingFloors,
  }
  const dormerPositions = (RENDER_DORMERS && R.roofAngle >= 50) ? addDormers(frameGroup, R, roofSpec, rand, lib) : []
  addChimneys(frameGroup, [R], wingFloors, rand, lib, dormerPositions)
}

// small mesh helpers
function boxAt(w, h, d, region, material, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d)
  for (let i = 0; i < g.attributes.uv.count; i++) { const u = g.attributes.uv.getX(i), v = g.attributes.uv.getY(i); g.attributes.uv.setXY(i, ...regionUV(region, u, v)) }
  const m = new THREE.Mesh(g, material); m.position.set(x, y, z); return m
}
function plainBox(w, h, d, material, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); m.position.set(x, y, z); return m }

// Collapse the assembled group from ~50-100 Mesh objects down to one Mesh per material.
// All sub-meshes are world-flattened into merged BufferGeometries before being discarded.
function mergeBuilding(group) {
  group.updateMatrixWorld(true)
  const byMat = new Map()
  group.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return
    // Convert indexed geometries (PlaneGeometry, BoxGeometry) to non-indexed so
    // mergeGeometries can combine them with our hand-built non-indexed trisMesh geometry.
    const g = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone()
    g.applyMatrix4(obj.matrixWorld)
    if (!byMat.has(obj.material)) byMat.set(obj.material, [])
    byMat.get(obj.material).push(g)
  })
  // Dispose originals before dropping the group
  group.traverse(obj => { if (obj.isMesh) obj.geometry?.dispose() })
  const out = new THREE.Group()
  for (const [mat, geoms] of byMat) {
    const merged = mergeGeometries(geoms, false)
    for (const g of geoms) g.dispose()
    if (merged) {
      const mesh = new THREE.Mesh(merged, mat)
      mesh.castShadow = false
      mesh.receiveShadow = false
      out.add(mesh)
    }
  }
  return out
}
