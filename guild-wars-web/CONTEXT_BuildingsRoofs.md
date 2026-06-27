# Guild Wars Web — Buildings & Roofs

Terminology for dynamically generated buildings and their roofs. Buildings are assembled at runtime from parametric specs and kit parts. This section may be split further as subsystems grow.

## Language

### Buildings

**Building**:
A structure generated within a plot. A plot can contain one or more building footprints.
_Avoid_: structure, object

**Townhouse block**:
A block classified (probabilistically per district type) to produce buildings with shared party walls and continuous street facades. Within a townhouse block, ~5% of plots are freestanding slots instead. The block carries a `blockType: 'townhouse'` flag set at generation time.
_Avoid_: row block, terrace block

**Freestanding slot**:
A plot inside a Townhouse block that receives a GLB model building rather than a continuous party-wall facade. Rare (~5%). Adjacent townhouse plots must detect the gap and expose (not suppress) their shared boundary wall.
_Avoid_: singleton plot, instanced plot

**Townhouse footprint**:
The building polygon for a plot in a Townhouse block. Computed by: (1) keeping every street-facing edge as a front wall; (2) for each street-facing edge, insetting it inward (perpendicular) by a wing depth chosen from four district-defined bay-depth options; (3) clipping the inset segment to the plot polygon; (4) closing the perimeter with side walls along boundary edges and back walls parallel to their respective frontage. A plot with N street-facing edges produces N wings, each potentially at a different depth.
_Avoid_: plot footprint, building outline

**Landmark**:
A district-specific feature building (per `DISTRICT_MODEL_SQUARE`) placed on a district's Square clusters before plots are generated; plot ground under a Landmark footprint is dropped. Distinct from an ordinary plot Building.
_Avoid_: square feature-building, specialist building

**Hall**:
A generic large building model (the GLB formerly named `guildhall`). A rendering asset only — not tied to the Guild concept or a Guild Headquarters.
_Avoid_: guildhall

**Parametric Building**:
A Building assembled at runtime from kit parts per a Building Spec, rather than a single fixed GLB model (h1–h19) or a Landmark.
_Avoid_: generated building, modular building

**Building part**:
A small reusable mesh that fills one named kit slot (e.g. `post`, `panel-stone`, `window`), authored to a shared bay grid.
_Avoid_: component, piece

**Part kit**:
The canonical set of named part slots (and their grid) a Parametric Building is built from.
_Avoid_: part set, library

**Theme**:
A swappable set of part GLBs plus one texture atlas filling the kit slots (`default` = procedural placeholders); future per-district styles or alternate settings are themes.
_Avoid_: skin, style-pack

**Bay**:
The wall module between two posts on one floor — the unit of wall layout. Rigid features (window/door) sit fixed-size and centred in a bay; flex infill panels X-scale to fill it.
_Avoid_: panel slot, module

**Building Spec**:
The compact deterministic descriptor (seed, footprint, roof, suppressedFaces) a Parametric Building is assembled from. The footprint is a wing list (`{type:'wings', wings:[…]}`); each wing is either an axis-aligned rect (`{minX,maxX,minZ,maxZ}`) or a polygon (`{vertices:[[x,z],…]}`), plus a per-wing `floors` list (see Floor entry) and optional roof override. Computed client-side from plot geometry; the client assembles deterministically from the seed (no `Math.random`). There is no building-wide material array — each Floor entry carries its own material.
_Avoid_: blueprint, recipe

**Wing**:
One rectangular or polygonal volume within a building's footprint. Each wing has an independent Floor entry list — its own floor count, per-floor heights, and ground-floor Foundation, drawn independently per district style; sibling wings of one building are never forced to align. Adjacent wings at different heights produce a lean-to roof on the shorter wing. The roof ridge follows the footprint spine and hips around corners; gable ends appear only on free-standing ends (those exposed to open space or a taller-neighbour step).
_Avoid_: section, module, arm

**Floor entry**:
One element of a wing's `floors` list: `{ zHeight, height, material }`, in floor-height units (`lib.grid.floorHeight`) with half-floor granularity — `zHeight: 0` is the true ground plane. `zHeight` is absolute, not a running sum, so "everything at or below z" (used by the top-down Floor scroll) is a direct comparison rather than a per-floor accumulation. After the roof is built, a trailing `{ type: 'roof', zHeight, height, riseHalfUnits }` entry is appended to the same list (see Roof rise quantization), so floor-scrolling past the top floor transitions uniformly into the roof.
_Avoid_: floor record, level entry

**Foundation**:
A half-height stone (or granite/brick) footing filling the gap between true ground (`zHeight: 0`) and a ground floor whose own `zHeight` was raised — only possible when the ground floor's material is stone/granite/brick. Derived, not separately rolled: whichever roll decides the ground floor's `zHeight` implicitly decides whether a Foundation exists and how tall it is. Any door on a floor with `zHeight > 0` gets an Entrance stair rising from true ground to its threshold.
_Avoid_: footing (alone), plinth

**Basement**:
A Floor entry with a *negative* `zHeight`, sitting below true ground. Representable in the per-wing floor list but **carries no special rendering rules yet** — distinct from Foundation (which is the above-ground gap-filler under a raised ground floor), not a synonym for it.
_Avoid_: cellar, undercroft

**Entrance stair**:
A small stepped stair from true ground (`y=0`) up to a door's threshold, added whenever that door's floor has `zHeight > 0` (i.e. sits behind a Foundation).
_Avoid_: stoop, porch steps

**Lean-to roof**:
A single-pitch roof on a wing that is shorter than an adjacent wing. Slopes from the outer eave upward to its abutment against the taller adjacent wing's wall. Used on secondary wings in a Townhouse building.
_Avoid_: shed roof, mono-pitch, pent roof

**Suppressed face**:
A building face where wall panels, interior posts, and roof trim are omitted because the face abuts a neighbour building of equal or greater height. Corner posts shared with perpendicular faces are retained. Encoded in the Building Spec as `suppressedFaces`, pre-computed by the server.
_Avoid_: hidden face, invisible wall, party wall

### Roofs

**Ridge**:
The horizontal top line of a pitched roof where the two slopes meet. Runs along the building's long axis.
_Avoid_: peak, roofline, gable

**Apex**:
The top vertex of a gable end, where the two rakes meet the ridge (code `apexY`).
_Avoid_: peak, tip

**Gable end**:
The triangular wall section filling the end of a pitched roof, rising from the wall below to the apex. (The code's "gable fill" and the TODO's "peak".)
_Avoid_: peak, gable, gable wall

**Rake**:
The sloped roof edge running down each side of a gable end (ridge → eave).
_Avoid_: gable edge, verge slope

**Bargeboard**:
A board run along a rake — wood sitting proud above the rake for tile/wood roofs; a band hanging below the rake for thatch/reed (to show material depth).
_Avoid_: vergeboard, gableboard

**Eave**:
The lower edge of a roof slope, overhanging the wall below; the long, low side of a gable roof.
_Avoid_: overhang

**Fascia**:
The vertical board or face running along an eave. For thatch/reed, the hanging band along the eave that shows material thickness (code `addEaveFascia`).
_Avoid_: eave board, trim

**Soffit**:
The underside of an eave or overhang.
_Avoid_: underside, ceiling

**Overhang**:
How far an eave or rake projects horizontally beyond the wall plane (Building Spec `roof.overhang`).
_Avoid_: eave, projection

**Pitch**:
The slope steepness of a roof, as a ratio or angle; clamped ~20°–60°.
_Avoid_: slope, angle, grade

**Span**:
The horizontal distance a roof covers between its two eaves; half-span (`halfSpan`) × pitch sets the ridge height.
_Avoid_: width, run

**Dormer**:
A roofed window projection standing out from a steep roof slope. Always exactly one floor tall — omitted if a full floor won't fit, never stretched to fill taller roof above it. Its window registers to the building's floor grid, sitting at the height it would have on a normal next floor. Tagged with `userData.floorLevel` (one above its wing's top Floor entry) so it can later be associated with a Floor scroll level.
_Avoid_: roof window, gablet

**Roof rise quantization**:
A wing's roof rise (ridge height above its top floor) is snapped to whole half-floor-height units (0–4, i.e. 0–2.0 floor-heights; code `riseHalfUnits`) instead of staying a continuous `halfSpan × pitch` value, so the roof can be appended as a `{type:'roof',…}` Floor entry in the same per-wing list as the walls — letting the Floor scroll step onto it uniformly.
_Avoid_: roof snapping, rise rounding

**Floor scroll**:
A top-down-only camera feature (`PageUp`/`PageDown`, only while top-down is active — `[`/`]` stay zoom everywhere): steps a world-space horizontal clip plane up/down in half-floor-height units, clipping away everything above the scrolled-to level while the scrolled-to level and below render normally. Paging up past the top floor instead reveals the roof (a separate, all-or-nothing toggle, not a gradual clip-through). Isolating only the selected floor, or blurring floors below it, is explicitly future work — not implemented.
_Avoid_: floor isolation, level peeling

**Valley**:
The concave internal angle where two roof slopes meet (e.g. where an L-shape's wings intersect); sheds water inward.
_Avoid_: gutter, trough

**Hip**:
The convex external sloping ridge where two roof slopes meet at an outward corner; carries the ridge around a corner of the footprint.
_Avoid_: hipped edge, hip ridge

**Dutch gable**:
A roof end where a small gable (gablet) sits atop a hipped lower portion: the end hips partway up, then a triangular gablet caps the ridge. Preferred on steeper thatch/reed roofs.
_Avoid_: gablet roof, gable-on-hip

**Flat roof**:
A roof of negligible pitch. Not yet rendered.
_Avoid_: deck roof

**Abutment**:
The line where a lower roof slope (a lean-to or shorter wing) or a chimney meets a taller vertical wall.
_Avoid_: shared wall, junction wall

**Sidewall**:
A long wall sitting beneath the eaves of a roof (the eave-side wall), as opposed to the gable end. May or may not be the building's street frontage.
_Avoid_: eave wall, long wall
