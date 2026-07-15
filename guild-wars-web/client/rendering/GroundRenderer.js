import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { makeStreetMaterial } from './buildings/streetMaterial.js'
import { makeWallMaterial } from './buildings/stoneMaterial.js'
import { makeBrickMaterial } from './buildings/brickMaterial.js'
import { DISTRICT_COLORS } from './DistrictRenderer.js'
import BuildingRenderer, { PARA_SCALE } from './utils/BuildingRenderer.js'
import { posHash, pointInPolygon } from './utils/renderUtils.js'

// Merged renderer for everything that sits on the ground plane: streets,
// junction caps, city squares, plot fills, block outlines, and fences.
// BuildingRenderer is kept here because buildings are tightly coupled to plots.
//
// One shared atlas is loaded once and used by all surface materials (brick/mud
// streets and squares get atlas tiles; stone uses the procedural Voronoi shader).

export const STREET_COLORS = {
  Mud:       0x6B4C2A,
  Brick:     0x6B291C,
  Stone:     0x888fa0,
  unassigned: 0xb8a680,
  get(type) { return this[type] ?? null },
}

const PLOT_FILL_MAT   = { roughness: 0.75, emissiveIntensity: 0.0}

// Ground surface is Y=0. No layering — every (X,Z) point is covered by exactly one polygon.
// Matches BuildingRenderer.js's GROUND_Y.
const GROUND_Y = 0

const FENCE_FRACTION = 0.5
const FENCE_HEIGHT   = 0.03
const FENCE_BASE_Y   = 0
// "Head height" matches WalkMode's own PIVOT_Y (camera/head pivot) above ground:
// BODY_HEIGHT (0.60 * CHAR_HEIGHT) + HEAD_RADIUS (0.22 * CHAR_HEIGHT) = 0.82 * CHAR_HEIGHT,
// where CHAR_HEIGHT = 1 * PARA_SCALE. "Waist" is 60% of that.
// NOTE: the post/panel/rail fence rework (_buildFences, routeFenceAroundBuildings) that
// uses these is currently DISABLED — reverted back to the old flat tan strip below after
// it turned out to be drawing real, but badly corrupted, building-wing geometry (pass 4
// is disabled — see _spawnWingBuilding — and was producing self-intersecting wings). Kept
// in place, unused, to pick back up once pass 4 is properly fixed rather than disabled.
const FENCE_HEAD_HEIGHT_FRAC  = 0.82
const FENCE_WAIST_HEIGHT_FRAC = 0.6
const FENCE_WOOD_POST_SPACING_BAYS = 2   // "2x bay width" — bayWidth is the building grid's own module size

const GRASSY_BROWN   = 0x838f55

const ATLAS_BASE = '/resources/buildingparts/default'

// A fence walking a→b that meets a building polygon detours around it to the building's
// BACK (the far side from the a→b line) instead of just leaving a gap — modeling each
// building as its own oriented bounding box in the (a→b)-local frame: forward distance
// `s` along a→b, perpendicular depth `d` toward the building. The detour steps in to the
// building's deepest (back) extent, runs alongside it, then steps back out — works well
// for the box-ish wing/GLB footprints this game actually has; a fully general polygon
// perimeter walk isn't needed for that shape. Returns the full routed point list
// (including a and b); consecutive pairs are the fence's actual built segments.
// Real buildings in this game are well under this deep — anything beyond is treated as
// corrupted wing data (e.g. a self-intersecting polygon with a wild outlier vertex —
// ParametricBuilding.js's pass 4 is currently disabled for debugging and can produce
// these) rather than routed around, so one bad vertex can't turn into a fence detour
// that shoots across half the city.
const MAX_FENCE_DETOUR_DEPTH = 0.6

function routeFenceAroundBuildings(a, b, polys) {
  const fx = b.x - a.x, fy = b.y - a.y, flen = Math.hypot(fx, fy)
  if (flen < 1e-6) return [a, b]
  const ux = fx / flen, uy = fy / flen

  const hits = []
  for (const poly of polys) {
    if (!poly?.length) continue
    let pcx = 0, pcy = 0
    for (const v of poly) { pcx += v.x; pcy += v.y }
    pcx /= poly.length; pcy /= poly.length
    // Perpendicular pointing FROM the fence line TOWARD the building (so "depth" is
    // always positive into the yard, regardless of the plot edge's own winding).
    let px = -uy, py = ux
    if ((pcx - a.x) * px + (pcy - a.y) * py < 0) { px = -px; py = -py }

    let sMin = Infinity, sMax = -Infinity, depth = -Infinity
    for (const v of poly) {
      const s = (v.x - a.x) * ux + (v.y - a.y) * uy
      const d = (v.x - a.x) * px + (v.y - a.y) * py
      if (s < sMin) sMin = s
      if (s > sMax) sMax = s
      if (d > depth) depth = d
    }
    if (depth > MAX_FENCE_DETOUR_DEPTH) continue   // corrupted wing data — skip, don't detour
    const s0 = Math.max(0, sMin), s1 = Math.min(flen, sMax)
    if (s1 <= s0 || depth < 0.01) continue   // doesn't actually reach this edge
    hits.push({ s0, s1, depth, px, py })
  }
  if (!hits.length) return [a, b]
  hits.sort((h1, h2) => h1.s0 - h2.s0)

  // Merge overlapping hits (two buildings' projections overlapping along this edge) —
  // keep the union of their span and the deeper of the two depths.
  const merged = [hits[0]]
  for (let i = 1; i < hits.length; i++) {
    const h = hits[i], last = merged[merged.length - 1]
    if (h.s0 <= last.s1 + 0.02) {
      last.s1 = Math.max(last.s1, h.s1)
      last.depth = Math.max(last.depth, h.depth)
    } else merged.push(h)
  }

  const path = [a]
  for (const h of merged) {
    const entry  = { x: a.x + ux * h.s0, y: a.y + uy * h.s0 }
    const exitPt = { x: a.x + ux * h.s1, y: a.y + uy * h.s1 }
    const backNear = { x: entry.x + h.px * h.depth, y: entry.y + h.py * h.depth }
    const backFar  = { x: exitPt.x + h.px * h.depth, y: exitPt.y + h.py * h.depth }
    path.push(entry, backNear, backFar, exitPt)
  }
  path.push(b)
  return path
}

// Shortest distance from (x,y) to polygon `poly`'s boundary (its edges, not just verts).
function distToPolygonBoundary(x, y, poly) {
  let minD = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2))
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t))
    if (d < minD) minD = d
  }
  return minD
}
// Sub-intervals [t0,t1] of segment a→b that lie clear of every polygon in `polys` (outside
// AND at least `tol` from its boundary). Used to keep a fence from coinciding with a
// building's footprint. Sampled rather than split at exact line crossings: a building wall
// commonly runs flush/collinear with the plot edge a fence follows, which produces no
// transversal crossing for an exact-intersection split to find, and a point-in-polygon test
// is unreliable for a sample sitting exactly on (or a hair outside) the boundary line.
function segmentMinusPolygons(a, b, polys, tol = 0.15) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy)
  if (len < 1e-6) return [[0, 1]]
  const covered = (t) => {
    const x = a.x + dx * t, y = a.y + dy * t
    return polys.some(poly => pointInPolygon(x, y, poly) || distToPolygonBoundary(x, y, poly) < tol)
  }
  const step = Math.max(0.02, Math.min(0.1, len / 30))
  const n = Math.max(1, Math.round(len / step))
  const out = []
  let runStart = null
  for (let i = 0; i <= n; i++) {
    const t = i / n
    if (!covered(t)) { if (runStart === null) runStart = t }
    else if (runStart !== null) { out.push([runStart, t]); runStart = null }
  }
  if (runStart !== null) out.push([runStart, 1])
  return out
}

// A small square upright post — 4 side faces + a top cap (bottom is never seen, at
// ground level). `ux,uy` is the fence run's own unit direction; the post's square cross
// section is aligned to it purely so its faces aren't an arbitrary world-axis diagonal,
// not because the post itself looks different end-on vs side-on.
function pushPostQuads(verts, cx, cy, baseY, height, halfW, ux, uy) {
  const px = -uy, py = ux
  const top = baseY + height
  const corners = [
    { x: cx - ux * halfW - px * halfW, y: cy - uy * halfW - py * halfW },
    { x: cx + ux * halfW - px * halfW, y: cy + uy * halfW - py * halfW },
    { x: cx + ux * halfW + px * halfW, y: cy + uy * halfW + py * halfW },
    { x: cx - ux * halfW + px * halfW, y: cy - uy * halfW + py * halfW },
  ]
  for (let i = 0; i < 4; i++) {
    const A = corners[i], B = corners[(i + 1) % 4]
    verts.push(
      A.x, baseY, A.y,  B.x, baseY, B.y,  B.x, top, B.y,
      A.x, baseY, A.y,  B.x, top, B.y,    A.x, top, A.y,
    )
  }
  const [c0, c1, c2, c3] = corners
  verts.push(
    c0.x, top, c0.y,  c1.x, top, c1.y,  c2.x, top, c2.y,
    c0.x, top, c0.y,  c2.x, top, c2.y,  c3.x, top, c3.y,
  )
}

// A proper extruded wall box along a→b: front face, back face, a flat top cap, and two
// end caps (bottom is never seen, at ground level) — unlike a single zero-thickness
// double-sided plane, this has a real visible top edge and reads correctly as a wall
// from any angle, not just face-on. Used for stone/brick fence walls and the wood top
// rail/beam.
function pushWallBox(verts, ax, ay, bx, by, baseY, height, halfThick) {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1
  const ux = dx / len, uy = dy / len
  const px = -uy, py = ux
  const top = baseY + height
  const fa = { x: ax + px * halfThick, y: ay + py * halfThick }
  const fb = { x: bx + px * halfThick, y: by + py * halfThick }
  const ra = { x: ax - px * halfThick, y: ay - py * halfThick }
  const rb = { x: bx - px * halfThick, y: by - py * halfThick }
  // front
  verts.push(fa.x, baseY, fa.y,  fb.x, baseY, fb.y,  fb.x, top, fb.y,  fa.x, baseY, fa.y,  fb.x, top, fb.y,  fa.x, top, fa.y)
  // back
  verts.push(rb.x, baseY, rb.y,  ra.x, baseY, ra.y,  ra.x, top, ra.y,  rb.x, baseY, rb.y,  ra.x, top, ra.y,  rb.x, top, rb.y)
  // top
  verts.push(fa.x, top, fa.y,  fb.x, top, fb.y,  rb.x, top, rb.y,  fa.x, top, fa.y,  rb.x, top, rb.y,  ra.x, top, ra.y)
  // start / finish end caps
  verts.push(ra.x, baseY, ra.y,  fa.x, baseY, fa.y,  fa.x, top, fa.y,  ra.x, baseY, ra.y,  fa.x, top, fa.y,  ra.x, top, ra.y)
  verts.push(fb.x, baseY, fb.y,  rb.x, baseY, rb.y,  rb.x, top, rb.y,  fb.x, baseY, fb.y,  rb.x, top, rb.y,  fb.x, top, fb.y)
}

// Canonical, direction-independent key for a plot boundary edge a→b — two adjacent
// plots share the exact same physical edge but usually wind opposite ways around it
// (plot A sees a→b, plot B sees the same edge as b→a), so this rounds both endpoints
// and sorts them into a consistent order regardless of which plot is asking. Used to
// make sure a shared boundary only ever gets ONE fence (one material, one set of
// posts) instead of each adjacent plot independently building its own copy.
function edgeKey(a, b, precision = 1e-3) {
  const round = (v) => Math.round(v / precision) * precision
  const pa = [round(a.x), round(a.y)], pb = [round(b.x), round(b.y)]
  const [p0, p1] = (pa[0] < pb[0] || (pa[0] === pb[0] && pa[1] <= pb[1])) ? [pa, pb] : [pb, pa]
  return `${p0[0]},${p0[1]}|${p1[0]},${p1[1]}`
}

export default class GroundRenderer {
  constructor(scene, originalMaterials) {
    this.scene = scene
    this.originalMaterials = originalMaterials
    this.showDebug = false
    this.debugObjects = []

    // ── Street state ──────────────────────────────────────────────────────────
    this._streetSeedMeshes  = []
    this._streetSeedsVisible = true
    this._streetGraph       = null
    this.streetMeshes       = []
    this.gutterMeshes       = []
    this._boundaryHighlight = []
    this.hoveredStreetEdgeKey = null
    this._streetHoverMesh    = null
    this.hoveredJunctionId   = null
    this._junctionHoverMesh  = null

    // ── Block / plot state ────────────────────────────────────────────────────
    this._blockDebugMeshes     = []
    this._blockSeedMeshes      = []
    this._plotDebugMeshes      = []
    this._blockCentersVisible  = true
    this._blockSeedsVisible    = true
    this._plotCentersVisible   = true
    this.buildingRenderer      = new BuildingRenderer()
    this.blockMeshes           = []
    this.plotMeshes            = []
    this._terrainPlotMeshes    = []
    this._blockById            = new Map()
    this._hoveredBlockMesh     = null
    this.hoveredBlockId        = null
    this.finishedGround        = false
    this._plotFills            = []   // { mesh, districtId, districtColor, seed }
    this._squareFills          = []   // { mesh, districtId }
    this._fenceSegments        = []   // { a:{x,y}, b:{x,y} } world-space — for collision (e.g. WalkMode)
    this._fenceMeshes          = []   // merged post/panel/rail meshes, one per material — see _buildFences

    // ── Terrain plot state ────────────────────────────────────────────────────
    this._terrainPlotMeshMap   = new Map()  // plotId → THREE.Mesh
    this._terrainPlots         = []         // stored for hit testing
    this._terrainPlotHighlightMesh    = null
    this._terrainPlotHighlightMeshRef = null
    this._terrainPlotHighlightOrigColor   = undefined
    this._terrainPlotHighlightOrigEmissive = undefined

    // ── Combined district highlight ───────────────────────────────────────────
    // Covers streets, plot bases, and squares in one array.
    // Each entry: { mat, color, emissive, ei } for save/restore.
    this._districtHighlight = []

    // ── Surface corners (debug) ───────────────────────────────────────────────
    // Mirrors TerrainRenderer's own _surfaceCornerMeshes/_surfaceCornersVisible —
    // user-requested (2026-07-15, "all surface corners, incl streets, plots, should
    // have surface corners in debug mode"): that visualization only ever covered
    // terrain-plot/river-cliff-face corners, nothing city-side. Off by default, same
    // reason as the terrain one — a real city has thousands of these.
    this._surfaceCornerMeshes = []
    this._surfaceCornersVisible = false

    // ── Atlas ────────────────────────────────────────────────────────────────
    this._atlas                       = null
    this._lastRenderedGraph           = null
    this._lastRenderedPlots           = null
    this._lastRenderedPlotDistrictData = null
    this._loadAtlas()
  }

  // Load the shared atlas async. If ground was already drawn with fallback colours,
  // redraw streets and plots with proper textures once it arrives.
  async _loadAtlas() {
    try {
      const manifest = await fetch(`${ATLAS_BASE}/manifest.json`).then((r) => r.json())
      const tex = await new THREE.TextureLoader().loadAsync(`${ATLAS_BASE}/${manifest.atlas}`)
      tex.flipY = false
      tex.colorSpace = THREE.SRGBColorSpace
      tex.magFilter = THREE.NearestFilter
      tex.minFilter = THREE.NearestMipmapLinearFilter
      tex.generateMipmaps = true
      this._atlas = { tex, regions: manifest.atlasRegions }
      if (this._lastRenderedGraph) this.renderStreetGraph(this._lastRenderedGraph)
      if (this._lastRenderedPlots) this.renderPlots(this._lastRenderedPlots, this._lastRenderedPlotDistrictData)
    } catch (e) {
      console.error('[GroundRenderer] FAILED to load atlas – all streets/squares will be flat colour', e)
    }
  }


  // ── Debug visibility ─────────────────────────────────────────────────────────

  setDebugVisible(show) {
    this.showDebug = show
    for (const m of this._streetSeedMeshes) m.visible = show && this._streetSeedsVisible
    for (const m of this._blockDebugMeshes)  m.visible = show && this._blockCentersVisible
    for (const m of this._blockSeedMeshes)   m.visible = show && this._blockSeedsVisible
    for (const m of this._plotDebugMeshes)   m.visible = show && this._plotCentersVisible
    for (const m of this._surfaceCornerMeshes) m.visible = show && this._surfaceCornersVisible
  }

  setSurfaceCornersVisible(on) {
    this._surfaceCornersVisible = on
    for (const m of this._surfaceCornerMeshes) m.visible = this.showDebug && on
  }

  setStreetSeedsVisible(on) {
    this._streetSeedsVisible = on
    for (const m of this._streetSeedMeshes) m.visible = this.showDebug && on
  }

  setBlockCentersVisible(on) {
    this._blockCentersVisible = on
    for (const m of this._blockDebugMeshes) m.visible = this.showDebug && on
  }

  setBlockSeedsVisible(on) {
    this._blockSeedsVisible = on
    for (const m of this._blockSeedMeshes) m.visible = this.showDebug && on
  }

  setPlotCentersVisible(on) {
    this._plotCentersVisible = on
    for (const m of this._plotDebugMeshes) m.visible = this.showDebug && on
  }

  _clearDebugGroup(arr) {
    for (const obj of arr) this.scene.remove(obj)
    const toRemove = new Set(arr)
    this.debugObjects = this.debugObjects.filter(o => !toRemove.has(o))
    arr.length = 0
  }

  clearDebugObjects() {
    this._clearDebugGroup(this._streetSeedMeshes)
    this._clearDebugGroup(this._blockDebugMeshes)
    this._clearDebugGroup(this._blockSeedMeshes)
    this._clearDebugGroup(this._plotDebugMeshes)
    this._clearDebugGroup(this._surfaceCornerMeshes)
    for (const obj of this.debugObjects) this.scene.remove(obj)
    this.debugObjects = []
  }


  // ── Street graph ─────────────────────────────────────────────────────────────

  setStreetGraph(streetGraph) {
    this._streetGraph = streetGraph
  }

  renderStreetGraph(streetGraph) {
    this.clearStreetLayer()
    this._lastRenderedGraph = streetGraph
    const junctions = streetGraph?.junctions
    if (!junctions?.length) return

    const junctionById = new Map(junctions.map(j => [j.id, j]))
    const fallback = STREET_COLORS.Mud
    const gz = (x, y) => this.getZHeight?.(x, y) ?? GROUND_Y

    for (const j of junctions) {
      for (const conn of j.connections) {
        if (conn.toId <= j.id) continue
        if (conn.type === 'Canal' || conn.type === 'Docks') continue
        const j2 = junctionById.get(conn.toId)
        if (!j2) continue
        const conn2 = j2.connections.find(c => c.toId === j.id)
        if (!conn2) continue

        // Wall boundaries render as Mud surface so the ground is covered beneath the
        // wall mesh that DistrictRenderer places on top. All other types use their own type.
        const type = conn.type === 'Wall' ? 'Mud' : conn.type
        const { gutterLeft: aL, gutterRight: aR } = conn
        const { gutterLeft: bL, gutterRight: bR } = conn2
        const verts = new Float32Array([
          aR.x, aR.z ?? gz(aR.x, aR.y), aR.y,  aL.x, aL.z ?? gz(aL.x, aL.y), aL.y,
          bR.x, bR.z ?? gz(bR.x, bR.y), bR.y,  bL.x, bL.z ?? gz(bL.x, bL.y), bL.y,
        ])
        const geom = new THREE.BufferGeometry()
        geom.setAttribute('position', new THREE.BufferAttribute(verts, 3))
        geom.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1))
        geom.computeVertexNormals()
        // Segment's own direction — Brick streets rotate their procedural brick
        // pattern to it so bricks lay long-axis-across-the-road (see streetMaterial.js).
        // Overridden to the connected-square-cluster's shared direction when this road
        // borders a city square (see _computeSquareClusterAngles) — squares only look
        // seamlessly paved with their connected streets if they all share ONE texture
        // origin/rotation instead of each segment picking its own.
        const segAngle = this._squareClusterRoadAngle?.get(conn.roadId) ?? Math.atan2(j2.y - j.y, j2.x - j.x)
        const mat = makeStreetMaterial(type, this._atlas, STREET_COLORS.get(type) || fallback, undefined, segAngle)
        const mesh = new THREE.Mesh(geom, mat)
        mesh.userData = { roadId: conn.roadId, districtId: conn.districtId }
        this.scene.add(mesh)
        this.streetMeshes.push(mesh)
      }
    }

    for (const j of junctions) {
      if (j.connections.length < 2) continue
      if (j.type === 'Canal' || j.type === 'Docks') continue

      const pts = []
      for (const conn of j.connections) {
        if (conn.type === 'Canal' || conn.type === 'Docks') continue
        pts.push(conn.gutterLeft, conn.gutterRight)
      }
      pts.sort((a, b) => Math.atan2(a.y - j.y, a.x - j.x) - Math.atan2(b.y - j.y, b.x - j.x))

      const uniq = [pts[0]]
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i], q = uniq[uniq.length - 1]
        if (Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) uniq.push(p)
      }
      const last = uniq[uniq.length - 1], first = uniq[0]
      if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-6) uniq.pop()
      if (uniq.length < 3) continue

      const n = uniq.length
      const verts = new Float32Array((n + 1) * 3)
      verts[0] = j.x; verts[1] = j.z ?? gz(j.x, j.y); verts[2] = j.y
      for (let i = 0; i < n; i++) {
        verts[(i + 1) * 3]     = uniq[i].x
        verts[(i + 1) * 3 + 1] = uniq[i].z ?? gz(uniq[i].x, uniq[i].y)
        verts[(i + 1) * 3 + 2] = uniq[i].y
      }
      const tris = []
      for (let i = 0; i < n; i++) tris.push(0, ((i + 1) % n) + 1, i + 1)

      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.BufferAttribute(verts, 3))
      geom.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1))
      geom.computeVertexNormals()
      // Same cluster-angle override as the street segments above — if any road meeting
      // at this junction belongs to a square cluster, the fan adopts that direction too.
      let fanAngle = 0
      for (const conn of j.connections) {
        const a = this._squareClusterRoadAngle?.get(conn.roadId)
        if (a !== undefined) { fanAngle = a; break }
      }
      const fanType = j.type === 'Wall' ? 'Mud' : j.type
      const mat = makeStreetMaterial(fanType, this._atlas, STREET_COLORS.get(fanType) || fallback, undefined, fanAngle)
      const mesh = new THREE.Mesh(geom, mat)
      mesh.userData = { districtId: j.districtId }
      this.scene.add(mesh)
      this.streetMeshes.push(mesh)
    }
  }

  // "Adjacent" squares share a street (a roadId in common between their streetEdges);
  // "connected" squares are the transitive closure of adjacency — a whole interlinked
  // plaza network. For each connected cluster, computes ONE shared texture direction
  // (the length-weighted, pi-periodic circular mean of every road in the cluster) so
  // every square and street segment belonging to it renders as one continuous paved
  // area instead of each piece picking its own brick rotation.
  // Returns { roadAngle: Map<roadId, angle>, plotAngle: Map<plotId, angle> }.
  _computeSquareClusterAngles(plots, streetGraph) {
    const empty = { roadAngle: new Map(), plotAngle: new Map() }
    const squares = (plots || []).filter(p => p.blockType === 'square' && p.streetEdges?.length)
    if (!squares.length || !streetGraph?.junctions?.length) return empty

    const parent = new Map(squares.map(s => [s.id, s.id]))
    const find = (id) => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id) } return id }
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }

    const byRoad = new Map()   // roadId -> [square, ...] referencing it
    for (const sq of squares) {
      for (const se of sq.streetEdges) {
        if (!byRoad.has(se.roadId)) byRoad.set(se.roadId, [])
        byRoad.get(se.roadId).push(sq)
      }
    }
    for (const list of byRoad.values()) {
      for (let i = 1; i < list.length; i++) union(list[0].id, list[i].id)
    }

    const clusterRoadIds = new Map()    // root -> Set<roadId>
    const clusterSquareIds = new Map()  // root -> [squareId, ...]
    for (const sq of squares) {
      const root = find(sq.id)
      if (!clusterRoadIds.has(root)) { clusterRoadIds.set(root, new Set()); clusterSquareIds.set(root, []) }
      clusterSquareIds.get(root).push(sq.id)
      for (const se of sq.streetEdges) clusterRoadIds.get(root).add(se.roadId)
    }

    // roadId -> direction vector, from the street graph itself (first occurrence; both
    // ends of one road agree on the line it runs along).
    const junctionById = new Map(streetGraph.junctions.map(j => [j.id, j]))
    const segByRoad = new Map()
    for (const j of streetGraph.junctions) {
      for (const conn of (j.connections || [])) {
        if (segByRoad.has(conn.roadId)) continue
        const j2 = junctionById.get(conn.toId)
        if (!j2) continue
        segByRoad.set(conn.roadId, { dx: j2.x - j.x, dy: j2.y - j.y })
      }
    }

    const roadAngle = new Map(), plotAngle = new Map()
    for (const [root, roadIds] of clusterRoadIds) {
      // Length-weighted circular mean, doubled-angle trick — brick rows look identical
      // rotated by pi, so two streets running "the same way" but in opposite winding
      // order (180 deg apart) must reinforce, not cancel, in the average.
      let sx = 0, sy = 0
      for (const roadId of roadIds) {
        const seg = segByRoad.get(roadId)
        if (!seg) continue
        const len = Math.hypot(seg.dx, seg.dy)
        if (len < 1e-6) continue
        const theta = Math.atan2(seg.dy, seg.dx)
        sx += Math.cos(2 * theta) * len
        sy += Math.sin(2 * theta) * len
      }
      const angle = (sx === 0 && sy === 0) ? 0 : Math.atan2(sy, sx) / 2
      for (const roadId of roadIds) roadAngle.set(roadId, angle)
      for (const sqId of clusterSquareIds.get(root)) plotAngle.set(sqId, angle)
    }
    return { roadAngle, plotAngle }
  }

  clearStreetLayer() {
    this.clearBoundaryChainHighlight()
    for (const m of this.streetMeshes) this.scene.remove(m)
    this.streetMeshes = []
  }

  renderGutters(streetGraph) {
    this.clearGutterLayer()
    const junctions = streetGraph?.junctions
    if (!junctions?.length) return

    const Y = GROUND_Y
    const verts = []
    const junctionById = new Map(junctions.map(j => [j.id, j]))

    const addSeg = (a, b) => { verts.push(a.x, Y, a.y, b.x, Y, b.y) }

    for (const j of junctions) {
      for (const conn of j.connections) {
        if (conn.toId <= j.id) continue
        const j2 = junctionById.get(conn.toId)
        if (!j2) continue
        const conn2 = j2.connections.find(c => c.toId === j.id)
        if (!conn2) continue
        addSeg(conn.gutterLeft,  conn2.gutterRight)
        addSeg(conn.gutterRight, conn2.gutterLeft)
      }
    }

    for (const j of junctions) {
      const conns = j.connections
      const n = conns.length
      if (n === 1) { addSeg(conns[0].gutterRight, conns[0].gutterLeft); continue }
      for (let i = 0; i < n; i++) {
        const a = conns[i].gutterLeft
        const b = conns[(i + 1) % n].gutterRight
        if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-6) addSeg(a, b)
      }
    }

    if (verts.length === 0) return
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0x00ffff }))
    this.scene.add(lines)
    this.gutterMeshes.push(lines)
  }

  clearGutterLayer() {
    for (const m of this.gutterMeshes) this.scene.remove(m)
    this.gutterMeshes = []
  }


  // ── Boundary chain highlight ──────────────────────────────────────────────────

  setBoundaryChainHighlight(edgeId, color = 0xffff66) {
    this.clearBoundaryChainHighlight()
    const prefix = `street-boundary-${edgeId}-`
    for (const mesh of this.streetMeshes) {
      if (!mesh.userData.roadId?.startsWith(prefix)) continue
      const mat = mesh.material
      this._boundaryHighlight.push({ mat, color: mat.color.getHex(), emissive: mat.emissive?.getHex(), ei: mat.emissiveIntensity })
      mat.color.setHex(color)
      if (mat.emissive) mat.emissive.setHex(color)
      mat.emissiveIntensity = 0.9
    }
  }

  clearBoundaryChainHighlight() {
    for (const h of this._boundaryHighlight) {
      h.mat.color.setHex(h.color)
      if (h.emissive !== undefined && h.mat.emissive) h.mat.emissive.setHex(h.emissive)
      h.mat.emissiveIntensity = h.ei
    }
    this._boundaryHighlight = []
  }


  // ── District highlight (streets + plots + squares) ────────────────────────────

  highlightDistrict(districtId) {
    this.clearDistrictHighlight()
    if (districtId === undefined || districtId === null) return
    const white = new THREE.Color(0xffffff)
    const lighten = (mat) => {
      this._districtHighlight.push({ mat, color: mat.color.getHex(), emissive: mat.emissive?.getHex(), ei: mat.emissiveIntensity })
      mat.color.lerp(white, 0.5)
      mat.emissive?.lerp(white, 0.5)
      mat.emissiveIntensity = 0.85
    }
    for (const m of this.streetMeshes) if (m.userData?.districtId === districtId) lighten(m.material)
    for (const f of this._plotFills)   if (f.districtId === districtId) lighten(f.mesh.material)
    for (const s of this._squareFills) if (s.districtId === districtId) lighten(s.mesh.material)
  }

  clearDistrictHighlight() {
    for (const h of this._districtHighlight) {
      h.mat.color.setHex(h.color)
      if (h.emissive !== undefined && h.mat.emissive) h.mat.emissive.setHex(h.emissive)
      h.mat.emissiveIntensity = h.ei
    }
    this._districtHighlight = []
  }


  // ── Hover ────────────────────────────────────────────────────────────────────

  clearHover() {
    this.clearBlockHover()
    if (this.hoveredStreetEdgeKey !== null) {
      if (this._streetHoverMesh) {
        this.scene.remove(this._streetHoverMesh)
        this._streetHoverMesh.geometry?.dispose?.()
        this._streetHoverMesh.material?.dispose?.()
        this._streetHoverMesh = null
      }
      this.hoveredStreetEdgeKey = null
    }
    if (this.hoveredJunctionId !== null) {
      if (this._junctionHoverMesh) {
        this.scene.remove(this._junctionHoverMesh)
        this._junctionHoverMesh.geometry?.dispose?.()
        this._junctionHoverMesh.material?.dispose?.()
        this._junctionHoverMesh = null
      }
      this.hoveredJunctionId = null
    }
    this.clearBoundaryChainHighlight()
  }

  setStreetEdgeHover(edge) {
    if (!edge) return
    const key = edge.id ?? `${edge.nodeA}_${edge.nodeB}`
    if (this.hoveredStreetEdgeKey === key) return
    this.clearHover()
    const junctions = this._streetGraph?.junctions
    if (!junctions?.length) return
    const byId = new Map(junctions.map(j => [j.id, j]))
    const a = byId.get(edge.nodeA), b = byId.get(edge.nodeB)
    if (!a || !b) return
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len === 0) return
    const r = (0.0875 * 1.2) / 2
    const px = (-dy / len) * r, py = (dx / len) * r
    const Y = GROUND_Y
    const verts = new Float32Array([
      a.x - px, Y, a.y - py,
      a.x + px, Y, a.y + py,
      b.x + px, Y, b.y + py,
      b.x - px, Y, b.y - py,
    ])
    const idx = new Uint16Array([0, 1, 2, 0, 2, 3])
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geom.setIndex(new THREE.BufferAttribute(idx, 1))
    geom.computeVertexNormals()
    const mat = new THREE.MeshBasicMaterial({ color: 0xffff66, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geom, mat)
    this.scene.add(mesh)
    this._streetHoverMesh = mesh
    this.hoveredStreetEdgeKey = key
  }

  setJunctionHover(junctionId) {
    if (this.hoveredJunctionId === junctionId) return
    this.clearHover()
    const junction = this._streetGraph?.junctions?.find(j => j.id === junctionId)
    if (!junction) return
    const r = 0.0875
    const geo = new THREE.CylinderGeometry(r, r, 0.002, 16)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(junction.x, GROUND_Y, junction.y)
    this.scene.add(mesh)
    this._junctionHoverMesh = mesh
    this.hoveredJunctionId = junctionId
  }


  // ── Street hit testing ────────────────────────────────────────────────────────

  getStreetEdgeAtWorldPos(worldX, worldY, threshold = 0.0875) {
    const junctions = this._streetGraph?.junctions
    if (!junctions?.length) return null
    const byId = new Map(junctions.map(j => [j.id, j]))
    const thrSq = threshold * threshold
    let bestEdge = null, bestDistSq = Infinity, bestT = 0
    for (const j of junctions) {
      for (const conn of j.connections) {
        if (conn.toId <= j.id) continue
        const b = byId.get(conn.toId)
        if (!b) continue
        const dx = b.x - j.x, dy = b.y - j.y
        const lenSq = dx * dx + dy * dy
        if (lenSq < 1e-12) continue
        let t = ((worldX - j.x) * dx + (worldY - j.y) * dy) / lenSq
        t = Math.max(0, Math.min(1, t))
        const px = j.x + t * dx, py = j.y + t * dy
        const distSq = (worldX - px) ** 2 + (worldY - py) ** 2
        if (distSq < thrSq && distSq < bestDistSq) {
          bestDistSq = distSq
          bestEdge = { nodeA: j.id, nodeB: conn.toId, id: conn.roadId, type: conn.type,
            districtId: conn.districtId, left: conn.left, right: conn.right }
          bestT = t
        }
      }
    }
    if (!bestEdge) return null
    const a = byId.get(bestEdge.nodeA), b = byId.get(bestEdge.nodeB)
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    return {
      kind: 'streetEdge',
      id: bestEdge.id ?? null,
      type: bestEdge.type ?? null,
      districtId: bestEdge.districtId ?? null,
      left: bestEdge.left ?? null,
      right: bestEdge.right ?? null,
      nodeA: bestEdge.nodeA,
      nodeB: bestEdge.nodeB,
      length,
      tipDist: Math.sqrt(bestDistSq),
      t: bestT,
    }
  }

  getJunctionAtWorldPos(worldX, worldY, threshold = 0.175) {
    const junctions = this._streetGraph?.junctions
    if (!junctions?.length) return null
    const thrSq = threshold * threshold
    let best = null, bestDistSq = Infinity
    for (const j of junctions) {
      const dx = worldX - j.x, dy = worldY - j.y
      const distSq = dx * dx + dy * dy
      if (distSq < thrSq && distSq < bestDistSq) { bestDistSq = distSq; best = j }
    }
    return best
  }


  // ── Blocks ────────────────────────────────────────────────────────────────────

  renderBlocks(blocks) {
    this.clearBlockLayer()
    this._blockById = new Map((blocks || []).map(b => [b.id, b.blockCorners]))
    if (!blocks?.length) return

    const blockLineVerts = []
    for (const block of blocks) {
      const poly = block.blockCorners
      if (!poly?.length) continue
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length]
        blockLineVerts.push(a.x, GROUND_Y , a.y, b.x, GROUND_Y, b.y)
      }
    }
    if (blockLineVerts.length === 0) return
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(blockLineVerts), 3))
    const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xff8800 }))
    this.scene.add(lines)
    this.blockMeshes.push(lines)
  }

  clearBlockLayer() {
    for (const m of this.blockMeshes) this.scene.remove(m)
    this.blockMeshes = []
  }

  setBlockHover(blockId) {
    if (this.hoveredBlockId === blockId) return
    this.clearBlockHover()
    const poly = this._blockById.get(blockId)
    if (!poly?.length) return
    const verts = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      verts.push(a.x, GROUND_Y, a.y, b.x, GROUND_Y, b.y)
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    const mesh = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xffff00 }))
    this.scene.add(mesh)
    this._hoveredBlockMesh = mesh
    this.hoveredBlockId = blockId
  }

  clearBlockHover() {
    if (this._hoveredBlockMesh) {
      this.scene.remove(this._hoveredBlockMesh)
      this._hoveredBlockMesh.geometry?.dispose()
      this._hoveredBlockMesh.material?.dispose()
      this._hoveredBlockMesh = null
    }
    this.hoveredBlockId = null
  }


  // ── Plots + Squares + Fences ──────────────────────────────────────────────────

  renderPlots(plots, districtData, { preserveTerrainPlots = false } = {}) {
    this.clearPlotLayer({ preserveTerrainPlots })
    this._lastRenderedPlots            = plots
    this._lastRenderedPlotDistrictData = districtData
    if (!plots?.length) return

    const districtById = new Map((districtData?.districts || []).map(d => [d.id, d]))
    const STREET_PRIORITY = { Stone: 2, Brick: 1, Mud: 0 }

    // Connected-square texture-direction clusters — see _computeSquareClusterAngles.
    // Re-triggers a street redraw afterward (mirrors the atlas-loaded pattern) so
    // already-rendered street segments bordering a square pick up its cluster angle —
    // renderStreetGraph() normally runs BEFORE renderPlots() (App.js), i.e. before
    // squares/plots even exist yet to cluster.
    const { roadAngle, plotAngle } = this._computeSquareClusterAngles(plots, this._streetGraph)
    this._squareClusterRoadAngle = roadAngle
    if (roadAngle.size && this._lastRenderedGraph) this.renderStreetGraph(this._lastRenderedGraph)

    const getColor = (districtId) => {
      const d = districtById.get(districtId)
      if (!d?.assignedType) return DISTRICT_COLORS.Neutral
      const key = d.assignedType === 'Residential' && d.residentialClass ? d.residentialClass
        : d.assignedType === 'Leadership' && d.LeadershipClass ? d.LeadershipClass
        : d.assignedType
      return DISTRICT_COLORS.get(key) || DISTRICT_COLORS.Neutral
    }

    const plotBase = (districtId) => this.finishedGround ? GRASSY_BROWN : getColor(districtId)

    const TERRAIN_FILL_COLORS = {
      Plains: 0xb2de69, Desert: 0xedca72, Mountains: 0x8d8d8d,
      Forest: 0x218c21, Lake:   0x1a5abf, Sea:       0x0e6e6c,
      Hills:  0x699B4F, Swamp:  0x4a6b4a, 'Ice Sheet': 0xf4f8ff, unassigned: 0xb8a680,
      // River/Cliff DCEL faces (see TerrainPlotConverter's riverCliffFaces param, plan
      // "typed-giggling-giraffe" addendum) — same hex values as TerrainRenderer's
      // TERRAIN_COLORS, so the fill doesn't change color across the Terrain Setup ->
      // live gameplay rendering handoff.
      River: 0x1a5abf, Cliff: 0xaaaaaa,
    }

    for (const plot of plots) {
      // ── Terrain plots: simple fill, no fences or buildings ──────────────────
      if (plot.type === 'terrain') {
        // If we preserved existing terrain meshes, skip re-creating them.
        if (preserveTerrainPlots) continue
        const baseColor = TERRAIN_FILL_COLORS[plot.assignedType] ?? TERRAIN_FILL_COLORS.unassigned
        const seed = this._polySeed(plot.blockCorners)
        const color = this._jitterColor(baseColor, seed)
        const mesh = this._makeFill(plot.blockCorners, color, GROUND_Y, { roughness: 0.6, emissiveIntensity: 0.2 })
        if (!mesh) continue
        if (this.showDebug) {
          this.originalMaterials.set(mesh, mesh.material)
          mesh.material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.7, 0.6), side: THREE.DoubleSide })
        }
        this.scene.add(mesh)
        this.plotMeshes.push(mesh)
        this._terrainPlots.push(plot)
        if (plot.id) this._terrainPlotMeshMap.set(plot.id, mesh)
        continue
      }

      const isSquare = plot.blockType === 'square'
      const seed = this._polySeed(plot.blockCorners)

      let mesh
      const color = this._jitterColor(plotBase(plot.districtId), seed)
      mesh = this._makeFill(plot.blockCorners, color, GROUND_Y, PLOT_FILL_MAT)

      if (isSquare) {
        const type = this._squareType(plot, STREET_PRIORITY)
        const fallback = STREET_COLORS.Stone
        // Connected squares share one texture direction (plotAngle) instead of each
        // independently defaulting to angle 0 — see _computeSquareClusterAngles.
        const angle = plotAngle.get(plot.id) ?? 0
        const mat = makeStreetMaterial(type, this._atlas, STREET_COLORS.get(type) || fallback, undefined, angle)
        mesh = this._makeFill(plot.blockCorners, 0, GROUND_Y, PLOT_FILL_MAT, mat)
      }

      if (!mesh) {
        console.error('[GroundRenderer] triangulation failed — data bug, plot must be fixed server-side', plot.id, JSON.stringify(plot.blockCorners))
        continue
      }
      mesh.userData = { districtId: plot.districtId }
      this._plotFills.push({ mesh, districtId: plot.districtId, districtColor: getColor(plot.districtId), seed })
      if (this.showDebug) {
        this.originalMaterials.set(mesh, mesh.material)
        mesh.material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.7, 0.6), side: THREE.DoubleSide })
      }
      this.scene.add(mesh)
      this.plotMeshes.push(mesh)
    }

    // Buildings are placed first (synchronous part of render() — mesh assembly is async
    // but footprints are ready immediately) so fences below can avoid their footprints.
    this.buildingRenderer.render(this.scene, plots.filter(p => p.type !== 'terrain'), districtData)

    // World-space wing polygons per plot, for every building that actually got built
    // there (townhouses AND free-standing houses — both are polygon-wing footprints).
    // Used below so a fence never coincides with a building: a back edge the building
    // fully spans loses its fence entirely; a side edge the building only partly runs
    // along keeps its fence for the uncovered remainder only.
    const wingPolysByPlot = new Map()
    for (const { entry, plot } of (this.buildingRenderer._lastPolyWingEntries ?? [])) {
      const wings = entry.spec?.footprint?.wings ?? []
      const c = Math.cos(entry.rotY ?? 0), sn = Math.sin(entry.rotY ?? 0)
      const toWorld = (vx, vz) => {
        const px = vx * PARA_SCALE, pz = vz * PARA_SCALE
        return { x: entry.x + px * c + pz * sn, y: entry.z - px * sn + pz * c }
      }
      const polys = wings.filter(w => w.vertices?.length).map(w => w.vertices.map(([vx, vz]) => toWorld(vx, vz)))
      if (polys.length) wingPolysByPlot.set(plot, polys)
    }
    // Same avoidance for custom/GLB buildings (non-parametric districts, or a
    // freestanding-slot townhouse plot) — these never had a wings polygon at all, so a
    // fence on that plot's edge previously ignored the building entirely (most visible
    // where a GLB building neighbours a parametric one: only the parametric side got
    // notched out, the GLB side's fence cut straight through the model).
    for (const { plot, poly } of (this.buildingRenderer._lastGlbFootprints ?? [])) {
      const existing = wingPolysByPlot.get(plot)
      if (existing) existing.push(poly); else wingPolysByPlot.set(plot, [poly])
    }

    // Fences: low wall along non-street-facing plot edges, for a seeded fraction of plots —
    // SAME locations/geometry as before (segmentMinusPolygons avoidance, flat vertical
    // strip), just split into 3 vertex buffers by material instead of one flat tan colour.
    // Segments are also kept on `this._fenceSegments` (world-space {a,b} pairs) so other
    // systems (e.g. WalkMode's collision) can treat them as solid without re-deriving them.
    const top = FENCE_BASE_Y + FENCE_HEIGHT
    const woodVerts = [], stoneVerts = [], brickVerts = []
    this._fenceSegments = []
    // Two adjacent plots both have the SAME shared boundary edge in their own
    // blockCorners (wound opposite ways) — without this, each could independently roll
    // "build a fence" with a DIFFERENT material there, drawing two overlapping fences.
    // Whichever plot is processed first claims the edge; its neighbour then skips it.
    const builtFenceEdgeKeys = new Set()

    // Posts, same material as their panel — wood posts are thin (matches a house's own
    // wood post thickness), stone/brick posts a bit thicker (matches the 60%-of-a-
    // building-stone-post sizing used elsewhere). Spacing matches a building's own bay
    // module (2 bays) so posts read as the same scale as the building next to them.
    const bayWorld = PARA_SCALE   // grid.bayWidth defaults to 1 — lib isn't loaded yet at this point
    const postSpacing = bayWorld * 2
    const woodPostHalfW = (0.12 * PARA_SCALE) / 2          // matches lib.grid.postThickness's default
    const stonePostHalfW = woodPostHalfW * 1.2              // "a bit thicker"
    const halfWByType = { wood: woodPostHalfW, stone: stonePostHalfW, brick: stonePostHalfW }
    const stoneWallHalfThick = stonePostHalfW * 0.6   // stone/brick: a proper two-sided wall, not a zero-thickness plane
    const woodBeamHalfThick = woodPostHalfW
    const woodBeamHeight = FENCE_HEIGHT * 0.3
    const woodBeamBaseY = FENCE_BASE_Y + FENCE_HEIGHT - woodBeamHeight * 0.5   // straddles the top edge

    // This plot's own building's ground-floor wall material, where known — the fence
    // matches it (wood/plaster -> wood fence; stone/granite -> stone fence; brick ->
    // brick fence). Falls back to a seeded wood/stone split for custom/GLB buildings or
    // plots with no building at all.
    const wallMatByPlot = new Map()
    for (const { entry, plot } of (this.buildingRenderer._lastPolyWingEntries ?? [])) {
      const m = entry.spec?.footprint?.wings?.[0]?.floors?.[0]?.material
      if (m) wallMatByPlot.set(plot, m)
    }

    // Only plots that actually received a building are eligible for fences.
    const plotsWithBuildings = new Set()
    for (const { plot } of (this.buildingRenderer._lastPolyWingEntries ?? [])) plotsWithBuildings.add(plot)
    for (const { plot }  of (this.buildingRenderer._lastGlbFootprints   ?? [])) plotsWithBuildings.add(plot)

    for (const plot of plots) {
      if (plot.type === 'terrain') continue   // no fences on open terrain
      if (plot.blockType === 'square') continue
      if (!plotsWithBuildings.has(plot)) continue   // no building → no fence
      const poly = plot.blockCorners
      if (!poly?.length) continue
      let fcx = 0, fcy = 0
      for (const v of poly) { fcx += v.x; fcy += v.y }
      const seed = posHash(fcx / poly.length, fcy / poly.length)
      if (this._rand(seed) >= FENCE_FRACTION) continue

      const wallMat = wallMatByPlot.get(plot)
      let fenceType
      if (wallMat === 'brick') fenceType = 'brick'
      else if (wallMat === 'stone' || wallMat === 'granite') fenceType = 'stone'
      else if (wallMat === 'wood' || wallMat === 'plaster') fenceType = 'wood'
      else fenceType = this._rand(seed + 5) < 0.6 ? 'wood' : 'stone'
      const targetVerts = fenceType === 'brick' ? brickVerts : fenceType === 'stone' ? stoneVerts : woodVerts
      const postHalfW = halfWByType[fenceType]

      const streetIdx = new Set((plot.streetEdges || []).map(e => e.index))
      const wingPolys = wingPolysByPlot.get(plot)
      for (let i = 0; i < poly.length; i++) {
        if (streetIdx.has(i)) continue
        const a = poly[i], b = poly[(i + 1) % poly.length]
        const ek = edgeKey(a, b)
        if (builtFenceEdgeKeys.has(ek)) continue   // already fenced from the neighbouring plot sharing this edge
        builtFenceEdgeKeys.add(ek)
        const segs = wingPolys?.length ? segmentMinusPolygons(a, b, wingPolys) : [[0, 1]]
        for (const [t0, t1] of segs) {
          const ax = a.x + (b.x - a.x) * t0, ay = a.y + (b.y - a.y) * t0
          const bx = a.x + (b.x - a.x) * t1, by = a.y + (b.y - a.y) * t1
          if (fenceType === 'wood') {
            // Thin single plane (unchanged) + a top rail/beam running its full length.
            targetVerts.push(
              ax, FENCE_BASE_Y, ay,  bx, FENCE_BASE_Y, by,  bx, top, by,
              ax, FENCE_BASE_Y, ay,  bx, top, by,           ax, top, ay,
            )
            pushWallBox(targetVerts, ax, ay, bx, by, woodBeamBaseY, woodBeamHeight, woodBeamHalfThick)
          } else {
            // Stone/brick: a proper two-sided wall with a flat top, not a zero-thickness plane.
            pushWallBox(targetVerts, ax, ay, bx, by, FENCE_BASE_Y, FENCE_HEIGHT, stoneWallHalfThick)
          }
          this._fenceSegments.push({ a: { x: ax, y: ay }, b: { x: bx, y: by } })

          // Posts at both ends of this run plus every postSpacing along it, so a run
          // interrupted by a building still gets an end-post at the cut.
          const segDx = bx - ax, segDy = by - ay, segLen = Math.hypot(segDx, segDy)
          if (segLen > 1e-4) {
            const pux = segDx / segLen, puy = segDy / segLen
            const nPosts = Math.max(1, Math.round(segLen / postSpacing))
            for (let p = 0; p <= nPosts; p++) {
              const t = (p / nPosts) * segLen
              pushPostQuads(targetVerts, ax + pux * t, ay + puy * t, FENCE_BASE_Y, FENCE_HEIGHT, postHalfW, pux, puy)
            }
          }
        }
      }
    }

    for (const m of this._fenceMeshes) this.scene.remove(m)
    this._fenceMeshes = []
    const buildFenceMesh = (verts, fallbackColor) => {
      if (!verts.length) return null
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
      geom.computeVertexNormals()
      const mat = new THREE.MeshStandardMaterial({ color: fallbackColor, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, emissive: fallbackColor, emissiveIntensity: 0.12 })
      const mesh = new THREE.Mesh(geom, mat)
      this.scene.add(mesh)
      this.plotMeshes.push(mesh)
      this._fenceMeshes.push(mesh)
      return mesh
    }
    const woodMesh  = buildFenceMesh(woodVerts, 0xc2a878)
    const stoneMesh = buildFenceMesh(stoneVerts, 0x999999)
    const brickMesh = buildFenceMesh(brickVerts, 0x8b4030)

    // Swap in real materials once the PartLibrary loads. Wood reuses the building's own
    // floor material directly. Stone/brick get their OWN dedicated instances instead of
    // reusing lib.stoneMaterial/lib.brickMaterial: those are tuned for MODEL-space units
    // inside a PARA_SCALE-scaled building group, but this fence geometry is built
    // directly in WORLD space with no such wrapping scale, so reusing them outright reads
    // ~1/PARA_SCALE (~18x) too large already — scaling density/tile-count up another 30x
    // on top of a from-scratch instance is what actually gets a visually small, fence-
    // appropriate stone/brick pattern instead of the building wall's own coarser one.
    this.buildingRenderer._ensureLib().then(lib => {
      if (this._lastRenderedPlots !== plots) return   // superseded by a newer renderPlots() call
      if (woodMesh && lib.floorWoodMaterial) woodMesh.material = lib.floorWoodMaterial
      const grimeHeight = (lib.grid?.floorHeight ?? 1.4) * PARA_SCALE
      if (stoneMesh) stoneMesh.material = makeWallMaterial({ stone: true, density: 6.0 * 30, grimeHeight, baseY: FENCE_BASE_Y })
      if (brickMesh) {
        const brickBase = new THREE.Color(0xbcbcb6).lerp(new THREE.Color().setHSL(0.58, 0.35, 0.88), 0.1)
        brickMesh.material = makeBrickMaterial({ scaleU: 4 * 30, scaleV: 8 * 30, palette: [[brickBase.getHex(), 1, 0.002]], grimeHeight, baseY: FENCE_BASE_Y })
      }
    })
  }

  // Builds every plot's yard fence: wood (posts every 2 bays + thin panels + a top rail,
  // all sharing the wood floor texture) or stone/brick (posts 60% of a building stone
  // post's width, thinner panels reusing the building's own wall material) — matching
  // whichever material that plot's OWN building used, so a fence reads as "this house's
  // fence" rather than a generic city-wide style. Height is either head height (matches
  // WalkMode's character head) or 60% of that (waist), per plot.
  // Geometry is batched per material into a handful of merged meshes (mergeGeometries),
  // not one mesh per post/panel — a city has hundreds of fenced plots.
  _buildFences(plots, lib) {
    for (const m of (this._fenceMeshes || [])) this.scene.remove(m)
    this._fenceMeshes = []
    this._fenceSegments = []

    const charHeight = PARA_SCALE                          // matches WalkMode.CHAR_HEIGHT (1 * PARA_SCALE)
    const headH  = charHeight * FENCE_HEAD_HEIGHT_FRAC      // matches WalkMode's PIVOT_Y height above ground
    const waistH = headH * FENCE_WAIST_HEIGHT_FRAC
    const bay = (lib?.grid?.bayWidth ?? 1) * PARA_SCALE
    const woodPostSpacing  = bay * FENCE_WOOD_POST_SPACING_BAYS
    const woodPostW        = (lib?.grid?.postThickness ?? 0.12) * PARA_SCALE
    const buildingStonePostW = (lib?.grid?.postThickness ?? 0.12) * 2 * PARA_SCALE   // matches addStoneColumn in ParametricBuilding.js
    const stonePostW       = buildingStonePostW * 0.6
    const stonePanelThick  = stonePostW * 0.5
    const stonePostSpacing = bay * FENCE_WOOD_POST_SPACING_BAYS

    const FALLBACK_WOOD  = new THREE.MeshStandardMaterial({ color: 0xc2a878, roughness: 0.9, metalness: 0 })
    const FALLBACK_STONE = new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.95, metalness: 0 })
    const woodMat        = lib?.floorWoodMaterial ?? FALLBACK_WOOD
    const stonePostMat    = lib?.stoneColumnMaterial ?? FALLBACK_STONE
    const stonePanelMat   = lib?.stoneMaterial ?? stonePostMat
    const brickPostMat    = lib?.brickColumnMaterial ?? stonePostMat
    const brickPanelMat   = lib?.brickMaterial ?? stonePanelMat

    // World-space wing polygons per plot — parametric AND custom/GLB buildings — used so
    // a fence routes AROUND a building's footprint (to its back) instead of just leaving
    // a gap, and so the fence can match that building's own wall material.
    const wingPolysByPlot = new Map()
    const wallMatByPlot = new Map()
    for (const { entry, plot } of (this.buildingRenderer._lastPolyWingEntries ?? [])) {
      const wings = entry.spec?.footprint?.wings ?? []
      const c = Math.cos(entry.rotY ?? 0), sn = Math.sin(entry.rotY ?? 0)
      const toWorld = (vx, vz) => {
        const px = vx * PARA_SCALE, pz = vz * PARA_SCALE
        return { x: entry.x + px * c + pz * sn, y: entry.z - px * sn + pz * c }
      }
      const polys = wings.filter(w => w.vertices?.length).map(w => w.vertices.map(([vx, vz]) => toWorld(vx, vz)))
      if (polys.length) wingPolysByPlot.set(plot, polys)
      const groundMat = wings[0]?.floors?.[0]?.material
      if (groundMat) wallMatByPlot.set(plot, groundMat)
    }
    for (const { plot, poly } of (this.buildingRenderer._lastGlbFootprints ?? [])) {
      const existing = wingPolysByPlot.get(plot)
      if (existing) existing.push(poly); else wingPolysByPlot.set(plot, [poly])
    }

    const woodGeoms = [], stonePostGeoms = [], stonePanelGeoms = [], brickPostGeoms = [], brickPanelGeoms = []
    const tmpObj = new THREE.Object3D()
    const pushBox = (list, cx, cy, baseY, height, angle, lenAlong, widthAcross) => {
      if (lenAlong <= 0.0005 || widthAcross <= 0.0005 || height <= 0.0005) return
      const g = new THREE.BoxGeometry(lenAlong, height, widthAcross)
      tmpObj.position.set(cx, baseY + height / 2, cy)
      tmpObj.rotation.set(0, angle, 0)
      tmpObj.scale.set(1, 1, 1)
      tmpObj.updateMatrix()
      g.applyMatrix4(tmpObj.matrix)
      list.push(g)
    }

    for (const plot of plots) {
      if (plot.blockType === 'square') continue
      const poly = plot.blockCorners
      if (!poly?.length) continue
      let fcx = 0, fcy = 0
      for (const v of poly) { fcx += v.x; fcy += v.y }
      fcx /= poly.length; fcy /= poly.length
      const seed = posHash(fcx, fcy)
      if (this._rand(seed) >= FENCE_FRACTION) continue

      // Match this plot's own building material where known; otherwise (a custom/GLB
      // building, or no building at all) fall back to a seeded wood/stone split.
      const wallMat = wallMatByPlot.get(plot)
      let fenceType
      if (wallMat === 'brick') fenceType = 'brick'
      else if (wallMat === 'stone' || wallMat === 'granite') fenceType = 'stone'
      else if (wallMat === 'wood' || wallMat === 'plaster') fenceType = 'wood'
      else fenceType = this._rand(seed + 5) < 0.6 ? 'wood' : 'stone'
      const isWood = fenceType === 'wood'

      const fenceH = this._rand(seed + 13) < 0.5 ? headH : waistH
      const postW = isWood ? woodPostW : stonePostW
      const postSpacing = isWood ? woodPostSpacing : stonePostSpacing
      const panelThick = isWood ? postW * 0.6 : stonePanelThick
      const postGeoms  = isWood ? woodGeoms : (fenceType === 'brick' ? brickPostGeoms  : stonePostGeoms)
      const panelGeoms = isWood ? woodGeoms : (fenceType === 'brick' ? brickPanelGeoms : stonePanelGeoms)

      const streetIdx = new Set((plot.streetEdges || []).map(e => e.index))
      const wingPolys = wingPolysByPlot.get(plot)
      for (let i = 0; i < poly.length; i++) {
        if (streetIdx.has(i)) continue
        const a = poly[i], b = poly[(i + 1) % poly.length]
        const path = wingPolys?.length ? routeFenceAroundBuildings(a, b, wingPolys) : [a, b]

        for (let k = 0; k < path.length - 1; k++) {
          const p0 = path[k], p1 = path[k + 1]
          const dx = p1.x - p0.x, dy = p1.y - p0.y
          const segLen = Math.hypot(dx, dy)
          if (segLen < 1e-4) continue
          const ux = dx / segLen, uy = dy / segLen
          const angle = Math.atan2(-dy, dx)   // local +X (BoxGeometry's length axis) -> world (dx,dy)

          const nPosts = Math.max(1, Math.round(segLen / postSpacing))
          const step = segLen / nPosts
          for (let p = 0; p <= nPosts; p++) {
            const t = p * step
            pushBox(postGeoms, p0.x + ux * t, p0.y + uy * t, FENCE_BASE_Y, fenceH, angle, postW, postW)
          }
          const panelH = fenceH * (isWood ? 0.85 : 0.9)
          for (let p = 0; p < nPosts; p++) {
            const t0 = p * step, t1 = t0 + step
            const panelLen = step - postW
            if (panelLen <= 0.001) continue
            const mt = (t0 + t1) / 2
            pushBox(panelGeoms, p0.x + ux * mt, p0.y + uy * mt, FENCE_BASE_Y, panelH, angle, panelLen, panelThick)
          }
          if (isWood) {
            const railH = postW * 0.5
            pushBox(woodGeoms, p0.x + ux * segLen / 2, p0.y + uy * segLen / 2, FENCE_BASE_Y + fenceH - railH, railH, angle, segLen, postW * 0.7)
          }
          this._fenceSegments.push({ a: { x: p0.x, y: p0.y }, b: { x: p1.x, y: p1.y } })
        }
      }
    }

    const addMerged = (geoms, mat) => {
      if (!geoms.length) return
      const merged = mergeGeometries(geoms, false)
      if (!merged) return
      const mesh = new THREE.Mesh(merged, mat)
      this.scene.add(mesh)
      this._fenceMeshes.push(mesh)
    }
    addMerged(woodGeoms, woodMat)
    addMerged(stonePostGeoms, stonePostMat)
    addMerged(stonePanelGeoms, stonePanelMat)
    addMerged(brickPostGeoms, brickPostMat)
    addMerged(brickPanelGeoms, brickPanelMat)
  }

  clearPlotLayer({ preserveTerrainPlots = false } = {}) {
    for (const m of this.plotMeshes) {
      // When preserving terrain plots, skip removing their meshes from the scene.
      if (preserveTerrainPlots && this._terrainPlots.some(p => this._terrainPlotMeshMap.get(p.id) === m)) continue
      this.scene.remove(m)
    }
    this.plotMeshes    = preserveTerrainPlots ? [...this.plotMeshes.filter(m => this._terrainPlots.some(p => this._terrainPlotMeshMap.get(p.id) === m))] : []
    this._plotFills    = []
    this._squareFills  = []
    this._fenceSegments = []
    for (const m of this._fenceMeshes) this.scene.remove(m)
    this._fenceMeshes = []
    this._districtHighlight = []
    this.buildingRenderer.clear(this.scene)
    if (!preserveTerrainPlots) {
      this.clearTerrainPlotHighlight()
      this._terrainPlotMeshMap.clear()
      this._terrainPlots = []
    }
  }

  highlightTerrainPlot(plotId) {
    this.clearTerrainPlotHighlight()
    const plot = this._terrainPlots.find(p => p.id === plotId)
    if (!plot?.blockCorners?.length) return
    const poly = plot.blockCorners
    const verts = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      verts.push(a.x, GROUND_Y, a.y, b.x, GROUND_Y, b.y)
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    this._terrainPlotHighlightMesh = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xffff66 }))
    this.scene.add(this._terrainPlotHighlightMesh)
    const mesh = this._terrainPlotMeshMap.get(plotId)
    if (mesh) {
      this._terrainPlotHighlightMeshRef = mesh
      this._terrainPlotHighlightOrigColor = mesh.material.color.getHex()
      this._terrainPlotHighlightOrigEmissive = mesh.material.emissive?.getHex()
      const white = new THREE.Color(0xffffff)
      mesh.material.color.lerp(white, 0.4)
      if (mesh.material.emissive) mesh.material.emissive.lerp(white, 0.4)
      mesh.material.emissiveIntensity = 0.85
    }
  }

  clearTerrainPlotHighlight() {
    if (this._terrainPlotHighlightMesh) {
      this.scene.remove(this._terrainPlotHighlightMesh)
      this._terrainPlotHighlightMesh.geometry?.dispose()
      this._terrainPlotHighlightMesh = null
    }
    if (this._terrainPlotHighlightMeshRef) {
      const m = this._terrainPlotHighlightMeshRef.material
      if (this._terrainPlotHighlightOrigColor !== undefined) m.color.setHex(this._terrainPlotHighlightOrigColor)
      if (this._terrainPlotHighlightOrigEmissive !== undefined && m.emissive) m.emissive.setHex(this._terrainPlotHighlightOrigEmissive)
      this._terrainPlotHighlightMeshRef = null
      this._terrainPlotHighlightOrigColor = undefined
      this._terrainPlotHighlightOrigEmissive = undefined
    }
  }

  getTerrainPlotAtWorldPos(worldX, worldY) {
    for (const plot of this._terrainPlots) {
      if (plot.blockCorners?.length && pointInPolygon(worldX, worldY, plot.blockCorners)) return plot
    }
    return null
  }

  // Top-down mode reinstates the floor-scroll clip plane (user-confirmed 2026-07-13),
  // which only behaves correctly against a flat world — see TerrainRenderer's matching
  // method. Only terrain-type fills (_terrainPlotMeshMap) ever carry real per-vertex
  // relief; block/plot/street/square fills are already flat (GROUND_Y = 0), so this is
  // a no-op for them.
  setTerrainFlattened(flat) {
    for (const mesh of this._terrainPlotMeshMap.values()) {
      const geo = mesh?.geometry
      const realY = geo?.userData?.realY
      if (!realY) continue
      const pos = geo.attributes.position
      for (let i = 0; i < realY.length; i++) pos.array[i * 3 + 1] = flat ? 0 : realY[i]
      pos.needsUpdate = true
      geo.computeVertexNormals()
    }
  }

  // Switch plot bases between per-district colours (during setup) and uniform grassy brown.
  setFinishedGround(finished) {
    this.finishedGround = !!finished
    this.clearDistrictHighlight()
    for (const f of this._plotFills) {
      const c = this._jitterColor(this.finishedGround ? GRASSY_BROWN : f.districtColor, f.seed ?? 0)
      f.mesh.material.color.setHex(c)
      f.mesh.material.emissive?.setHex(c)
    }
  }


  // ── Debug draw ────────────────────────────────────────────────────────────────

  drawStreetSeeds(streetGraph) {
    this._clearDebugGroup(this._streetSeedMeshes)
    const junctions = streetGraph?.junctions
    if (!junctions?.length) return
    const geo = new THREE.SphereGeometry(0.018, 6, 6)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffff00 })
    for (const j of junctions) {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(j.x, GROUND_Y + 0.100, j.y)
      m.visible = this.showDebug && this._streetSeedsVisible
      m.userData = { kind: 'streetSeed', id: j.id, type: j.type, districtId: j.districtId, connections: j.connections?.length ?? 0, x: j.x, y: j.y }
      this.scene.add(m)
      this.debugObjects.push(m)
      this._streetSeedMeshes.push(m)
    }
  }

  drawBlockCenters(blocks) {
    this._clearDebugGroup(this._blockDebugMeshes)
    this._clearDebugGroup(this._blockSeedMeshes)

    const blockGeo = new THREE.SphereGeometry(0.0375, 6, 6)
    const blockMat = new THREE.MeshBasicMaterial({ color: 0xff0000 })
    const seedGeo  = new THREE.SphereGeometry(0.018, 5, 5)
    const seedMat  = new THREE.MeshBasicMaterial({ color: 0x00ffff })

    for (const b of (blocks || [])) {
      const poly = b.blockCorners
      if (!poly?.length) continue
      const c = { x: poly.reduce((s, v) => s + v.x, 0) / poly.length, y: poly.reduce((s, v) => s + v.y, 0) / poly.length }
      const mesh = new THREE.Mesh(blockGeo, blockMat)
      mesh.position.set(c.x, GROUND_Y + 0.100, c.y)
      mesh.userData = { kind: 'block', id: b.id, blockType: b.blockType, districtId: b.districtId }
      mesh.visible = this.showDebug && this._blockCentersVisible
      this.scene.add(mesh)
      this.debugObjects.push(mesh)
      this._blockDebugMeshes.push(mesh)

      for (const s of (b.seeds || [])) {
        const sm = new THREE.Mesh(seedGeo, seedMat)
        sm.position.set(s.x, GROUND_Y + 0.100, s.y)
        sm.visible = this.showDebug && this._blockCentersVisible
        this.scene.add(sm)
        this.debugObjects.push(sm)
        this._blockSeedMeshes.push(sm)
      }
    }
  }

  // City-side counterpart to TerrainRenderer.drawSurfaceCorners (user-requested
  // 2026-07-15, "all surface corners, incl streets, plots, should have surface corners
  // in debug mode") — junctions/gutters (blue), block corners (orange), plot corners
  // (green), deduped by point id like the terrain version (a shared corner between a
  // block and its own plots would otherwise get one marker per Surface).
  drawSurfaceCorners(streetGraph, blocks, plots) {
    this._clearDebugGroup(this._surfaceCornerMeshes)
    const geo = new THREE.OctahedronGeometry(0.04, 0)
    const junctionMat = new THREE.MeshBasicMaterial({ color: 0x3399ff })
    const blockMat = new THREE.MeshBasicMaterial({ color: 0xffa500 })
    const plotMat = new THREE.MeshBasicMaterial({ color: 0x33ff33 })
    const seen = new Set()
    const addMarker = (id, x, y, z, mat, sourceKind) => {
      if (id == null || seen.has(id) || !isFinite(x) || !isFinite(y)) return
      seen.add(id)
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, (z ?? GROUND_Y) + 0.12, y)
      m.renderOrder = 999
      m.userData = { kind: 'surfaceCorner', id, sourceKind, x, y, z: z ?? GROUND_Y, realY: (z ?? GROUND_Y) + 0.12, flatY: 0.12 }
      m.visible = this.showDebug && this._surfaceCornersVisible
      this.scene.add(m)
      this.debugObjects.push(m)
      this._surfaceCornerMeshes.push(m)
    }
    for (const j of (streetGraph?.junctions || [])) {
      addMarker(j.id, j.x, j.y, j.z, junctionMat, 'junction')
      for (const c of (j.connections || [])) {
        if (c.gutterLeft) addMarker(`gL:${j.id}:${c.toId}`, c.gutterLeft.x, c.gutterLeft.y, c.gutterLeft.z, junctionMat, 'gutter')
        if (c.gutterRight) addMarker(`gR:${j.id}:${c.toId}`, c.gutterRight.x, c.gutterRight.y, c.gutterRight.z, junctionMat, 'gutter')
      }
    }
    const addPoly = (ids, poly, mat, sourceKind) => {
      if (!ids?.length || !poly?.length || ids.length !== poly.length) return
      for (let i = 0; i < ids.length; i++) {
        const v = poly[i]
        if (v) addMarker(ids[i], v.x, v.y, v.z, mat, sourceKind)
      }
    }
    for (const b of (blocks || [])) addPoly(b.pointIds, b.blockCorners, blockMat, 'block')
    for (const p of (plots || [])) addPoly(p.pointIds, p.blockCorners, plotMat, 'plot')
  }

  drawPlotCenters(plots) {
    this._clearDebugGroup(this._plotDebugMeshes)
    const geo = new THREE.SphereGeometry(0.022, 6, 6)
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ff88 })
    for (const p of (plots || [])) {
      const poly = p.blockCorners
      if (!poly?.length) continue
      const cx = poly.reduce((s, v) => s + v.x, 0) / poly.length
      const cy = poly.reduce((s, v) => s + v.y, 0) / poly.length
      const m = new THREE.Mesh(geo, mat)
      m.position.set(cx, GROUND_Y + 0.100, cy)
      m.visible = this.showDebug && this._plotCentersVisible
      m.userData = { kind: 'plot', id: p.id, blockId: p.blockId, districtId: p.districtId, blockType: p.blockType ?? 'normal', streetEdges: p.streetEdges?.length ?? 0 }
      this.scene.add(m)
      this.debugObjects.push(m)
      this._plotDebugMeshes.push(m)
    }
  }

  getStreetSeedAtWorldPos(worldX, worldY, threshold = 0.1) {
    const rSq = threshold * threshold
    for (const m of this._streetSeedMeshes) {
      if (!m.visible) continue
      const dx = worldX - m.position.x, dy = worldY - m.position.z
      if (dx * dx + dy * dy < rSq) return m.userData
    }
    return null
  }

  getBlockCenterAtWorldPos(worldX, worldY, threshold = 0.2) {
    const rSq = threshold * threshold
    for (const mesh of this._blockDebugMeshes) {
      if (!mesh.visible) continue
      const dx = worldX - mesh.position.x, dy = worldY - mesh.position.z
      if (dx * dx + dy * dy < rSq) return mesh.userData
    }
    return null
  }

  getPlotCenterAtWorldPos(worldX, worldY, threshold = 0.2) {
    const rSq = threshold * threshold
    for (const mesh of this._plotDebugMeshes) {
      if (!mesh.visible) continue
      const dx = worldX - mesh.position.x, dy = worldY - mesh.position.z
      if (dx * dx + dy * dy < rSq) return mesh.userData
    }
    return null
  }


  // ── Private helpers ───────────────────────────────────────────────────────────

  _rand(seed) {
    let s = (seed * 2654435761) >>> 0
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 0x100000000
  }

  _polySeed(poly) {
    if (!poly?.length) return 0
    let cx = 0, cy = 0
    for (const v of poly) { cx += v.x; cy += v.y }
    return posHash(cx / poly.length, cy / poly.length)
  }

  _jitterColor(hex, seed) {
    const ch = (shift, i) => {
      const v = (hex >> shift) & 255
      const f = 0.95 + this._rand(seed * 31 + i) * 0.10
      return Math.max(0, Math.min(255, Math.round(v * f)))
    }
    return (ch(16, 1) << 16) | (ch(8, 2) << 8) | ch(0, 3)
  }

  // Returns the dominant street TYPE for a city-square plot (Stone/Brick/Mud).
  // Primary source: plot.streetEdges (edges touching street gutters).
  // Fallback: scan the street graph for connections in the same district —
  // needed when streetEdges is empty (rare) or yields only unrecognised types.
  _squareType(plot, priority) {
    const KNOWN = new Set(['Stone', 'Brick', 'Mud'])
    const dominant = (counts) => {
      let best = null, bestN = -1
      for (const [type, n] of counts) {
        if (!KNOWN.has(type)) continue
        if (n > bestN || (n === bestN && (priority[type] ?? -1) > (priority[best] ?? -1))) {
          best = type; bestN = n
        }
      }
      return best
    }

    // Primary: plot.streetEdges carries the type of each gutter-facing edge.
    const edges = plot.streetEdges || []
    if (edges.length) {
      const counts = new Map()
      for (const e of edges) counts.set(e.type, (counts.get(e.type) || 0) + 1)
      const best = dominant(counts)
      if (best) return best
    }

    // Fallback: use connection types of same-district junctions in the street graph.
    // Matches BOTH interior junctions (districtId) and boundary junctions (left/right) —
    // a big plaza merged from several small squares (_mergeSquareClusters) commonly sits
    // right at a multi-way intersection where several district boundaries meet, so its
    // neighbouring junctions are often boundary ones; matching only `districtId` missed
    // those entirely and fell through to a flat, untextured fill.
    if (this._streetGraph) {
      const counts = new Map()
      for (const j of this._streetGraph.junctions) {
        const matches = j.districtId === plot.districtId || j.left === plot.districtId || j.right === plot.districtId
        if (!matches) continue
        for (const conn of (j.connections || [])) {
          if (KNOWN.has(conn.type))
            counts.set(conn.type, (counts.get(conn.type) || 0) + 1)
        }
      }
      const best = dominant(counts)
      if (best) return best
    }

    // Last resort: a paved square should never render as a flat untextured fill — Stone
    // is a reasonable default plaza paving and is always proceduraly textured (doesn't
    // even need the atlas to have loaded).
    return 'Stone'
  }

  // Build a triangulated polygon mesh. `overrideMat` skips colour-based material
  // creation — used when the caller has already built a textured material (e.g. squares).
  // `Y` is the flat fallback height (every caller today: blocks/plots/streets/squares
  // have no per-point z data yet). A poly whose vertices carry a real `.z` (terrain
  // plots, once resolved through pointsById — see setTerrainWaterData/TODO.md
  // "Groundplane Z-height implementation") gets real relief per vertex instead —
  // additive, no existing flat caller is affected.
  _makeFill(poly, colorHex, Y, matOpts = PLOT_FILL_MAT, overrideMat = null) {
    if (!poly || poly.length < 3) return null
    const contour = poly.map(v => new THREE.Vector2(v.x, v.y))
    let triangles
    try { triangles = THREE.ShapeUtils.triangulateShape(contour, []) } catch { return null }
    if (!triangles?.length) return null
    const verts = []
    for (const v of poly) verts.push(v.x, v.z ?? (this.getZHeight?.(v.x, v.y) ?? Y), v.y)
    const indices = []
    for (const [a, b, c] of triangles) indices.push(a, b, c)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1))
    geometry.computeVertexNormals()
    // Real per-vertex height, kept for top-down flatten/unflatten (see
    // setTerrainFlattened) — a no-op for every flat (block/plot/street) caller since Y
    // already equals the flatten target (GROUND_Y = 0).
    geometry.userData.realY = verts.filter((_, i) => i % 3 === 1)
    const mat = overrideMat ?? new THREE.MeshStandardMaterial({
      color: colorHex, roughness: matOpts.roughness, metalness: 0,
      emissive: colorHex, emissiveIntensity: matOpts.emissiveIntensity, side: THREE.DoubleSide,
    })
    return new THREE.Mesh(geometry, mat)
  }
}
