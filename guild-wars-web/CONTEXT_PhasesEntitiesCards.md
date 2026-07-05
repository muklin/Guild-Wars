# Guild Wars Web — Phases, Game Entities & Cards

Game concepts for setup/round phases, guilds, factions, and card mechanics. Load when dealing with rulesets and UIs. This file will likely be split further as more subsystems are added.

## Language

### Phases

#### **Setup Phase**:
The pre-game phase covering Terrain Setup, City Subdivision, and Guild Creation, in that order. Shared but **turn-ordered by Initiative** — players act freely in parallel.
_Avoid_: initialization, game creation

**Terrain Setup**:
The first Setup sub-phase — players assign terrain types to regions and edge types to boundaries. Players also define Foreign Powers, Gods, and a Magic System via buttons in the Terrain Setup panel.
_Avoid_: world generation, map creation

**District Setup**:
The second Setup sub-phase — the city region is divided into named districts. Assigning a district its type immediately generates that district's streets, blocks, plots, and buildings; the player may regenerate (reseed) it, then lock it in.  This is the only time players can edit streets or Districts at large. 
_Avoid_: district creation, city planning, street setup

**Guild Creation**:
The third and final Setup sub-phase — players define guilds, recruit characters, and allocate starting Resources and Services.
_Avoid_: guild setup, character creation

#### **Actual Game**:

**Upkeep Phase**:
The first segment of a game round. Sequence: (1) each faction produces Resources and Services from prior-round stockpiles scaled by Faction Health; (2) the shared trade queue resolves — all factions and guilds compete to buy and sell at Standing-adjusted Market Values; (3) Market Values recalculate based on new stockpile levels vs the World-Creation Baseline.
_Avoid_: income phase, production phase

**Planning Phase**:
The main segment of a game round: guilds declare and execute actions (PvP, PvE, trade, district control).
_Avoid_: action phase, main phase

**Activities Phase**:
The majority of Game play, whe actions planned take place. 


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
A 3rd-level character who heads a guild. Succession rules are set by the city's Leadership Class.
_Avoid_: guild master, commander, head

**Guild Second**:
A 1st-level character who serves as deputy to the Guild Leader.
_Avoid_: second-in-command, deputy

**Faction**:
A city constituency — a district, a terrain resource source, a Trading Destination, a Threat, or the Leadership — with which guilds build Influence. Not the same as a Guild. Each faction has a `typeName` (the type label, e.g. "Market", "Forest") and a `name` (the player-assigned short label, e.g. "Silk Ward"). Displayed as "Name — TypeName" in the Factions Panel once named.
_Avoid_: guild, group, party

**Entity Name**:
The player-assigned short label for a terrain region, edge, district, Foreign Power, Trading Destination, or Threat — required before Apply completes. Assigned via a naming dialog with generated suggestions. Distinct from the entity's type label (`typeName`). Displayed as the primary identifier in the Factions Panel.
_Avoid_: title, label, type name

**Influence**:
A 0–100 per-actor-per-faction score representing the degree of control an actor holds over a faction's decisions. Guilds start at 0; the Leadership faction starts at 60 over all district and leadership factions. The sum of all actors' Influence over any single faction must not exceed 100.
_Avoid_: standing, reputation, relationship score

**Standing**:
A 0–100 symmetric per-pair mutual-regard score between any two entities (factions, guilds, threats, trade routes). Default 50 (neutral). Guilds start at 0 Standing with Threat factions.
_Avoid_: influence, diplomacy score, relationship

**Faction Health**:
A single 0–100 value on a faction (the same for all guilds), starting at 70, that linearly scales the Resources and Services that faction produces (`produced = base × Health/100`).
_Avoid_: vitality, condition, district health

**Threat**:
A danger that originates FROM a terrain plot or a Foreign Power and always targets the city. Threat-Factions (those anchored to a Foreign Power) have Influence and Standing mechanics: guilds start at 0 Influence and 0 Standing. Guilds can build both over time — collaborating with a Threat is a valid path to winning the game.
_Avoid_: hazard, crisis, enemy

**Foreign Power**:
An off-map civilization, culture, or organised entity (kingdom, empire, goblin infestation, etc.) defined during Terrain Setup. Represented by a compass direction (continuous angle; each occupied arc blocks the adjacent 45° for future placements), a player-assigned name, colour, and free-text description. Max 8 per game. NOT a Faction until a relationship is assigned during City Subdivision. Declaration is subject to veto via the Event Card system.
_Avoid_: neighbour, regional neighbour, external entity

**Trade Route**:
The relationship that converts a Foreign Power into a Trading Destination Faction. Assigned during City Subdivision. A Foreign Power with a Trade Route supplies and consumes Resources and Services; connected to the city by a road. Exempt from input requirements — always produces at full Base Production Units regardless of Faction Health. Mutually exclusive with Threat status.
_Avoid_: trade partner, external market, trading destination (use Trading Destination when referring to the Faction that results)

**Trading Destination**:
A Foreign Power that has been assigned a Trade Route. It becomes a Faction at this point, with full Influence and Standing mechanics.
_Avoid_: trade partner, external market

**City Leader**:
The NPC figure heading the Leadership District, whose Leadership Class shapes city politics and certain victory conditions.
_Avoid_: ruler, king, mayor, city governor

**Leadership Class**:
The governance type of the Leadership District — one of Monarchy, Republic, Tyrant, Oligarchy, Theocracy, or Anarchist. Shapes succession rules and certain victory conditions. In Theocracy, god alignment is mandatory.
_Avoid_: succession method, leadership type, government type

### Worldbuilding

**God**:
A deity defined during Terrain Setup by selecting up to 3 Domains and assigning a name. Multiple gods may be defined. Declaration is subject to veto via the Event Card system. God alignment is optional for Residential and Leadership districts; mandatory for Religious districts and Leadership districts with Theocracy class.
_Avoid_: deity (acceptable synonym, but God is the canonical term in UI)

**Domain**:
A thematic portfolio of a god (e.g. War, Trade, Death, Harvest). Twelve Domains are drawn at random from the Domain Library when the first god is created — only those twelve are available for the current game.
_Avoid_: aspect, sphere, portfolio

**Domain Library**:
The full set of possible Domains from which the game's twelve active Domains are drawn when the first god is created.
_Avoid_: domain pool, global domains

**Magic System**:
The single framework of magic that governs the world, defined during Terrain Setup by the first player to claim it (first-come-first-served). Chosen from a Magic Concept Library of real-world fictional archetypes (MtG land-power, Allomancy, D&D Schools, etc.). Only one Magic System exists per game. Once defined, any player may refine it on their turn. If undefined at the end of Terrain Setup, defaults to the D&D magic system. Declaration is subject to veto via the Event Card system.
_Avoid_: magic, magic type, spell system

**Magic Concept Library**:
The curated list of fictional magic-system archetypes from which the game's Magic System is chosen.
_Avoid_: magic library, system list

**Worship**:
A Service automatically produced by a Religious district that has been aligned to a god. Its full name is "Worship of \<godname\>". Inputs are Labour and Gold.
_Avoid_: prayer, devotion, faith (as a resource/service name)

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