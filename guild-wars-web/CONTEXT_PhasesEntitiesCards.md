# Guild Wars Web — Phases, Game Entities & Cards

Game concepts for setup/round phases, guilds, factions, and card mechanics. Load when dealing with rulesets and UIs. This file will likely be split further as more subsystems are added.

## Language

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

### Cards

**Situation Card**:
A card drawn at the start of a round that applies a global effect to all guilds for that round's duration.
_Avoid_: event card, global card

**Special Event Card**:
A card drawn at the round start that sets a conditional trigger; personal ones award a Round Point when their condition is met.
_Avoid_: event card (ambiguous with Situation Card), bonus card

### UI Feedback

**Event Card**:
A non-blocking, auto-dismissing UI notification that appears in the right-side stack when any player makes a declaration during a Setup sub-phase. Each card shows the declaring player's name, the entity type and name, and a 30-second green pill countdown. Vetoable Event Cards (red border) reveal a round VETO button on hover — only to players other than the one who declared. Non-vetoable cards have a grey border. Distinct from Situation Cards and Special Event Cards, which are physical game-round cards.
_Avoid_: modal (reserved for full-screen blocking overlays), toast (developer synonym), action card
