# 0002 — Per-district incremental street generation; remove Street Setup phase

## Decision

Street, block, plot, and building generation moves out of a single global batch
(`finishSubdivision`) and into **City Subdivision**, run **per district** the moment
its type is assigned. The player regenerates (reseeds) a district until satisfied, then
**locks** it. The **Street Setup** sub-phase is removed; Setup is now
**Terrain Setup → City Subdivision → Guild Creation**.

The committed street graph is generated over the set of **locked** districts (plus the
single district currently in preview). Each district carries its own **street seed**,
frozen at lock. Shared **City Edges** are deferred and **continuously re-resolved**:
they resolve as soon as both adjacent districts are locked, with no separate final pass.
A lock is **final** — type and seed are immutable thereafter — but a district's
boundary-adjacent geometry still finalizes as its neighbors lock. Advancing to Guild
Creation auto-assigns and locks any still-untyped districts.

## Why it works with the existing generator

`StreetVoronoiGenerator.generate()` already builds each district's interior
micro-Voronoi independently and its global union-find only merges nodes near shared
boundaries, so running it over a subset of districts yields stable interiors. The
boundary→interior connect pass already skips a side whose district has no nodes, so an
edge to an unlocked neighbor is naturally one-sided until that neighbor joins. The only
core change is generating over the locked subset using a stored per-district seed
instead of all districts with one global epoch seed.

## Consequences

- A district is interior-stable on lock, but its edge blocks/plots/buildings (within
  ~one block of a boundary) update as neighbors lock — and may flicker while a neighbor
  is in preview. Accepted as inherent to deferred-boundary generation.
- Saves at the removed `StreetSetup` step map to `GuildCreation` on load.

## Status

Accepted.

## Context for the three ADR criteria

- **Hard to reverse:** touches the whole setup pipeline (generator, SetupPhase, routes,
  client flow) and the save format.
- **Surprising without context:** generation is triggered by per-district lock, and
  there is no Street Setup phase — a future reader would expect a dedicated street step.
- **Trade-offs:** full-city-recompute vs per-district vs final-pass, and continuous
  re-resolve vs a deferred final pass, were each weighed; per-district + continuous
  re-resolve + locked-is-final was chosen for tight feedback with minimal generator change.
