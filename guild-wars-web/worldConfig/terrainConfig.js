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
// TERRAIN_TYPES (renamed from TERRAIN_TYPE_Z_RULES, 2026-07-27 — TERRAIN_COLORS merged
// into it the same call) is now the single per-type "whole object" table
// districtConfig.js's DISTRICTS already was — every OTHER export below stays its own
// distinctly-named, independently-documented constant (linear-FEATURE tuning, adjacency
// sets, placement rules) since those aren't per-region-TYPE data at all.

// ── Per-region-type config (ADR-0021 "Terrain z-height propagation" for the z-effect
// fields; colour for client rendering) ──────────────────────────────────────────────────
// `color`: every type — including ones with no z-effect at all (Plains/Forest) and ones
// that are never a player-placed region type at all (City, River, Shore-Sea/Shore-Lake,
// Cliff-Edge, unassigned) — has one; it's the only field those latter entries carry.
//
// z-effect fields (only on types that actually have one — see `mode` below): applied on
// Apply (TerrainSetup.assignTerrainToRegion) as a delta on the source region's own
// corners, then propagated outward by walking the FINE Point/Edge graph from all of the
// source region's corners, blending each reached point's current z toward the source
// region's z along a distance-based falloff curve. Live-tuned 2026-07-12 (user feedback:
// original magnitudes "a bit too much" once actually rendered) — every non-zero amount
// below is the original design value /3. `direction`: the ONLY way this type's
// propagation is allowed to move a point (fixed 2026-07-13, user-confirmed "the only
// direction Hills should move terrain points is upwards") — a safety clamp in
// TerrainZHeight.propagateFromRegion. `mode` is the actual signal for "has a z-effect at
// all" (TerrainZHeight.applyTerrainTypeZEffect's own guard is `!rule?.mode`, not
// `!rule`) — a colour-only entry (Plains, Forest, City, ...) simply has no `mode`.
export const TERRAIN_TYPES = {
  Sea:        { mode: 'set',   amount: 0,    cornerAmount: 0,    hopCount: 8, curve: 'scurve', direction: 'down', color: 0x0e6e6c },
  // Lake's own flat height is no longer `mode`/`amount`/`cornerAmount` (superseded
  // 2026-07-19 — see the dedicated `region.assignedType === 'Lake'` branch in
  // TerrainZHeight.applyTerrainTypeZEffect: settles to its lowest shore corner instead).
  // Those three fields are dead for Lake now, kept only so `mode` stays set (the
  // `!rule?.mode` guard's actual signal); hopCount/curve/direction still govern how the
  // lake's (now corner-derived) height propagates into the surrounding terrain.
  Lake:       { mode: 'delta', amount: -0.33, cornerAmount: -0.33, hopCount: 1, curve: 'linear', direction: 'down', color: 0x1a5abf },
  // ── 'deltaandextterrainplots' mode (re-added 2026-07-26/generalized 2026-07-27,
  // TerrainExtrusion.js — Hills' own extrude/inset/wall version "got lost somewhere" when
  // ADR-0022 retired it in favour of a plain rolling height field; a rolling field alone
  // never actually reads as "a hill"/"a mountain" in play). `amount`/`cornerAmount`/
  // `hopCount`/`curve`/`direction` still give the region its gentle rolling-field slope
  // exactly like plain `'delta'` mode does (TerrainZHeight.applyTerrainTypeZEffect
  // matches both modes identically there) — the per-PLOT inset+extrude below sits on top
  // of that, same relationship the original (pre-ADR-0022) version had. Any type using
  // this mode needs its own TOP_INSET_RANGE/EXTRUDE_HEIGHT_RATIO (below); a type on plain
  // `'delta'` mode never reads them.
  //
  // TOP_INSET_RANGE: each plot's own top is pulled toward its own centroid by a randomly-
  // chosen fraction in this [min, max] range (a different draw per plot, seeded off its
  // centroid — organic per-plot variety, same "individual faces" look the original Hills-
  // only extrude had) before terrain-wide subdivision (subsurf) rounds the resulting mesa/
  // plateau shape off. 1.0 would mean no inset at all (the top stays the plot's full
  // original footprint); smaller values leave more room for the sloped skirt around each
  // plot's edge — Mountains' own narrower range keeps more of its footprint as a steep
  // peak than Hills' gentler, more-inset mound.
  //
  // EXTRUDE_HEIGHT_RATIO: NOT a fixed world-unit constant (the original 2026-07-20
  // Hills-only version's HILLS_EXTRUDE_HEIGHT was) — always scaled proportional to the
  // plot's own size (user-confirmed 2026-07-26), specifically height = this ratio ×
  // sqrt(plot footprint area), so a small Voronoi plot gets a proportionally small bump
  // and a large one a proportionally tall one, instead of every plot in a region popping
  // up by the same absolute amount regardless of how big it is.
  //
  // Starting values, tune once seen live.
  Hills:      { mode: 'deltaandextterrainplots', amount: 1, cornerAmount: 0.33, hopCount: 1, curve: 'linear', direction: 'up', TOP_INSET_RANGE: [0.3, 0.6], EXTRUDE_HEIGHT_RATIO: 0.15, color: 0x699B4F },
  Mountains:  { mode: 'deltaandextterrainplots', amount: 2, cornerAmount: 0.66, hopCount: 3, curve: 'linear', direction: 'up', TOP_INSET_RANGE: [0.3, 0.3], EXTRUDE_HEIGHT_RATIO: 0.7, color: 0x8d8d8d },
  Swamp:      { mode: 'flattenThenDelta', amount: -0.33, floor: 0.33, hopCount: 1, curve: 'linear', direction: 'down', color: 0x4a6b4a },
  // Ice Sheet (superseded 2026-07-13 — see the dedicated branch in
  // TerrainZHeight.applyTerrainTypeZEffect): map-average-of-centres+3 (or the average of
  // already-placed Ice Sheets), +/-0.25 jitter, permanently locked. This entry only needs
  // `mode` truthy so the `!rule?.mode` guard doesn't treat Ice Sheet as a no-op — none of
  // the OTHER z-effect fields are read for it.
  'Ice Sheet': { mode: 'delta', color: 0xf4f8ff },
  Desert:     { mode: 'delta', amount: -0.33, floor: 0.33, cornerAmount: -0.33, hopCount: 1, curve: 'linear', direction: 'down', color: 0xedca72 },
  // Cliff (an Edge type, not a Region type — see CONTEXT_WorldTerrain.md), folded in here
  // 2026-07-27 (was the standalone CLIFF_Z_RULE export below, now dead). Outward
  // propagation shape once a Cliff's own high/low split has been computed — the
  // split-vertex magnitude itself comes from computeCliffChainSides' own per-edge local
  // neighbour average (full snap, no lerp — see that function's own doc comment), not a
  // fixed magnitude here. hopCount 4→2 (user-confirmed 2026-07-26, "cliff depths should be
  // reduced, then they will be steeper"): the same height difference now spreads over half
  // the horizontal run, roughly doubling the visual slope.
  Cliff:      { mode: 'delta', hopCount: 2, curve: 'linear', color: 0xaaaaaa },
  // Colour-only from here down — no z-effect (`mode` intentionally absent).
  Plains:      { color: 0xb2de69 },
  Forest:      { color: 0x218c21 },
  City:        { color: 0x808080 },
  River:       { color: 0x1a5abf },   // same as Lake — a river is the same water, just flowing
  'Shore-Sea': { color: 0xedca72 },   // matches Desert — sand
  'Shore-Lake': { color: 0x8d8d8d },  // matches Mountains — stone
  'Cliff-Edge': { color: 0xaaaaaa },  // matches Cliff itself — no separate design decision
  // made yet for it, revisit once it's visible in-game.
  unassigned:  { color: 0xb8a680 },
}

// Region types whose z is permanently flat and locked (TerrainZHeight.applyTerrainTypeZEffect
// sets zLocked=true on their whole domain) — a Cliff touching one of these must NEVER move
// that side's z, at all, ever. Also gates propagateFromPoints' split-copy z assignment
// (GroundplaneAudit._dcelPullbackMaterialize) the same way.
export const ALWAYS_LOCKED_TERRAIN_TYPES = new Set(['Sea', 'Lake', 'Ice Sheet'])

// A region touching any of these is always the LOW side of a Cliff run it's part of
// (TerrainZHeight.computeCliffChainSides) — Swamp is forced-low here without being
// ALWAYS_LOCKED_TERRAIN_TYPES (it still needs a real target average, not null).
export const CLIFF_LOW_TYPES = new Set(['Sea', 'Swamp', 'Lake'])
// A region touching any of these is always the HIGH side of a Cliff run it's part of
// (TerrainZHeight.computeCliffChainSides) — Ice Sheet moved here from CLIFF_LOW_TYPES
// 2026-07-27. Ice Sheet is also ALWAYS_LOCKED_TERRAIN_TYPES, so this only affects
// sidedness bookkeeping (which side the run treats as "high" for the OTHER side's
// forced resolution/topology), never Ice Sheet's own frozen z.
export const CLIFF_HIGH_TYPES = new Set(['Mountains', 'Hills', 'Ice Sheet'])

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
// Ice Sheet<->Ice Sheet added 2026-07-26 (user-confirmed: "should not exist between
// icesheets") — matches computeCliffChainSides' own standing invariant (TerrainZHeight.js)
// that a Cliff between two Ice Sheets is never valid either; this is the client-side
// rendering half of that same rule, for the plain-unassigned-edge case.
export const SAME_TYPE_ONLY_TYPES = new Set(['Mountains', 'Desert', 'Ice Sheet', 'Lake', 'Sea'])

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
// TERRAIN_COLORS retired 2026-07-27 — every type's colour now lives on its own
// TERRAIN_TYPES entry above (`.color`); this is just a thin accessor so call sites don't
// each repeat `TERRAIN_TYPES[type]?.color` — same null-for-unknown contract
// TERRAIN_COLORS.get(type) had.
export function terrainColor(type) {
  return TERRAIN_TYPES[type]?.color ?? null
}
