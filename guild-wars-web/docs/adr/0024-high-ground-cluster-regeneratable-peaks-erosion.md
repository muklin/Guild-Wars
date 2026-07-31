# 0024 — High-ground clusters: regeneratable, multi-peak cones + shared erosion domain

## Status

Accepted (2026-07-30, design agreed via a grilling session). Supersedes the "one-time,
per-region, single-peak" parts of ADR-0023 — that ADR's z-only/no-new-topology/finite-
difference-gradient decisions all still hold, only the *when*, *how many*, and *what scope*
questions change here. Not yet implemented; this ADR records the design and intent.

## Decision

**Cones and erosion both become fully regeneratable**, not one-time. A Peak's location and
height, and the whole erosion pass, are recomputed from scratch on every regeneration — never
additive on their own prior output, the same idempotency discipline the erosion filter
already had (and the delta/taper step has had since its own compounding-delta bug).

**The unit of generation is a High-ground cluster** — a maximal connected group of Mountains
*and* Hills regions (connected via shared Terrain Edges; the two types freely connect to each
other, not just their own kind) — never a single region in isolation. A cluster holds however
many Peaks its total area calls for (more area, more summits), each sized off its own
*containing region's* own bounding radius (`CONE_RADIUS_FRACTION`/`CONE_HEIGHT_RATIO` — the
only fields still per-type; every `EROSION_*` field becomes one shared config used across the
whole cluster regardless of Mountains/Hills mix). Peaks are placed with a minimum separation
to avoid two landing on top of each other; where two Peaks' cones overlap anyway, the taller
wins at each point (a natural saddle between summits, not a fused blob).

**Regeneration triggers only on cluster-membership change** — a region's type-assignment
(direct Apply, or auto-revealed/absorbed into visibility) joining it to a High-ground cluster
regenerates that entire cluster's Peaks and erosion. A later, unrelated edit (a Cliff carved
through an already-generated cluster, a neighbouring region's own Apply) does not.

**Erosion becomes cluster-scoped, not region-scoped**: one shared neighbour graph across every
region in the cluster (so gradients and ridge/gully noise flow continuously across a region
seam instead of stopping dead at it), with each vertex's edge-fade computed against its
*nearest* Peak rather than "the one Peak my region happens to own."

## Why

The prior one-time, per-region design broke as soon as a single reveal action could absorb
several hidden neighbours at once (Mountains/Sea/Desert/Ice Sheet's own "edge of the known
world" reveal mechanic): whichever region the player actually clicked got its one Peak, and
everything absorbed but far from it stayed flat despite carrying the same `assignedType` —
confirmed live 2026-07-29 ("2nd/3rd Mountain terrains are not having a cone built on them").
An earlier same-session fix kept revealed regions as distinct Region objects instead of
folding them into one merged domain, which is necessary infrastructure for this design (there
must be separate, edge-connected regions for a cluster to be *made of*) but insufficient on
its own — the real gap was one-peak-per-region-object being the wrong granularity entirely
for what's visually one connected landform.

Multiple Peaks per connected landform also restores what the original validated prototype
always had (two mounds, not one) and directly answers the standing "does a mountain *range*
need more than one summit" question this session kept circling back to.

## Considered options

- **Keep one-time, single-peak-per-region, add a "joint" pass only for freshly-absorbed
  siblings** — rejected. Still one-off/special-cased rather than a general rule; doesn't
  handle a *later* Apply joining two already-generated clusters together, and doesn't answer
  "how many peaks should a big cluster have" at all.
- **Type-segregated clusters (Mountains only joins Mountains, Hills only joins Hills)** —
  rejected in favour of one combined "high ground" cluster crossing both types, so a Mountains
  region bordering Hills reads as one continuous range transitioning from foothills to peaks,
  not two abruptly-adjacent landforms.
- **Per-type erosion params retained, blended/zoned at a mixed-type seam** — rejected as
  unnecessary complexity once erosion collapsed to a single shared config; Hills vs Mountains
  is now purely cone height/radius (footprint) and post-generation colour, nothing about the
  erosion math itself differs.
- **Overlapping Peaks forbidden by construction (placement enforces radius-sum separation)**
  — considered, then reversed back to a max-combine rule: forbidding overlap entirely made
  placement more constrained for no real benefit once "taller peak wins" gives a believable
  saddle for free.

## Consequences

- `TerrainPeak.js`'s single "find the region's own highest point, bump once" function is
  replaced by a cluster-scoped, multi-peak, regeneratable search — a materially different
  algorithm, not a parameter tweak.
- `TerrainErosion.js`'s `applyTerrainErosion` must regroup by cluster instead of by region:
  one shared neighbour graph and vertex→nearest-Peak assignment across every region in the
  cluster, instead of today's per-region `quadsByRegion` grouping.
- `worldConfig/terrainConfig.js`: every `EROSION_*` field moves off `TERRAIN_TYPES.Mountains`/
  `.Hills` into one shared constant; only `CONE_RADIUS_FRACTION`, `CONE_HEIGHT_RATIO`, and
  `color` remain per-type.
- `TerrainSetup.js` needs a cluster-connectivity walk (BFS/union-find over Mountains/Hills
  regions via `wt.edges`) triggered from the same place `_applyRegionZEffectAndPeak` is called
  today, replacing "call it once for this region" with "find this region's cluster, call it
  for every region in that cluster."
- `region.peakPoint` (singular, persisted) is no longer the right shape — a region's
  containing cluster now owns a set of Peaks, not each region owning exactly one.
- Existing `TerrainPeak.test.mjs`/`TerrainErosion.test.mjs` idempotency tests need rewriting
  around cluster-level regeneration rather than single-region Apply.
