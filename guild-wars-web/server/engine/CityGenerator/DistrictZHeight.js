// District-scale z-height (plan "typed-gliding-leaf", companion to TerrainZHeight.js /
// ADR-0021, which explicitly scoped itself to terrain only).
//
// `idwZ`/`applyIdwZ` (inverse-distance-weighted / Shepard's method interpolation) were
// the PRIMARY mechanism here until ADR-0022 Stage 4a: Junctions/Gutters, Blocks, and
// Plots each interpolated from progressively nearer already-z-aware control points,
// tracing back to the district's own coarse (pre-subdivision) boundary corners. Since
// Stage 4a, StreetVoronoiGenerator/CityBlockGenerator/PlotVoronoiGenerator instead
// sample the ACTUAL subdivided terrain mesh directly (TerrainHeightSampler.js) —
// idwZ now only fires as their FALLBACK, for a point that lands outside the subdivided
// mesh's own coverage (no heightIndex passed, or genuinely uncovered geometry). Kept
// exactly as before (and still fully covered by DistrictZHeight.test.mjs) rather than
// retired, since it's a real, low-risk safety net now, not dead code. Canal's z effect
// unifies into the same mechanism either way: its own points just become additional,
// locally-lowered control points that a fallback IDW call would naturally pick up.
//
// Pure functions, independent of SetupPhase.js — unit-testable against synthetic control
// points, same style as TerrainZHeight.test.mjs.

export const IDW_POWER = 2   // Shepard's method default — tune once seen live, same as every other z-height magnitude in this system.
const COINCIDENT_EPS = 1e-9

// Canal (District Edge type): lowers the z of its own centreline points by this amount,
// directly on the shared registry points (some of which are also district boundary
// corners) — no separate propagation mechanism. Tier 1/2 IDW calls near a Canal pick up
// the now-lowered points as ordinary control points automatically. Starting value, tune
// once seen live, same as every other z-height magnitude in this system.
export const CANAL_Z_DELTA = -1

// Mutates each registry point named in pointIds: z -= CANAL_Z_DELTA magnitude (lowers).
// Idempotency is the caller's responsibility (SetupPhase.assignCityEdgeType only calls
// this once per edge — an edge can't be re-assigned once typed).
export function applyCanalZDelta(registry, pointIds, delta = CANAL_Z_DELTA) {
  for (const id of pointIds || []) {
    const p = registry?.get(id)
    if (!p) continue
    p.z = (isFinite(p.z) ? p.z : 0) + delta
  }
}

// controlPoints: [{x, y, z}]. Returns null if controlPoints is empty (caller decides the
// fallback — there's no universally-correct default here). If the target point coincides
// with a control point (within COINCIDENT_EPS), returns that control point's z exactly
// rather than dividing by ~0.
export function idwZ(x, y, controlPoints, power = IDW_POWER) {
  if (!controlPoints?.length) return null
  let weightedSum = 0, weightSum = 0
  for (const c of controlPoints) {
    const dSq = (x - c.x) ** 2 + (y - c.y) ** 2
    if (dSq < COINCIDENT_EPS) return c.z
    const w = 1 / Math.pow(dSq, power / 2)
    weightedSum += w * c.z
    weightSum += w
  }
  return weightSum > 0 ? weightedSum / weightSum : null
}

// Convenience batch form: assigns .z to every point in `points` (mutates in place) via
// idwZ against the same `controlPoints` set. Points that already carry a finite .z are
// left untouched (a point that IS itself one of the control points, or was already
// resolved by an earlier tier, shouldn't be overwritten).
export function applyIdwZ(points, controlPoints, power = IDW_POWER) {
  for (const p of points) {
    if (p.z != null && isFinite(p.z)) continue
    const z = idwZ(p.x, p.y, controlPoints, power)
    if (z != null) p.z = z
  }
}
