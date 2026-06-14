# Guild Wars Web

A collaborative city-building and guild-competition game. The web app manages setup (terrain, city, streets, guilds) and the live game loop (round phases, actions, factions, resources). This context covers the full server-and-client system.

## Language

### Multiplayer & Turns

**Player**:
A human participant in a game. A player controls exactly one Guild.
_Avoid_: user, client

**Seat**:
A player's claimed place in a game — a name plus a server-issued Seat key. Created by joining a host's server; one game has a fixed set of seats.
_Avoid_: account, session, slot

**Seat key**:
The per-seat credential a client attaches to every request so the server knows which player is acting. Deliberately *not* called a "token".
_Avoid_: token (reserved for the game Token economy), session id, auth token

**Initiative**:
The server-fixed turn order, set by an in-app d20 roll per seat, that drives whose turn it is during the Setup sub-phases.
_Avoid_: turn order, play order

**Reversed Initiative**:
Initiative walked back-to-front. District Setup proceeds in Reversed Initiative; Terrain Setup and Guild Creation proceed in forward Initiative.
_Avoid_: reverse order

**Token**:
A per-player game counter spent during play — one of Veto, Guild, Character, or Round Token. Distinct from a Seat key (which is the auth credential).
_Avoid_: seat key, credential

**Lobby**:
The pre-Setup state where seats gather and Initiative is rolled before Terrain Setup begins.
_Avoid_: waiting room, staging

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
1. A river may not be adjacent to a Lake or a Sea region.  
  1a. When a River is "Applied" alongside an adjacent Lake or a Sea region, the adjacent edge reverts to being undefined.
  1b. When a Lake or Sea is defined adjacent to an existing River, the adjacent edge reverts to being undefined.
2. Every free endpoint of a River path must terminate at one of: an existing River, a Sea region, a Lake region, or the physical map boundary.
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
The pre-game phase covering Terrain Setup, City Subdivision, and Guild Creation, in that order. Shared but **turn-ordered by Initiative** — players act in turn, not freely in parallel.
_Avoid_: initialization, game creation

**Terrain Setup**:
The first Setup sub-phase — players assign terrain types to regions and edge types to boundaries.
_Avoid_: world generation, map creation

**City Subdivision**:
The second Setup sub-phase — the city region is divided into named districts. Assigning a district its type immediately generates that district's streets, blocks, plots, and buildings; the player may regenerate (reseed) it, then lock it in.
_Avoid_: district creation, city planning, street setup

**Guild Creation**:
The third and final Setup sub-phase — players define guilds, recruit characters, and allocate starting resources.
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
An organisation controlled by a single player (one per Seat), with a Guild Leader and Second, a Guild Headquarters, a per-faction Influence map, a per-faction Standing map, and a resource stockpile. The primary competitive unit.
_Avoid_: team, company, faction (faction has a distinct meaning)

**Guild Headquarters**:
The single Plot or Landmark a guild designates as its base. Grants +30 Influence and +20 Standing with its district's faction.
_Avoid_: Guildhouse, guild house, HQ

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
A city constituency — a district, a terrain resource source, a Trading Destination, or the Leadership — with which guilds build Influence. Not the same as a Guild.
_Avoid_: guild, group, party

**Influence**:
A 0–100 per-actor-per-faction score representing the degree of control an actor holds over a faction's decisions. Guilds start at 0; the Leadership faction starts at 60 over all district and leadership factions. The sum of all actors' Influence over any single faction must not exceed 100.
_Avoid_: standing, reputation, relationship score

**Standing**:
A 0–100 symmetric per-pair mutual-regard score between any two entities (factions, guilds, threats, trade routes). Default 50 (neutral). Threats start at 30 against all other entities.
_Avoid_: influence, diplomacy score, relationship

**Faction Health**:
A single 0–100 value on a faction (the same for all guilds), starting at 70, that linearly scales the resources that faction produces (`produced = base × Health/100`).
_Avoid_: vitality, condition

**Threat**:
A danger marker (dragon, plague, invasion, etc.) placed on a map-edge region that guilds can earn points by addressing.
_Avoid_: hazard, crisis, enemy

**Trading Destination**:
An off-map faction placed on a map-edge region that supplies and consumes resources; connected to the city by a road.
_Avoid_: trade partner, external market

**City Leader**:
The NPC figure heading the Leadership District, whose Succession Method shapes city politics and certain victory conditions.
_Avoid_: ruler, king, mayor, city governor

### Resources & Services

**Resource**:
A commodity (Gold, Basic Food, etc.) produced and consumed by districts each round. Has units; can be stockpiled by Guilds.
_Avoid_: commodity, good, currency (currency is Gold only)

**Service**:
A non-physical output (Security, Labour, etc.) produced and consumed by districts each round. Mechanically identical to a Resource — has units, can be stockpiled by Guilds. Distinct in flavour only.
_Avoid_: resource (when precision matters; in rules text use "Resource or Service" to cover both)

**Gold**:
The primary currency resource, automatically produced by every non-Residential district each round. Not selectable as an explicit "Produced Resource or Service" in setup — it is always implicit.
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
A street node where three or more streets or street like connections meet (degree ≥ 3). Interior junctions carry a single `districtId`. Boundary junctions carry `left` and `right` district ids instead, plus an `edgeKind` field matching the District Edge type. The junction `type` reflects the physical boundary: Wall edges produce `type: 'Wall'` junctions, Canal edges produce `type: 'Canal'`, MainRoad edges produce `type: 'Stone'`. Wall and Canal junctions are skipped by the StreetRenderer (their meshes are built by DistrictRenderer instead). `right: null` indicates the exterior (outer city boundary). Distinct from a bend node (degree 2).
_Avoid_: intersection, crossroads

**District Edge**:
The boundary line between two adjacent districts (or between a district and the city exterior), assignable to a type (Wall, MainRoad, Canal, Docks). Before either adjacent district is defined, represented as a straight polyline; once either side has a district, represented by the boundary-sampled street chain. Distinct from a terrain **Edge** (which separates terrain regions).
_Avoid_: city edge, district border, district boundary

**Wall** (district edge type):
A fortified city-edge forming a defensive barrier between or around districts.
_Avoid_: fence, barrier, rampart

**MainRoad** (district edge type):
A major road city-edge indicating a primary transit corridor between two districts.
_Avoid_: highway, main street

**Canal** (district edge type):
A navigable waterway city-edge connecting districts; requires adjacent water terrain.
_Avoid_: channel, waterway

**Docks** (district edge type):
A maritime city-edge placed where the city meets a Sea, Lake, or River region, enabling water-based trade.
_Avoid_: port, harbor

**Alley**:
A narrow street generated automatically on each side of a Wall or Canal District Edge, providing plot frontage where the structure would otherwise leave plots landlocked. Stone surface beside Canals; Mud surface beside Walls.
_Avoid_: service road, back lane

### Blocks & Plots

**Gutter**:
The edge of the road on each side of a street centerline.  These are offset from the street centers, and at junctions are mitred to find the junction point with the adjacent road's gutter.  They do not cross roads or cross into junctions at all.  They are always continous, multi segment loops, which are the logical boundary of Blocks.
_Avoid_: curb, kerb, road edge

**Block**:
A contiguous polygon of land bounded by gutters, derived by tracing planar faces of the gutter graph. The raw unit of land between roads.
_Avoid_: parcel, lot, face

**City square**:
A block whose area falls below the district's `square_threshhold` threshold, or one that cannot fit any plots. Rendered as a paved surface in the district's street colour rather than subdivided. Adjacent squares in a district join into a Square cluster.
_Avoid_: plaza

**Square cluster**:
A maximal group of same-district City squares joined across shared street segments (each join spans a full street between two junctions, not a single shared junction), rendered as one continuous paved plaza and hosting the district's Landmarks.
_Avoid_: plaza, joined squares

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
The compact deterministic descriptor (seed, footprint, floors, per-floor wall material, roof, chimneys, suppressedFaces) a Parametric Building is assembled from. The footprint is a wing list (`{type:'wings', wings:[…]}`) of axis-aligned rectangles; the server emits the spec; the client assembles deterministically (no `Math.random`).
_Avoid_: blueprint, recipe

**Suppressed face**:
A building face where wall panels, interior posts, and roof trim are omitted because the face abuts a neighbour building of equal or greater height. Corner posts shared with perpendicular faces are retained. Encoded in the Building Spec as `suppressedFaces`, pre-computed by the server.
_Avoid_: hidden face, invisible wall, party wall
