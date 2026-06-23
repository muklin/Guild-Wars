# Roof generation — unified single-path architecture

**Update:** this file originally documented two parallel roof systems ("Path A" for townhouses, "Path B" for free-standing houses). Path B has since been deleted — every building (townhouse or free-standing) now goes through the same per-wing polygon system. A free-standing rectangular house is just the degenerate one-wing case of the same polygon-wing footprint townhouses use. This file now documents the unified system.

## The spec shape

```js
// Spec: { seed, floors, footprint:{type:'wings', wings:[{vertices,front,floors?,jetty?}]},
//         wallMaterial:[perFloor], roof:{shape:'gable',material,pitch,overhang?},
//         neighborWings?, suppressedFaces? }
```

Every wing carries `vertices: [[x,z],...]` (model space) and `front: [[x,z],[x,z]]` (the street-facing edge — required, since the roof frame is built around it). Produced by:

- `BuildingRenderer._buildTownhouseSpec`/`_spawnTownhouse` — multi-wing polygon townhouses, one wing per street-facing edge of the plot.
- `BuildingRenderer._buildSpec`/`_spawnParametric` — free-standing houses, a single rectangular wing.
- `client/preview/gallery.js` — dev preview, same single-rectangle shape.

True L-shaped (two-wing valley/hip) roofs have no equivalent in this system and aren't produced anywhere live.

## Debug constants (top of `ParametricBuilding.js`)

```js
const RENDER_ROOFS = true
const RENDER_DORMERS = true
const DEBUG_FORCE_GABLE_ROOFS = true   // disable Dutch-gable hip ends
const DEBUG_UNIFORM_RIDGE = true       // ignore real pitch/height, use constants below
const DEBUG_RIDGE_PITCH  = 0.6
const DEBUG_RIDGE_HEIGHT = 1.0
```

## Per-wing pipeline (`assemble()`)

For each wing, in order:

1. **Walls**: `boundaryIntervals` clips each polygon edge against sibling wings (same building) and `spec.neighborWings` (other buildings on the block), so party walls between attached buildings come out flush and shared/interior segments are omitted. Bays, posts, windows/doors, and (plaster only) knee braces are placed per drawn interval. `frontEdgeIndex` finds which edge is `wing.front`, used to force a door onto the street frontage.
2. **Jetty** (townhouses only — see below): floors at/above `wing.jetty.fromFloor` use a front-pushed polygon (`pushFrontEdge`) instead of the base one, for both walls and the floor beam at the transition.
3. **Roof**: `computeWingRoofFrame` (pure geometry) → `addBuildingRoof` (the mesh). One independent gable roof per wing; sibling/neighbour wings suppress the gable+overhang on any edge that's actually flush against another building, exactly like the wall logic.
4. **Gable decoration**: `addGableDecoration` — king-post / chevron-brace / horizontal-brace gable filling, called from inside `addBuildingRoof`'s gable-end construction.
5. **Dormers + chimneys**: `addWingRoofFeatures` wraps the wing's roof frame as a rotated/positioned `THREE.Group` (local x→u, local z→n) so the world-axis-aligned `addDormers`/`addChimneys` can be reused unmodified inside it.

### `computeWingRoofFrame` — the geometry core

Exported so the debug preview (`blockpreview.js`) calls the *exact same function* as the real mesh builder, instead of a hand-duplicated copy:

1. Builds a local `(u, n)` frame from `wing.front` — `u` along the street frontage, `n` perpendicular into the building.
2. Projects all vertices into `(u, n)` → `uMin/uMax/nMin/nMax`.
3. `inNeighbor(uc, nc)` probes a frame point against `neighborPolys` (world-space) to find which of the four ends are "free" (gable) vs "flush" (party wall).
4. Computes ridge endpoints: a flush end stops exactly at the wall; a free end runs the ridge all the way to the eave overhang when `DEBUG_FORCE_GABLE_ROOFS` is on (a true flat-topped gable, no diagonal hip faces), or pulls in by `halfSpan` for the old hip/Dutch-gable-capable behavior when off.
5. Returns `{ ridgeP0, ridgeP1, toW, apexY, topY, ht, halfSpan, ridgeAlongU, freeUMin/UMax/NMin/NMax, ... }` — everything both the mesh builder and the debug overlay need.

## Jetty (street-relative, townhouses only)

Replaces the old "stone ground floor → uniform 4-side expansion" jetty with a street-relative, front-only mechanic:

- `BuildingRenderer._spawnTownhouse` sets each wing's front wall back from the plot's true street edge by `FRONT_SETBACK` (≈ `StreetVoronoiGenerator.STREET_HALF_WIDTH`, kept in sync by value), anchoring the *back* corners at the original plot-derived depth so only the front moves.
- `_buildTownhouseSpec` rolls one building-level jetty decision (gated on a stone/granite ground floor + `floors > 1`, matching the old material rule), then per wing a jetty amount capped at that wing's own setback — so a jettied upper floor can reach but never cross the original street line.
- `ParametricBuilding.js`'s `pushFrontEdge(poly, frontEdgeIdx, dir, amount)` offsets just the two front vertices, leaving the rest of the wing polygon untouched. Floors `>= wing.jetty.fromFloor` use this pushed polygon for walls, the transition floor beam, support poles at the two jettied corners, and the roof (built from a `roofWing` variant with the pushed front).

## Quick map of what to read if you're chasing a specific shape

| Symptom | Look at |
|---|---|
| Wrong roof orientation relative to street | `computeWingRoofFrame`'s `front`/`u`/`n` frame setup |
| Ridge too short/long | `freeU*`/`freeN*` flags + `inNeighbor`/`STEP` inside `computeWingRoofFrame` |
| Hip-shaped/diagonal faces where you expect flat gable | the `ridgeP0`/`ridgeP1` branch in `computeWingRoofFrame`, and `addEnd`'s 3-way branch (dutch / forced-gable / old-hip) in `addBuildingRoof` |
| Party walls between buildings not flush | `neighborPolys`/`wingNeighbors` construction in `assemble()`, and `boundaryIntervals`/`otherWings` for the matching wall logic |
| Jetty geometry | `pushFrontEdge`, `wing.jetty`/`wing.jettyDir`/`wing.setback` (set in `BuildingRenderer._spawnTownhouse`/`_buildTownhouseSpec`) |
| Gable decoration | `addGableDecoration`, called from `addBuildingRoof`'s `addEnd` |
| Dormers/chimneys | `addWingRoofFeatures` (the frame→world-axis-aligned adapter), `addDormers`/`addChimneys` |
| Free-standing house placement/orientation | `BuildingRenderer._spawnParametric`/`_buildSpec` — unrelated `setback` (small, plot-relative, not the street-relative jetty setback) |
