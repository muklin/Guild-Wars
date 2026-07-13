# 0021 — Terrain z-height: per-type delta + Euclidean-falloff propagation, Apply-triggered

## Status

Proposed (2026-07-12). Extends ADR-0020's Groundplane Point (already reserves `z`, currently unused) to carry meaningful data. Terrain-scope only — District-scale z-height (Canals, District boundary dragging, streets/plots/wings, berm walls) is a deliberate, separate follow-up, not decided here.

## Decision

Each terrain type's z-height effect (Sea, Lake, Hills, Mountains, Swamp, Ice Sheet, Desert, Cliff; Plains/Forest have none) runs once, when the player hits **Apply** on that region during Terrain Setup — not on preview/selection. The effect sets a delta on the source terrain's own corners (and, for a Cliff, splits the shared Edge into high/low-side corners using the DCEL's existing `splitVertexSimple`/`getOrCreateSplitVertex`, the same mechanism the X,Y river/cliff pullback already uses), then propagates outward:

1. BFS the fine Point/Edge graph (not the coarse terrain-region graph) from all of the source terrain's corners, out to a fixed hop count per type (Sea 12, Lake/Hills/Mountains 8, Desert/Cliff 4).
2. For every point reached, take its Euclidean ("as the crow flies") distance to the *nearest* corner of the source terrain.
3. The *maximum* such nearest-corner distance across the whole reached set defines the falloff curve's zero point — `f(maxDistance) = 0` exactly, by construction.
4. Blend each point's current z toward the source terrain's z by `f(t)`, `t` = that point's own nearest-corner distance. Sea and Lake use a smoothstep-shaped S-curve; Hills, Mountains, Desert, and Cliff use a plain linear falloff. Rivers propagate to no one — only their own path points are set, via a start-to-end linear grade (split into two grades either side of a Cliff crossing, when the topology is monotonic — see the ADR body's source plan for the non-monotonic fallback).

Nothing is frozen once Applied except the region's *type* — a later-Applied neighbor's propagation still adjusts already-Applied corners, cascading, until District Setup ends. A terrain plot's Voronoi seed/centre stays outside the point registry, as a scoped exception to ADR-0020's "one registry" default: it is never part of any Surface's boundary and never shared with another Surface, so there is no reconciliation risk to justify registry membership.

## Why

The raw source proposal (`TODO.md`, "Groundplane Z-height implementation") specified propagation as "walk N connected edges" with discrete percentage tiers (e.g. Sea: 80%/50%/20%). Two rounds of revision during design surfaced problems with that literal reading: (1) the coarse terrain-region adjacency graph was tried first and rejected — a fine Point/Edge-graph walk (with hop counts scaled 4x to compensate) gives a materially smoother result since one terrain region spans multiple Voronoi cells; (2) discrete percentage tiers, even at fine granularity, produce visible banding/terracing, and the literal tier endpoints (20%, 33%) don't reach zero, which would leave a hard discontinuity at the propagation boundary. Replacing tiers with a continuous curve, calibrated through the original percentages but forced to `f(maxDistance)=0` by construction, gets a smooth result without inventing an arbitrary extended radius. Reusing the existing X,Y split-vertex mechanism for Cliff z-splitting (rather than an independent z-specific split) avoids a second, un-synced split decision — exactly the class of bug ADR-0020 was written to eliminate.

## Consequences

- Propagation walks the same Point/Edge graph the DCEL Groundplane produces; a hole in that graph (acknowledged as still occurring occasionally as of this ADR) could locally truncate or misroute a wave. Not blocking, but implementation should bound BFS defensively rather than assume full connectivity.
- `SetupPhase.assignTerrainToRegion` (and the River/Cliff pullback methods) grow additional per-type branches; there is no pre-built dispatch table for this in the current 3900+-line `SetupPhase.js`, so this ADR does not introduce one — it follows the file's existing if/else-branch convention.
- Terrain plots gain a `z`-bearing `seedPoint` that is *not* in the point registry — a deliberate, narrow exception to ADR-0020's single-registry rule, worth remembering if a future feature ever needs to share that coordinate with another Surface (at that point it would need promotion into the registry, which it currently does not warrant).
- `CONTEXT.md`'s Rendering Rules "Y = 0, provisional" note gets resolved once this is actually implemented in rendering (tracked separately, not part of this ADR's scope).
- `tools/generateSaveSchema.mjs` + `tools/generateSchemaViewer.mjs` must be re-run once Point z is actually populated by generation, since save shape changes.
