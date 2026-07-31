# 0023 — Hills/Mountains: gradient-based erosion filter, no mound-minting

## Status

Accepted (2026-07-28, design agreed via a grilling session). Builds on ADR-0021 (per-type
z-height propagation) and ADR-0022 (subdivided, welded manifold groundplane). Retires
`TerrainExtrusion.js` and its whole mound-minting mechanism. Not yet implemented; this ADR
records the design and intent, not a completed migration.

## Decision

Hills/Mountains adopt the per-point erosion technique from
[runevision's "Fast and Gorgeous Erosion Filter"](https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html)
as a **z-only detail pass over existing Groundplane vertices** — no new points are ever
minted for Hills/Mountains. This fully retires `TerrainExtrusion.js` (mound-top minting,
skirt quads, the independent-tops/shared-vertex/fan-cap design journey it went through
this session) and `TerrainExtrusion.test.mjs`.

**Base shape is unchanged.** ADR-0021's existing delta + hop-count propagation + corner
taper still defines the coarse "how tall, how far it tapers to neighbours" shape on the
generative layer — this ADR does not touch that. No new analytic/closed-form base height
function is introduced.

**The erosion pass runs after Catmull-Clark subdivision** (ADR-0022), sampling gully/ridge
detail at each *subdivided* vertex — the coarse generative-layer mesh is too sparse for the
filter's branching detail to read. The algorithm's required gradient is approximated via
finite differences off the neighbouring subdivided-mesh z values (this mesh has no
closed-form height function to differentiate analytically).

**Must recompute from the canonical pre-erosion base height on every pass**, never fed its
own prior output — the same discipline already forced on `applyTerrainTypeZEffect`
elsewhere in this pipeline after a compounding-delta bug. Pinned corners (Shore / Cliff-edge
transition-band boundary points) are skipped, exactly like every other terrain z-mutation in
this codebase.

## Why

`TerrainExtrusion.js`'s mound-minting (new topology per Hills/Mountains plot) was this
session's single largest source of HOLE/DEGENERATE findings — independent tops leave real
gaps at 3-valent Voronoi junctions (the normal case for this terrain, not the exception);
shared-vertex tops eliminate the gaps but merge adjacent mounds into one blob; fan-cap
topology fixed the merge but broke on denser real topology twice. A pure per-existing-vertex
z field sidesteps the entire class of bug by construction — X/Z and connectivity never
change, only Z does, so a hole or overlap from this pass is structurally impossible, not
just carefully avoided.

The erosion filter itself is attractive specifically because it needs no simulation and no
global state — every point evaluated in isolation from a base height + gradient — which
fits a server-side, per-vertex JS evaluation model far better than a real hydraulic-erosion
simulation would, and directly targets the live-reported visual complaints ("mountain tops
have strange artifacts", flat mesa-shaped extrusion tops) with natural branching gully/ridge
detail instead.

## Considered options

- **Full heightmap/shader terrain pivot** — rejected. Would abandon the Groundplane's
  polygon/Surface/Region/point-registry model (ADR-0020) that streets, blocks, plots, and
  the manifold audit all depend on, for the sake of one terrain type.
- **Keep mound extrusion, layer erosion detail on top of it** — rejected. Keeps the exact
  new-topology risk this decision exists to eliminate; the erosion detail would just be
  texture painted over a still-fragile mesh.
- **New analytic noise-based base height field** (true closed-form gradient, replacing
  delta/hopCount/taper too) — rejected for now as larger scope than needed. Revisit only if
  the finite-difference gradient approximation proves visually insufficient once prototyped.

## Consequences

- `TerrainExtrusion.js` / `TerrainExtrusion.test.mjs` are deleted; `TERRAIN_TYPES`'s
  `TOP_INSET_RANGE` / `EXTRUDE_HEIGHT_RATIO` fields (extrusion-only) retire, replaced by new
  erosion-filter tunables (strength, octave count, lacunarity, persistence, detail, gully
  weight, ridge/crease rounding) on the same per-type config object.
- `auditGroundplane` needs no new checks for this pass — no topology change means the
  existing HOLE/OVERLAP/DEGENERATE checks are structurally unaffected by it.
- Needs a from-scratch server-side JS port of the blog's shader math (no GPU shader path in
  this codebase's architecture — evaluated per-vertex on the Node server during the
  subdivision/pullback pass).
- Tunable magnitudes are not derivable from the blog post alone (its target domain is
  real-world-scale heightmap terrain, not this game's coarse Voronoi plots) — needs
  empirical, tune-once-seen-live calibration same as every other magnitude in this pipeline.
