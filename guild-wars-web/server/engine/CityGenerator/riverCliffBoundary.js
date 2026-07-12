// Computes LEFT/RIGHT boundary positions for every point along every River/Cliff chain,
// using the SAME miter/junction geometry PolylineRenderer.js uses for rendering (see
// shared/polylineGeometry.js) — so the terrain data these positions get baked into and
// the on-screen stroke agree by construction (no separate width-reconciliation pass
// needed), and multi-chain junctions (2+ rivers/cliffs meeting) are handled by the same
// mature fan/miter/bevel logic already proven for rendering, not a second, DCEL-specific
// mechanism (see plan "typed-giggling-giraffe" — this is a deliberately separate,
// standalone, well-tested piece; NOT YET wired into SetupPhase's live pullback).
import { computeJunctionData, computeEdgeCorners } from '../../../shared/polylineGeometry.js'

// edges: a plain object/map of chainId -> { pointIds: [id, ...], ... } — callers pass
// worldTerrainData.edges PRE-FILTERED to just the River/Cliff entries (an unassigned or
// non-linear edge has no boundary to compute and would only add noise to the junction
// fan-sorting).
// pointsById: Map<id, {x,y}> (or anything with a matching .get).
// halfWidth: river/cliff half-width (the boundary sits halfWidth away from the chain on
// each side).
// miterLimitDist: same narrow-angle clamp/bevel threshold PolylineRenderer uses.
// fillsOut: optional Map, passed straight through to computeJunctionData — populate it
// (ptId -> {boundaryPts, edgeIds, center}) for every 3+-way junction, so a caller
// building real filled River/Cliff FACES (not just a stroke) can also close the small
// fan-shaped gap a beveled (narrow-angle) junction leaves between two chains' ribbons —
// see SetupPhase._buildRiverCliffJunctionCaps. Omit if you only need boundaries.
//
// Returns: Map<chainId, Array<{left:{x,y}, right:{x,y}} | null>> — one entry per point
// in that chain's own pointIds, in order. A null entry means that specific vertex's
// corner couldn't be computed (missing/coincident point) — same convention
// computeEdgeCorners itself uses.
export function computeRiverCliffBoundaries(edges, pointsById, halfWidth, miterLimitDist, fillsOut = new Map()) {
  const overrides = computeJunctionData(edges, pointsById, halfWidth, miterLimitDist, fillsOut)
  const result = new Map()
  for (const [chainId, edge] of Object.entries(edges)) {
    result.set(chainId, computeEdgeCorners(edge, chainId, overrides, pointsById, halfWidth, miterLimitDist))
  }
  return result
}
