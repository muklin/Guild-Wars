# Plan: correct plot trimming + repair malformed blocks

Status: proposed (2026-06-25). Owner: plot/block generation pipeline.

## Context (established by investigation)

- All plot geometry comes from `PlotVoronoiGenerator`. Townhouse plots are just
  Voronoi plots relabeled by `markTownhouseBlocks` (SetupPhase) — there is no
  separate townhouse geometry path.
- Blocks come from `CityBlockGenerator._traceFaces` (right-hand face walk over the
  gutter graph built from junction `gutterLeft`/`gutterRight` points).

### Already fixed (prior to this plan)
- Debug rendering: the debug material swaps now use `side: THREE.DoubleSide`, so the
  flat ground fills (which `THREE.ShapeUtils.triangulateShape` gives a downward normal)
  are no longer back-face culled in debug mode.
- Plot trim: `intersectPolygons` (centroid angle-sort, invalid for concave results)
  was replaced by `clipToPolygon`. Big improvement but still not correct on concave
  blocks (see below).
- Seed winding: the inward-inset normal now derives from the block's signed area
  instead of assuming CCW.
- Inset removed entirely: seeds sit on the block boundary. `clipToPolygon` clips every
  cell to the block regardless of seed position, so the inset's purpose was redundant,
  and it was punching seeds on thin blocks through to the opposite gutter. Coverage gap
  after removal ≈ 0.05%.

### Remaining problems (confirmed by offline measurement on autosave.json)
1. **Trim still leaks.** 76 plots escape into the street, on **10 clean-concave + 9
   malformed blocks**. Cause: `clipToPolygon` is Sutherland–Hodgman, which is only valid
   when the *subject* is convex. On a concave block, when a cut would split the block in
   two, S-H reconnects the pieces with a bridge edge that runs **outside** the block,
   across the concave notch — that bridge is the plot spilling over the street. No seed
   position can fix this; the clipper is wrong for concave input.
2. **Malformed blocks.** `_traceFaces` emits **4 self-intersecting + 7 spiral/over-concave
   blocks** (e.g. block 70/85: 34–39 verts, area ~4x normal). No clipper can make a sane
   plot from a self-intersecting block. Plot 585 (block 70) is one of these.

Guiding principle (from the user): *generate a polygon, correctly trim it to the block
boundary → it literally cannot extend over the street.* The trim must be exact.

---

## Part A — Correct concave-capable trim (the "can't escape" guarantee)

**Goal:** a plot is exactly `cell ∩ block`, with no vertex/edge outside the block, for
any non-self-intersecting block. The Voronoi cell is always **convex**, which makes an
exact, self-contained clipper tractable (no new dependency).

### A1. `clipPolygonByConvex(subject, convexClip)` → array of simple polygons
New export in `server/engine/voronoi/VoronoiUtils.js`.

- A convex polygon is the intersection of its edge half-planes. Clip the (possibly
  concave) `subject` by each half-plane in turn, carrying a **list** of polygons.
- Core primitive — *clip one simple polygon by one half-plane → list of simple polygons*:
  collect the inside boundary chains, then reconnect them with segments of the cut line,
  pairing entry/exit crossings sorted along the line (even–odd). This produces **separate**
  pieces for disconnected results instead of S-H's bridging. That is the entire fix.
- Tolerances for grazing/collinear edges; discard pieces with area < ε.

### A2. Use it in `PlotVoronoiGenerator.generate`
- Replace `clipToPolygon(blockCorners, cell.polygon)` with
  `clipPolygonByConvex(blockCorners, cell.polygon)`.
- Piece selection: seeds now sit ON the block boundary, so `pip(seed)` is ambiguous.
  Keep the **largest-area** piece; if multiple non-sliver pieces, prefer the one whose
  boundary the seed lies on. Document the tiebreak.
- Leave the road-centreline `clipPolygonToSide` pass as-is (half-plane clip is safe; it
  rarely triggers now).

### A3. Verify & clean up
- Re-run the offline escape/coverage harness → assert **0 escapes** on all
  non-self-intersecting blocks, coverage gap ≈ 0.
- Grep callers of `intersectPolygons` / `clipToPolygon`; remove `intersectPolygons` if
  now unused.

---

## Part B — Repair malformed blocks (root cause in block-gen)

**Goal:** `CityBlockGenerator` emits only simple, bounded-vertex blocks.

### B1. Planarize the gutter graph before `_traceFaces`
- Self-intersecting faces come from gutter edges that cross without a shared node
  (worsened by per-district variable street widths). In/after
  `_gutterGraphFromJunctions`, detect all pairwise gutter-edge intersections, split the
  crossing edges at the intersection point, insert nodes, and rebuild adjacency. O(n²) is
  fine at this scale. After planarization the face walk yields only simple faces.

### B2. Corrected, validated notch cleanup (only if still needed after B1)
- The disabled `_simplifyReflexNotches` removed reflex vertices but made things worse
  (deleted real geometry / didn't address self-intersections). With B1 fixing the
  crossings, re-check whether spiral blocks remain. If they do, collapse short edges /
  shallow reflex spikes using **per-district** width (`halfWidthForDistrict`), and
  *validate* each removal keeps the polygon simple and area-stable — never delete a
  vertex that flips winding or introduces a crossing.

### B3. Validate + quarantine (safety net)
- After tracing, validate each block: simple (no self-intersection), area > min, vertex
  count bounded. Any block that fails → mark `blockType:'single'` (whole-block plot, no
  subdivision) instead of feeding a garbage polygon to the plotter. Combined with Part A,
  this makes "plots in the street" impossible even if one bad face slips through.

---

## Sequencing
1. **Part A** (isolated: `VoronoiUtils` + one call site) → regenerate → visual + harness
   check. Delivers the "can't extend over the street" guarantee for well-formed blocks.
2. **B1 planarize** → biggest block-quality win (kills the spiral/self-intersecting
   blocks → Plot 585 / block 70).
3. Re-evaluate **B2**; add **B3** safety net.
4. Final harness pass: 0 escapes, 0 gaps, 0 self-intersecting blocks, bounded vertex
   counts.

## Verification assets
- Promote the node measurement one-liners used during investigation into one reusable
  regression script (escapes, coverage gaps, seed containment, block validity), runnable
  against `autosave.json` after any regen.

## Files touched
- `server/engine/voronoi/VoronoiUtils.js` — new `clipPolygonByConvex`.
- `server/engine/CityGenerator/PlotVoronoiGenerator.js` — use it; piece selection.
- `server/engine/CityGenerator/CityBlockGenerator.js` — planarize gutter graph;
  corrected/validated notch cleanup; block validation + single-fallback.

## Out of scope (note, don't fix here)
- The **magenta junction triangles** seen in debug are a *junction road-fill* coverage
  gap (neither plot nor junction fan), not a plot problem — separate task.

## Risks
- Piece-selection rule with boundary seeds (A2) needs a deterministic tiebreak.
- B1 changes block adjacency → re-verify `extractOuterGutterPolygon` and terrain plots
  still line up.
- Performance: O(n²) planarization per city is fine for hundreds of edges.
