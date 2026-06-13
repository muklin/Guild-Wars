# 0005 — Landmark placement moves server-side, before plots

## Decision

Building placement is reordered and relocated. Previously the per-district feature
buildings ("square feature-buildings") were placed **on the client** (`computeSquareBuildings`)
**after** plots existed, then overlapping plots were absorbed via a `recordSquares`
round-trip (`/api/setup/city/squares`). Now:

1. `CityBlockGenerator` traces blocks.
2. `markSquareBlocks` flags every block under `square_threshhold` as a **City square**.
3. `LandmarkPlacer` joins squares that share a **real street segment** (two junctions, in
   the same district) into **Square clusters**, and packs each district's
   `DISTRICT_MODEL_SQUARE` models — largest first, non-overlapping, inside the district —
   onto those clusters, producing **Landmark** placements and their footprint polygons.
4. `PlotVoronoiGenerator` generates plots for non-square blocks and **drops** any plot
   overlapping a Landmark footprint.

The model **dimension catalogue** (`MODELS`), `MODEL_SCALE`, and `DISTRICT_MODEL_SQUARE`
move to a **shared module** (`shared/buildingCatalogue.js`) imported by both the client
renderers and the server placer, because the server now needs footprints to carve plot
ground. The client only **renders** the server-recorded `landmarkBuildings`. The
`computeSquareBuildings`/`recordSquares` round-trip and the `/api/setup/city/squares`
route are removed.

## Why

Placing Landmarks before plots makes "no plot under a Landmark" a property of generation
rather than a retroactive absorb, and removes a client→server hop. Doing it server-side is
necessary because the plot generator (server) must know Landmark footprints up front —
which forces the model-dimension catalogue, previously client-only rendering config, into a
shared location.

## Consequences

- Rendering config (`MODELS` sizes, `MODEL_SCALE`) is now shared client/server; the two can
  no longer drift, but a model-size edit is a shared-module change.
- Squares can now be **joined** (across a road) into one paved plaza hosting multiple
  Landmarks; previously each tiny block stood alone. The street graph is **not** mutated —
  spanned road segments stay routable (pathfinding is future work); only the rendered/plot
  surface changes.
- A Landmark footprint may overflow a plaza into adjacent buildable blocks; those plots are
  dropped wholesale (same effect as the old absorb, computed before plots finalize).

## Status

Accepted.

## Context for the three ADR criteria

- **Hard to reverse:** relocates the model catalogue, reorders the generation pipeline, and
  deletes a route + a client compute path.
- **Surprising without context:** rendering config lives server-side now, and feature
  buildings are placed *before* the plots they sit among.
- **Trade-offs:** server-side placement (shared catalogue, no round-trip) vs keeping
  placement client-side (catalogue stays client-only, extra hop) were weighed; server-side
  was chosen.
