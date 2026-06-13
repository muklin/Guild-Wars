import { computeVoronoiCellsHalfPlane, clipToPolygon, intersectPolygons, polygonBBox } from '../voronoi/VoronoiUtils.js'
import { STREET_HALF_WIDTH } from './StreetVoronoiGenerator.js'
import { findStreetFacingEdges } from './CityBlockGenerator.js'
import { getDistrictParams } from './StreetVoronoiGenerator.js'
import { polysOverlap } from './buildings/LandmarkPlacer.js'

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
  // Returns { plots }.
  generate(blocks, districts, junctions, roadEdges, landmarkFootprints = []) {
    const districtById = new Map((districts || []).map(d => [d.id, d]))
    const plots = []
    let plotId = 0

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
      const { blockCorners, area, districtId } = block

      // Squares are pre-marked (markSquareBlocks) before Landmark placement; emit the
      // paved square plot and move on.
      if (block.blockType === 'square') {
        block.seeds = []
        plots.push({ id: plotId++, blockId: block.id, districtId, blockCorners, streetEdges: block.streetEdges, blockType: 'square' })
        continue
      }

      // Blocks too complex to subdivide safely become a single whole-block plot.
      if (blockCorners.length > MAX_BLOCK_VERTS) {
        block.blockType = 'single'
        block.seeds = []
        plots.push({ id: plotId++, blockId: block.id, districtId, blockCorners, streetEdges: block.streetEdges })
        continue
      }

      const district = districtById.get(districtId)
      const params   = getDistrictParams(district)

      const minPlotSize = params.minPlotSize ?? 0
      // A block too small to hold even one minimum-size plot stays a single whole-block plot.
      if (minPlotSize > 0 && area < minPlotSize) {
        block.blockType = 'single'
        block.seeds = []
        plots.push({ id: plotId++, blockId: block.id, districtId, blockCorners, streetEdges: block.streetEdges })
        continue
      }

      const seeds = this._generateBoundarySeeds(blockCorners, params.plotSpacing, junctions)

      if (seeds.length === 0) {
        block.blockType = 'single'
        block.seeds = []
        plots.push({ id: plotId++, blockId: block.id, districtId, blockCorners, streetEdges: block.streetEdges })
        continue
      }

      const bbox = polygonBBox(blockCorners)
      const roughCells = computeVoronoiCellsHalfPlane(seeds, bbox)
      const plotCells = roughCells.reduce((acc, cell) => {
        // intersectPolygons (convex cell ∩ block) is robust for non-convex blocks
        // with thin fingers (dead-end notches); clipToPolygon can emit a
        // self-intersecting spike. Correct arg order is (convex subject, clip).
        let poly = intersectPolygons(cell.polygon, blockCorners)
                ?? clipToPolygon(blockCorners, cell.polygon)
        if (!poly) return acc
        // A thin block finger can still leave a plot spiking across a road. Clip
        // the cell to its seed's side of every road centreline it crosses, so no
        // plot spans a road. (The seed sits on the block boundary, one side of
        // the road; we keep that side.)
        for (const r of roadLines) {
          if (this._polygonCrossesSegment(poly, r[0], r[1])) {
            const clipped = this._clipPolygonToSide(poly, r[0], r[1], cell.seedPoint)
            if (clipped) poly = clipped
          }
        }
        acc.push({ ...cell, polygon: poly })
        return acc
      }, [])

      if (plotCells.length === 0) {
        block.blockType = 'single'
        block.seeds = seeds
        plots.push({ id: plotId++, blockId: block.id, districtId, blockCorners, streetEdges: block.streetEdges })
      } else {
        block.blockType = 'subdivided'
        block.seeds = seeds
        const mergedCells = this._mergeSmallPlots(plotCells, minPlotSize)
        for (const cell of mergedCells) {
          plots.push({
            id: plotId++,
            blockId: block.id,
            districtId,
            blockCorners: cell.polygon,
            streetEdges: findStreetFacingEdges(cell.polygon, roadEdges),
          })
        }
      }
    }

    // Drop the ground under Landmarks: any non-square plot overlapping a Landmark
    // footprint is removed wholesale (ADR-0005). Squares (the paved plaza the Landmark
    // sits on) are kept.
    let kept = plots
    if (landmarkFootprints.length) {
      kept = plots.filter(p =>
        p.blockType === 'square' || !landmarkFootprints.some(f => polysOverlap(p.blockCorners, f.polygon))
      )
    }

    const sq = blocks.filter(b => b.blockType === 'square').length
    const si = blocks.filter(b => b.blockType === 'single').length
    const sd = blocks.filter(b => b.blockType === 'subdivided').length
    console.log(`PlotVoronoiGenerator: ${blocks.length} blocks (${sq} square, ${si} single, ${sd} subdivided), ${kept.length} plots (${plots.length - kept.length} dropped under Landmarks)`)

    return { plots: kept }
  }

  // True if any edge of `poly` properly crosses segment (c,d) — interior
  // crossing only (shared endpoints / grazing don't count).
  _polygonCrossesSegment(poly, c, d) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      const r1x = b.x - a.x, r1y = b.y - a.y, r2x = d.x - c.x, r2y = d.y - c.y
      const den = r1x * r2y - r1y * r2x
      if (Math.abs(den) < 1e-12) continue
      const sx = c.x - a.x, sy = c.y - a.y
      const t = (sx * r2y - sy * r2x) / den
      const u = (sx * r1y - sy * r1x) / den
      if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) return true
    }
    return false
  }

  // Clip `poly` to the half-plane bounded by the infinite line through (la,lb)
  // that contains `ref`. Returns the clipped polygon (≥3 verts) or null.
  _clipPolygonToSide(poly, la, lb, ref) {
    const nx = -(lb.y - la.y), ny = (lb.x - la.x)
    const side = (p) => nx * (p.x - la.x) + ny * (p.y - la.y)
    const sRef = side(ref)
    if (sRef === 0) return poly
    const out = []
    for (let i = 0; i < poly.length; i++) {
      const A = poly[i], B = poly[(i + 1) % poly.length]
      const dA = side(A), dB = side(B)
      const inA = dA * sRef >= -1e-9
      if (inA) out.push(A)
      if ((dA < 0) !== (dB < 0)) {
        const t = dA / (dA - dB)
        out.push({ x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y) })
      }
    }
    return out.length >= 3 ? out : null
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

    return seedLens.map(l => {
      for (let i = 0; i < n; i++) {
        if (arcLen[i + 1] >= l - 1e-10) {
          const seg = arcLen[i + 1] - arcLen[i]
          if (seg < 1e-10) return { x: blockCorners[i].x, y: blockCorners[i].y }
          const frac = (l - arcLen[i]) / seg
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
  // Geometry is unioned robustly: vertices are snapped to a shared registry so
  // adjacent cells share exact edges, then shared (reversed) boundary edges
  // cancel and the remaining edges are chained back into a polygon.
  _mergeSmallPlots(cells, minPlotSize) {
    if (!minPlotSize || minPlotSize <= 0 || cells.length <= 1) return cells
    const EPS2 = 1e-4 * 1e-4

    const canon = []
    const keyOf = (p) => {
      for (let i = 0; i < canon.length; i++) {
        const dx = canon[i].x - p.x, dy = canon[i].y - p.y
        if (dx * dx + dy * dy < EPS2) return i
      }
      canon.push({ x: p.x, y: p.y })
      return canon.length - 1
    }
    const signedArea = (poly) => {
      let a = 0
      for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y }
      return a / 2
    }
    const ek = (i, j) => i + '_' + j
    const rev = (e) => { const u = e.indexOf('_'); return e.slice(u + 1) + '_' + e.slice(0, u) }

    // One group per cell: CCW boundary as a set of directed edges.
    const groups = cells.map((c) => {
      let poly = c.polygon
      if (signedArea(poly) < 0) poly = [...poly].reverse()
      const idx = poly.map(keyOf)
      const edges = new Set()
      for (let i = 0; i < idx.length; i++) {
        const a = idx[i], b = idx[(i + 1) % idx.length]
        if (a !== b) edges.add(ek(a, b))
      }
      return { edges, area: Math.abs(signedArea(poly)), alive: true }
    })

    const sharesEdge = (G, H) => { for (const e of G.edges) if (H.edges.has(rev(e))) return true; return false }
    const absorb = (G, N) => {
      for (const e of N.edges) {
        const r = rev(e)
        if (G.edges.has(r)) G.edges.delete(r) // shared interior edge cancels
        else G.edges.add(e)
      }
      G.area += N.area
      N.alive = false
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
        absorb(G, nbrs[0])
      }
    }

    const out = []
    for (const g of groups) {
      if (!g.alive) continue
      const poly = this._chainEdges(g.edges, canon)
      if (poly && poly.length >= 3) out.push({ polygon: poly })
    }
    return out.length ? out : cells
  }

  // Chain a set of directed boundary edges ("i_j") into the largest closed loop,
  // returned as polygon points via the canonical vertex registry.
  _chainEdges(edgeSet, canon) {
    const outgoing = new Map()
    for (const e of edgeSet) {
      const u = e.indexOf('_'); const i = +e.slice(0, u), j = +e.slice(u + 1)
      if (!outgoing.has(i)) outgoing.set(i, [])
      outgoing.get(i).push(j)
    }
    const used = new Set()
    let best = null
    for (const start of edgeSet) {
      if (used.has(start)) continue
      const s0 = +start.slice(0, start.indexOf('_'))
      const loop = []
      let cur = s0, guard = 0, closed = false
      while (guard++ <= edgeSet.size + 1) {
        loop.push(cur)
        const outs = outgoing.get(cur)
        if (!outs) break
        let nxt = null
        for (const cand of outs) { const k = cur + '_' + cand; if (!used.has(k)) { nxt = cand; used.add(k); break } }
        if (nxt === null) break
        if (nxt === s0) { closed = true; break }
        cur = nxt
      }
      if (closed && loop.length >= 3) {
        const poly = loop.map(i => ({ x: canon[i].x, y: canon[i].y }))
        let a = 0
        for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y }
        if (!best || Math.abs(a) > best.a) best = { poly, a: Math.abs(a) }
      }
    }
    return best ? best.poly : null
  }

}
