import FeatureManager from './FeatureManager.js'
import { pointInPolygon, posHash } from './renderUtils.js'
import { MODEL_BY_NAME, MODEL_SCALE } from '../../../shared/buildingCatalogue.js'
import { DISTRICTS, DEFAULTS, districtConfigKey } from '../../../shared/districtConfig.js'
import PartLibrary from '../buildings/PartLibrary.js'
import { assemble } from '../buildings/ParametricBuilding.js'

export const PARA_SCALE = MODEL_SCALE / 1.5   // parametric model-unit → world-unit scale
const PARA_LIB_PATH = '/resources/buildingparts/default'
const STONE_MATS = new Set(['stone', 'granite', 'brick'])
// ≈ StreetVoronoiGenerator.STREET_HALF_WIDTH — keep in sync. Townhouse front walls sit
// back from the plot's street edge by this much (a small yard/sidewalk strip); a jettied
// upper floor can push forward into that strip but never past the original street line.
// Global default — per-district override goes on DISTRICT_BUILDING_STYLES[key].frontSetback.
const FRONT_SETBACK = 0.04
const frontSetbackFor = (style) => style.frontSetback ?? FRONT_SETBACK

// Model catalogue notes (which GLB goes with which style):
// 2,3,4 = brick town houses variants · 5+6 = half stone plaster variants
// 7+10+11 = barn/farm stone · 8+9 = wood roof red · 12 = wood shingle
// 13 = stone multi story · 14+17 = log hut · 15 = slate roof plaster multi story
// 16+18+19 = Bankers German house wood and stone · m1+t4 = market tower
// m2 = lords house · t1 = barn/farm stone tower · t2 = lords tower
// t3 = military tower · t5 = dilapidated 4 story building
// alchemists / church / forge / hall / watchmaker / waterwheel

// Per-district parametric building style profiles (floors, wall materials, roof type,
// eave overhang, GLB model weights for freestanding/custom slots) and landmark
// buildings now live in shared/districtConfig.js (DISTRICTS[key].buildingStyle /
// .landmarks — landmarks are placed server-side, ADR-0005, the client just renders the
// recorded landmarkBuildings) alongside every other per-district-type table. Kept as
// derived local consts so this file's many DISTRICT_BUILDING_STYLES[key] call sites
// don't all need to change — see shared/districtConfig.js's header for the full
// field-by-field breakdown.
const DISTRICT_BUILDING_STYLES = Object.fromEntries(
  Object.entries(DISTRICTS).map(([key, d]) => [key, d.buildingStyle])
)
const DEFAULT_BUILDING_STYLE = DEFAULTS.buildingStyle

const FIT_FACTOR = 0.92    // a model must fit within this fraction of the plot footprint
const FIT_TOLERANCE = 0.12    // models within this coverage of the best fit are randomised between

// ── BuildingRenderer ──────────────────────────────────────────────────────────
// Places a building on every plot, using the plot's recorded streetEdges to find its
// frontage(s). Per-plot, seeded, client-side rolls (ADR-0019) decide Custom Model (a
// fixed GLB, closest fit) vs Parametric Building, and — for Parametric — Attached
// (flush, party-wall eligible) vs Freestanding (set back on every side).

export const GROUND_Y = 0   // ground surface is Y=0; buildings seat here

// Back-yard trees: plots whose building leaves empty space behind it get small trees
// scattered in the back (never on the street-facing front).
const TREE_GLBS = [
  '/resources/Models/tree.glb',
  '/resources/Models/tree1.glb',
  '/resources/Models/tree2.glb',
  '/resources/Models/tree3.glb',
]
const TREE_MIN_BACK_DEPTH = 0.08   // empty depth behind the building required to add trees
const TREE_SPACING = 0.07   // back-yard scatter grid spacing
const TREE_DENSITY = 0.6    // fraction of grid cells that get a tree
const TREE_MAX_PER_PLOT = 4
const TREE_MIN_FRONTAGE = 0.16   // plot frontage below which we skip trees

// Degenerate-wing thresholds (model units / bounding-box aspect ratio) — wings clipped
// against neighbours/plot bounds can come out as slivers too thin or small to read as
// a building; these get dropped in _spawnWingBuilding's pass 3.
const MIN_WING_AREA = 1.0   // model units² — roughly one bay²
const MAX_WING_ASPECT = 6     // bounding-box long:short side ratio
// Engine-wide floor for a split wing's width (bays) — see Wing, CONTEXT_BuildingsRoofs.md.
// The matching ceiling (`maxWingWidth`) is per-district, in shared/districtConfig.js.
const MIN_WING_WIDTH = 3

// True if polygon `vertices` ([[x,z],…]) is self-intersecting (any two non-adjacent
// edges cross). A self-intersecting "bowtie" wing — the known failure mode of the
// (currently-disabled) pass 4 corner nudge — has signed-area contributions from its two
// lobes partially cancelling out, so it can read as deceptively small/normal-aspect and
// slip past the area/aspect filter alone; this catches it directly.
function isSelfIntersecting(vertices) {
  const n = vertices.length
  const cross = (ox, oy, ax, ay, bx, by) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox)
  const segCross = (p1, p2, p3, p4) => {
    const [x1, y1] = p1, [x2, y2] = p2, [x3, y3] = p3, [x4, y4] = p4
    const d1 = cross(x3, y3, x4, y4, x1, y1), d2 = cross(x3, y3, x4, y4, x2, y2)
    const d3 = cross(x1, y1, x2, y2, x3, y3), d4 = cross(x1, y1, x2, y2, x4, y4)
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  }
  for (let i = 0; i < n; i++) {
    const a1 = vertices[i], a2 = vertices[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue   // skip adjacent edges
      if (segCross(a1, a2, vertices[j], vertices[(j + 1) % n])) return true
    }
  }
  return false
}

// Shoelace area of a model-space polygon `[[x,z],…]`.
function polygonArea(vertices) {
  let area = 0
  for (let i = 0; i < vertices.length; i++) {
    const [x0, z0] = vertices[i], [x1, z1] = vertices[(i + 1) % vertices.length]
    area += x0 * z1 - x1 * z0
  }
  return Math.abs(area) / 2
}

// Distance from (px,py) to where a ray in direction (dx,dz) first EXITS polygon `poly`
// (the nearest edge crossing ahead of the origin). Used to find how much depth a plot
// actually has available at a specific point along a wing's frontage — unlike taking
// the single farthest vertex anywhere in the plot, this respects a notch/reflex lobe
// (e.g. a plot beside a star intersection) that narrows well before that farthest point.
function rayPolyExitDist(px, py, dx, dz, poly) {
  let minT = Infinity
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n]
    const ex = b.x - a.x, ez = b.y - a.y
    const denom = ex * dz - ez * dx
    if (Math.abs(denom) < 1e-9) continue
    const apx = a.x - px, apz = a.y - py
    const t = (ex * apz - ez * apx) / denom
    const u = (dx * apz - dz * apx) / denom
    if (t > 1e-6 && u > -1e-6 && u < 1 + 1e-6 && t < minT) minT = t
  }
  return isFinite(minT) ? minT : 0
}

// Intersect a convex `subject` polygon with a simple (possibly concave) `clip` polygon,
// both [{x,y}]. Candidate points = subject verts inside clip + clip verts inside subject
// + edge crossings, then angle-sorted around the centroid. Returns [{x,y},…] (CCW-ish) or
// null. Star-shaped results only — fine for a convex wing clipped to a plot. A tiny nudge
// toward the subject centroid keeps front-edge verts that sit exactly on the plot boundary.
function clipConvexToPolygon(subject, clip) {
  const segSeg = (a, b, c, d) => {
    const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y
    const den = rx * sy - ry * sx
    if (Math.abs(den) < 1e-12) return null
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den
    return (t >= 0 && t <= 1 && u >= 0 && u <= 1) ? { x: a.x + t * rx, y: a.y + t * ry } : null
  }
  let scx = 0, scy = 0
  for (const v of subject) { scx += v.x; scy += v.y }
  scx /= subject.length; scy /= subject.length
  const pts = []
  for (const v of subject) {                       // nudge inward so boundary verts count
    if (pointInPolygon(v.x + (scx - v.x) * 1e-4, v.y + (scy - v.y) * 1e-4, clip)) pts.push({ x: v.x, y: v.y })
  }
  for (const v of clip) { if (pointInPolygon(v.x, v.y, subject)) pts.push({ x: v.x, y: v.y }) }
  for (let i = 0; i < subject.length; i++) {
    const a = subject[i], b = subject[(i + 1) % subject.length]
    for (let j = 0; j < clip.length; j++) {
      const p = segSeg(a, b, clip[j], clip[(j + 1) % clip.length])
      if (p) pts.push(p)
    }
  }
  if (pts.length < 3) return null
  let cx = 0, cy = 0
  for (const p of pts) { cx += p.x; cy += p.y }
  cx /= pts.length; cy /= pts.length
  pts.sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx))
  const out = []
  for (const p of pts) {                           // drop near-duplicate consecutive points
    const last = out[out.length - 1]
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-5) out.push(p)
  }
  if (out.length >= 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-5) out.pop()
  return out.length >= 3 ? out : null
}

// Sutherland-Hodgman half-plane clip: keep the part of `poly` ([{x,y},…], any simple
// polygon) where (P - origin)·normal >= offset. Used by _spawnWingBuilding's wing passes —
// setback-strip subtraction and convex polygon difference both reduce to this.
function halfPlaneClip(poly, originX, originY, nx, ny, offset) {
  const out = []
  const n = poly.length
  if (n === 0) return out
  const side = (p) => (p.x - originX) * nx + (p.y - originY) * ny - offset
  for (let i = 0; i < n; i++) {
    const cur = poly[i], next = poly[(i + 1) % n]
    const curSide = side(cur), nextSide = side(next)
    if (curSide >= 0) out.push(cur)
    if ((curSide >= 0) !== (nextSide >= 0)) {
      const t = curSide / (curSide - nextSide)
      out.push({ x: cur.x + (next.x - cur.x) * t, y: cur.y + (next.y - cur.y) * t })
    }
  }
  return out
}

// Shoelace area of a {x,y}-object polygon (world space) — companion to polygonArea(),
// which takes [x,z] tuples in model space.
function polyAreaXY(poly) {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    area += a.x * b.y - b.x * a.y
  }
  return Math.abs(area) / 2
}

// Decomposes `subject` (convex) minus `clip` (convex) into convex pieces whose union is
// the difference — the standard "sweep the clip polygon's edges" construction: at edge i,
// split off whatever's left of `subject` (already trimmed to clip edges [0..i-1]) that
// falls OUTSIDE edge i, then narrow `remaining` to edge i's INSIDE half-plane before
// moving to edge i+1. Winding-agnostic (uses clip's centroid to find its inward side).
function convexDifferencePieces(subject, clip) {
  if (subject.length < 3 || clip.length < 3) return [subject]
  let ccx = 0, ccy = 0
  for (const p of clip) { ccx += p.x; ccy += p.y }
  ccx /= clip.length; ccy /= clip.length

  const pieces = []
  let remaining = subject
  for (let i = 0; i < clip.length && remaining.length >= 3; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length]
    let nx = -(b.y - a.y), ny = (b.x - a.x)
    if ((ccx - a.x) * nx + (ccy - a.y) * ny < 0) { nx = -nx; ny = -ny }   // now points INSIDE clip
    const outside = halfPlaneClip(remaining, a.x, a.y, -nx, -ny, 0)
    if (outside.length >= 3) pieces.push(outside)
    remaining = halfPlaneClip(remaining, a.x, a.y, nx, ny, 0)
  }
  return pieces
}

// World-space rotated bounding rectangle for a GLB placement — same rotation convention
// THREE.Object3D.rotation.y uses (x'=x*cos+z*sin, z'=-x*sin+z*cos), so this lines up
// exactly with how FeatureManager actually orients the spawned model. Used for fence
// footprint-avoidance on custom/GLB buildings (see _spawn) — they don't have a wings
// polygon like parametric buildings, just this approximate box.
function footprintRectWorld(cx, cz, rotY, halfW, halfD) {
  const c = Math.cos(rotY), s = Math.sin(rotY)
  return [[-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD]]
    .map(([lx, lz]) => ({ x: cx + lx * c + lz * s, y: cz + (-lx * s + lz * c) }))
}

// Deep-copies a {x,y}-object polygon — used for debugSink pass snapshots so later
// mutation of rw.poly (passes are in-place) doesn't retroactively change an earlier
// pass's recorded shape.
function clonePoly(poly) { return poly.map(p => ({ x: p.x, y: p.y })) }

// Vertex of `poly` nearest to `pt` — used by Pass 4 to relocate a wing's back corner
// after earlier passes may have changed its vertex count/order.
function nearestVertex(poly, pt) {
  let best = null, bestD = Infinity
  for (const v of poly) {
    const d = (v.x - pt.x) ** 2 + (v.y - pt.y) ** 2
    if (d < bestD) { bestD = d; best = v }
  }
  return best
}

// The polygon edge of `poly` lying closest to the street line through `A` (inward
// normal nx,nz) — i.e. the wing's actual front (street-facing) wall after clipping,
// which may no longer be a fixed corner index once boolean ops have run.
function frontEdgeOf(poly, A, nx, nz) {
  let best = null, bestD = Infinity
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    const d = ((p.x - A.x) * nx + (p.y - A.y) * nz + (q.x - A.x) * nx + (q.y - A.y) * nz) / 2
    if (d < bestD) { bestD = d; best = [p, q] }
  }
  return best
}

export default class BuildingRenderer {
  constructor() {
    this.featureManager = null   // lazily created (needs the scene)
    this._lib = null             // PartLibrary once loaded
    this._libPromise = null      // loading promise (singleton)
    this._paraGroups = []        // THREE.Groups added for parametric buildings
    this._renderGen = 0          // incremented each render; async callbacks abort if stale
    this._visible = true         // buildings shown by default; persists across regenerations
    this._roofsVisible = true    // roofs shown by default; hidden in top-down mode
    this._interbuildingVisible = false  // party walls between buildings kept but hidden by default; shown in top-down mode
    this._seedOffset = 0         // mixed into position hashes; 0 = stable (main game default)
  }

  // Randomise the seed offset so the next render() produces a different layout.
  // Only used by dev/preview tools — the main game leaves seedOffset at 0.
  randomizeSeed() { this._seedOffset = (Math.random() * 0x7FFFFFFF) | 0 }

  // District z-height (plan "typed-gliding-leaf"): a plot's blockCorners already carry
  // real per-vertex z (Tier 2, CityBlockGenerator/PlotVoronoiGenerator) — every building/
  // tree placement on that plot used to hardcode GROUND_Y (0) instead, so houses floated
  // above or sank into their own plot as soon as the plot itself stopped being flat.
  // Average of the plot's own corners, not a footprint-local lookup — good enough for a
  // building's base seat; Stage 6 (Wing z-quantization, still pending) is the place for
  // per-footprint-corner precision.
  _plotGroundZ(plot) {
    const poly = plot?.blockCorners
    if (!poly?.length) return GROUND_Y
    let sum = 0, n = 0
    for (const v of poly) { if (v.z != null && isFinite(v.z)) { sum += v.z; n++ } }
    return n ? sum / n : GROUND_Y
  }

  clear(scene) {
    this.featureManager?.clear()
    for (const g of this._paraGroups) scene?.remove(g)
    this._paraGroups = []
  }

  setBuildingsVisible(on) {
    this._visible = on
    for (const g of this._paraGroups) g.visible = on
    if (this.featureManager) {
      for (const obj of this.featureManager._objects) obj.visible = on
    }
  }

  // Roofs are a tagged child sub-group (userData.isRoof) inside each parametric building's
  // assembled group — see ParametricBuilding.js's assemble(). Free-standing GLB houses
  // (featureManager._objects) don't have a separate roof piece, so they're unaffected.
  setRoofsVisible(on) {
    this._roofsVisible = on
    for (const g of this._paraGroups) this._applyRoofVisible(g, on)
  }

  _applyRoofVisible(group, on) {
    for (const child of group.children) if (child.userData?.isRoof) child.visible = on
  }

  // Interbuilding party walls are kept (not suppressed) but tagged (userData.interbuilding)
  // and hidden by default — only shown in top-down mode. See ParametricBuilding.js's assemble().
  setInterbuildingWallsVisible(on) {
    this._interbuildingVisible = on
    for (const g of this._paraGroups) this._applyInterbuildingVisible(g, on)
  }

  _applyInterbuildingVisible(group, on) {
    for (const child of group.children) if (child.userData?.interbuilding) child.visible = on
  }

  _ensureLib() {
    if (this._libPromise) return this._libPromise
    this._libPromise = new PartLibrary(PARA_LIB_PATH, { worldScale: PARA_SCALE, baseY: GROUND_Y }).load()
      .then(lib => { this._lib = lib; return lib })
    return this._libPromise
  }

  // Called by WorldRenderer so async building loads trigger a re-render.
  setDirtyCallback(fn) { this._markDirty = fn }

  // World-space height of one floor-height unit (lib.grid.floorHeight, scaled by
  // PARA_SCALE) — used by WorldRenderer to convert CameraController's floor-scroll
  // units (half-floor-height steps) into an actual clip-plane world Y. Falls back to
  // PartLibrary's default grid floor height if the lib hasn't loaded yet.
  get floorHeightWorld() { return (this._lib?.grid?.floorHeight ?? 1.4) * PARA_SCALE }

  render(scene, plots, districtData) {
    const t0 = performance.now()
    const gen = ++this._renderGen
    this.clear(scene)
    if (!plots?.length) return
    if (!this.featureManager) this.featureManager = new FeatureManager(scene)

    const districtById = new Map((districtData?.districts || []).map(d => [d.id, d]))
    const housePlacements = []
    const paraQueue = []   // { spec, x, z, rotY } — assembled once the PartLibrary is ready
    const polyWingEntries = []   // polygon-wing entries for party-wall suppression pass
    const glbFootprints = []   // { plot, poly } world-space rects for custom/GLB buildings

    for (const plot of plots) {
      if (plot.blockType === 'square') continue   // paved squares grow no house
      const district = districtById?.get(plot.districtId)
      // One plot's spec-building throwing must not abort this loop — `plots` spans the
      // WHOLE city in one synchronous pass, so an uncaught exception here previously
      // killed every plot queued after it (most districts going blank), not just the
      // one plot that actually had bad data.
      try {
        if (this._isParametric(district, plot)) {
          const entry = this._spawnParametric(plot, district, housePlacements)
          if (entry) {
            paraQueue.push(entry)
            if (entry.spec?.footprint?.wings?.some(w => w.vertices)) {
              polyWingEntries.push({ entry, plot })
            }
          }
        } else {
          this._spawn(plot, housePlacements, districtById, glbFootprints)
        }
      } catch (e) {
        console.error('[BuildingRenderer] failed to build a spec for a plot — skipping it', e, plot)
      }
    }
    // Party-wall suppression only applies to Attached buildings (deliberately built flush
    // against the street, party-wall eligible) — Freestanding buildings are set back on
    // every side and shouldn't have walls suppressed just because another building
    // happens to be nearby in the same block (see Attached/Freestanding, ADR-0019).
    if (!this.skipPartyWalls) {
      this._suppressPartyWalls(polyWingEntries.filter(({ plot }) => plot.attached))
    }
    // Expose the computed para entries (specs + transforms) for debug overlays. Built
    // synchronously; available as soon as render() returns (before async mesh assembly).
    this._lastParaEntries = paraQueue
    // { entry, plot } pairs for every polygon-wing building (townhouses AND free-standing
    // houses, both routed through the wings footprint) — lets callers (e.g. fence
    // placement) find the actual built footprint for a given plot, in world space via
    // entry.x/z/rotY + PARA_SCALE.
    this._lastPolyWingEntries = polyWingEntries
    // { plot, poly } world-space bounding rects for custom/GLB buildings — same purpose
    // as _lastPolyWingEntries above, just for the non-parametric building path.
    this._lastGlbFootprints = glbFootprints
    // Landmarks are placed by the server before plots (ADR-0005); here we just render
    // the recorded placements. No plot reference of their own — find the plot (always a
    // paved square, per convertTerrainCellsToPlots/ADR-0005) actually underneath the
    // landmark's footprint and borrow its ground z, same as every other building.
    for (const lb of (districtData?.landmarkBuildings || [])) {
      const m = MODEL_BY_NAME.get(lb.name)
      if (m) {
        const style = this._districtStyle(districtById?.get(lb.districtId))
        const { buildingTypes, buildingSubtype } = this._rollBuildingTypes(style, posHash(lb.x, lb.z) + this._seedOffset)
        const underPlot = plots.find(p => p.blockCorners?.length && pointInPolygon(lb.x, lb.z, p.blockCorners))
        housePlacements.push({ x: lb.x, z: lb.z, y: this._plotGroundZ(underPlot), rotY: lb.rotY ?? 0, glbPath: m.glbPath, scale: MODEL_SCALE, buildingTypes, buildingSubtype })
      }
    }

    const tDispatch = performance.now()
    console.log(`[perf] BuildingRenderer dispatch: ${(tDispatch - t0).toFixed(1)}ms (${plots.length} plots → ${paraQueue.length} para + ${housePlacements.length} glb, ${districtData?.landmarkBuildings?.length ?? 0} landmarks)`)

    if (housePlacements.length) {
      const tGlb = performance.now()
      this.featureManager.spawnBuildings(housePlacements, GROUND_Y).then(() => {
        if (this._renderGen !== gen) return
        console.log(`[perf] BuildingRenderer GLB spawn done: ${(performance.now() - tGlb).toFixed(1)}ms (${housePlacements.length} buildings)`)
        if (!this._visible) for (const obj of this.featureManager._objects) obj.visible = false
        this._markDirty?.()
      })
    }

    if (paraQueue.length) {
      const tPara = performance.now()
      this._ensureLib().then(lib => {
        if (this._renderGen !== gen) return   // superseded by a newer render call
        for (const { spec, x, z, rotY, y } of paraQueue) {
          // One building's spec throwing inside assemble() must not abort the rest of
          // the batch — that previously meant a single bad spec silently killed every
          // building queued after it in this render() call (most districts going blank).
          let g
          try {
            g = assemble(spec, lib)
          } catch (e) {
            console.error('[BuildingRenderer] assemble() failed for a building — skipping it', e, spec)
            continue
          }
          g.scale.setScalar(PARA_SCALE)
          g.position.set(x, y ?? GROUND_Y, z)
          g.rotation.y = rotY
          g.visible = this._visible
          this._applyRoofVisible(g, this._roofsVisible)
          this._applyInterbuildingVisible(g, this._interbuildingVisible)
          scene.add(g)
          this._paraGroups.push(g)
        }
        console.log(`[perf] BuildingRenderer para assembly done: ${(performance.now() - tPara).toFixed(1)}ms (${paraQueue.length} buildings)`)
        this._markDirty?.()
      })
    }
  }

  // Build one wing's per-floor list: [{ zHeight, height, material }] in floor-height
  // units (replaces the old floors-count + spec-level wallMaterial array — see plan
  // "Per-floor building data model"). `wallMaterial` is the building-shared material
  // array (clamped at the top floor) so sibling wings stay visually consistent;
  // height rolls are wing+floor-specific so per-floor height can vary freely within
  // one wing. `startZ` is 0, or 0.5 when a Foundation gap precedes the ground floor.
  _buildFloorList(hash, seedBase, floorCount, wallMaterial, startZ) {
    const list = []
    let z = startZ
    for (let f = 0; f < floorCount; f++) {
      const mat = wallMaterial[Math.min(f, wallMaterial.length - 1)]
      const tall = this._rand(hash + seedBase + f) < 0.15
      const height = tall ? 1.5 : 1.0
      list.push({ zHeight: z, height, material: mat })
      z += height
    }
    return list
  }

  // Deterministic [0,1) RNG from a seed (stable across rebuilds).
  _rand(seed) {
    let s = (seed * 2654435761) >>> 0
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 0x100000000
  }

  // Split one street edge's frontage (in bays) into 1+ side-by-side wing segments no
  // wider than maxWidth, each a seeded-random width no smaller than MIN_WING_WIDTH bays.
  // A remainder too small to stand alone on its own is folded into the last drawn width
  // and that combined length re-split within bounds, rather than left as a sliver (e.g.
  // 13 → 6,6,1 becomes 6,4,3; 7 → 6,1 becomes 4,3). Returns [{ startT, endT,
  // centreSetback }] as fractions (0..1) along the edge — an odd-count split gets a
  // small seeded chance for its centre wing to sit back one bay (see Wing,
  // CONTEXT_BuildingsRoofs.md). Only ever called on the plot's actual street edges.
  _splitFrontage(frontageBays, maxWidth, seedBase) {
    if (!(frontageBays > maxWidth)) return [{ startT: 0, endT: 1, centreSetback: false }]

    const widths = []
    let remaining = frontageBays
    let i = 0
    while (remaining > maxWidth) {
      const w = MIN_WING_WIDTH + this._rand(seedBase + i * 13) * (maxWidth - MIN_WING_WIDTH)
      widths.push(w)
      remaining -= w
      i++
    }
    if (remaining < MIN_WING_WIDTH && widths.length > 0) {
      const last = widths.pop()
      const combined = last + remaining
      const w1 = Math.min(maxWidth, Math.max(MIN_WING_WIDTH, combined - MIN_WING_WIDTH))
      widths.push(w1, combined - w1)
    } else {
      widths.push(remaining)
    }

    const total = widths.reduce((s, w) => s + w, 0)
    const segments = []
    let acc = 0
    for (const w of widths) {
      segments.push({ startT: acc / total, endT: (acc + w) / total, centreSetback: false })
      acc += w
    }
    if (segments.length >= 3 && segments.length % 2 === 1) {
      const mid = (segments.length - 1) / 2
      if (this._rand(seedBase + 9973) < 0.15) segments[mid].centreSetback = true
    }
    return segments
  }

  // District type → DISTRICT_BUILDING_STYLES/DISTRICTS key — same scheme as
  // shared/districtConfig.js's districtConfigKey (Leadership split by ruling-body
  // subclass too, now that every per-district table is unified onto that scheme),
  // just defaulting to the literal string 'default' instead of null.
  _districtKey(district) {
    return districtConfigKey(district) ?? 'default'
  }

  // Merged building style: base from the static DISTRICTS table, overridden by any
  // per-district configOverrides.buildingStyle set via the cog/settings dialog.
  _districtStyle(district) {
    const key = this._districtKey(district)
    const base = DISTRICT_BUILDING_STYLES[key] ?? DEFAULT_BUILDING_STYLE
    const overrides = district?.configOverrides?.buildingStyle
    if (!overrides) return base
    return { ...base, ...overrides }
  }

  // Pick a model for a plot of footprint bw×bd in the given district. Models are
  // placed at their natural size (MODEL_SCALE), never stretched. Every plot gets a
  // model — as close to a fit as possible: models that fit within FIT_FACTOR are
  // preferred (best coverage wins, with FIT_TOLERANCE-banded ties randomised), and
  // if none fit the least-overflowing model is used. When the district has no
  // weighted models (empty/missing list), every model is eligible so a closest fit
  // is still found. Returns { glbPath, width, depth } (model-space, ÷MODEL_SCALE — see
  // _spawn for the world-space footprint rectangle built from these) — null only if no
  // models exist at all.
  _selectModel(district, bw, bd, seed) {
    const style = this._districtStyle(district)
    let weights = style.modelWeights
    if (!weights || Object.keys(weights).length === 0) {
      weights = Object.fromEntries([...MODEL_BY_NAME.keys()].map(name => [name, 1]))
    }
    const fitW = bw * FIT_FACTOR, fitD = bd * FIT_FACTOR
    const fitting = []      // models that fit inside the plot: { glbPath, width, depth, w, cov }
    const overflowing = []  // models too big: { glbPath, width, depth, over }  (over = how far past the plot)
    let bestCov = 0
    for (const name in weights) {
      const w = weights[name]
      const m = MODEL_BY_NAME.get(name)
      if (!w || w <= 0 || !m) continue
      const mw = m.width * MODEL_SCALE, md = m.depth * MODEL_SCALE   // world footprint at fixed scale
      const over = Math.max(0, mw - fitW) + Math.max(0, md - fitD)   // 0 = fits (front faces the street)
      if (over <= 0) {
        const cov = (mw * md) / (bw * bd)
        fitting.push({ glbPath: m.glbPath, width: m.width, depth: m.depth, w, cov })
        if (cov > bestCov) bestCov = cov
      } else {
        overflowing.push({ glbPath: m.glbPath, width: m.width, depth: m.depth, over })
      }
    }
    if (fitting.length) {
      const close = fitting.filter(c => c.cov >= bestCov - FIT_TOLERANCE)
      const total = close.reduce((s, c) => s + c.w, 0)
      let r = this._rand(seed) * total
      for (const c of close) { if ((r -= c.w) <= 0) return { glbPath: c.glbPath, width: c.width, depth: c.depth } }
      return { glbPath: close[0].glbPath, width: close[0].width, depth: close[0].depth }
    }
    if (overflowing.length) {   // nothing fits — use the model closest to fitting
      overflowing.sort((a, b) => a.over - b.over)
      return { glbPath: overflowing[0].glbPath, width: overflowing[0].width, depth: overflowing[0].depth }
    }
    return null
  }

  // Deterministic per-plot seed from its centroid — shared by every per-building roll
  // (Custom Model vs Parametric, Attached vs Freestanding, Building Type) so they're
  // all reproducible from plot geometry alone, no server round-trip (ADR-0019).
  _plotHash(plot) {
    const poly = plot?.blockCorners
    if (!poly || poly.length === 0) return this._seedOffset
    let cx = 0, cy = 0
    for (const v of poly) { cx += v.x; cy += v.y }
    cx /= poly.length; cy /= poly.length
    return posHash(cx, cy) + this._seedOffset
  }

  // Roll up to two Building Types for a building (gameplay classification, not a
  // geometry driver — see Building Type/Subtype, CONTEXT_BuildingsRoofs.md), weighted
  // by the district's buildingTypeWeights. Applies uniformly to every building —
  // Parametric (Attached/Freestanding), Custom Model, and Landmark alike. Subtype is
  // reserved but deliberately left unassigned: future work, once Building Type itself
  // is validated in practice.
  _rollBuildingTypes(style, seed) {
    const weights = style?.buildingTypeWeights ?? { Residential: 1 }
    const entries = Object.entries(weights).filter(([, w]) => w > 0)
    if (!entries.length) return { buildingTypes: [], buildingSubtype: null }
    const pick = (excludeType, seedOffset) => {
      const pool = excludeType ? entries.filter(([t]) => t !== excludeType) : entries
      const poolTotal = pool.reduce((s, [, w]) => s + w, 0)
      if (!poolTotal) return null
      let r = this._rand(seed + seedOffset) * poolTotal
      for (const [t, w] of pool) { if ((r -= w) <= 0) return t }
      return pool[pool.length - 1][0]
    }
    const first = pick(null, 701)
    const buildingTypes = first ? [first] : []
    if (first && this._rand(seed + 709) < 0.4) {
      const second = pick(first, 719)
      if (second) buildingTypes.push(second)
    }
    return { buildingTypes, buildingSubtype: null }
  }

  // True for plots that get a Parametric Building instead of a fixed GLB (Custom
  // Model). Independent per-plot roll on the district's `customModelChance` —
  // replaces the old blockType==='townhouse'+freestanding check (ADR-0019).
  _isParametric(district, plot) {
    const style = this._districtStyle(district)
    const hash = this._plotHash(plot)
    return this._rand(hash + 101) >= (style.customModelChance ?? 0.05)
  }

  // Build a { spec, x, z, rotY } entry for a Parametric Building. Rolls Attached vs
  // Freestanding per-plot (district `freestandingChance`) and records the result on
  // the plot itself so _suppressPartyWalls (and Archway eligibility) can read it back.
  // Both cases run through the same wing-list pipeline (_spawnWingBuilding) — see
  // ADR-0019 and the Attached/Freestanding glossary entries.
  _spawnParametric(plot, district, housePlacements) {
    const style = this._districtStyle(district)
    const hash = this._plotHash(plot)
    plot.attached = this._rand(hash + 103) >= (style.freestandingChance ?? 0.05)
    return this._spawnWingBuilding(plot, district, housePlacements, null, plot.attached)
  }

  // Debug helper (dev tools only) — runs _spawnWingBuilding for one plot and returns the
  // per-wing-pass geometry (world space) instead of a built spec: white = pass-1 full
  // (setback+depthBays) quad, grey = that edge's own setback-only strip, red = white
  // minus grey (the "naive" single-edge setback delta), blue = pass-4 corner nudges
  // ({from,to} pairs), green = the wing's final surviving polygon (null if pass 5
  // dropped it). Comparing green against red shows exactly how much MORE pass 2's
  // cross-edge subtraction / pass 3's wing-vs-wing boolean / pass 4's nudge removed
  // beyond the single-edge setback you'd naively expect.
  debugTownhouseWingPasses(plot, district) {
    const debugSink = []
    this._spawnWingBuilding(plot, district, null, debugSink, plot.attached ?? true)
    return debugSink
  }

  // Build a { spec, x, z, rotY } entry for a plot's Wing-list footprint (Attached or
  // Freestanding — see ADR-0019 and the Wing/Wing-list footprint glossary entries).
  // `attached` controls front setback (0 vs a seeded gap on every edge) and party-wall
  // suppression eligibility downstream; splitting, depth, and merging are identical
  // either way. Computes polygon wings in world space; group sits at origin with no
  // rotation. `debugSink` (optional, dev tools only) — see debugTownhouseWingPasses().
  _spawnWingBuilding(plot, district, housePlacements, debugSink, attached) {
    const poly = plot.blockCorners
    const n = poly?.length ?? 0
    const streetEdges = plot.streetEdges || []
    if (!poly || n < 3 || streetEdges.length === 0) return null

    const distKey = this._districtKey(district)
    const style = this._districtStyle(district)
    const wingDepths = style.wingDepths ?? [2, 3, 4, 5]
    const floorWeights = style.floors ?? { 2: 0.5, 3: 0.5 }
    const maxWingWidth = style.maxWingWidth ?? 6
    // World units per bay. Mirrors GroundRenderer's own `bayWorld` fallback — the
    // PartLibrary manifest isn't guaranteed loaded yet at spec-building time, and its
    // grid.bayWidth default is 1, so PARA_SCALE alone already IS one bay in world units.
    const bayWorld = PARA_SCALE

    // Polygon centroid for inward-normal checks
    let pcx = 0, pcy = 0
    for (const v of poly) { pcx += v.x; pcy += v.y }
    pcx /= n; pcy /= n

    const hash = posHash(pcx, pcy) + this._seedOffset

    // Pass 1 — extrude one-or-more wings per street edge, inward by depthBays, as a
    // world-space quad [A, B, Bp, Ap] (A,B = frontage/street endpoints; Ap,Bp = back
    // corners). A frontage longer than the district's maxWingWidth is first split into
    // several side-by-side wings (see _splitFrontage) — splitting only ever operates on
    // the plot's actual street edges, never on a wing's own generated back/side edges.
    const raw = []
    // Records EVERY street edge, even ones dropped before a wing is ever built — so the
    // debug viewer can show "this plot has N streetEdges but only built M wings" instead
    // of silently having fewer coloured outlines than expected with no explanation.
    const dropEarly = (wi, se, reason) => {
      if (debugSink) debugSink.push({ debugId: wi, edgeIndex: se.index, dropped: reason, white: null, grey: null, red: null, blue: null, green: null })
    }
    let wingSeed = 0   // unique per-wing counter across all edges & splits, for seed variety
    for (let wi = 0; wi < streetEdges.length; wi++) {
      const se = streetEdges[wi]
      const A = poly[se.index], B = poly[(se.index + 1) % n]
      if (!A || !B) { dropEarly(wi, se, 'missing plot vertex at streetEdges[].index'); continue }
      const dx = B.x - A.x, dz = B.y - A.y
      const L = Math.hypot(dx, dz)
      if (L < 0.04) { dropEarly(wi, se, `frontage too short (${L.toFixed(4)} < 0.04)`); continue }
      const ux = dx / L, uz = dz / L   // along frontage

      // Inward normal
      let nx = -uz, nz = ux
      const midX = (A.x + B.x) / 2, midZ = (A.y + B.y) / 2
      if ((pcx - midX) * nx + (pcy - midZ) * nz < 0) { nx = -nx; nz = -nz }

      const segments = this._splitFrontage(L / bayWorld, maxWingWidth, hash + wi * 977)

      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si]
        const segId = wingSeed++
        const segA = { x: A.x + dx * seg.startT, y: A.y + dz * seg.startT }
        const segB = { x: A.x + dx * seg.endT, y: A.y + dz * seg.endT }
        const segL = L * (seg.endT - seg.startT)

        // Depth available behind THIS segment only — sampled at several points ALONG
        // the segment (not just the single deepest vertex anywhere in the plot), taking
        // the MINIMUM ray-exit distance. A plot with a notch/reflex lobe (e.g. beside a
        // star intersection) narrows well before its single farthest vertex; using that
        // one farthest point as the depth budget for the WHOLE segment produces a wing
        // that overshoots the notch and has to be carved up by the plot-boundary clip
        // afterward, instead of never reaching the notch in the first place.
        const DEPTH_SAMPLES = 5
        let maxD = Infinity
        for (let s = 0; s <= DEPTH_SAMPLES; s++) {
          const st = s / DEPTH_SAMPLES
          const sx = segA.x + (segB.x - segA.x) * st, sy = segA.y + (segB.y - segA.y) * st
          const exitDist = rayPolyExitDist(sx, sy, nx, nz, poly)
          if (exitDist < maxD) maxD = exitDist
        }
        if (!isFinite(maxD)) maxD = 0

        // A centre wing (odd-count split, seeded 15% chance — see _splitFrontage) sits
        // one bay back from the street; its front wall is frontA-frontB instead of the
        // segment's own street corners. The flanking wings either side are built
        // completely normally (full depth, full side walls) — their unmodified side
        // walls, running the full depth from street to their own back corners, already
        // pass right along the notch's side boundary and read as its return wall, so no
        // separate return-wall geometry is needed.
        const centreBack = seg.centreSetback ? bayWorld : 0
        const frontA = seg.centreSetback ? { x: segA.x + nx * bayWorld, y: segA.y + nz * bayWorld } : segA
        const frontB = seg.centreSetback ? { x: segB.x + nx * bayWorld, y: segB.y + nz * bayWorld } : segB

        // `jettyBudget` is the forward distance a jettied upper floor may overhang into
        // the street. It used to double as a front SETBACK (the wing was pushed back
        // this far from the frontage); for Attached buildings the setback is removed —
        // the front wall sits on the plot's street edge and the jetty spends this
        // budget OUTWARD into the street instead of inward. Freestanding buildings get a
        // real setback on every edge instead (seeded, `style.frontSetback` up to 15% of
        // this segment's own frontage length).
        const jettyBudget = Math.min(frontSetbackFor(style), maxD * 0.5)
        const setback = attached ? 0
          : frontSetbackFor(style) + this._rand(hash + 971 + segId * 11) * Math.max(0, segL * 0.15 - frontSetbackFor(style))
        const depthBays = wingDepths[Math.floor(this._rand(hash + 2 + segId * 7) * wingDepths.length)]
        const availD = Math.max(0, maxD - centreBack)
        // Extrude straight back from the (possibly recessed) front wall by the wing's depth.
        const worldD = Math.min(depthBays * PARA_SCALE, availD * 0.92)
        if (worldD < 0.04) { dropEarly(segId, se, `no depth available behind frontage (worldD ${worldD.toFixed(4)} < 0.04, maxD ${maxD.toFixed(4)})`); continue }

        const r_wing = this._rand(hash + 3 + segId * 7)
        let wingFloorCount = 2, wingFloorCum = 0
        for (const [f, w] of Object.entries(floorWeights)) {
          wingFloorCum += w
          wingFloorCount = parseInt(f)
          if (r_wing < wingFloorCum) break
        }
        const Ap = { x: frontA.x + nx * worldD, y: frontA.y + nz * worldD }
        const Bp = { x: frontB.x + nx * worldD, y: frontB.y + nz * worldD }
        raw.push({
          edgeIndex: se.index,
          poly: [{ x: frontA.x, y: frontA.y }, { x: frontB.x, y: frontB.y }, Bp, Ap],
          worldD,
          floorCount: wingFloorCount,
          forceRidgeAlongX: Math.abs(ux) >= Math.abs(uz),
          setback,                                  // Attached: 0 (pass 2 no-ops). Freestanding: seeded gap.
          jettyBudget,                              // forward projection budget for a jettied upper floor (into the street)
          origAp: Ap, origBp: Bp,                   // pass-1 (un-clipped) back corners, for pass 4's gap test
          streetA: { x: frontA.x, y: frontA.y }, streetB: { x: frontB.x, y: frontB.y },   // this wing's own front edge (recessed for a centre wing), for jetty capping
          nx, nz,                                   // inward normal, for jetty's forward push
          _debugId: segId,
        })

        if (debugSink) {
          // white = pass 1's full quad. grey = this wing's OWN setback-only strip (a
          // reference shape — the "pushback region" itself, not a wing snapshot). red =
          // white minus grey (the naive single-wing-only setback result). blue/green are
          // filled in below as REAL wing-polygon snapshots after pass 4 / pass 5 actually
          // run — comparing green against red shows how much MORE got removed by
          // cross-edge setback subtraction (pass 2) and wing-vs-wing overlap (pass 3)
          // beyond what a single wing's own setback would naively remove.
          const Af = { x: frontA.x + nx * jettyBudget, y: frontA.y + nz * jettyBudget }
          const Bf = { x: frontB.x + nx * jettyBudget, y: frontB.y + nz * jettyBudget }
          const white = clonePoly(raw[raw.length - 1].poly)
          const grey = [{ x: frontA.x, y: frontA.y }, { x: frontB.x, y: frontB.y }, Bf, Af]
          debugSink.push({
            debugId: segId, edgeIndex: se.index,
            white, grey, red: convexDifferencePieces(white, grey).filter(p => polyAreaXY(p) > 1e-6),
            blue: null,   // pass 4 snapshot — filled in below once that pass runs
            green: null,  // pass 5 snapshot (final survivor) — stays null if dropped
          })
        }

        // Scatter trees behind the primary wing only
        if (wi === 0 && si === 0 && housePlacements) {
          this._scatterBackTrees(plot, poly, midX, midZ, ux, uz, nx, nz, L, worldD, maxD, housePlacements, this._plotGroundZ(plot))
        }
      }
    }
    if (raw.length === 0) return null

    // Pass 2 — remove each wing's own street-edge setback strip. Cross-setbacks between
    // ADJACENT street edges (sharing a corner vertex) are skipped — at acute corners they
    // clip too aggressively; pass 3's wing-vs-wing subtraction handles that separation.
    // Sibling wings split from the SAME edge are skipped too — they're collinear, so
    // clipping one against another's setback line would level every sibling to whichever
    // one has the largest setback instead of keeping each split wing's own. Non-adjacent,
    // non-sibling edges still cross-clip to keep distant wings clear of each other's yards.
    for (const rw of raw) {
      for (const edge of raw) {
        if (edge !== rw) {
          const diff = Math.abs(rw.edgeIndex - edge.edgeIndex)
          if (diff === 1 || diff === n - 1 || edge.edgeIndex === rw.edgeIndex) continue   // adjacent or sibling edge — skip cross-setback
        }
        rw.poly = halfPlaneClip(rw.poly, edge.streetA.x, edge.streetA.y, edge.nx, edge.nz, edge.setback)
        if (rw.poly.length < 3) break
      }
    }
    for (let i = raw.length - 1; i >= 0; i--) if (raw[i].poly.length < 3) raw.splice(i, 1)
    if (raw.length === 0) return null

    // Pass 3 — boolean-subtract overlapping wings from each other: process largest-area
    // wing first, and for every smaller wing it overlaps, replace that wing's polygon
    // with the largest surviving piece of (smaller \ larger). Processing largest-first
    // means a wing already trimmed by a bigger sibling is what a later, even-smaller
    // sibling gets tested against — overlap always resolves in favour of the bigger wing.
    raw.sort((a, b) => polyAreaXY(b.poly) - polyAreaXY(a.poly))
    for (let i = 0; i < raw.length; i++) {
      for (let j = i + 1; j < raw.length; j++) {
        const big = raw[i], small = raw[j]
        if (big.poly.length < 3 || small.poly.length < 3) continue
        const overlap = clipConvexToPolygon(small.poly, big.poly)
        if (!overlap || polyAreaXY(overlap) < 1e-6) continue
        const pieces = convexDifferencePieces(small.poly, big.poly)
        let best = null, bestArea = 0
        for (const p of pieces) { const ar = polyAreaXY(p); if (ar > bestArea) { bestArea = ar; best = p } }
        small.poly = best || []
      }
    }
    for (let i = raw.length - 1; i >= 0; i--) if (raw[i].poly.length < 3) raw.splice(i, 1)
    if (raw.length === 0) return null

    // Pass 4 — concave frontage: adjacent wings (consecutive street edges) share a
    // frontage corner but, when that corner is concave, their back walls diverge leaving
    // an acute gap. Test using each wing's pass-1 (un-clipped) back corners — passes 2/3
    // may have trimmed the actual corner vertex away, but the concavity test itself is
    // unaffected — then nudge whichever surviving vertex sits nearest that original back
    // corner over to close the gap (skipped if nothing survived nearby: that corner was
    // consumed entirely by the boolean ops above, nothing left to nudge).
    // Pass 4 TEMPORARILY DISABLED for debugging — confirmed buggy via the pass-debug
    // overlay (plot 922): nearestVertex(rw.poly, Bp) finds whichever vertex is spatially
    // closest to Bp, but after passes 2/3 a wing can have many more than 4 vertices (the
    // boolean subtraction in pass 3 routinely adds them), and the spatially-nearest one
    // is not reliably the topological "back corner" — it can be a vertex on a completely
    // different edge, and relocating THAT one creates a self-intersecting (bowtie)
    // polygon, which read as a notch being cut into the wing. Needs a topologically-aware
    // corner identification (e.g. walk the polygon edges adjacent to the frontage corner)
    // before re-enabling, not just nearest-by-distance.
    // for (const rw of raw) {
    //   const lw = raw.find(w => w.edgeIndex === (rw.edgeIndex + 1) % n)   // shares corner B
    //   if (!lw || rw.poly.length < 3 || lw.poly.length < 3) continue
    //   const B = rw.streetB, Bp = rw.origBp, Bpp = lw.origAp
    //   const dx = Bp.x - B.x, dz = Bp.y - B.y, L = Math.hypot(dx, dz) || 1
    //   const px = -dz / L, pz = dx / L                                   // interior of right wing
    //   const test = (Bpp.x - B.x) * px + (Bpp.y - B.y) * pz
    //   if (test < 0) {
    //     const v = nearestVertex(rw.poly, Bp)
    //     if (v && Math.hypot(v.x - Bp.x, v.y - Bp.y) < rw.worldD * 0.5) { v.x = Bpp.x; v.y = Bpp.y }
    //   }
    // }
    if (debugSink) for (const rw of raw) {
      const rec = debugSink.find(d => d.debugId === rw._debugId)
      if (rec) rec.blue = clonePoly(rw.poly)
    }

    // Safety clip — constrain every wing to the actual plot polygon. Not one of the
    // named passes, but kept from the previous implementation: the depth-sampling in
    // pass 1 budgets depth along specific rays, which a concave plot can still poke past
    // between samples, and passes 2-4 only resolve wing-vs-wing/street overlap, not
    // wing-vs-plot-boundary.
    for (const rw of raw) rw.poly = clipConvexToPolygon(rw.poly, poly) ?? rw.poly

    // Pass 5 — drop wings that come out too thin/small to read as a building (clipping
    // against setbacks/siblings/plot bounds can produce these), then convert survivors
    // to model space (÷ PARA_SCALE) and record the bbox for roofing.
    const S = PARA_SCALE
    const wings = []
    for (const rw of raw) {
      const vertices = rw.poly.map(p => [p.x / S, p.y / S])
      const xs = vertices.map(v => v[0]), zs = vertices.map(v => v[1])
      const minX = Math.min(...xs), maxX = Math.max(...xs)
      const minZ = Math.min(...zs), maxZ = Math.max(...zs)
      const area = polygonArea(vertices)
      const aspect = Math.max(maxX - minX, maxZ - minZ) / Math.max(1e-6, Math.min(maxX - minX, maxZ - minZ))
      // Pass 5 TEMPORARILY DISABLED for debugging (a corner wing was being dropped here
      // and it wasn't obvious why) — left in place, just not executed. Re-enable once the
      // pass 1-4 geometry is confirmed correct via the pass-debug overlay. isSelfIntersecting()
      // (above) is also kept defined but unused for the same reason — both were briefly
      // re-enabled together, but the underlying pass 4 corruption needs an actual fix
      // first, not just a filter mopping up after it.
      // if (area < MIN_WING_AREA || aspect > MAX_WING_ASPECT || isSelfIntersecting(vertices)) continue
      if (debugSink) {
        const rec = debugSink.find(d => d.debugId === rw._debugId)
        if (rec) rec.green = rw.poly.map(p => ({ x: p.x, y: p.y }))
      }
      const [fp, fq] = frontEdgeOf(rw.poly, rw.streetA, rw.nx, rw.nz)
      wings.push({
        vertices,
        floorCount: rw.floorCount,
        minX, maxX, minZ, maxZ,
        forceRidgeAlongX: rw.forceRidgeAlongX,
        // Street-facing front edge (model space), preserved through clipping so the
        // assembler can guarantee a door on the frontage.
        front: [[fp.x / S, fp.y / S], [fq.x / S, fq.y / S]],
        // For the jetty mechanic (_buildTownhouseSpec): how far a jettied upper floor may
        // overhang FORWARD into the street (model space), the forward push direction, and the
        // original street edge. The front wall sits on the street edge now (no setback), so
        // the jetty projects past it into the street.
        jettyProjection: rw.jettyBudget / S,
        jettyDir: [-rw.nx, -rw.nz],
        streetFront: [[rw.streetA.x / S, rw.streetA.y / S], [rw.streetB.x / S, rw.streetB.y / S]],
        // This wing's own depth in bays (model units), for Archway eligibility (≤4 bays).
        depthBays: rw.worldD / S,
      })
    }
    if (wings.length === 0) return null   // every wing was degenerate — no building here

    const primaryFloors = Math.max(...wings.map(w => w.floorCount))
    const spec = this._buildTownhouseSpec(distKey, wings, primaryFloors, hash, style, attached)
    return { spec, x: 0, z: 0, rotY: 0, y: this._plotGroundZ(plot) }
  }

  _buildTownhouseSpec(distKey, wings, floors, hash, style, attached) {
    style = style ?? (DISTRICT_BUILDING_STYLES[distKey] ?? DEFAULT_BUILDING_STYLE)
    const r1 = this._rand(hash + 11), r2 = this._rand(hash + 17)
    const r4 = this._rand(hash + 23), r5 = this._rand(hash + 29), r6 = this._rand(hash + 37)

    // roof ridge height — weighted pick, in floor-height units (entries iterated in
    // definition order); converted to riseHalfUnits (1 unit = 0.5 floor-heights) so
    // ParametricBuilding can use it directly instead of deriving rise from footprint span.
    const r9 = this._rand(hash + 53)
    let ridgeHeight = 0, ridgeCum = 0
    for (const [h, w] of Object.entries(style.roofRidgeHeight ?? { 1: 1.0 })) {
      ridgeCum += w
      ridgeHeight = parseFloat(h)
      if (r9 < ridgeCum) break
    }
    const roofRiseHalfUnits = Math.round(ridgeHeight / 0.5)

    const nonstone = r1 < style.woodChance ? 'wood' : 'plaster'
    const stone = r4 < style.graniteChance ? 'granite'
      : r4 < style.graniteChance + (style.brickChance ?? 0) ? 'brick' : 'stone'
    let wallMaterial
    if (r2 < style.stoneChance) {
      wallMaterial = Array.from({ length: floors }, (_, f) => f === 0 ? stone : nonstone)
    } else {
      wallMaterial = Array.from({ length: floors }, () => nonstone)
    }
    let roofMat = 'thatch', roofCum = 0
    for (const [mat, w] of Object.entries(style.roof)) {
      roofCum += w; roofMat = mat
      if (r5 < roofCum) break
    }
    // Foundation: derived from the ground floor's material (decision #5) — one
    // building-wide roll (applies identically to every wing's ground floor), gated on
    // that floor being stone/granite/brick. Replaces the old separate hasFoundation roll
    // that used to live in ParametricBuilding's assemble().
    const r8 = this._rand(hash + 41)
    const hasFoundation = STONE_MATS.has(wallMaterial[0]) && r8 < 0.35
    const startZ = hasFoundation ? 0.5 : 0
    for (const [wi, wing] of wings.entries()) {
      wing.floors = this._buildFloorList(hash, 200 + wi * 13, wing.floorCount, wallMaterial, startZ)
      delete wing.floorCount
    }
    // Archway: one seeded roll per building (never more than one), only once every
    // wing's floor list (and so ground-floor clearance) is known — see Archway,
    // CONTEXT_BuildingsRoofs.md, and ADR-0019 (Attached-only).
    this._assignArchway(wings, style, hash, attached)
    // Jetty: a stone/granite/brick ground floor can carry a jettied (overhanging) upper
    // storey, historically timber-over-masonry. Building-level decision (one roll for the
    // whole row-house unit); each wing then jetties its own front by a random amount up to
    // its jettyProjection budget, overhanging FORWARD into the street (the ground floor now
    // sits on the street edge — front setback removed).
    const r7 = this._rand(hash + 43)
    const canJetty = STONE_MATS.has(wallMaterial[0]) && floors > 1
    const jettied = canJetty && r7 < 0.5
    if (jettied) {
      for (const [wi, wing] of wings.entries()) {
        if (!(wing.jettyProjection > 0)) continue
        // Fixed 2026-07-13: `canJetty`/`jettied` above only check the BUILDING-level
        // `floors`, but each wing has its own independent wing.floors list (built at
        // :983 from wing.floorCount, which can be shorter than the building's overall
        // floor count). `fromFloor: 1` needs a real index-1 entry in THIS wing's own
        // floors — skip wings that don't have one, or ParametricBuilding.assemble()
        // throws reading .zHeight off undefined (confirmed live: "lots of these
        // errors" once auto-regenerate-on-drag-stop made this roll far more often).
        if (!(wing.floors.length > 1)) continue
        const rJ = this._rand(hash + 47 + wi * 5)
        wing.jetty = { amount: rJ * wing.jettyProjection, fromFloor: 1 }
      }
    }
    const { buildingTypes, buildingSubtype } = this._rollBuildingTypes(style, hash)
    return {
      seed: hash + 1000,
      floors,
      footprint: { type: 'wings', wings },
      roof: { shape: 'gable', material: roofMat, pitch: 0.55 + r6 * 0.45, overhangMin: style.overhangMin ?? 0.14, overhangMax: style.overhangMax ?? 0.48, riseHalfUnits: roofRiseHalfUnits },
      suppressedFaces: [],
      buildingTypes,
      buildingSubtype,
    }
  }

  // Pick at most one wing to carry an Archway (see Archway, CONTEXT_BuildingsRoofs.md):
  // a ground-floor passage tunnelling the wing's full depth to the Courtyard behind.
  // Attached-only; eligible wings are ≤4 bays deep with ≥1.5 floor-heights of clearance
  // below floor 2 (a tall-rolled ground floor, or a Foundation under a normal one).
  // Mutates the chosen wing with `wing.archway = { startT, endT, bays }` — fractions
  // along `wing.front` for the assembler to snap to its own bay grid.
  // NOTE: centred placement only. The TODO'd "edge-adjacent, if a neighbouring wing
  // exists to back onto" variant needs each wing's same-block *and* neighbour-building
  // wings, and neighbour-building wings aren't attached to the spec until
  // _suppressPartyWalls runs — after every plot's spec already exists. Deferred rather
  // than guessed at here.
  _assignArchway(wings, style, hash, attached) {
    if (!attached) return
    if (this._rand(hash + 601) >= (style.archChance ?? 0.15)) return
    const eligible = wings.filter(w => {
      const f0 = w.floors[0]
      return (w.depthBays ?? Infinity) <= 4 && (f0.zHeight + f0.height) >= 1.5
    })
    if (!eligible.length) return
    const wing = eligible[Math.floor(this._rand(hash + 607) * eligible.length)]
    const [fx0, fz0] = wing.front[0], [fx1, fz1] = wing.front[1]
    const frontLen = Math.hypot(fx1 - fx0, fz1 - fz0)
    const bays = Math.min(3, Math.max(1, Math.floor(frontLen)))
    if (frontLen < bays) return   // frontage too narrow for even a 1-bay archway
    const startT = (frontLen - bays) / 2 / frontLen
    wing.archway = { startT, endT: startT + bays / frontLen, bays }
  }

  // Record a placement for a district-appropriate model in this plot's front half.
  // `glbFootprints` (optional) collects { plot, poly } world-space bounding rectangles —
  // mirrors polyWingEntries for parametric buildings, so fence placement can avoid a
  // custom/GLB building's footprint the same way it already avoids a parametric one
  // (previously GLB buildings weren't tracked at all, so a fence could cut right through
  // one — most visible where a GLB building neighbours a parametric one and only the
  // parametric side's fence got the avoidance treatment).
  _spawn(plot, housePlacements, districtById, glbFootprints) {
    const poly = plot.blockCorners
    const streetEdges = plot.streetEdges || []
    if (!poly || poly.length < 3 || streetEdges.length === 0) return
    const groundZ = this._plotGroundZ(plot)

    // Primary frontage = longest street-facing edge.
    let a = null, b = null, len = -1
    for (const se of streetEdges) {
      const va = poly[se.index], vb = poly[(se.index + 1) % poly.length]
      if (!va || !vb) continue
      const l = Math.hypot(vb.x - va.x, vb.y - va.y)
      if (l > len) { len = l; a = va; b = vb }
    }
    if (!a || len < 0.06) return

    // Edge direction and inward normal.
    const ex = (b.x - a.x) / len, ey = (b.y - a.y) / len
    let nx = -ey, ny = ex
    let cx = 0, cy = 0
    for (const v of poly) { cx += v.x; cy += v.y }
    cx /= poly.length; cy /= poly.length
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny }   // point into the plot

    // Plot depth perpendicular to the frontage.
    let depth = 0
    for (const v of poly) {
      const d = (v.x - a.x) * nx + (v.y - a.y) * ny
      if (d > depth) depth = d
    }

    const bw = len * 0.72
    const bd = Math.min(depth * 0.5, bw * 1.5) * 0.9   // front ~half, not absurdly deep
    if (bw < 0.06 || bd < 0.05) return

    const setback = Math.min(0.04, depth * 0.12)
    const ccx = mx + nx * (setback + bd / 2)
    const ccy = my + ny * (setback + bd / 2)
    const theta = Math.atan2(-nx, -ny)   // local +Z → outward (worldX=-nx, worldZ=-ny)

    // Every plot gets a district-appropriate model (closest fit), placed at the
    // footprint centre and seated on the ground. No procedural box houses. Seeded by
    // position (not plot id) so the choice is stable when neighbouring districts change.
    const glbHash = posHash(ccx, ccy) + this._seedOffset
    const sel = this._selectModel(districtById?.get(plot.districtId), bw, bd, glbHash)
    if (sel) {
      const { buildingTypes, buildingSubtype } = this._rollBuildingTypes(this._districtStyle(districtById?.get(plot.districtId)), glbHash)
      housePlacements.push({ x: ccx, z: ccy, y: groundZ, rotY: theta, glbPath: sel.glbPath, scale: MODEL_SCALE, buildingTypes, buildingSubtype })
      if (glbFootprints) {
        const poly = footprintRectWorld(ccx, ccy, theta, (sel.width * MODEL_SCALE) / 2, (sel.depth * MODEL_SCALE) / 2)
        glbFootprints.push({ plot, poly })
      }
    }

    // A large/deep plot leaves empty yard behind the building — scatter small trees there.
    this._scatterBackTrees(plot, poly, mx, my, ex, ey, nx, ny, len, setback + bd, depth, housePlacements, groundZ)
  }

  // Scatter small trees in the back of a plot (perpendicular distance from `frontDepth`
  // to the plot's full `depth`), skipped unless the back yard is sizeable. `frontDepth`
  // is the building's back edge, so trees never land on the street-facing front.
  // Attach each Attached building's same-block neighbours' wings to its spec (`entries`
  // is already filtered to plot.attached ones by the caller). All entries share one
  // model space (each group sits at origin), so the assembler can test a building's
  // walls directly against neighbour wings to suppress shared party walls — up to each
  // neighbour's height (a taller building keeps the wall above a shorter neighbour). A
  // Freestanding neighbour is set back on every side, so nothing is ever flush against
  // it and its shared-boundary face naturally stays unsuppressed with no special-casing
  // (see Attached/Freestanding, ADR-0019) — Custom Model plots are GLB models (not
  // entries at all), so walls facing them also stay exposed.
  _suppressPartyWalls(entries) {
    const byBlock = new Map()
    for (const e of entries) {
      const b = e.plot?.blockId
      if (!byBlock.has(b)) byBlock.set(b, [])
      byBlock.get(b).push(e)
    }
    for (const group of byBlock.values()) {
      for (const { entry: B } of group) {
        const neighbors = []
        for (const { entry: N } of group) {
          if (N === B) continue
          // .slice() the floor list: assemble() later appends a roof entry onto each
          // wing's OWN `floors` array in place, and that mutation must not leak into
          // this snapshot (taken before any building's assemble() has run).
          for (const w of (N.spec?.footprint?.wings ?? [])) neighbors.push({ vertices: w.vertices, floors: (w.floors ?? []).slice() })
        }
        B.spec.neighborWings = neighbors
      }
    }
  }

  _scatterBackTrees(plot, poly, mx, my, ex, ey, nx, ny, len, frontDepth, depth, placements, plotZ = GROUND_Y) {
    // Push trees toward the back of the plot: skip the first 55% of the back yard and
    // only scatter in the rear zone, so trees cluster at the plot boundary rather than
    // right behind the building.
    const yard = depth - (frontDepth + 0.04)
    const backStart = frontDepth + 0.04 + yard * 0.55
    if (depth - backStart < TREE_MIN_BACK_DEPTH || len < TREE_MIN_FRONTAGE) return
    const halfLen = len / 2 - 0.03
    let placed = 0
    for (let d = backStart; d < depth - 0.03 && placed < TREE_MAX_PER_PLOT; d += TREE_SPACING) {
      for (let l = -halfLen; l <= halfLen && placed < TREE_MAX_PER_PLOT; l += TREE_SPACING) {
        // Seed by the (un-jittered) world cell position so trees are stable across
        // regenerations, independent of plot id.
        const seed = posHash(mx + ex * l + nx * d, my + ey * l + ny * d)
        if (this._rand(seed) > TREE_DENSITY) continue
        const ll = l + (this._rand(seed + 1) - 0.5) * TREE_SPACING * 0.7
        const dd = d + (this._rand(seed + 2) - 0.5) * TREE_SPACING * 0.7
        const px = mx + ex * ll + nx * dd
        const pz = my + ey * ll + ny * dd
        if (!pointInPolygon(px, pz, poly)) continue
        const scale = 0.104 + this._rand(seed + 3) * 0.064   // small (−20%)
        const treeGlb = TREE_GLBS[Math.floor(this._rand(seed + 5) * TREE_GLBS.length)]
        placements.push({ x: px, z: pz, rotY: this._rand(seed + 4) * Math.PI * 2, glbPath: treeGlb, scale })
        placed++
      }
    }
  }
}
