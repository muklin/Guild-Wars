// KNOWN LIMITATION (found live 2026-07-26, NOT fixed here — see below): on a real
// generated world, a minority of trials still show HOLE findings along a LONG Cliff
// chain's middle stretch, even with zero Cliff-edge bands involved at all — confirmed
// via a raw (pre-subdivision, pre-band) audit of just terrainPlots + ribbon segments.
// Root cause is upstream of this file and of TransitionBand.js: for some chains, NO
// land plot (kept or hidden) has an edge matching the ribbon's own per-segment side
// edges at all, meaning the chain's own boundary-corner point list
// (_computeRiverCliffBoundaryData) doesn't correspond 1:1 with the actual Voronoi land
// tessellation along that stretch — a pre-existing density/structure mismatch between
// the coarse Edge chain and the fine land plots, not a bug in the pull/swap/band engine
// itself (which only ever operates on edges that DO have a valid land match). This is
// the same class of complexity River-bank shores were deferred for (confluence/
// junction handling) — fixing it needs work in the boundary-chain construction or the
// confluence-splice machinery, not here. Left unresolved; flagged for a focused
// follow-up rather than patched under time pressure.
//
// Cliff-edge transition bands (ADR-0022 Stage 2). A band on EACH bank of a Cliff run —
// pinned to that side's own cliff-lip height on its inner edge, ramping (via terrain-wide
// subdivision, see TerrainSubdivision.js) out to that side's own natural terrain height on
// its outer edge. The cliff FACE itself (the steep drop, already built as a
// worldTerrainData.riverCliffFaces entry — see GroundplaneAudit._buildRiverCliffFacesDirect)
// is untouched; this only carves the LAND margin back on either side to open room for the
// band, same land-pull philosophy as Shore.
//
// Unlike Shore (a plain Region perimeter), a Cliff is a linear Edge feature: its own
// filled ribbon Surface already exists in riverCliffFaces, and the LAND plots on both
// banks already had their shared corners pulled back (and given the correct high/low
// "cliff-lip" z via the split-vertex machinery in GroundplaneAudit._dcelPullbackMaterialize/
// TerrainZHeight.computeCliffChainSides) by the EXISTING River/Cliff pullback, long before
// this file ever runs. That means this module does NOT need to re-derive which side is
// high/low, or touch the confluence-splice DCEL machinery at all — a land plot's own
// corner at the shared boundary is ALREADY exactly the right cliff-lip height, for
// whichever side that plot is on, by construction. This module only needs to: detect
// which land-plot edges border a Cliff-type riverCliffFace (treating each face as one
// more "plot" purely for TransitionBand's adjacency scan — never mutated), and pull those
// land plots' boundary corners further out to a genuinely more natural height (see
// zForVertex below) — deliberately NOT the flat "keep the same z" Shore uses, since a
// Cliff-edge band's whole purpose is a smooth ramp DOWN/UP from the cliff, whereas Shore's
// water side has no "more natural" height to ramp toward (it's already flat everywhere).
import { CLIFF_EDGE_WIDTH } from '../../../worldConfig/terrainConfig.js'
import { detectBoundarySegments, buildTransitionBand } from './TransitionBand.js'

// Builds Cliff-edge bands for every Cliff-type riverCliffFace and pulls the bordering LAND
// plots' own corners outward (away from the cliff) to open room for them (see
// TransitionBand.js for the actual pull/swap/band mechanics). Returns the Cliff-edge band
// Surface array ({ id, assignedType: 'Cliff-Edge', parentRegionId, hidden, pointIds,
// polygon }) — caller stores it (e.g. worldTerrainData.cliffEdgeBands) and merges it into
// subdivideTerrain's face list, same as Shore.
export function buildCliffEdgeBands(registry, terrainPlots, riverCliffFaces) {
  registry.clearKind('cliff-edge-split')

  const cliffFaces = (riverCliffFaces || []).filter(f => f.assignedType === 'Cliff')
  if (!cliffFaces.length) return []

  const segments = detectBoundarySegments(
    terrainPlots || [],
    (other) => other.assignedType === 'Cliff',   // riverCliffFace entries are the only things ever assignedType 'Cliff' — it's an Edge type, never a plot's own type
    cliffFaces,
  )
  if (!segments.length) return []

  // Per-vertex "natural" (non-cliff-boundary) height: for each land plot touching the
  // cliff, average the z of its OWN corners that are NOT themselves on a cliff boundary
  // (falling back to the plot's whole-corner average if every corner happens to be
  // boundary — a tiny sliver plot at a confluence). Averaged again across every segment
  // incident on a given vertex, same "blend the neighbours" spirit
  // buildTransitionBand's own offset-normal averaging already uses, for a vertex shared
  // by two different cliff-adjacent plots.
  const boundaryVertexIdsByPlot = new Map()
  for (const seg of segments) {
    const set = boundaryVertexIdsByPlot.get(seg.landPlot) || new Set()
    set.add(seg.a); set.add(seg.b)
    boundaryVertexIdsByPlot.set(seg.landPlot, set)
  }
  const naturalZSumByVertex = new Map()   // vertexId -> { sum, count }
  const naturalZByPlot = new Map()
  for (const [plot, boundarySet] of boundaryVertexIdsByPlot) {
    const ids = plot.pointIds
    const pts = registry.resolve(ids)
    let sum = 0, count = 0, allSum = 0
    for (let i = 0; i < pts.length; i++) {
      const z = pts[i].z ?? 0
      allSum += z
      if (!boundarySet.has(ids[i])) { sum += z; count++ }
    }
    naturalZByPlot.set(plot, count ? sum / count : (pts.length ? allSum / pts.length : 0))
  }
  for (const seg of segments) {
    const naturalZ = naturalZByPlot.get(seg.landPlot) ?? 0
    for (const v of [seg.a, seg.b]) {
      const cur = naturalZSumByVertex.get(v) || { sum: 0, count: 0 }
      cur.sum += naturalZ; cur.count++
      naturalZSumByVertex.set(v, cur)
    }
  }
  const naturalZByVertex = new Map()
  for (const [v, { sum, count }] of naturalZSumByVertex) naturalZByVertex.set(v, sum / count)

  return buildTransitionBand(registry, terrainPlots, segments, {
    splitKind: 'cliff-edge-split',
    width: CLIFF_EDGE_WIDTH,
    zForInland: (vertexId, baseZ) => naturalZByVertex.get(vertexId) ?? baseZ,
    // No isImmutable needed — unlike Shore's water plot, the cliff face itself is a
    // riverCliffFace, never a terrainPlot, so it's never among the plots this pulls.
    makeBand: (seg, pointIds, polygon, index) => ({
      id: `cliff-edge:${index}`,
      assignedType: 'Cliff-Edge',
      parentRegionId: seg.landPlot.parentRegionId,
      hidden: false,
      pointIds,
      polygon,
      // seg.other IS the riverCliffFace this band ramps away from — carries its own
      // iceSheetAdjacent flag straight through (same white-near-Ice-Sheet rule as the
      // cliff face itself, user-confirmed 2026-07-26: "never grey or sand yellow").
      // Without this the band always rendered TERRAIN_COLORS['Cliff-Edge'] (a flat grey,
      // "matches Cliff itself" — its own doc comment predates the white rule entirely),
      // so a white Ice-Sheet cliff always had a grey ring drawn right around its own
      // land-side edge, reading as "still a terrain edge"/"still not white" even after
      // the cliff face itself went white.
      iceSheetAdjacent: !!seg.other.iceSheetAdjacent,
    }),
  })
}
