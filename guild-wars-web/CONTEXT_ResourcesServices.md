# Guild Wars Web — Resources & Services

Terminology for game resources and services. Load whenever Resources or Services are mentioned.

## Language

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

**Market Value**:
The global, per-resource current price in Gold. Shifts up to ±10% per round based on total stockpile (all factions combined) vs the World-Creation Baseline. Players set the initial value at resource creation; the UI auto-populates it as the sum of all input costs per unit produced. Player may adjust the auto-populated value by up to ±20%.
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
A Service automatically produced by a Religious district aligned to a god. Full name: "Worship of \<godname\>". Inputs are Labour and Gold. See also: God (CONTEXT_PhasesEntitiesCards.md).
_Avoid_: prayer, devotion, faith
