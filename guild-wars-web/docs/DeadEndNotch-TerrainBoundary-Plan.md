# Plan: fix dead-end plot notches + city/terrain boundary gap

Status: proposed (2026-06-25). Follows the plot-trim and landmark-paving fixes.

## Context

Two remaining visual bugs after the `clipPolygonByConvex` trim fix (plots no longer
overrun streets) and the landmark→square paving fix:

1. **Dead-end notch (red-circled).** Plots retreat from the *sides* of a dead-end street
   (not the end), leaving a magenta notch along the stub.
2. **City/terrain boundary gap (purple-circled).** A magenta sliver sits between the city's
   edge plots and the surrounding terrain plots — they aren't adjacent.

Both root causes are confirmed by offline measurement on the regenerated `autosave.json`.

---

## Bug 1 — Dead-end notch

**Root cause (measured).** `_generateBoundarySeeds`
(`server/engine/CityGenerator/PlotVoronoiGenerator.js`) suppresses boundary seeds within
`2·plotSpacing` of every "real" junction, where real = `(connections.length) !== 2`.
That set **includes degree-1 dead-ends**. For dead-end junction 321, the seeds along the
stub corridor jump from axial 0.0 (the cap corners) straight to 0.40 (near the mouth) —
a ~0.4-unit seed-free gap. The mid-stub uncovered points (sdist 0.23, 0.28) lie in that
gap, 0.16–0.20 from the nearest seed, so no Voronoi cell reaches them → notch. 8 of 21
dead-ends show this.

A dead-zone is meant to stop seeds crowding at busy intersections (degree ≥ 3). A dead-end
is a single stub and needs normal seed spacing along it.

**Fix.** In `_generateBoundarySeeds`, only let degree ≥ 3 junctions create a dead-zone:
```js
const realJunctions = junctions.filter(j => (j.connections?.length ?? 0) >= 3)
```
(was `!== 2`). Update the adjacent comment. Degree-2 bends already excluded; this also
excludes degree-1 dead-ends, so seeds front the stub normally.

**Verify.** Re-run the offline dead-end harness: the in-block uncovered count along stubs
(currently 45 sample points across 8 dead-ends) drops to ~0, with no new escapes/gaps
elsewhere (the existing escape/coverage harness still reads 0/0).

---

## Bug 2 — City/terrain boundary gap

**Root cause (measured).** `SetupPhase._generateBuildings` builds terrain plots from world
fine cells but excludes the entire City region:
`fineCells.filter(c => c.parentRegionId !== cityRegion.id)`. City plots only fill up to the
outer gutter, so the **City-region margin** (gutter → region boundary) is covered by
nothing: 3735 magenta sample points, all inside the City region. `extractOuterGutterPolygon`
(the intended clip boundary, passed to `TerrainPlotConverter` but ignored) is also broken —
it returns a 10-vertex sliver, not the city outline.

**Fix (primary, simple).** Stop excluding City-region cells — include all world fine cells
as terrain plots:
```js
const terrainFineCells = wt?.fineCells || []
```
The City-region cells tile the margin, so it is filled and terrain meets the city exactly
at the gutter. Terrain renders at `GROUND_Y - 0.001` (below city plots), so the cells under
the built city are hidden and only the margin shows. Apply the same change in
`regenerateTerrainPlots` (the save-load path) so existing saves migrate.

**Colour note / optional refinement.** Margin cells carry the City region's `assignedType`
('City'), which `renderTerrainPlots` has no colour for → falls back to tan (unassigned). If
a natural green-to-city edge is preferred over a tan margin, a follow-up can (a) fix
`extractOuterGutterPolygon` to return the true outer ring, (b) clip terrain cells to outside
that ring (avoids hidden overdraw), and (c) re-type margin cells to the nearest non-City
region's terrain type. Recommend shipping the simple fix first and deciding the colour after
seeing it.

**Verify.** Re-run the city/terrain classification harness: magenta-inside-City-Region drops
from 3735 to ~0; terrain now covers the margin; city plots unchanged.

---

## Files
- `server/engine/CityGenerator/PlotVoronoiGenerator.js` — dead-zone filter (Bug 1).
- `server/engine/SetupPhase.js` — terrain fine-cell selection in `_generateBuildings` and
  `regenerateTerrainPlots` (Bug 2).
- Verify-only: `server/engine/CityGenerator/TerrainPlotConverter.js`,
  `client/rendering/GroundRenderer.js` (`renderTerrainPlots` colours).

## Sequencing
1. Bug 1 dead-zone fix (one line + comment) → verify dead-end harness.
2. Bug 2 include-all-cells fix → verify boundary harness; eyeball the tan-margin question.
3. Regenerate a city in-app to confirm both visually.
