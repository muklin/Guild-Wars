// Shore transition bands (ADR-0022 Stage 2). A Shore rings every Sea/Lake perimeter —
// flat at water level on the water side, ramping (via terrain-wide subdivision, see
// TerrainSubdivision.js) up to terrain height on the land side. Land-pull: the water body
// keeps its full placed extent; the beach is carved from the LAND margin (never the
// water's own footprint/z, which stays exactly as applyTerrainTypeZEffect set it — Sea/Lake
// points are zLocked and are never touched here — see isImmutable below).
//
// Modelled the same way Hills' rolling relief now is (ADR-0022 decision): NOT a separate
// mesh layer, just more ordinary n-gon Surfaces fed into the SAME welded terrain-wide
// subdivision pass. The actual pull/swap/band-build mechanics — and the three hole-
// avoidance rules they depend on — live in TransitionBand.js, shared with Cliff-edge
// (ADR-0022's own "one mechanism, two named types"); this file only supplies WHICH edges
// qualify (a land plot bordering a Sea/Lake plot), what z the inland copy gets (the
// water-adjacent corner's own current z, unchanged — the water side stays flat, so there
// is no "natural height" to ramp toward the way Cliff-edge needs), and the Shore-specific
// Surface shape.
//
// River-bank shores (ADR-0022 also calls for these) are NOT implemented here yet — they
// need to interface with the existing, considerably more complex River/Cliff DCEL pullback
// (confluence splicing, chain-wide bank siding) rather than TransitionBand.js's simpler
// single-sided land-pull, and are deliberately deferred to a focused follow-up.

// SHORE_WIDTH/WATER_TYPES live in worldConfig/terrainConfig.js now (the single source of
// truth for every terrain tunable).
import { SHORE_WIDTH, WATER_TYPES } from '../../../worldConfig/terrainConfig.js'
import { detectBoundarySegments, buildTransitionBand } from './TransitionBand.js'

// Builds Shore bands for every kept Sea/Lake perimeter and pulls the bordering LAND plots'
// own corners inland to open room for them (see TransitionBand.js for the actual pull/
// swap/band mechanics). Returns the Shore band Surface array
// ({ id, assignedType: 'Shore-Sea'|'Shore-Lake', parentRegionId, hidden, pointIds,
// polygon }) — caller stores it (e.g. worldTerrainData.shoreBands) and merges it into
// subdivideTerrain's face list.
export function buildShoreBands(registry, terrainPlots) {
  registry.clearKind('shore-split')

  const segments = detectBoundarySegments(
    terrainPlots || [],
    (other, plot) => !WATER_TYPES.has(plot.assignedType) && !other.hidden && WATER_TYPES.has(other.assignedType),
  )
  if (!segments.length) return []

  return buildTransitionBand(registry, terrainPlots, segments, {
    splitKind: 'shore-split',
    width: SHORE_WIDTH,
    // Keep the water-adjacent corner's own current z, unchanged — the water side is
    // flat (applyTerrainTypeZEffect), so there's no "more natural" height to blend
    // toward the way Cliff-edge needs; the ramp comes entirely from the welded
    // subdivision smoothing between this z and the land plot's OWN other corners.
    zForInland: (vertexId, baseZ) => baseZ,
    isImmutable: (plot) => WATER_TYPES.has(plot.assignedType),
    makeBand: (seg, pointIds, polygon, index) => ({
      id: `shore:${index}`,
      assignedType: seg.other.assignedType === 'Sea' ? 'Shore-Sea' : 'Shore-Lake',
      parentRegionId: seg.landPlot.parentRegionId,
      hidden: false,
      pointIds,
      polygon,
    }),
  })
}
