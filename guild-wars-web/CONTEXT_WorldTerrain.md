# Guild Wars Web — World & Terrain

Terminology for terrain regions, edges, and city districts. Note: Streets, Blocks & Plots are generated within the city but their concepts can also apply outside it — see [CONTEXT_StreetsBlocksPlots.md](CONTEXT_StreetsBlocksPlots.md).

## Language

### World & Terrain

**Terrain**:
The typed landscape of a region — one of a fixed set of types (Plains, Forest, Hills, Mountains, Sea, Lake, River, Cliff, City, etc.). Assigned to regions during Terrain Setup. Made up of multiple terrain plots.
_Avoid_: biome, tile type, land type

**Edge**:
The boundary line between two adjacent Terrains, which can be assigned a type (River, Cliff, etc.).
_Avoid_: border, boundary

**River** (edge type):
An edge marked as a river channel. A valid River selection must satisfy all four rules:
1. A river may not be adjacent to a Lake or a Sea terrain.
  1a. When a River is "Applied" alongside an adjacent Lake or a Sea terrain, the adjacent edge reverts to being undefined.
  1b. When a Lake or Sea is defined adjacent to an existing River, the adjacent edge reverts to being undefined.
2. Every free endpoint of a River path must terminate at one of: an existing River, a Sea terrain, a Lake terrain, or the physical map boundary.
_Avoid_: stream, waterway

**Terrain plot**:
A fine grained voronoi cell. These become Districts in the City Terrain.

**City Terrain**:
The Terrain identified to become the City, in this game, made up of Districts, and District Edges.

**District**:
A terrain plot within the city terrain, assigned a purpose type (Residential, Market, Military, Entertainment, Religious, Magical, Industry, or Leadership).
_Avoid_: zone, quarter, ward

**Leadership District**:
The single special district that serves as the seat of city government. Has a Succession Method and a City Leader NPC rather than a resource type.
_Avoid_: government district, ruling district
