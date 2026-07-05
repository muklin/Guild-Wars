# Guild Wars Web — Buildings & Roofs

Terminology for dynamically generated buildings and their roofs. Buildings are assembled at runtime from parametric specs and kit parts. This section may be split further as subsystems grow.

## Language

### Buildings

**Building**:
A structure generated within a plot. A plot can contain one or more building footprints.
_Avoid_: structure, object

**Building Type**:
A per-building gameplay classification (game-mechanical intent, not primarily a geometry driver, though it may later influence footprint/decoration) — one of Residential (people live there), Industrial (people make something), Commercial (people sell something), Public (open-access, services or governing bodies), Military (private, specialized training), extensible. A Building carries up to two Types, drawn via a per-district weighted roll (`buildingTypeWeights`) at creation, independent of the district's own type (a Residential district is mostly Residential-typed buildings but isn't exclusively so). Deliberately generative: types are assigned first, with what a given combination actually *does* in-game left as future work rather than a fixed per-model lookup.
_Avoid_: building category, use type

**Building Subtype**:
A finer classification within one Building Type (e.g. Residential: Slum/MiddleClass/Noble; Commercial: trader/bank/moneylender; Industrial: forge/smelter/blacksmith; Public: tavern/inn/temple) — examples only, not an exhaustive list. Field reserved on the Building Spec now; not yet rolled or assigned — deferred until Building Type itself is validated in practice.
_Avoid_: sub-category, subclass

**Attached**:
A Parametric Building whose Wing-list footprint sits flush (zero setback) against every street edge of its plot, eligible to have faces Suppressed wherever it meets an equally-tall neighbour doing the same. Chosen per-building (not per-block) via that district's `freestandingChance` roll — the complement of Freestanding — client-side and seeded from the plot.
_Avoid_: townhouse, townhouse block, row house, terrace house

**Freestanding**:
A Parametric Building set back from every edge of its plot by a seeded-random gap (from `style.frontSetback` up to 15% of that edge's frontage length), never Suppressing a face against a neighbour. Chosen per-building via the same district `freestandingChance` roll as Attached; independent of the Custom Model roll below.
_Avoid_: freestanding slot (renamed to Custom Model), detached

**Custom Model**:
A plot that receives a fixed GLB model building instead of a Parametric Building. Chosen per-building via a district's `customModelChance` roll, client-side and seeded; independent of the Attached/Freestanding roll. Formerly called "Freestanding slot" — renamed because "freestanding" now names the unattached Parametric Building case above, which this is not.
_Avoid_: freestanding slot, GLB slot

**Wing-list footprint**:
The building polygon for any Parametric Building, Attached or Freestanding. Computed by: (1) splitting each street-facing edge into one or more Wings (see Wing); (2) for each resulting wing, insetting it inward (perpendicular) by a depth chosen from four district-defined bay-depth options — plus, for a Freestanding building, an outward setback on every side; (3) clipping to the plot polygon; (4) closing the perimeter with side/back walls and resolving overlaps across all wings from all edges together. A plot with N street-facing edges, each split into wings up to `maxWingWidth` bays wide, produces N or more wings total.
_Avoid_: townhouse footprint, plot footprint, building outline

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
One rectangular or polygonal volume within a building's footprint. Each wing has an independent Floor entry list — its own floor count, per-floor heights, and ground-floor Foundation, drawn independently per district style; sibling wings of one building are never forced to align. Adjacent wings at different heights produce a lean-to roof on the shorter wing. The roof ridge follows the footprint spine and hips around corners; gable ends appear only on open ends (those exposed to open space or a taller-neighbour step, as opposed to a Suppressed face).

A street-facing edge longer than the district's `maxWingWidth` (bays) is split into multiple side-by-side Wings before depth is computed, each a seeded-random width no smaller than the engine-wide `MIN_WING_WIDTH` (currently 3 bays) — a remainder too small to stand alone is folded back into the last two wings and re-split within bounds, rather than left as a sliver. When a split has an odd wing count, its centre wing has a small seeded chance to sit one bay back from the street, with a return wall closing the resulting side notch.
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
A single-pitch roof on a wing that is shorter than an adjacent wing. Slopes from the outer eave upward to its abutment against the taller adjacent wing's wall. Used on secondary wings in an Attached building.
_Avoid_: shed roof, mono-pitch, pent roof

**Archway**:
A ground-floor passage tunnelling the full depth of an eligible Wing through to the Courtyard behind the building. Eligible wings are Attached (never Freestanding), ≤4 bays deep, with ≥1.5 floor-heights of clearance below floor 2 (i.e. a Foundation under a normal ground floor, or a ground floor itself rolled 1.5 tall). 1–3 bays wide, always 1.5 floor-heights tall; simple internal walls face inward, with no ceiling finish yet (wood ceiling and knee braces are future work). Chosen once per building via a per-district `archChance` roll (default 15% everywhere; never more than one per building), and can sit centred in its wing or pushed to one edge if that edge has a neighbouring wing (same building, from a frontage split, or an adjacent building) to back onto — the archway never crosses into that neighbour's own footprint.
_Avoid_: gatehouse, tunnel, carriageway

**Courtyard**:
The open plot area behind a building's rearmost wing(s) — today only used for back-yard tree scattering. An Archway's purpose is connecting the street to this space through the building.
_Avoid_: backyard, back lot, rear yard

**Suppressed face**:
A building face where wall panels, interior posts, and roof trim are omitted because the face abuts an Attached neighbour building of equal or greater height. Corner posts shared with perpendicular faces are retained. Computed client-side (`_suppressPartyWalls`, `BuildingRenderer.js`) from each same-block neighbour's wing geometry, not pre-computed by the server (ADR-0008 describes an earlier, since-superseded server-side design).
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
