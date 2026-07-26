// Single source of truth for every terrain-TYPE and terrain-FEATURE tunable in the game:
// per-type z-height delta/propagation rules, map colour, placement eligibility, and the
// width/blend tuning for the linear features (Cliff, River, Shore). Used by BOTH server
// (generation, TerrainZHeight.js/TerrainSetup.js/GroundplaneAudit.js/ShoreBands.js) and
// client (rendering, TerrainRenderer.js) code — see worldConfig/districtConfig.js for the
// same cross-import pattern (ADR-0005) applied to districts.
//
// Formerly scattered across five files with no single place to look:
//   - TERRAIN_TYPE_Z_RULES, CLIFF_Z_RULE, CLIFF_LOW_TYPES
//     (server/engine/CityGenerator/TerrainZHeight.js)
//   - ALWAYS_LOCKED_TERRAIN_TYPES, MITER_LIMIT_RATIO, RIVER_CLIFF_HALF_WIDTH
//     (server/engine/GroundplaneAudit.js)
//   - SHORE_WIDTH, WATER_TYPES (server/engine/CityGenerator/ShoreBands.js)
//   - TERRAIN_REVEAL_TYPES, EDGE_ONLY_TYPES, NORTH_HALF_ANGLE_DEG
//     (server/engine/TerrainSetup.js)
//   - TERRAIN_COLORS, WATER_TYPES, SAME_TYPE_ONLY_TYPES (client/rendering/TerrainRenderer.js)
// Terrain types don't have districtConfig.js's per-type "whole object" shape (no building
// style, no sub-classing) — the tunables are more heterogeneous (some per-region-TYPE,
// some per-linear-FEATURE), so this file stays as the same set of distinctly-named,
// independently-documented exports those five files already had, just gathered into one
// place instead of five, unlike districtConfig.js's single merged DISTRICTS table.

// ── Per-region-type z-height (ADR-0021 "Terrain z-height propagation") ─────────────────
// Each terrain type's z effect (applied on Apply — see TerrainSetup.assignTerrainToRegion)
// sets a delta on the source region's own corners, then propagates outward by walking the
// FINE Point/Edge graph from all of the source region's corners, blending each reached
// point's current z toward the source region's z along a distance-based falloff curve.
// Live-tuned 2026-07-12 (user feedback: original magnitudes "a bit too much" once actually
// rendered) — every non-zero amount below is the original design value /3.
// `direction`: the ONLY way this type's propagation is allowed to move a point (fixed
// 2026-07-13, user-confirmed "the only direction Hills should move terrain points is
// upwards") — a safety clamp in TerrainZHeight.propagateFromRegion.
export const TERRAIN_TYPE_Z_RULES = {
  Sea:        { mode: 'set',   amount: 0,    cornerAmount: 0,    hopCount: 8, curve: 'scurve', direction: 'down' },
  // Lake's own flat height is no longer `mode`/`amount`/`cornerAmount` (superseded
  // 2026-07-19 — see the dedicated `region.assignedType === 'Lake'` branch in
  // TerrainZHeight.applyTerrainTypeZEffect: settles to its lowest shore corner instead).
  // Those three fields are dead for Lake now, kept only so this entry stays truthy for the
  // `if (!rule) return` guard; hopCount/curve/direction still govern how the lake's (now
  // corner-derived) height propagates into the surrounding terrain.
  Lake:       { mode: 'delta', amount: -1 / 3, cornerAmount: -1 / 3, hopCount: 1, curve: 'linear', direction: 'down' },
  // Hills is now a rolling height field (ADR-0022): this delta/taper is its ENTIRE
  // shaping — the old extrude/inset/wall machinery retired once terrain-wide subdivision
  // could weld and smooth across every seam on its own.
  Hills:      { mode: 'delta', amount: 2 / 3, cornerAmount: 1 / 3, hopCount: 1, curve: 'linear', direction: 'up' },
  Mountains:  { mode: 'delta', amount: 1, cornerAmount: 2 / 3, hopCount: 3, curve: 'linear', direction: 'up' },
  Swamp:      { mode: 'flattenThenDelta', amount: -1 / 3, floor: 1 / 3, hopCount: 1, curve: 'linear', direction: 'down' },
  // Ice Sheet (superseded 2026-07-13 — see the dedicated branch in
  // TerrainZHeight.applyTerrainTypeZEffect): map-average-of-centres+3 (or the average of
  // already-placed Ice Sheets), +/-0.25 jitter, permanently locked. This entry only needs
  // to stay truthy so the `if (!rule) return` guard doesn't treat Ice Sheet as a no-op —
  // none of these fields are read for it anymore.
  'Ice Sheet': { mode: 'delta' },
  Desert:     { mode: 'delta', amount: -1 / 3, floor: 1 / 3, cornerAmount: -1 / 3, hopCount: 1, curve: 'linear', direction: 'down' },
  Plains:     null,
  Forest:     null,
}

// Region types whose z is permanently flat and locked (TerrainZHeight.applyTerrainTypeZEffect
// sets zLocked=true on their whole domain) — a Cliff touching one of these must NEVER move
// that side's z, at all, ever. Also gates propagateFromPoints' split-copy z assignment
// (GroundplaneAudit._dcelPullbackMaterialize) the same way.
export const ALWAYS_LOCKED_TERRAIN_TYPES = new Set(['Sea', 'Lake', 'Ice Sheet'])

// ── Cliff (an Edge type, not a Region type — see CONTEXT_WorldTerrain.md) ──────────────
// Outward propagation shape once a Cliff's own high/low split has been computed — the
// split-vertex magnitude itself comes from computeCliffChainSides' own per-edge local
// neighbour average (full snap, no lerp — see that function's own doc comment), not a
// fixed magnitude here. hopCount 4→2 (user-confirmed 2026-07-26, "cliff depths should be
// reduced, then they will be steeper"): the same height difference now spreads over half
// the horizontal run, roughly doubling the visual slope.
export const CLIFF_Z_RULE = { hopCount: 2, curve: 'linear' }

// A region touching any of these is always the LOW side of a Cliff run it's part of
// (TerrainZHeight.computeCliffChainSides) — Swamp is forced-low here without being
// ALWAYS_LOCKED_TERRAIN_TYPES (it still needs a real target average, not null).
export const CLIFF_LOW_TYPES = new Set(['Sea', 'Swamp', 'Ice Sheet', 'Lake'])

// Minimum |high - low| local separation (world z units) a Cliff edge must keep. Used two
// places (user-confirmed 2026-07-26): (1) TerrainSetup.assignEdgeType forces a Cliff up to
// at least this much separation the moment it's defined (split 50/50 around its existing
// natural midpoint), so a Cliff always visibly reads as a cliff right away rather than
// purely hoping the surrounding terrain already differs enough; (2)
// TerrainSetup.clearWeakCliffSegments, run when Terrain mode is left, clears any Cliff
// edge that's drifted back below this (neighbouring terrain edits since definition can
// still narrow it — "it can still change afterwards"). Starting value, tune once seen live.
export const CLIFF_MIN_SEPARATION = 0.3

// How close two adjacent segments' strength (avg local height diff × edge count) must be,
// as a ratio (min/max), to treat a local high/low inversion as a genuine split rather than
// downgrading the weaker segment to ordinary terrain (TerrainZHeight.computeCliffChainSides,
// user-confirmed 2026-07-26: "if the height differences of the two ends are about the
// same... it's ok to swap the cliffs halfway"). Starting value, tune once seen live.
export const CLIFF_SPLIT_EQUAL_TOLERANCE = 0.85

// ── River/Cliff pullback width (GroundplaneAudit._applyRiverCliffPullbackToTerrainPlots) ──
// Was 0.25 ("purely visual/feature-placement — no block-tracing slop to buffer against"),
// back when districts computed their OWN independent 0.35 pullback. Then 0.35 once
// _applyRiverCliffPullback started adopting districts' geometry directly from here — that
// value carried over as districts' own block/plot-tracing clearance margin too. Now
// 0.35/3, kept in sync with TerrainRenderer's stroke thickness (`0.7/3`) so the visual
// stroke exactly covers the pulled-back gap again (half-width = thickness/2). NOTE: 0.25
// was previously too small and caused splitVertexGeneral geometric-overshoot failures —
// 0.35/3 (~0.117) is smaller still, so watch for that failure mode resurfacing.
export const RIVER_CLIFF_HALF_WIDTH = 0.35 / 3

// Historically matched PolylineRenderer.js's own default miter-limit ratio (retired — see
// plan "typed-gliding-leaf" Stage D; miterLimitDist = thickness * 1.5 = (2*halfWidth) * 1.5
// = halfWidth * 3) — kept as GroundplaneAudit's pullback's own narrow-angle bevel threshold
// regardless of what the client stroke renderer does now.
export const MITER_LIMIT_RATIO = 3

// ── Shore (ADR-0022 Stage 2 — a transition band ringing every Sea/Lake perimeter, land-
// pull: the water body keeps its full placed extent, the beach is carved from the land
// margin) ────────────────────────────────────────────────────────────────────────────────
export const SHORE_WIDTH = 0.35   // single width for both Sea and Lake shores, to start
// (split per water type later only if it reads wrong).

// Region types treated as "water" for adjacency/same-type-edge and Shore-band purposes —
// matches on EITHER side being in the set (any water/water combo has no valid Edge type,
// and any water/land boundary is a Shore).
export const WATER_TYPES = new Set(['Sea', 'Lake'])

// ── Cliff-edge (ADR-0022 Stage 2 — a transition band on EACH bank of a Cliff, land-pull:
// the cliff face's own footprint is untouched, the land margin on either side is what
// gets carved back to open room for the ramp down/up to that side's own natural height)
// ────────────────────────────────────────────────────────────────────────────────────────
export const CLIFF_EDGE_WIDTH = 0.35   // same starting width as SHORE_WIDTH — tune apart
// once both are visible in-game and read wrong relative to each other.

// Terrain-type pairs with NO valid edge type at all (user-confirmed 2026-07-19): River and
// Cliff are the only two terrain edge types, and neither means anything between two
// regions that read as one continuous, undifferentiated body — Mountains<->Mountains /
// Desert<->Desert (a Voronoi-noise seam inside what's meant to look like one contiguous
// range/dune sea, not a real geographic feature — unlike e.g. two Plains regions, where a
// River genuinely can run between them). Only matches when BOTH sides are the IDENTICAL
// type, since e.g. Mountains<->Desert is a real, definable boundary. (Sea/Lake<->Sea/Lake
// is covered by WATER_TYPES above instead, matching on EITHER side.)
export const SAME_TYPE_ONLY_TYPES = new Set(['Mountains', 'Desert'])

// ── Placement eligibility (TerrainSetup.assignTerrainToRegion) ─────────────────────────
// Only ever placed on an `isEdge` region (the "edge of the known world") — placing one
// reveals and absorbs whatever hidden terrain borders it directly.
export const TERRAIN_REVEAL_TYPES = ['Desert', 'Mountains', 'Sea', 'Ice Sheet']
// Same edge-only restriction, WITHOUT the reveal/absorb behaviour (Ice Sheet also reveals,
// tracked separately in TERRAIN_REVEAL_TYPES since it has its own north-edge-only gate too).
export const EDGE_ONLY_TYPES = ['Desert', 'Mountains', 'Sea']
// A region's seedPoint bearing within this many degrees of due north (0°=north, clockwise)
// qualifies as a "north edge" — Ice Sheet's own, additional placement gate.
export const NORTH_HALF_ANGLE_DEG = 60

// ── Client rendering (TerrainRenderer.js) ───────────────────────────────────────────────
// Map/UI colour per terrain type. Shore-Sea/Shore-Lake (ADR-0022 Stage 2, ShoreBands.js)
// match Desert (sand) and Mountains (stone) respectively, per design. Cliff-Edge
// (CliffEdgeBands.js) matches the Cliff face's own colour — no separate design decision
// made yet for it, revisit once it's visible in-game.
export const TERRAIN_COLORS = {
  City:          0x808080,
  Plains:        0xb2de69,
  Desert:        0xedca72,
  Mountains:     0x8d8d8d,
  Forest:        0x218c21,
  Lake:          0x1a5abf,
  Sea:           0x0e6e6c,
  Hills:         0x699B4F,
  Swamp:         0x4a6b4a,
  'Ice Sheet':   0xf4f8ff,
  unassigned:    0xb8a680,
  Cliff:         0xaaaaaa,
  River:         0x1a5abf,   // same as Lake — a river is the same water, just flowing
  'Shore-Sea':   0xedca72,   // matches Desert — sand
  'Shore-Lake':  0x8d8d8d,   // matches Mountains — stone
  'Cliff-Edge':  0xaaaaaa,   // matches Cliff itself
  get(type) {
    return this[type] ?? null
  },
}
