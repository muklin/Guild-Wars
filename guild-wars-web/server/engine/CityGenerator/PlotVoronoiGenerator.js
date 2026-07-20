import { computeVoronoiCellsHalfPlane, polygonCrossesSegment, clipPolygonToSide, polygonBBox, clipPolygonByConvex } from '../voronoi/VoronoiUtils.js'
import { STREET_HALF_WIDTH } from './StreetVoronoiGenerator.js'
import { findStreetFacingEdges } from './CityBlockGenerator.js'
import { getDistrictParams } from './StreetVoronoiGenerator.js'
import { polysOverlap } from './buildings/LandmarkPlacer.js'
import GroundPointRegistry from './GroundPointRegistry.js'
import DCEL, { dedupeConsecutiveIds } from './DCEL.js'
import { idwZ } from './DistrictZHeight.js'

// Mark every block below its district's square_threshhold as a City square. Run as a
// pre-pass (before Landmark placement) so squares are known when Landmarks are placed
// on their clusters — ADR-0005.
export function markSquareBlocks(blocks, districts) {
  const districtById = new Map((districts || []).map(d => [d.id, d]))
  for (const block of blocks || []) {
    const params = getDistrictParams(districtById.get(block.districtId))
    if (block.area < params.square_threshhold) block.blockType = 'square'
  }
}

export default class PlotVoronoiGenerator {
  // Subdivides non-square blocks into plots using boundary-seeded Voronoi.
  // Squares are expected to be pre-marked by markSquareBlocks. Mutates each block to add
  // `blockType` and `seeds`. Plots overlapping a Landmark footprint are dropped.
  // registry (optional, ADR-0020 Stage C): the SHARED GroundPointRegistry, threaded
  // into _mergeSmallPlots for subdivided plots' newly-cut corners. A plot that keeps
  // its block's own unchanged corners (square/single/no-subdivision cases) reuses
  // block.pointIds directly — already registry-backed by CityBlockGenerator when the
  // SAME registry was passed there, so no re-minting needed for those.
  // Returns { plots }.
  generate(blocks, districts, junctions, roadEdges, landmarkFootprints = [], registry = null) {
    const districtById = new Map((districts || []).map(d => [d.id, d]))
    const plots = []
    let plotId = 0
    // Clear ONCE here, not inside _mergeSmallPlots — that method runs once PER BLOCK
    // in the loop below, and clearing there would wipe out an earlier block's
    // already-minted 'plot' points on every subsequent block's call within this same
    // generate() invocation.
    if (registry) registry.clearKind('plot')

    // Road centrelines (junction→junction) used to keep plots from spanning a road.
    const jById = new Map((junctions || []).map(j => [j.id, j]))
    const roadLines = []
    const seenRoad = new Set()
    for (const j of junctions || []) {
      for (const conn of j.connections) {
        const k = j.id < conn.toId ? `${j.id}_${conn.toId}` : `${conn.toId}_${j.id}`
        if (seenRoad.has(k)) continue
        seenRoad.add(k)
        const j2 = jById.get(conn.toId)
        if (j2) roadLines.push([{ x: j.x, y: j.y }, { x: j2.x, y: j2.y }])
      }
    }

    const MAX_BLOCK_VERTS = 48

    for (const block of blocks) {
      const { area, districtId } = block
      // Stage D (ADR-0020): regeneratePlots() on load hands this whatever came straight
      // out of the save's cityData.blocks — once GameStateManager.serialize() stops
      // persisting blockCorners, this block only has pointIds to work with. Resolve
      // through the registry first, falling back to blockCorners for an old save that
      // still carries it (or a registry-less throwaway/test call).
      const blockCorners = block.blockCorners ?? (registry && block.pointIds
        ? registry.resolve(block.pointIds).map(p => ({ x: p.x, y: p.y, z: p.z }))
        : block.blockCorners)

      // Squares are pre-marked (markSquareBlocks) before Landmark placement; emit the
      // paved square plot and move on.
      if (block.blockType === 'square') {
        block.seeds = []
        plots.push({ id: plotId++, blockId: block.id, districtId, blockCorners, pointIds: block.pointIds ?? null, streetEdges: block.streetEdges, blockType: 'square', type: 'block', assignedType: districtById.get(districtId)?.assignedType ?? null })
        continue
      }

      // CityBlockGenerator's B3 quarantine already marked this block 'single' because
      // it's self-intersecting (see its own comment: "so the plotter never subdivides
      // garbage geometry") — but nothing here actually checked for that flag, so a
      // self-intersecting block's bad blockCorners fell straight into Voronoi
      // subdivision anyway, producing a self-intersecting PLOT with no guard at all
      // (confirmed live: an extra black sliver appearing specifically during District
      // conversion, on top of whatever the block's own boundary already showed in
      // Terrain mode — a sharp reflex notch from a Cliff's pullback survives the
      // block-level check but corrupts the finer plot-level subdivision inside it).
      // Respect the upstream verdict here, same whole-block-plot fallback as every
      // other "can't subdivide safely" case below.
      if (block.blockType === 'single') {
        block.seeds = []
        plots.push({ id: plotId++, blockId: block.id, districtId, blockCorners, pointIds: block.pointIds ?? null, streetEdges: block.streetEdges, type: 'block', assignedType: districtById.get(districtId)?.assignedType ?? null })
        continue
      }

      // Blocks too complex to subdivide safely become a single whole-block plot.
      if (blockCorners.length > MAX_BLOCK_VERTS) {
        block.blockType = 'single'
        block.seeds = []
        plots.push({ id: plotId++, blockId: block.id, districtId, blockCorners, pointIds: block.pointIds ?? null, streetEdges: block.streetEdges, type: 'block', assignedType: districtById.get(districtId)?.assignedType ?? null })
        continue
      }

      const district = districtById.get(districtId)
      const params   = getDistrictParams(district)

      const minPlotSize = params.minPlotSize ?? 0
      // A block too small to hold even one minimum-size plot stays a single whole-block plot.
      if (minPlotSize > 0 && area < minPlotSize) {
        block.blockType = 'single'
        block.seeds = []
        plots.push({ id: plotId++, blockId: block.id, districtId, blockCorners, pointIds: block.pointIds ?? null, streetEdges: block.streetEdges, type: 'block', assignedType: district?.assignedType ?? null })
        continue
      }

      const seeds = this._generateBoundarySeeds(blockCorners, params.plotSpacing, junctions)

      if (seeds.length === 0) {
        block.blockType = 'single'
        block.seeds = []
        plots.push({ id: plotId++, blockId: block.id, districtId, blockCorners, pointIds: block.pointIds ?? null, streetEdges: block.streetEdges, type: 'block', assignedType: district?.assignedType ?? null })
        continue
      }

      // Convex bbox → each Voronoi cell is convex; no S-H self-intersection from
      // non-convex initial clip polygons.
      const roughCells = computeVoronoiCellsHalfPlane(seeds, polygonBBox(blockCorners))

      const plotCells = roughCells.reduce((acc, cell) => {
        // clipPolygonByConvex: clip the (possibly concave) block by each half-plane of
        // the CONVEX Voronoi cell. Unlike Sutherland–Hodgman, disconnected results
        // produce separate pieces rather than bridging across concave notches (which was
        // the root cause of plots leaking into the street on concave blocks).
        const pieces = clipPolygonByConvex(blockCorners, cell.polygon)
        if (!pieces.length) {
          console.error('[manifold-diag] plot clipped to zero — seed', cell.seedPoint, 'block', block.id,
            'blockArea', area.toFixed(4), 'blockCorners', JSON.stringify(blockCorners.map(v => [+v.x.toFixed(3), +v.y.toFixed(3)])),
            'cellPoly', JSON.stringify(cell.polygon.map(v => [+v.x.toFixed(3), +v.y.toFixed(3)])),
            'totalSeeds', seeds.length)
          return acc
        }
        // Keep EVERY piece, not just the largest. A concave block (the notch on the inner
        // side of a winding street, or a dead-end U) splits a cell into a main region plus
        // slivers; discarding the slivers left triangular gaps in the plot tiling — the
        // "missing corners". All pieces are clipped to the block, so none leak into the
        // street, and Voronoi cells are mutually disjoint, so pieces never overlap.
        // _mergeSmallPlots then absorbs slivers into neighbours, filling the gaps without
        // spawning tiny plots.
        for (let poly of pieces) {
          // A thin block finger can still leave a plot spiking across a road. Clip the
          // piece to its seed's side of every road centreline it crosses.
          for (const r of roadLines) {
            if (polygonCrossesSegment(poly, r[0], r[1])) {
              const clipped = clipPolygonToSide(poly, r[0], r[1], cell.seedPoint)
              if (clipped) poly = clipped
            }
          }
          acc.push({ ...cell, polygon: poly })
        }
        return acc
      }, [])

      if (plotCells.length === 0) {
        block.blockType = 'single'
        block.seeds = seeds
        plots.push({ id: plotId++, blockId: block.id, districtId, blockCorners, pointIds: block.pointIds ?? null, streetEdges: block.streetEdges, type: 'block', assignedType: district?.assignedType ?? null })
      } else {
        block.blockType = 'subdivided'
        block.seeds = seeds
        const mergedCells = this._mergeSmallPlots(plotCells, minPlotSize, registry)
        for (const cell of mergedCells) {
          plots.push({
            id: plotId++,
            blockId: block.id,
            districtId,
            blockCorners: cell.polygon,
            pointIds: cell.pointIds ?? null,
            // _clipPolygonToSide may clip cell polygons to road CENTRELINES (not
            // gutters), producing edges that sit STREET_HALF_WIDTH away from any
            // gutter roadEdge — outside findStreetFacingEdges' normal tolerance.
            // Adding the centreline segments lets those edges be detected too.
            streetEdges: findStreetFacingEdges(cell.polygon, [
              ...roadEdges,
              ...roadLines.map(([a, b]) => ({ roadId: 'centreline', type: 'Mud', ax: a.x, ay: a.y, bx: b.x, by: b.y })),
            ]),
            type: 'block',
            assignedType: district?.assignedType ?? null,
          })
        }
      }
    }

    // Pave the ground under Landmarks: any non-square plot overlapping a Landmark
    // footprint is CONVERTED to a square (paved plaza) rather than dropped (ADR-0005).
    // A Landmark's bodyFootprint is offset behind the model's front door and overhangs
    // its plaza onto adjacent subdivided blocks; dropping those plots left bare world-
    // colour ground, so instead we pave them — a 'square' plot renders as stone, grows no
    // building (BuildingRenderer skips it), and is skipped by markTownhouseBlocks.
    let paved = 0
    if (landmarkFootprints.length) {
      for (const p of plots) {
        if (p.blockType === 'square') continue
        if (landmarkFootprints.some(f => polysOverlap(p.blockCorners, f.polygon))) {
          p.blockType = 'square'
          paved++
        }
      }
    }

    const sq = blocks.filter(b => b.blockType === 'square').length
    const si = blocks.filter(b => b.blockType === 'single').length
    const sd = blocks.filter(b => b.blockType === 'subdivided').length
    console.log(`PlotVoronoiGenerator: ${blocks.length} blocks (${sq} square, ${si} single, ${sd} subdivided), ${plots.length} plots (${paved} paved under Landmarks)`)

    // District z-height Tier 2 (plan "typed-gliding-leaf"): a square/single/unsubdivided
    // plot's blockCorners is the same array CityBlockGenerator already IDW-assigned z to,
    // so nothing to do there. A SUBDIVIDED plot's blockCorners is a fresh Voronoi-clipped
    // polygon (cell.polygon) — vertices kept from the original block boundary already
    // carry z, but new intersection points minted by the clip do not. Fill those in the
    // same way CityBlockGenerator did for block corners: IDW from the nearby, already-
    // z-aware Tier-1 junctions/gutters belonging to the plot's district. Those new
    // intersection points were already minted into the registry (via mintDeduped in
    // _mergeSmallPlots, at z ?? 0) before this z was known, so — same fix as
    // CityBlockGenerator's Tier 2 — the computed z is written back to the registry
    // point (plot.pointIds) too, not just the blockCorners array.
    {
      const controlPointsByDistrict = new Map()
      const controlPointsFor = (districtId) => {
        if (controlPointsByDistrict.has(districtId)) return controlPointsByDistrict.get(districtId)
        const pts = []
        for (const j of (junctions || [])) {
          if (j.z == null) continue
          if (j.districtId !== districtId && j.left !== districtId && j.right !== districtId) continue
          pts.push({ x: j.x, y: j.y, z: j.z })
          for (const c of (j.connections || [])) {
            if (c.gutterLeft?.z != null) pts.push({ x: c.gutterLeft.x, y: c.gutterLeft.y, z: c.gutterLeft.z })
            if (c.gutterRight?.z != null) pts.push({ x: c.gutterRight.x, y: c.gutterRight.y, z: c.gutterRight.z })
          }
        }
        controlPointsByDistrict.set(districtId, pts)
        return pts
      }
      const _loggedPlotDistricts = new Set()   // TEMP diagnostic — remove once root cause confirmed
      let _missingCount = 0, _filledCount = 0, _alreadyCount = 0
      for (const plot of plots) {
        const controls = controlPointsFor(plot.districtId)
        if (!_loggedPlotDistricts.has(plot.districtId)) {
          _loggedPlotDistricts.add(plot.districtId)
          console.log(`[zheight-diag] plot Tier3 district=${plot.districtId} controls=${controls.length} sampleZ=${controls.slice(0, 3).map(c => c.z.toFixed(2)).join(',')}`)
        }
        for (let i = 0; i < plot.blockCorners.length; i++) {
          const v = plot.blockCorners[i]
          if (v.z == null) {
            const z = idwZ(v.x, v.y, controls)
            if (z != null) { v.z = z; _filledCount++ } else { _missingCount++ }
          } else {
            _alreadyCount++
          }
          // Same registry/array desync as CityBlockGenerator's Tier-2 pass: a subdivided
          // plot's intersection corners were minted into the registry (via mintDeduped in
          // _mergeSmallPlots, at z ?? 0) before this z was ever computed — keep the
          // registry-backed copy (plot.pointIds) in sync or any consumer resolving via
          // pointIds sees the stale mint-time value forever.
          if (v.z != null && registry && plot.pointIds?.[i] != null) {
            const rp = registry.get(plot.pointIds[i])
            if (rp) rp.z = v.z
          }
        }
      }
      console.log(`[zheight-diag] plot Tier3 corners: already-had-z=${_alreadyCount} filled=${_filledCount} STILL-NULL=${_missingCount}`)
    }

    return { plots }
  }

  // Walk the block boundary placing a seed on every corner (so corners become
  // squareish plots fronting both edges) plus seeds at plotSpacing intervals along
  // each edge. Interval seeds keep 2*plotSpacing clearance from real junctions;
  // corner seeds and degree-2 bends do not (bends aren't intersections).
  _generateBoundarySeeds(blockCorners, plotSpacing, junctions) {
    const n = blockCorners.length
    if (n < 3 || plotSpacing <= 0) return []

    const arcLen = new Array(n + 1)
    arcLen[0] = 0
    for (let i = 0; i < n; i++) {
      const a = blockCorners[i], b = blockCorners[(i + 1) % n]
      arcLen[i + 1] = arcLen[i] + Math.hypot(b.x - a.x, b.y - a.y)
    }
    const totalLen = arcLen[n]
    if (totalLen < 1e-10) return []

    // Only real junctions (degree ≠ 2) create a seed dead-zone; 2-way bends don't.
    const realJunctions = junctions.filter(j => (j.connections?.length ?? 0) !== 2)
    const jThreshSq = (STREET_HALF_WIDTH * 3) ** 2
    const rawJuncLens = []
    for (let i = 0; i < n; i++) {
      const v = blockCorners[i]
      if (realJunctions.some(j => (v.x - j.x) ** 2 + (v.y - j.y) ** 2 < jThreshSq)) {
        rawJuncLens.push(arcLen[i])
      }
    }

    const mergeGap = plotSpacing
    const juncLens = []
    for (const l of rawJuncLens) {
      if (juncLens.length > 0 && l - juncLens[juncLens.length - 1] < mergeGap) continue
      juncLens.push(l)
    }
    if (juncLens.length === 0) juncLens.push(0)

    const exclusion = 2 * plotSpacing
    // Arc distance (around the loop) from L to the nearest real-junction dead-zone centre.
    const inDeadZone = (L) => juncLens.some(jl => {
      let d = Math.abs(L - jl) % totalLen
      d = Math.min(d, totalLen - d)
      return d < exclusion
    })

    // Place a seed on every block corner so each corner becomes one squareish plot
    // fronting both edges, instead of being split between the two edges' seeds.
    // Corners bypass the junction dead-zone (owning the corner is the goal);
    // mid-edge interval seeds still honour it to avoid crowding real junctions.
    const candidates = []
    for (let i = 0; i < n; i++) {
      candidates.push({ L: arcLen[i], corner: true })
      const segLen = arcLen[i + 1] - arcLen[i]
      for (let s = plotSpacing; s < segLen - 1e-9; s += plotSpacing) {
        const L = arcLen[i] + s
        if (!inDeadZone(L)) candidates.push({ L, corner: false })
      }
    }
    candidates.sort((a, b) => a.L - b.L)
    // Merge-dedup: drop a seed within mergeGap of the previous, but never drop a corner.
    const seedLens = []
    let prev = -Infinity
    for (const c of candidates) {
      if (!c.corner && c.L - prev < mergeGap) continue
      seedLens.push(c.L); prev = c.L
    }

    // No inset: seeds sit exactly on the block boundary (the gutter). clipToPolygon
    // clips every cell to the block regardless of seed position, so cells can't leak
    // into the street; and a seed on the gutter is still on the block's side of the
    // road centreline, so the road-centreline clip keeps the correct half. Insetting
    // was the old guard against cell leak — now redundant (clipToPolygon does it), and
    // it punched seeds on thin blocks clean through to the opposite gutter, out into the
    // far street, so it's dropped entirely.
    return seedLens.map(l => {
      for (let i = 0; i < n; i++) {
        if (arcLen[i + 1] >= l - 1e-10) {
          const seg = arcLen[i + 1] - arcLen[i]
          const frac = seg < 1e-10 ? 0 : (l - arcLen[i]) / seg
          const a = blockCorners[i], b = blockCorners[(i + 1) % n]
          return { x: a.x + frac * (b.x - a.x), y: a.y + frac * (b.y - a.y) }
        }
      }
      return { x: blockCorners[0].x, y: blockCorners[0].y }
    })
  }

  // Merge plot cells smaller than minPlotSize. The smallest undersized cell
  // absorbs its smallest neighbour repeatedly until it meets the minimum (or has
  // no neighbour left), then the next smallest undersized cell does the same.
  // Geometry is unioned via a throwaway DCEL (see DCEL.js) scoped to just this merge
  // pass: every cell becomes a Face over a coordinate-proximity-deduped local vertex
  // registry, so adjacent cells' shared edges twin by real half-edge reference — not
  // by re-canceling directed edge strings — and dcel.mergeFaces does the actual splice.
  // This is the same operation CityBlockGenerator._mergeSquareClusters needs and used to
  // reimplement independently as _unionPolygons; both now go through DCEL.mergeFaces.
  // sharedRegistry (optional, ADR-0020 Stage C): mint plot corners into the SHARED
  // GroundPointRegistry instead of a call-scoped throwaway one — 'plot' is an
  // ephemeral kind (same discipline as 'gutter'/'terrain-split'). NOTE: this method is
  // called once PER BLOCK by generate()'s loop — the 'plot' kind is cleared ONCE by
  // the caller before that loop starts, not here (clearing per-call would wipe out an
  // earlier block's already-minted points within the same generate() invocation).
  // Falls back to a fresh local registry when omitted (this method's own unit tests,
  // and any pre-Stage-C caller).
  _mergeSmallPlots(cells, minPlotSize, sharedRegistry = null) {
    if (!minPlotSize || minPlotSize <= 0 || cells.length <= 1) return cells

    const signedArea = (poly) => {
      let a = 0
      for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y }
      return a / 2
    }

    const registry = sharedRegistry || new GroundPointRegistry()
    const dcel = new DCEL(registry)
    const groups = cells.map((c) => {
      let poly = c.polygon
      if (signedArea(poly) < 0) poly = [...poly].reverse()
      const ids = dedupeConsecutiveIds(registry.mintDeduped(poly, 'plot', 1e-4, { reuseExisting: true }))
      if (ids.length < 3) return { faceId: null, area: Math.abs(signedArea(poly)), alive: false }
      // Defensive (2026-07-13): insertFace throws if this cell's polygon claims a
      // directed edge another cell already owns in the same direction — genuinely
      // adjacent, consistently-CCW-wound cells always traverse a shared edge in
      // OPPOSITE directions, so this means either a duplicate/overlapping cell from
      // PlotVoronoiGenerator's own Voronoi computation, or mintDeduped's 1e-4 tolerance
      // + reuseExisting cross-block point sharing (sharedRegistry's 'plot' kind persists
      // across every block in one generate() call) picking up an unrelated point.
      // Root cause not yet confirmed live — treat the offending cell like any other
      // degenerate cell (dropped from output, same as ids.length < 3 above) rather than
      // crashing the whole District preview.
      let face
      try { face = dcel.insertFace(ids, 'plot', {}) }
      catch (e) {
        const resolved = ids.map(id => { const p = registry.get(id); return p ? [id, +p.x.toFixed(4), +p.y.toFixed(4)] : [id, null, null] })
        console.warn(`[manifold-diag] insertFace failed for a plot cell — dropping it: ${e.message}`, 'ids+pos', JSON.stringify(resolved), 'origPoly', JSON.stringify(poly.map(v => [+v.x.toFixed(4), +v.y.toFixed(4)])))
        return { faceId: null, area: Math.abs(signedArea(poly)), alive: false }
      }
      return { faceId: face.id, area: Math.abs(signedArea(poly)), alive: true }
    })

    const sharesEdge = (G, H) => {
      for (const he of dcel._faceHalfEdges(G.faceId)) {
        if (dcel.getHalfEdge(he.twin)?.face === H.faceId) return true
      }
      return false
    }
    const absorb = (G, N) => {
      const merged = dcel.mergeFaces(G.faceId, N.faceId)
      if (!merged) return false
      G.faceId = merged.id
      G.area += N.area
      N.alive = false
      return true
    }

    while (true) {
      const alive = groups.filter(g => g.alive)
      if (alive.length <= 1) break
      const under = alive.filter(g => g.area < minPlotSize).sort((a, b) => a.area - b.area)
      if (under.length === 0) break
      // Smallest undersized group that still has a neighbour to eat.
      const G = under.find(g => alive.some(H => H !== g && sharesEdge(g, H)))
      if (!G) break
      // G eats its smallest neighbour until it meets the minimum (or can't grow).
      while (G.area < minPlotSize) {
        const nbrs = groups.filter(H => H.alive && H !== G && sharesEdge(G, H)).sort((a, b) => a.area - b.area)
        if (nbrs.length === 0) break
        if (!absorb(G, nbrs[0])) break
      }
    }

    const out = []
    for (const g of groups) {
      if (!g.alive) continue
      const poly = dcel.resolveFacePolygon(g.faceId)
      if (!poly || poly.length < 3) continue
      let pointIds = null
      try { pointIds = dcel.walkFacePolygon(g.faceId) } catch { /* leave unset — polygon is still authoritative */ }
      out.push({ polygon: poly, pointIds })
    }
    return out.length ? out : cells
  }

}
