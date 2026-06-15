import FeatureManager from './FeatureManager.js'
import { pointInPolygon, posHash } from './renderUtils.js'
import { MODEL_BY_NAME, MODEL_SCALE } from '../../../shared/buildingCatalogue.js'
import PartLibrary from '../buildings/PartLibrary.js'
import { assemble } from '../buildings/ParametricBuilding.js'

export const PARA_SCALE = MODEL_SCALE / 2.3   // parametric model-unit → world-unit scale
const PARA_LIB_PATH = '/resources/buildingparts/default'

// ── District → model weighting matrix ────────────────────────────────────────
// Per district type, the building models allowed and their relative weight.
// Absent / 0 = never; higher = more likely when several models fit a plot equally
// well. District keys: Residential-Slums/Middle/Noble, Market, Leadership,
// Religious, Magical, Military, Industry, Entertainment, default. Edit freely.


// 2,3,4 = brick town houses variants
// 5+6 = half stone plaster variants

// 7+10+11 = barn/farm stone  

// 8+9 = wood roof red 
// 12 = wood shingle 
// 13 = stone multi story 
// 14+17 = log hut 
// 15 = slate roof plaster multi story 
// 16 + 18+19 = Bankers German house wood and stone
// m1 + t4  = market tower 
// m2 = lords house
// t1 = barn/farm stone tower
// t2 = lords tower
// t3 = military tower
// t5 = dilapidated 4 story building

// alchemists
// church
// forge
// hall
// watchmaker
// waterwheel

// Landmark buildings per district now live in shared/buildingCatalogue.js
// (DISTRICT_MODEL_SQUARE) — the SERVER places them before plots (ADR-0005). The
// client only renders the recorded landmarkBuildings.
// ── Per-district parametric building style profiles ──────────────────────────
// Controls probability distributions for floors, wall materials, roof type, and
// eave overhang for Residential plots.
//   woodChance     – probability nonstone material is wood (vs plaster)
//   stoneChance    – probability ground floor uses stone (upper floors always nonstone)
//   graniteChance  – probability stone variant is granite (vs regular stone)
//   roof           – relative weights, normalised internally; order defines tiebreak
//   overhangMin/Max – world-unit eave overhang range passed to ParametricBuilding
//   wingDepths     – bay-count options for townhouse wing depth (repeated = higher weight)
//   floorOptions   – floor count options for townhouse wings (repeated = higher weight)
const DISTRICT_BUILDING_STYLES = {
  'Residential-Slums': {
    floors:       { 1: 1.00 },
    woodChance:   0.75,
    stoneChance:  0.05,
    graniteChance: 0.00,
    roof:         { thatch: 0.70, reed: 0.25, slate: 0.05 },
    overhangMin:  0.06, overhangMax: 0.20,
    wingDepths:   [1, 2, 2, 3],
    floorOptions: [1, 1, 2],
  },
  'Residential-Middle': {
    floors:       { 1: 0.45, 2: 0.55 },
    woodChance:   0.50,
    stoneChance:  0.35,
    graniteChance: 0.15,
    roof:         { thatch: 0.45, slate: 0.35, reed: 0.20 },
    overhangMin:  0.12, overhangMax: 0.42,
    wingDepths:   [1, 2, 3, 4],
    floorOptions: [1, 2],
  },
  'Residential-Noble': {
    floors:       { 2: 0.65, 3: 0.35 },
    woodChance:   0.20,
    stoneChance:  0.80,
    graniteChance: 0.25,
    roof:         { slate: 0.72, reed: 0.18, thatch: 0.10 },
    overhangMin:  0.22, overhangMax: 0.48,
    wingDepths:   [2, 3, 4, 5],
    floorOptions: [2, 3],
  },
}
const DEFAULT_BUILDING_STYLE = {
  floors:       { 1: 0.50, 2: 0.50 },
  woodChance:   0.50,
  stoneChance:  0.32,
  graniteChance: 0.18,
  roof:         { slate: 0.40, thatch: 0.32, reed: 0.28 },
  overhangMin:  0.14, overhangMax: 0.48,
  wingDepths:   [2, 3, 4, 5],
  floorOptions: [1, 2],
}

const DISTRICT_MODEL_WEIGHTS = {
  'Residential-Slums':  { h10: 2, h11: 2, h8: 2, h9: 1, h14:3, h17:3 ,t5:1 ,t1: 1},
  'Residential-Middle': { h8: 3, h9: 3,t5:1, t2:1, h2:2,h3:1,h4:1,h5:2,h6:2,h13:2},
  'Residential-Noble':  { h8: 1, h9: 1, t2:1, h3:1,h4:1,h5:1,h6:1,h13:2,m2:2,h16:2,h18:2,h19:2},
  'Market':             { m1: 3, m2: 1, h8: 1, h9: 1,t5:1, t2:1, h2:2,h3:1,h4:2,h5:2,h6:2,h13:2,h16:3,h18:3,h19:3,watchmaker:2 },
  'Leadership':         { m2: 3, h8: 1, h9: 1, t2:1, h3:1,h4:1,h5:1,h6:1,h13:2,h16:2,h18:2,h19:2},
  'Religious':          { m1: 3, m2: 1, h8: 1, h9: 1,t5:1, t2:1, h2:2,h3:1,h4:2,h5:2,h6:2,h13:2,h16:3,h18:3,h19:3 },
  'Magical':            { h16:3,h18:3,h19:3, alchemists: 2,t19:5, watchmaker:2, alchemists:1},
  'Military':           { h11: 2, h13: 2, h6: 2,forge:2,alchemists:1},
  'Industry':           { t5: 3, h10: 2, h11: 2, alchemists:3,forge:3},
  'Entertainment':      { h8: 2, h9: 2, t5:2, h15:1},
  default:              { },
}

const FIT_FACTOR     = 0.92    // a model must fit within this fraction of the plot footprint
const FIT_TOLERANCE  = 0.12    // models within this coverage of the best fit are randomised between

// ── BuildingRenderer ──────────────────────────────────────────────────────────
// Places one street-facing model in the front half of each plot, using the plot's
// recorded streetEdges to find the frontage. Every plot gets a GLB model (closest
// fit); there are no procedural box houses.

const GROUND_Y = 0.075   // plot-fill surface height (see PlotRenderer); buildings seat here

// Back-yard trees: plots whose building leaves empty space behind it get small trees
// scattered in the back (never on the street-facing front).
const TREE_GLB            = '/resources/Models/tree.glb'
const TREE_MIN_BACK_DEPTH = 0.08   // empty depth behind the building required to add trees
const TREE_SPACING        = 0.07   // back-yard scatter grid spacing
const TREE_DENSITY        = 0.6    // fraction of grid cells that get a tree
const TREE_MAX_PER_PLOT   = 4
const TREE_MIN_FRONTAGE   = 0.16   // plot frontage below which we skip trees

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

export default class BuildingRenderer {
  constructor() {
    this.featureManager = null   // lazily created (needs the scene)
    this._lib = null             // PartLibrary once loaded
    this._libPromise = null      // loading promise (singleton)
    this._paraGroups = []        // THREE.Groups added for parametric buildings
    this._renderGen = 0          // incremented each render; async callbacks abort if stale
    this._visible = true         // buildings shown by default; persists across regenerations
    this._seedOffset = 0         // mixed into position hashes; 0 = stable (main game default)
  }

  // Randomise the seed offset so the next render() produces a different layout.
  // Only used by dev/preview tools — the main game leaves seedOffset at 0.
  randomizeSeed() { this._seedOffset = (Math.random() * 0x7FFFFFFF) | 0 }

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

  _ensureLib() {
    if (this._libPromise) return this._libPromise
    this._libPromise = new PartLibrary(PARA_LIB_PATH, { worldScale: PARA_SCALE }).load()
      .then(lib => { this._lib = lib; return lib })
    return this._libPromise
  }

  // Called by WorldRenderer so async building loads trigger a re-render.
  setDirtyCallback(fn) { this._markDirty = fn }

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

    for (const plot of plots) {
      if (plot.blockType === 'square') continue   // paved squares grow no house
      const district = districtById?.get(plot.districtId)
      if (this._isParametric(district, plot)) {
        const entry = this._spawnParametric(plot, district, housePlacements)
        if (entry) {
          paraQueue.push(entry)
          if (entry.spec?.footprint?.wings?.some(w => w.vertices)) {
            polyWingEntries.push({ entry, plot })
          }
        }
      } else {
        this._spawn(plot, housePlacements, districtById)
      }
    }
    if (!this.skipPartyWalls) this._suppressPartyWalls(polyWingEntries)
    // Expose the computed para entries (specs + transforms) for debug overlays. Built
    // synchronously; available as soon as render() returns (before async mesh assembly).
    this._lastParaEntries = paraQueue
    // Landmarks are placed by the server before plots (ADR-0005); here we just render
    // the recorded placements.
    for (const lb of (districtData?.landmarkBuildings || [])) {
      const m = MODEL_BY_NAME.get(lb.name)
      if (m) housePlacements.push({ x: lb.x, z: lb.z, rotY: lb.rotY ?? 0, glbPath: m.glbPath, scale: MODEL_SCALE })
    }

    const tDispatch = performance.now()
    console.log(`[perf] BuildingRenderer dispatch: ${(tDispatch-t0).toFixed(1)}ms (${plots.length} plots → ${paraQueue.length} para + ${housePlacements.length} glb, ${districtData?.landmarkBuildings?.length ?? 0} landmarks)`)

    if (housePlacements.length) {
      const tGlb = performance.now()
      this.featureManager.spawnBuildings(housePlacements, GROUND_Y).then(() => {
        if (this._renderGen !== gen) return
        console.log(`[perf] BuildingRenderer GLB spawn done: ${(performance.now()-tGlb).toFixed(1)}ms (${housePlacements.length} buildings)`)
        if (!this._visible) for (const obj of this.featureManager._objects) obj.visible = false
        this._markDirty?.()
      })
    }

    if (paraQueue.length) {
      const tPara = performance.now()
      this._ensureLib().then(lib => {
        if (this._renderGen !== gen) return   // superseded by a newer render call
        for (const { spec, x, z, rotY } of paraQueue) {
          const g = assemble(spec, lib)
          g.scale.setScalar(PARA_SCALE)
          g.position.set(x, GROUND_Y, z)
          g.rotation.y = rotY
          g.visible = this._visible
          scene.add(g)
          this._paraGroups.push(g)
        }
        console.log(`[perf] BuildingRenderer para assembly done: ${(performance.now()-tPara).toFixed(1)}ms (${paraQueue.length} buildings)`)
        this._markDirty?.()
      })
    }
  }

  // Deterministic [0,1) RNG from a seed (stable across rebuilds).
  _rand(seed) {
    let s = (seed * 2654435761) >>> 0
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 0x100000000
  }

  // District type → weight-matrix key.
  _districtKey(district) {
    const type = district?.assignedType
    if (!type) return 'default'
    if (type === 'Residential') return `Residential-${district.residentialClass ?? 'Middle'}`
    if (type === 'Leadership') return 'Leadership'
    return type
  }

  // Pick a model for a plot of footprint bw×bd in the given district. Models are
  // placed at their natural size (MODEL_SCALE), never stretched. Every plot gets a
  // model — as close to a fit as possible: models that fit within FIT_FACTOR are
  // preferred (best coverage wins, with FIT_TOLERANCE-banded ties randomised), and
  // if none fit the least-overflowing model is used. When the district has no
  // weighted models (empty/missing list), every model is eligible so a closest fit
  // is still found. Returns { glbPath } (null only if no models exist at all).
  _selectModel(district, bw, bd, seed) {
    let weights = DISTRICT_MODEL_WEIGHTS[this._districtKey(district)] || DISTRICT_MODEL_WEIGHTS.default
    if (!weights || Object.keys(weights).length === 0) {
      weights = Object.fromEntries([...MODEL_BY_NAME.keys()].map(name => [name, 1]))
    }
    const fitW = bw * FIT_FACTOR, fitD = bd * FIT_FACTOR
    const fitting = []      // models that fit inside the plot: { glbPath, w, cov }
    const overflowing = []  // models too big: { glbPath, over }  (over = how far past the plot)
    let bestCov = 0
    for (const name in weights) {
      const w = weights[name]
      const m = MODEL_BY_NAME.get(name)
      if (!w || w <= 0 || !m) continue
      const mw = m.width * MODEL_SCALE, md = m.depth * MODEL_SCALE   // world footprint at fixed scale
      const over = Math.max(0, mw - fitW) + Math.max(0, md - fitD)   // 0 = fits (front faces the street)
      if (over <= 0) {
        const cov = (mw * md) / (bw * bd)
        fitting.push({ glbPath: m.glbPath, w, cov })
        if (cov > bestCov) bestCov = cov
      } else {
        overflowing.push({ glbPath: m.glbPath, over })
      }
    }
    if (fitting.length) {
      const close = fitting.filter(c => c.cov >= bestCov - FIT_TOLERANCE)
      const total = close.reduce((s, c) => s + c.w, 0)
      let r = this._rand(seed) * total
      for (const c of close) { if ((r -= c.w) <= 0) return { glbPath: c.glbPath } }
      return { glbPath: close[0].glbPath }
    }
    if (overflowing.length) {   // nothing fits — use the model closest to fitting
      overflowing.sort((a, b) => a.over - b.over)
      return { glbPath: overflowing[0].glbPath }
    }
    return null
  }

  // True for district types that should use Parametric Buildings instead of fixed GLBs.
  // Freestanding slots inside townhouse blocks get a GLB model instead.
  _isParametric(district, plot) {
    if (plot?.blockType === 'townhouse' && plot.freestanding) return false
    return district?.assignedType === 'Residential'
  }

  // Build a { spec, x, z, rotY } entry for a parametric residential building.
  // Returns null if the plot is too small to build on.
  _spawnParametric(plot, district, housePlacements) {
    if (plot.blockType === 'townhouse') return this._spawnTownhouse(plot, district, housePlacements)
    const poly = plot.blockCorners
    const streetEdges = plot.streetEdges || []
    if (!poly || poly.length < 3 || streetEdges.length === 0) return null

    // Primary frontage = longest street-facing edge (same logic as _spawn).
    let a = null, b = null, len = -1
    for (const se of streetEdges) {
      const va = poly[se.index], vb = poly[(se.index + 1) % poly.length]
      if (!va || !vb) continue
      const l = Math.hypot(vb.x - va.x, vb.y - va.y)
      if (l > len) { len = l; a = va; b = vb }
    }
    if (!a || len < 0.06) return null

    const ex = (b.x - a.x) / len, ey = (b.y - a.y) / len
    let nx = -ey, ny = ex
    let cx = 0, cy = 0
    for (const v of poly) { cx += v.x; cy += v.y }
    cx /= poly.length; cy /= poly.length
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny }

    let depth = 0
    for (const v of poly) { const d = (v.x - a.x) * nx + (v.y - a.y) * ny; if (d > depth) depth = d }

    const distKey = this._districtKey(district)
    // Townhouse districts occupy a fixed front portion; others fill most of the plot.
    const isRow = distKey.includes('Noble') || distKey.includes('Middle')
    const worldBw = len * 0.90                                    // full frontage width (shared wall style)
    const worldBd = isRow ? Math.min(depth * 0.45, 3.0) : Math.min(depth * 0.50, worldBw * 1.5) * 0.9
    if (worldBw < 0.06 || worldBd < 0.05) return null

    const setback = Math.min(0.04, depth * 0.10)
    const x = mx + nx * (setback + worldBd / 2)
    const z = my + ny * (setback + worldBd / 2)
    const rotY = Math.atan2(-nx, -ny)

    // Convert world dimensions to model units (assemble() works in model space; PARA_SCALE applied later).
    const bw = worldBw / PARA_SCALE, bd = worldBd / PARA_SCALE
    const spec = this._buildSpec(distKey, bw, bd, x, z)
    if (housePlacements) {
      this._scatterBackTrees(plot, poly, mx, my, ex, ey, nx, ny, len, setback + worldBd, depth, housePlacements)
    }
    return { spec, x, z, rotY }
  }

  // Build a { spec, x, z, rotY } entry for a townhouse plot.
  // Computes polygon wings (one per street edge) in world space; group sits at origin with no rotation.
  _spawnTownhouse(plot, district, housePlacements) {
    const poly = plot.blockCorners
    const n = poly?.length ?? 0
    const streetEdges = plot.streetEdges || []
    if (!poly || n < 3 || streetEdges.length === 0) return null

    const distKey = this._districtKey(district)
    const style = DISTRICT_BUILDING_STYLES[distKey] ?? DEFAULT_BUILDING_STYLE
    const wingDepths = style.wingDepths ?? [2, 3, 4, 5]
    const floorOptions = style.floorOptions ?? [2, 3]

    // Polygon centroid for inward-normal checks
    let pcx = 0, pcy = 0
    for (const v of poly) { pcx += v.x; pcy += v.y }
    pcx /= n; pcy /= n

    const hash = posHash(pcx, pcy) + this._seedOffset

    // Pass 1 — build each wing as a world-space quad [A, B, Bp, Ap]
    //   A,B = frontage (street) endpoints; Ap,Bp = back corners (extruded inward by depth).
    //   index 0=front, 1=right side (B→Bp), 2=back (Bp→Ap), 3=left side (Ap→A).
    const raw = []
    for (let wi = 0; wi < streetEdges.length; wi++) {
      const se = streetEdges[wi]
      const A = poly[se.index], B = poly[(se.index + 1) % n]
      if (!A || !B) continue
      const dx = B.x - A.x, dz = B.y - A.y
      const L = Math.hypot(dx, dz)
      if (L < 0.04) continue
      const ux = dx / L, uz = dz / L   // along frontage

      // Inward normal
      let nx = -uz, nz = ux
      const midX = (A.x + B.x) / 2, midZ = (A.y + B.y) / 2
      if ((pcx - midX) * nx + (pcy - midZ) * nz < 0) { nx = -nx; nz = -nz }

      // Max depth from this frontage's midpoint
      let maxD = 0
      for (const v of poly) {
        const d = (v.x - midX) * nx + (v.y - midZ) * nz
        if (d > maxD) maxD = d
      }

      const depthBays = wingDepths[Math.floor(this._rand(hash + 2 + wi * 7) * wingDepths.length)]
      const worldD = Math.min(depthBays * PARA_SCALE, maxD * 0.92)
      if (worldD < 0.04) continue

      const wingFloors = floorOptions[Math.floor(this._rand(hash + 3 + wi * 7) * floorOptions.length)]
      const Ap = { x: A.x + nx * worldD, y: A.y + nz * worldD }
      const Bp = { x: B.x + nx * worldD, y: B.y + nz * worldD }
      raw.push({
        edgeIndex: se.index,
        corners: [{ x: A.x, y: A.y }, { x: B.x, y: B.y }, Bp, Ap],   // [front-L, front-R, back-R, back-L]
        floors: wingFloors,
        forceRidgeAlongX: Math.abs(ux) >= Math.abs(uz),
      })

      // Scatter trees behind the primary wing only
      if (wi === 0 && housePlacements) {
        this._scatterBackTrees(plot, poly, midX, midZ, ux, uz, nx, nz, L, worldD, maxD, housePlacements)
      }
    }
    if (raw.length === 0) return null

    // Pass 2 — concave frontage: adjacent wings share a frontage corner but, when that
    // corner is concave, their back walls diverge leaving an acute gap. Extend the
    // "right" wing's back-right corner to the "left" wing's back-left corner to close it.
    for (const rw of raw) {
      const lw = raw.find(w => w.edgeIndex === (rw.edgeIndex + 1) % n)   // shares corner B
      if (!lw) continue
      const B = rw.corners[1], Bp = rw.corners[2], Bpp = lw.corners[3]
      const dx = Bp.x - B.x, dz = Bp.y - B.y, L = Math.hypot(dx, dz) || 1
      const px = -dz / L, pz = dx / L                                   // interior of right wing
      const test = (Bpp.x - B.x) * px + (Bpp.y - B.y) * pz
      if (test < 0) rw.corners[2] = { x: Bpp.x, y: Bpp.y }              // concave → extend
    }

    // Pass 3 — clip each wing to the plot polygon so no wing extrudes past a boundary,
    // then convert to model space (÷ PARA_SCALE) and record the bbox for roofing.
    const S = PARA_SCALE
    const wings = []
    for (const rw of raw) {
      const clipped = clipConvexToPolygon(rw.corners, poly) ?? rw.corners
      const vertices = clipped.map(p => [p.x / S, p.y / S])
      const xs = vertices.map(v => v[0]), zs = vertices.map(v => v[1])
      wings.push({
        vertices,
        floors: rw.floors,
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minZ: Math.min(...zs), maxZ: Math.max(...zs),
        forceRidgeAlongX: rw.forceRidgeAlongX,
      })
    }

    const primaryFloors = Math.max(...wings.map(w => w.floors))
    const spec = this._buildTownhouseSpec(distKey, wings, primaryFloors, hash)
    return { spec, x: 0, z: 0, rotY: 0 }
  }

  _buildTownhouseSpec(distKey, wings, floors, hash) {
    const style = DISTRICT_BUILDING_STYLES[distKey] ?? DEFAULT_BUILDING_STYLE
    const r1 = this._rand(hash + 11), r2 = this._rand(hash + 17)
    const r4 = this._rand(hash + 23), r5 = this._rand(hash + 29)

    const nonstone = r1 < style.woodChance ? 'wood' : 'plaster'
    const stone    = r4 < style.graniteChance ? 'granite' : 'stone'
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
    return {
      seed: hash + 1000,
      floors,
      footprint: { type: 'wings', wings },
      wallMaterial,
      roof: { shape: 'gable', material: roofMat, pitch: 0.40, overhangMin: style.overhangMin ?? 0.14, overhangMax: style.overhangMax ?? 0.48 },
      suppressedFaces: [],
    }
  }

  // Build a Building Spec for a residential plot.
  // Deterministic by position when _seedOffset is 0 (main game); randomised in
  // preview tools by setting _seedOffset via randomizeSeed().
  _buildSpec(distKey, bw, bd, worldX, worldZ) {
    const hash = posHash(worldX, worldZ) + this._seedOffset
    const r0 = this._rand(hash),     r1 = this._rand(hash + 7)
    const r2 = this._rand(hash + 13)
    const r4 = this._rand(hash + 23), r5 = this._rand(hash + 29)

    const style = DISTRICT_BUILDING_STYLES[distKey] ?? DEFAULT_BUILDING_STYLE

    // floors — weighted pick (entries iterated in definition order)
    let floors = 1, floorCum = 0
    for (const [f, w] of Object.entries(style.floors)) {
      floorCum += w
      floors = parseInt(f)
      if (r0 < floorCum) break
    }

    // wall materials — stone ground floor only; upper floors always nonstone
    const nonstone = r1 < style.woodChance ? 'wood' : 'plaster'
    const stone    = r4 < style.graniteChance ? 'granite' : 'stone'
    let wallMaterial
    if (r2 < style.stoneChance) {
      wallMaterial = Array.from({ length: floors }, (_, f) => f === 0 ? stone : nonstone)
    } else {
      wallMaterial = Array.from({ length: floors }, () => nonstone)
    }

    // roof material — weighted pick
    let roofMat = 'thatch', roofCum = 0
    for (const [mat, w] of Object.entries(style.roof)) {
      roofCum += w
      roofMat = mat
      if (r5 < roofCum) break
    }

    return {
      seed: hash,
      floors,
      footprint: { type: 'wings', wings: [{ minX: -bw / 2, maxX: bw / 2, minZ: -bd / 2, maxZ: bd / 2, dormersOnMinSide: true }] },
      wallMaterial,
      roof: { shape: 'gable', material: roofMat, pitch: 0.40 + r0 * 0.45, overhangMin: style.overhangMin, overhangMax: style.overhangMax },
      suppressedFaces: [],   // server will populate this for townhouse adjacency
    }
  }

  // Record a placement for a district-appropriate model in this plot's front half.
  _spawn(plot, housePlacements, districtById) {
    const poly = plot.blockCorners
    const streetEdges = plot.streetEdges || []
    if (!poly || poly.length < 3 || streetEdges.length === 0) return

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
    const sel = this._selectModel(districtById?.get(plot.districtId), bw, bd, posHash(ccx, ccy) + this._seedOffset)
    if (sel) housePlacements.push({ x: ccx, z: ccy, rotY: theta, glbPath: sel.glbPath, scale: MODEL_SCALE })

    // A large/deep plot leaves empty yard behind the building — scatter small trees there.
    this._scatterBackTrees(plot, poly, mx, my, ex, ey, nx, ny, len, setback + bd, depth, housePlacements)
  }

  // Scatter small trees in the back of a plot (perpendicular distance from `frontDepth`
  // to the plot's full `depth`), skipped unless the back yard is sizeable. `frontDepth`
  // is the building's back edge, so trees never land on the street-facing front.
  // Attach each townhouse building's same-block neighbours' wings to its spec. All townhouse
  // entries share one model space (each group sits at origin), so the assembler can test a
  // building's walls directly against neighbour wings to suppress shared party walls — up to
  // each neighbour's height (a taller building keeps the wall above a shorter neighbour).
  // Freestanding plots are GLB models (not entries), so walls facing them stay exposed.
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
          for (const w of (N.spec?.footprint?.wings ?? [])) neighbors.push({ vertices: w.vertices, floors: w.floors })
        }
        B.spec.neighborWings = neighbors
      }
    }
  }

  _scatterBackTrees(plot, poly, mx, my, ex, ey, nx, ny, len, frontDepth, depth, placements) {
    const backStart = frontDepth + 0.04
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
        const scale = 0.13 + this._rand(seed + 3) * 0.08   // small
        placements.push({ x: px, z: pz, rotY: this._rand(seed + 4) * Math.PI * 2, glbPath: TREE_GLB, scale })
        placed++
      }
    }
  }
}
