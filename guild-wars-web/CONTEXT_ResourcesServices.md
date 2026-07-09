# Guild Wars Web — Resources & Services

Terminology for game resources and services. Load whenever Resources or Services are mentioned.

## Language

### Resources & Services

**Commodity**:
The umbrella economic item produced and consumed by districts each round. Has units; can be stockpiled by Guilds. Every Commodity declares exactly one Type: Raw, Resource, or Service.
_Avoid_: resource (as the umbrella term — "Resource" is reserved for one specific Type below), good, currency (currency is Gold only)

**Raw**:
A Commodity Type that can only be harvested at a Terrain plot — never produced by a district. Its Recipe is always fixed to Labour + Security (no player-chosen ingredients). Every Raw Commodity also declares a required sub-classification of Food or Resource (e.g. "Basic Food" is Raw/Food; "Iron Ore" is Raw/Resource) — this deliberately reuses the word "Resource" for the sub-classification, distinct from the sibling Resource Type below; a Raw/Resource item is never Type=Resource.
_Avoid_: resource (alone, when Type precision matters — say "Raw", "Raw Resource", or "Raw Food")

**Resource**:
A Commodity Type: a manufactured, physical output (as opposed to Raw, which is harvested with a fixed recipe, or Service, which is non-physical). See Recipe for how a Resource is manufactured.
_Avoid_: commodity (reserved for the umbrella term), good

**Service**:
A Commodity Type: a non-physical output (Security, Labour, Worship, etc.). Mechanically identical to a Resource — has units, can be stockpiled by Guilds, and follows the same Recipe rule — distinct in flavour only. Every Service also declares a required sub-classification of Entertainment or Tradeable. Services may never be sold to a Foreign Power.
_Avoid_: resource (when Type precision matters; in rules text use "Resource or Service" to cover both non-Raw Types)

**Recipe**:
How a Resource or Service Commodity is manufactured: 1-2 ingredient Commodities (any existing Commodity of any Type — Raw, Resource, or Service — enabling multi-hop production chains) plus exactly one required special input chosen from Labour, Gold, or Worship. A Commodity may never require itself, directly or transitively. A district's consumed Resources/Services are fully derived from the union of the Recipes (ingredients + special input) of everything it produces — there is no separately-configured consumption list.

**Gold**:
The primary currency resource, automatically produced by every non-Residential district each round. Not selectable as an explicit "Produced Resource or Service" in setup — it is always implicit.
_Avoid_: money, coin, currency

**Labour**:
A workforce resource produced by Residential districts (Slums and Middle class).
_Avoid_: workers, manpower, workforce

**Market Value**:
The global, per-Commodity current price in Gold. Shifts up to ±10% per round based on total stockpile (all factions combined) vs the World-Creation Baseline. Players set the initial value at Commodity creation; the UI auto-populates it as the sum of all Recipe input costs (ingredients plus the chosen special input) per unit produced. Player may adjust the auto-populated value by up to ±20%.
_Avoid_: market price, resource value, resource price

**World-Creation Baseline**:
The fixed supply reference for each resource, computed once at setup as the sum of all factions' Base Production Units for that resource. Used each round to measure scarcity: if total stockpile ≥ 2× baseline the Market Value drops 10% (the maximum single-round shift).
_Avoid_: equilibrium supply, reference supply

**Base Production Units**:
The fixed unit count a faction can produce per round at full Faction Health, calculated at creation as `floor(100Gp ÷ initial Market Value)`. Actual production per round = `Base Production Units × (Faction Health ÷ 100)`. Never recalculated after creation.
_Avoid_: production capacity, output rate, max production

**Faction Gold**:
The autonomous NPC economic gold balance held by each faction, starting at 100Gp. Separate from Guild Gold. Factions spend it to buy inputs and receive it when selling outputs in the shared trade queue each round.
_Avoid_: faction funds, faction treasury

**Guild Gold**:
Player-controlled gold held in `guild.resources`. Separate from Faction Gold. Guilds set desired purchases at end of round; guild gold is spent when those orders execute in the shared trade queue alongside faction orders.
_Avoid_: resources (when referring specifically to the gold balance)

**Worship**:
A Service automatically produced by a Religious district aligned to a god. Full name: "Worship of \<godname\>". A regular Service for Recipe purposes — its special input is Labour or Gold (never both, and never Worship itself — no self-reference). See also: God (CONTEXT_PhasesEntitiesCards.md).
_Avoid_: prayer, devotion, faith
