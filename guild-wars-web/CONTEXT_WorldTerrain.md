# Guild Wars Web — World, Terrain & City Streets

Terminology for terrain regions, edges, plots, districts, streets, and blocks and squares.  All spatial concepts — from the coarse world map to individual building parcels — are defined here.

## Language

### World & Terrain

**Terrain**:
The typed landscape of a region — one of a fixed set of types (Plains, Forest, Hills, Mountains, Sea, Lake, Ice Sheet, River, Cliff, City, etc.). Assigned to regions during Terrain Setup. Made up of multiple terrain ==plot==s.
_Avoid_: biome, tile type, land type

**Edge**:
The boundary line between two adjacent Terrains, which can be assigned a type (River, Cliff, etc.).
_Avoid_: border, boundary

River and Cliff edges render as a fixed-thickness polyline centred **on** the edge (not a filled region like Sea/Lake), so they extend into both neighbouring terrain plots' nominal area. A District (a typed terrain plot) must inset its usable polygon inward by half that thickness along any River/Cliff edge before street/block generation, so its real boundary is the river bank/cliff face rather than the raw Voronoi cell edge. Sea/Lake need no such pullback — their polygon already is the water's boundary.

**River** (edge type):
An edge marked as a river channel. A valid River selection must satisfy all four rules:

1. A river may not be adjacent to a Lake or a Sea terrain.
   1a. When a River is "Applied" alongside an adjacent Lake or a Sea terrain, the adjacent edge reverts to being undefined.
   1b. When a Lake or Sea is defined adjacent to an existing River, the adjacent edge reverts to being undefined.
2. Every free endpoint of a River path must terminate at one of: an existing River, a Sea terrain, a Lake terrain, or the physical map boundary.
   _Avoid_: stream, waterway

**City Terrain**: 
The Terrain identified to become the City, in this game, made up of Districts, and District Edges.

**City Expansion**:
The player-initiated promotion of an eligible adjacent terrain ==plot== into a full city District during District Setup. The plot must be unassigned (no Forestry, Agriculture, Mining, or Fishing assignment) and within the Living Boundary. Distinct from the initial City Terrain region established during Terrain Setup.
_Avoid_: annexation, absorption

**Living Boundary**:
The ever-growing set of terrain ==plot==s eligible for City Expansion: any terrain plot sharing an edge with a plot already in `cityDistrictData.districts`, including previously promoted plots. Expands outward as each new District is added.
_Avoid_: city edge, expansion zone

**==Plot==**:
A ==plot== whose source is a Voronoi cell from the world terrain generation (`TerrainVoronoiGenerator`). ==Plot==s that fall inside the City Terrain region are able to be selected as city Districts. They are stored in raw form as `worldTerrainData.terrainPlots` and re-derived on load via `regenerateTerrainPlots().`
_Avoid_: fine cell, fine Voronoi cell

**District**:
A ==plot== within the city terrain, eventually assigned a purpose type (Residential, Market, Military, Entertainment, Religious, Magical, Industry, or Leadership).
_Avoid_: zone, quarter, ward — as type labels. Players may use these words freely in their player-assigned Entity Names (e.g. "Silk Ward" is a valid name for a Market district).

**Leadership District**:
The single special district that serves as the seat of city government. Has a Leadership Class and a City Leader NPC rather than a Resource or Service type. May optionally align with a God; alignment is mandatory in Theocracy.
_Avoid_: government district, ruling district

**==Plot== Feature**:
A flavour addition scoped to a specific ==plot== within a compatible parent Terrain type. No mechanics currently — reserved for future implementation. Valid features and their compatible terrains:

- Glacier, Volcano → Mountains only
- Caves → Hills, Mountains, Desert, Plains
- Ruins → any terrain ==plot==
- Sinkhole → any except Hills, Mountains, Sea, Lake
- Whirlpool → Sea, Lake only
  _Avoid_: terrain modifier, terrain overlay, special terrain

---

### Streets

**Street graph**:
The network of nodes and edges representing road centerlines within a city. Generated per-district by `StreetVoronoiGenerator`.
_Avoid_: road network, road graph

**Street seed**:
The per-district seed driving a district's interior street layout. Defaults from the district id, reshuffled by Regenerate while the district is in preview, and frozen when the district is locked.
_Avoid_: random seed, epoch seed

**District lock**:
The act of committing a district during City Subdivision, freezing its type and Street seed (and therefore its interior streets). A locked district is final — it cannot be re-typed or regenerated — though its shared City Edges keep finalizing as neighboring districts are locked.
_Avoid_: confirm, accept, finalize

**Street node**:
A point in the street graph. Nodes with degree ≥ 3 are **junctions**; nodes with degree 2 are **bends**.
_Avoid_: vertex, waypoint

**Junction**:
A street node where three or more streets or street-like connections meet (degree ≥ 3). Interior junctions carry a single `districtId`. Boundary junctions carry `left` and `right` district ids instead, plus an `edgeKind` field matching the District Edge type. The junction `type` reflects the physical boundary: Wall edges produce `type: 'Wall'` junctions, Canal edges produce `type: 'Canal'`, MainRoad edges produce `type: 'Stone'`. Wall and Canal junctions are skipped by the StreetRenderer (their meshes are built by DistrictRenderer instead). Distinct from a bend node (degree 2).
_Avoid_: intersection, crossroads

**District Edge**:
The boundary line between two adjacent districts (or between a district and the city exterior), assignable to a type (Wall, MainRoad, Canal, Docks). Before either adjacent district is defined, represented as a straight polyline; once either side has a district, represented by the boundary-sampled street chain. Distinct from a terrain **Edge** (which separates terrain regions).
_Avoid_: city edge, district border, district boundary

**Wall** (district edge type):
A fortified city-edge forming a defensive barrier between or around districts.
_Avoid_: fence, barrier, rampart

**Auto-Walling**:
The probabilistic assignment of Wall District Edges at District lock time, driven by the locking district's `walledChance` (internal district-to-district edges) and `externalWalledChance` (outer city-boundary edges) config values. Pre-existing manual District Edge assignments are never overridden; when two districts share an edge, the first to lock determines the outcome.
_Avoid_: auto-wall generation, automatic walls

**MainRoad** (district edge type):
A major road city-edge indicating a primary transit corridor between two districts.
_Avoid_: highway, main street

**Canal** (district edge type):
A navigable waterway city-edge connecting districts; requires adjacent water terrain.
_Avoid_: channel, waterway

**Docks** (district edge type):
A maritime city-edge placed where the city meets a Sea, Lake, or River region, enabling water-based trade. Like Wall/Canal, gets its own Alley (wood surface) for ==plot== frontage, plus a row of Piers. Both are only generated along the segments of the Docks edge that are actually adjacent to water (checked per street-chain segment, not once for the whole edge as `_cityEdgeIsNearWater` does at assignment time) — segments of a Docks edge that border ordinary land remain plain road.
_Avoid_: port, harbor

**Pier**:
A discrete wood jetty projecting from a Docks Alley out into the water, with mooring space for boats along its length (no boats placed yet — future work). Spaced one per block-frontage, same cadence as ==plot==s along an ordinary street (street → cross Alley → Pier). Never projects past half the width of a River (the water body's centreline); Sea/Lake piers have no such cap.
_Avoid_: jetty (as the canonical term), wharf, quay

**Alley**:
A narrow street generated automatically on each side of a Wall, Canal, or Docks District Edge, providing ==plot== frontage where the structure would otherwise leave ==plot==s landlocked. Stone surface beside Canals, Mud beside Walls, Wood beside Docks.
_Avoid_: service road, back lane

---

### Blocks & ==Plot==s derived from Blocks

**Gutter**:
The edge of the road on each side of a street centerline. These are offset from the street centers, and at junctions are mitred to find the junction point with the adjacent road's gutter. They do not cross roads or cross into junctions at all. They are always continuous, multi segment loops, which are the logical boundary of Blocks.
_Avoid_: curb, kerb, road edge

**Block**:
A contiguous polygon of land bounded by gutters, derived by tracing planar faces of the gutter graph. The raw unit of land between roads.
_Avoid_: parcel, lot, face

**City square**:
A block whose area falls below the district's `square_threshhold` threshold, or one that cannot fit any ==plot==s. Rendered as a paved surface in the district's street colour rather than subdivided. Adjacent squares in a district join into a Square cluster.
_Avoid_: plaza

**Square cluster**:
A maximal group of same-district City squares joined across shared street segments (each join spans a full street between two junctions, not a single shared junction), rendered as one continuous paved plaza and hosting the district's Landmarks.
_Avoid_: plaza, joined squares

**==Plot==**:
Plots can also be derived from city blocks,  generated by `PlotVoronoiGenerator. `These are typically inside cities, and will have buildings constructed.  Units of property ownership where buildings are usually built.
_Avoid_: lot, building, parcel

**Fence**:
A low wall surrounding / rendered on the ==plot== boundary.
_Avoid_: wall, barrier, rampart

---

### Groundplane

**Groundplane**:
The single contiguous tessellation of the city ground — streets, gutters, blocks, ==plot==s, and terrain ==plot==s — where every (X, Z) is covered by exactly one Surface.
_Avoid_: ground mesh, terrain mesh

**Point**:
A shared Groundplane vertex `{id, x, y[, z]}` held in the persistent point registry. Multiple Surfaces referencing the same id move together — the basis for the future per-point z-height.
_Avoid_: vertex, corner

**Surface**:
A typed Groundplane polygon defined by an ordered list of Point ids (street, gutter, block, ==plot==, or terrain ==plot==).
_Avoid_: face, poly
