# 0020 — Unified Groundplane: one registry, Surface/Region taxonomy, topology-native generation

## Status

Accepted (2026-07-10). Supersedes the removed ADR 0018's polygon-soup direction entirely; staged migration in plan "typed-giggling-giraffe", Addendum 2.

## Decision

The world's ground geometry becomes a single **Groundplane** structure — replacing the parallel `worldTerrainData` / `cityDistrictData` split, the second point id-space (`cityData.points`, from the legacy `PointRegistry.js` — deleted), and the registry-keyed materialized point copies (`edgePoints`) — holding exactly:

- **points** — ONE registry, the only store of positional data. Points carry no semantic `kind`; lifetime is owned by whichever generator minted them. Pristine base vertices ("skeleton points") are retained even when no Surface references them, as long as any split point holds their `baseId` — they are the reversal anchor.
- **Surfaces** — single DCEL cells (terrain plots, blocks, plots, street segments, junction disks, River/Cliff/Wall/MainRoad/Canal/Docks segments), each an ordered Point-id list plus a type.
- **Regions** — typed groups of Surfaces (terrain regions, the City, districts, streets, rivers, cliffs…), carrying gameplay payload.
- **Edges** — zero-width boundary chains, needed during setup for hover/assignment. Assigning a linear type **converts** the Edge into a Region of face Surfaces; the Region stores the original centreline Point ids so clearing the type reconstructs the Edge.

Generation becomes **topology-native**: new points are born from split-edge/split-face operations against existing topology, never from coordinate soup reconciled by tolerance-based dedup. Saves persist **full current state** (base + derived topology); recompute-from-seeds remains a repair tool, never the load path. Materialized x,y copies (`.polygon`, `edgePoints`, `cityData.points`) leave the save entirely.

## Why

Every gap/spike/sliver bug class this project has fought traces to the same root: multiple independent computations of the same boundary (land pullback vs. stroke geometry; two registries dedup-ing the same corners at different tolerances), reconciled after the fact by coordinate proximity. A single topology makes agreement structural instead of tolerance-tuned — holes become impossible by construction. The genuine alternative (keep polygon-soup + reconciliation, patch each divergence) was tried extensively and produced an unbounded tail of geometric edge-case bugs; the cost of the rebuild was weighed against that tail and deliberately accepted.

## Consequences

- The three generators (`StreetVoronoiGenerator`, `CityBlockGenerator`, `PlotVoronoiGenerator`) are rewritten as DCEL mutators (migration Stage C) — the largest cost.
- Clearing a typed Edge with neighbours still typed requires re-anchoring to skeleton points and re-splitting for the survivors — an inverse that works only because base vertices are never garbage-collected.
- `PolylineRenderer.js` is deleted once all linear features are face Surfaces (Stage D); the miter-spike bug class dies with it.
- Save format changes; `tools/generateSaveSchema.mjs` + `tools/generateSchemaViewer.mjs` must be re-run at each stage.
