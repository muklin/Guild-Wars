# Guild Wars Web

A collaborative city-building and guild-competition game. The web app manages setup (terrain, city, streets, guilds) and the live game loop (round phases, actions, factions, resources). This context covers the full server-and-client system.

## Language

### World & Terrain

**Terrain**:
The typed landscape of a region — one of a fixed set of types (Plains, Forest, Hills, Mountains, Sea, Lake, River, Cliff, City, etc.). Assigned to regions during Terrain Setup.
_Avoid_: biome, tile type, land type

**Region**:
A single Voronoi cell of the world terrain, assigned a terrain type (Plains, Forest, Hills, etc.).
_Avoid_: zone, area, cell (cell is reserved for fine-grained subdivision)

**Edge**:
The boundary line between two adjacent regions, which can be assigned a type (River, Cliff, etc.).
_Avoid_: border, boundary

**River** (edge type):
An edge marked as a river channel. A valid River selection must satisfy all four rules:
1. No two River edges may run alongside each other (share an adjacent region) unless they share an endpoint — rivers may converge but not run in parallel.
2. A River edge may not run alongside a Lake or a Sea region (neither adjacent region may be a Lake or a Sea).
3. Every free endpoint of a River path must terminate at one of: an existing River, a Sea region, a Lake region, or the physical map boundary.
_Avoid_: stream, waterway

**District**:
A named subdivision of city land within a terrain region, assigned a purpose type (Residential, Market, Military, Entertainment, Religious, Magical, Industry, or Leadership).
_Avoid_: zone, quarter, ward

**Residential Class**:
A sub-classification of Residential districts — Slums, Middle, or Noble — affecting both resource production and street-generation parameters.
_Avoid_: residential tier, class type

**Leadership District**:
The single special district that serves as the seat of city government. Has a Succession Method and a City Leader NPC rather than a resource type.
_Avoid_: government district, ruling district

### Phases

**Setup Phase**:
The collaborative pre-game phase covering Terrain Setup, City Subdivision, Street Setup, and Guild Creation, in that order.
_Avoid_: initialization, game creation

**Terrain Setup**:
The first Setup sub-phase — players assign terrain types to regions and edge types to boundaries.
_Avoid_: world generation, map creation

**City Subdivision**:
The second Setup sub-phase — the city region is divided into named districts with assigned types and boundaries.
_Avoid_: district creation, city planning

**Street Setup**:
The third Setup sub-phase — streets, blocks, and plots are generated within each district.
_Avoid_: street generation

**Guild Creation**:
The fourth and final Setup sub-phase — players define guilds, recruit characters, and allocate starting resources.
_Avoid_: guild setup, character creation

**Upkeep Phase**:
The first segment of a game round: districts produce resources for their controlling guilds.
_Avoid_: income phase, production phase

**Planning Phase**:
The main segment of a game round: guilds declare and execute actions (PvP, PvE, trade, district control).
_Avoid_: action phase, main phase

**Pay the Bills**:
The closing segment of a game round: guilds pay consumption costs for districts they control and salaries for their characters.
_Avoid_: maintenance phase, end phase

### Game Entities

**Guild**:
An organisation controlled by a single player, composed of characters, resources, and controlled districts. The primary competitive unit.
_Avoid_: team, company, faction (faction has a distinct meaning)

**Squad**:
A named sub-group of guild members that executes one action per round. A guild plans exactly one action per squad.
_Avoid_: party, unit, group

**Guild Leader**:
A 3rd-level character who heads a guild. Succession rules are set by the city's Succession Method.
_Avoid_: guild master, commander, head

**Guild Second**:
A 1st-level character who serves as deputy to the Guild Leader.
_Avoid_: second-in-command, deputy

**Faction**:
A city constituency — a district, a terrain resource source, a Trading Destination, or the Leadership — with which guilds build standing. Not the same as a Guild.
_Avoid_: guild, group, party

**Faction Standing**:
A 0–100 numeric score representing a guild's relationship with a faction, starting at 50 (neutral).
_Avoid_: influence, relationship score, reputation

**Threat**:
A danger marker (dragon, plague, invasion, etc.) placed on a map-edge region that guilds can earn points by addressing.
_Avoid_: hazard, crisis, enemy

**Trading Destination**:
An off-map faction placed on a map-edge region that supplies and consumes resources; connected to the city by a road.
_Avoid_: trade partner, external market

**City Leader**:
The NPC figure heading the Leadership District, whose Succession Method shapes city politics and certain victory conditions.
_Avoid_: ruler, king, mayor, city governor

### Resources

**Resource**:
A commodity (Gold, Labour, Food, Water, etc.) produced and consumed by districts each round.
_Avoid_: commodity, good, currency (currency is Gold only)

**Gold**:
The primary currency resource, produced by Market districts and some Trading Destinations.
_Avoid_: money, coin, currency

**Labour**:
A workforce resource produced by Residential districts (Slums and Middle class).
_Avoid_: workers, manpower, workforce

### Cards

**Situation Card**:
A card drawn at the start of a round that applies a global effect to all guilds for that round's duration.
_Avoid_: event card, global card

**Special Event Card**:
A card drawn at the round start that sets a conditional trigger; personal ones award a Round Point when their condition is met.
_Avoid_: event card (ambiguous with Situation Card), bonus card

### Streets

**Street graph**:
The network of nodes and edges representing road centerlines within a city. Generated per-district by `StreetVoronoiGenerator`.
_Avoid_: road network, road graph

**Street node**:
A point in the street graph. Nodes with degree ≥ 3 are **junctions**; nodes with degree 2 are **bends**.
_Avoid_: vertex, waypoint

**Junction**:
A street node where three or more streets meet (degree ≥ 3). Distinct from a bend node (degree 2).
_Avoid_: intersection, crossroads

**City Edge**:
The boundary line between two adjacent districts, assignable to a type (Wall, MainRoad, Canal, Docks). Distinct from a terrain **Edge** (which separates terrain regions).
_Avoid_: district border, district boundary

**Wall** (city edge type):
A fortified city-edge forming a defensive barrier between or around districts.
_Avoid_: fence, barrier, rampart

**MainRoad** (city edge type):
A major road city-edge indicating a primary transit corridor between two districts.
_Avoid_: highway, main street

**Canal** (city edge type):
A navigable waterway city-edge connecting districts; requires adjacent water terrain.
_Avoid_: channel, waterway

**Docks** (city edge type):
A maritime city-edge placed where the city meets a Sea, Lake, or River region, enabling water-based trade.
_Avoid_: port, harbor

### Blocks & Plots

**Gutter**:
The edge of the road on each side of a street centerline.  These are offset from the street centers, and at junctions are mitred to find the junction point with the adjacent road's gutter.  They do not cross roads or cross into junctions at all.  They are always continous, multi segment loops, which are the logical boundary of Blocks.
_Avoid_: curb, kerb, road edge

**Block**:
A contiguous polygon of land bounded by gutters, derived by tracing planar faces of the gutter graph. The raw unit of land between roads.
_Avoid_: parcel, lot, face

**City square**:
A block whose area falls below the district's `square_threshhold` threshold, or one that cannot fit any plots. Rendered as a paved surface in the district's street colour rather than subdivided.
_Avoid_: plaza (plaza is a design intent, not a generation category)

**Plot**:
A single land parcel within a block — a unit of property ownership where buildings are built. Generated by a plot Voronoi seeded inside the plot and along the block's street edges.
_Avoid_: lot, building, parcel

**Plot Voronoi**:
The Voronoi diagram used to subdivide a block into plots. Seeds are placed along street graph edges at `lotWidth` intervals, with a `lotWidth / 2` dead zone pulled back from each junction node.
_Avoid_: lot Voronoi, building Voronoi

**Fence**:
A low wall surrounding / rendered on the plot boundary.   
_Avoid_: wall, barrier, rampart


### Buildings

**Building**:
A structure generated within a plot. A plot can contain one or more building footprints.
_Avoid_: structure, object
