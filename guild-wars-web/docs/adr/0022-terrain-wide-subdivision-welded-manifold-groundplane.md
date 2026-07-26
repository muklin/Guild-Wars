# 0022 — Terrain-wide subdivision: one welded, subdivided manifold groundplane

## Status

Accepted (2026-07-26, design agreed via a grilling session). Builds on ADR-0020 (unified Groundplane, one topology) and ADR-0021 (per-type z-height). Supersedes the per-plot Hills extrude+subdivide feature (plan "shimmering-wondering-flurry") — that machinery retires. Not yet implemented; this ADR records the design and the sequencing intent, not a completed migration.

## Decision

Terrain gains a **subdivision layer across all terrain**, replacing the per-plot Hills subdivision with a single welded, Catmull-Clark-subdivided manifold mesh that is the **authoritative** groundplane.

**Two layers, one-way commit.**
- The **generative layer** — coarse Voronoi terrain plots + per-type edits + ADR-0021 z-propagation — is the *edit target* during Terrain mode.
- The **subdivided groundplane** is derived from it **live on every edit** and is authoritative: it is what renders, what every height query samples, and what `auditGroundplane` polices. Leaving Terrain mode is a **one-way commit** — the generative layer is discarded; only the subdivided mesh persists. Terrain-type/Cliff/River edits are final after that (changing terrain = regenerate, not in-place edit). Everything District mode needs rides forward on the **Regions** (a terrain plot becomes a Region grouping its subdivided Surfaces, carrying its seed / assignedType / name); baked z lives in the Points.

**One welded manifold mesh — no crease tags, no non-weld seams.** Adjacent surfaces weld into one connected mesh so shared seams are *interior* edges Catmull-Clark averages across → smooth valleys by construction. The only open boundary is the pinned world outer ring. Sharpness is achieved by **geometry + transition bands**, never by topological seams or per-edge sharpness weights.

**Transition band — one mechanism, two named types.** A band pins one edge to a feature height and its other edge to terrain height, keeping the mesh fully welded while giving subdivision a smooth ramp:
- **Shore** — rings every Sea/Lake and both banks of every River. Inserted fixed-width band built with the existing River/Cliff ribbon machinery, **land-pull** (the water keeps its placed extent; the beach is carved from the land margin). Water-side edge at water level, land-side edge at terrain height. Rendered yellow (Sea) / stone-grey (Lake). Single width to start; split per-type only if it reads wrong.
- **Cliff-edge** — a band on **both** cliff banks; each band's inner edge pinned to the cliff top (high side) / bottom (low side) height, outer edge to that side's terrain height. The **cliff face** sits between the two inner edges (short horizontal run, large z-drop → reads steep/sharp; lips slightly rounded by subdivision). Fully manifold, no crease tags.

Bands exist **only for Water and Cliff** — the only places two surfaces must meet at different pinned heights. Plains/Desert/Forest/Swamp/Hills/Mountains ride the plain welded height field with their own ADR-0021 z-effect and smooth neighbour-into-neighbour directly. (Swamp bands are deferred — revisit after seeing the base look.)

**Hills become a rolling height field.** Each hill plot's interior lifts (peak near its centroid, existing per-plot height + jitter) while its boundary vertices stay shared with neighbours at the base height; welding + subdivision yields rolling domes with smooth saddle valleys. The Hills extrude / inset-floating-top / per-plot-wall machinery retires. Mountains are the same, taller. Any genuinely steep side is a Cliff, not a Hill.

**Subdivision + downstream.**
- **1 Catmull-Clark pass**, a single tunable constant. **Full re-subdivide on every edit** (no incremental/dirty-region path) — edits are player-paced, one always-correct path is safest for the no-holes invariant.
- The **city footprint is subdivided too**. District mode **samples** those subdivided heights to quantize block/plot/wing ground levels, then the district Surfaces **replace** the subdivided terrain quads under the city — so the final groundplane is subdivided countryside + district tessellation sitting on sampled heights, with no double-coverage.
- `auditGroundplane` runs against the subdivided mesh: zero holes/overlaps, world outer ring exempt.

## Why

Per-plot subdivision structurally cannot produce smooth valleys: Catmull-Clark pins boundary vertices, and every plot's bottom ring is a boundary, so two adjacent plots each subdivide their shared seam as a pinned boundary on their own side — a hard V-crease at every seam (confirmed live 2026-07-26). Smooth valleys require the seam to be an *interior* edge of one connected mesh. Welding all terrain into one mesh gets that.

The transition-band idea (Shore, Cliff-edge) is what lets the welded mesh stay **truly manifold with smooth transitions and no special-case sharpness machinery**: instead of leaving cliffs/shorelines as non-welded seams (manifold-with-boundary, and a gap risk) or tagging edges infinitely sharp (a second sharpness system fighting the existing vertex-split), a band supplies the intermediate geometry so subdivision can ramp between two pinned heights. Cliffs read sharp because the face is geometrically steep, not because the topology is broken there. This keeps ADR-0020's "one topology, agreement is structural" thesis intact all the way through subdivision — the standing "groundplane never has holes" rule now policing the subdivided surface directly.

Making the subdivided mesh the single authoritative source (render + height + audit) collapses a whole class of two-representations-disagree bugs — most recently walk-mode sampling the flat pre-subdivision plot top while the rounded dome rendered above it. One source, one truth.

## Consequences

- **New machinery:** a weld-adjacency graph over the coarse plots (weld across soft edges, not across Cliff edges); a generalized transition-band builder (Shore + Cliff-edge) factored out of the existing River/Cliff ribbon; whole-welded-mesh Catmull-Clark replacing per-plot `subdivideClosedMesh`; unified height-sampling onto the subdivided quads (indexed in the existing bbox spatial grid); and the save-format change from discarding the generative layer on leave.
- **Retires:** `extrudeHillsRegion` / `subdivideAllHills` / `rebuildAllHills` and `hillsWallFaces` / `hillsSurfaces`, the coarse-plot height-sampling path, and the 2026-07-26 hills-surface height fallback (bug 2 stops being a special case).
- **One-way commit** means no in-place terrain re-edit after District mode — an accepted product constraint, not a limitation to work around.
- **Large, interlocking change** touching terrain generation, the River/Cliff pullback pass, subdivision, height sampling, the District height handoff, and the save format. It must be **staged**, not big-banged: (1) weld + subdivide flat terrain to a manifold mesh; (2) transition bands (Shore, then Cliff-edge); (3) Hills-as-height-field; (4) the District height-sample-then-replace handoff; (5) save-format cutover. Each stage must keep `auditGroundplane` green.
- `tools/generateSaveSchema.mjs` + `tools/generateSchemaViewer.mjs` must be re-run at the save-format cutover.
- Canals (District mode, defined after Terrain mode) are explicitly **out of scope** here and get their own design.
