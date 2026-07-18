# Bugs:
- I don't like the current FP indication.  FP names are often not rendered.
- Archways are not appearing in game.  I've not yet found one.  


# Architecture
(from the 2026-07-16 architecture review, re-investigated and progressed 2026-07-19 — plan "wondrous-conjuring-wand" is the current sequencing plan; "logical-booping-bonbon" no longer has the StreetVoronoiGenerator detail, that pointer was stale)

- SetupPhase.js kitchen-sink split: IN PROGRESS. `GroundplaneAudit` extracted (2026-07-19) — river/cliff/District-Edge pullback, DCEL materialize/parity, groundplane Surface/Region sync, and the audit log now live in `server/engine/GroundplaneAudit.js` (28 methods, ~1950 lines). Dependency analysis before extraction found the whole bucket touched nothing else in SetupPhase.js besides `gameStateManager`/`worldGenerator` — the new module holds a live reference to the owning SetupPhase instance (`this.sp`) rather than copying those two, since `worldGenerator` is reassigned on every `initialize()` (New Game). SetupPhase.js dropped from 4529 to 2592 lines; kept thin delegates only for the 7 methods still called from elsewhere in SetupPhase.js plus `_recoverGeometryFromSeeds` (called from `server/index.js`) — every other moved method has zero external callers. All existing test suites pass; one test file (`SetupPhase.districtEdgeFaces.test.mjs`) updated to reference `GroundplaneAudit.prototype` directly since it exercised internal-only methods via prototype access. TerrainSetup, DistrictSetup, StreetBlockPlotPipeline still to do.

- StreetVoronoiGenerator.generate()'s repair passes: DONE — added the missing `DCEL.insertEdge` primitive and swapped the hand-rolled union-find near-duplicate-node merge for `registry.collapseNearbyVertices` (same clustering algorithm and survivor convention, position-averaging logic unchanged; verified against all golden fixtures + every other affected test suite, zero diffs). The remaining 8 named passes (`snapPerimeterJunctionsToBoundary`, `resolveStreetCrossings`, `absorbCollinearNodes`, `snapInteriorNodesToBoundary`, `pruneAcuteStubs`, `removeOrphanComponents`, `reconcileParallelStreetTypes`, `ensureTopology`) were deliberately left as plain array code: each is already a one-line filter/rebuild, and wrapping that in a throwaway DCEL (mint registry ids, insertEdge every edge, do the op, walk back out to arrays) would be more code and more translation-bug surface for no correctness or testability gain. They're now covered by the characterization harness (`StreetVoronoiGenerator.characterization.test.mjs` + golden fixtures) for future safety. Genuinely swapping them would need a bigger, separate architectural move — one persistent DCEL built after the merge and kept alive across all passes, converted to arrays once at the end — not sized or scheduled yet.

- Mesh disposal: DONE — new `client/rendering/utils/MeshLayer.js` (`disposeOne`/`disposeAll`) is now the single owner of the dispose-GPU-resources-then-unlink-from-scene pairing; all 37 real call sites across TerrainRenderer/GroundRenderer/DistrictRenderer migrated off the old hand-rolled `disposeMesh(x); scene.remove(x)` pattern.

- WorldRenderer.js (28 commits, second only to SetupPhase.js) — confirmed, no longer speculative: 1371+ lines, one class owning camera/animation, terrain render+hover+pick, district render+hover+pick, street/junction/block/plot render+hover+pick, walk mode, top-down flatten, debug visualization, HQ/faction highlighting. Not started yet.


# Features:
## General 
 
- Sometime Edge definition panels are not in a logical place.  

## Terrain Mode




## District Mode

### Outside city Plot improvements. 
- Hovering ie Mines, Fishing Factions, doesn't highlight their position on the map.  it should. 
- Hovering Foreign Powers (Trade routes or Threats) doesn't highlight their FP indicators on the map. it should. 
- Add a new outside City type, which is "Village" this is a new District.  
- all new outside city improvements should add a road connecting the new improvement to the nearesty City Gate.  Also detect other Roads within 2 plots distance, that are not in the direction of the city, and build roads to those as well.  

- Mines, Forestry type additions are applied to whole terrain, not just the terrain plot.  
Use case:
1. User selects a terrain surface.  
 - User selects mine, 
 - configures it to produce Iron Ore.
 - User applies the disrict. 
2. User selects an adjacent terrain surface, in the same Terrain region. 
 - User selects mine, 
 - the existing configuration of the sibling, (mine that creates Iron Ore) is prepopulated.  User CAN remove the preset and define a new one, but they shouldn't see this prepopulated.
  I think the issue is that we're just reshowing the same UI.  It needs to either have a memory connected to the surface, OR, just fully reset on each render.



### City Gates
- Add Concept of City Gate.
- Trade routes should establish a road in the direction of the Foreign Power, back to the nearest city gate.  
- Forestry, mines, etc, regional improvements should add a small number of roads and buildings, AND a road back to the nearest city gate. 


- Add Tutorial text around Leadership districts. 

### Buildings 

#### Library of parametric, dynamic Materials/textures. 
- We have stone and brick.  
- Alter brick to allow for ragged edges. 
- Add Bump/Normal Maps.
- Add Wood, tiles, 
- Add a "Stylized" amount, that pushes the contrast of images.  



#### buildings and Landmark buildings
 - analyze the images in K:\UnityProjects\Guild-Wars\guild-wars-web\resources\images to identify how to generate buildings that have these features.  .. Parametrically.


- Noble Note this will be some work as the castle needs to consume a large "block" area and be walled and grassed and etc.
- Market place stalls
- Better Mages towers
- Better and more varied churches
- Better Industrial buildings 
- Warehouses.


I am considering how best to create models that fit in well with the game look and feel.  But I do plan to explore adding a "customize building" toolset in the future, so that may be what we use to add castles too.  

 Walls as buildings. 
change wall generation to use building generation, to allow for turrets, gates, walls to have internal rooms.  Need to add some standard capabilities: wall pieces.  Crenelations, etc.  

- Fix rooves. Make sure they Gable correctly on the ends of wings.  


#### Special Junctions
Junctions that are "wall" should have a chance of being a gate.  use the t1.glb model for now.
Junctions that are "Canal" should have a chance of being a bridge.  

The chance, when the right district is null, is very low, maybe 1%
The chance, when districts are the same type, is high, 80%
The chance, when districts are a different type, is lower, 30%. 


## Gameplay
### Trade Phase
The Market Phase is a Live trading mini-game, where users buy from the market in real-time. 
Each Market District, and Trade route is its own market. 
Market Districts have a list of Resources they can trade.  Multiple markets can trade the same resources.  Not all resources must be tradable.
Guilds and Factions buy at a price based on their own relationship with the market selling the item. Purchases of an item decreases supply and hence increases the market price of the item, and fractionally reduces the price of all other items in the market, as attention on that product wanes.

Special trades can be arranged between districts.  These don't happen during the trade Phase. 

Trade routes will buy all items but their starting prices are 10% under the cheapest price for that resource, in all other markets. 
Trade routes have a set of resources they will sell.  These follow the normal rules for a market.  


### per round Actions

- Need to disambiguate between D&D rounds, (6s) and what I have been also calling rounds (game rounds: ~1 month) Need a new term for that. 
- Derive a list of per turn Character Actions from the list of Upgrades, Traits, combat, resource and Service systems. 















# DONE
### Building wings
 - Buildings should have a max wing size of 6.  If a street frontage is 12, split it into 2 wings of six wide.  If 15, then 3 wings of maybe 5,5,5 or maybe 4,7,4.  If 7 then maybe 4,3.  
 - Centre wings could be set back from the street.


### Add arches under buildings
Archways, Portals or passages that pass under a building to the Courtyard beyond.  
- only on ground floor. 
- one or two bays wide. 
- only up to 3 bays deep.
- These are simple, internal walls facing inward to the archway 
- Just leave the ceiling open at the moment.  We will add wood ceiling and knees later.

### Generate Docks 

### Building Type 
- buildings (including all Landmark buildings) have a Type. 
- Type can be Residental, Industial, Commercial, Military, Public
- All Types also have Subtypes:  Residential: [Slum, MiddleClass, Noble], Commercial:[ <resource>trader, (incl food and Labour), Banks, MoneyLenders, etc.], Industial:[forge, smelter,blacksmith, bowyer-fletcher, etc. ], Public: [tavern, inn, whorehouse, buskers alley, etc.], etc.  
- Type and subtype influence the Buildings initial geometry. 





I feel like the current problem: "trying to add Cliffs and Rivers as contiguous regions, with out breaking the adjacent terrain plots, Maps almost exactly to the Generation of Streets in the Street Generator / renderer.   We have solved that problem (see image.  Green circle has many streets which were once only edges, which have been successfully widened into consistent width streets, with no gaps or spikes in the adjacent terrain plots.)  Compare the two solutions and analyze if we might just use the same logic in Terrain plot regeneration.  

Note that there are differences.   
1. Streets end in square Dead Ends, not spiked ends ie. Cliff end points.
2. Streets are generated into a separate street graph.    We don't need this for Terrain edges.  But maybe its easier to just have them?   (We sort of have this in the riverCliffFaces element.)  



I have removed the now defunct ADR 018 from the Filesystem.
You still mention it in K:\UnityProjects\Guild-Wars\guild-wars-web\server\engine\CityGenerator\GroundPointRegistry.js.  that file mentions ADR20 which doesn't exist yet? 

I don't understand the need for pointRegistry.type  DCEL edges shouldn't know what they're saving.  They should only save the groundplane.
 
gameState.pointRegistry and gameState.cityDistrictData.points seem to be performing the same job at different scales?  We should have exactly one point registry, which is a DCEL map.  

why do gameState.worldTerrainData : regions, terrainPlots and edgePoints still have x,y coordinates?  shouldn't these all be references to the pointRegistry now? 

We have two parallel data structures : worldTerrainData and cityDistrictData.  These should be merged into a single Groundplane structure.  
This should store exatly and only: 
- pointRegistry - DCEL register of points.  provides: 1. the only place to store groundplane positional data.  2. Enables us to guarantee no holes. 3. Is unaware what its points represent - is a pure DCEL implementation.  
- Edges - these are needed during setup phases, and probably more in the future, to enable the hover and redefinition of those edges as something else.  store two or more pointRegistry records, and a type.  Ie, TerrainEdge, (can be converted into a river or Cliff.)  
- plots - These are single cells in the DCEL structure.  These are block plots, Terrain plots, segments of Rivers or cliffs, street junctions and street segments. They record a list of DCEL point ids, and type.
- regions - These are groups of plots.  Streets, cliffs, rivers, terrain regions, City regions, are all examples of regions.  They record a list of plot ids, and type.  







need to do more to help, suggest, guide Resources and Services
Resources and Services are manufactured out of 1-2 inputs, and then either Labour, Gold or Worship. Recipes are public knowledge. 
Items are declared as Raw, Resource, Service
Raw resources can only be harvested from Terrain plots, and their recipe is always Labour and Security, they can be identified as Basic Food.  
Districts consumed resources and services are completely defined by the resources they create, recipe. 
Services can be marked as Entertainment, or be regularly traded Services, just like resources. 
Services can never be sold to a foreign Power. 


A use case might be: 
1. User 1 defines Iron as a produced resource in an industry district.  
 - They define the resource as a Resource, not a service.  
 - They decide the recipe is Coal, Iron Ore and Labour. 
 - Industry can produce 2 Resources, so they also add Coal as a produced resource in the same industry district.  
 - They define the resource as a Resource, not a service.  
 - They decide the recipe is Wood, <undefined> and Labour. 
2. User 2 defines magic Items as a produced resource in an industry district.

Changes to Rivers.  
1. Rivers can begin and end at Mountains.
2. Rivers and Canals should be the same colour as Lakes.


## Districts
- Ensure exactly one Leadership District is selected by the end of District Setup.  
  - If one isn't, randomly select one unapplied city plot, OR terrain plot adjacent to the existing city to become a random LEadership district.
  - Allow non city plots to be made into District plots, when they're adjacent to the existing city. 
- Monarchy + Tyrant Leadership Districts MUST be a castle.  
- Add a "% walled" and "% external walled feature to District specs, default 0% & 0%.  That percentage of the district is walled.  
 - Monarchy, Tyrant are 100% & 100%
 - Noble and Military are 50% & 100%
 - Market is 0% & 100%
 - Religious is 10% & 80%



## Compass and minimap
- show the Compass in the Top down and iso modes, in the same space that the minimap is, in Walk mode. 
- Add NSEW indictors around the outside of the minimap.


## Names 
- When loading a new game, (or when a game loads and a previous view position isn't found) we're currently loading with N to the right.  Change this to be North at the top.
- Cliff and river Names are optional, if the user clicks apply without a name specified, allow it.  
- Add a "regenerate names" option everwhere prepopulated names are used. 
- Triple the number of random Names in all district, etc, naming categories.  (But not character names.)

Randomize the initially selected colour of a new Foreign power.  Don't allow 2 FPs to be the same colour, (Don't add new colours to the UI just disable that colour, when its selected)
- don't use Guild names (Weavers, Illusionists, etc.) for Terrain names.  We need to make a new way to make good terrain names.
- Don't name Threats and Trade Routes.  Allow the option to rename it, but mainly we're looking for the description.


Do the work to correct the jittered terrain-plot color reverting to default on hover/unhover instead of the deterministic jittered color - pending task  now.


- change the terrain generation away from a forced square World, to a circular-ish set of terrains.  still need to detect edge terrains.  
- Change City selection (currently its the largest non-edge terrain) to the terrain region that is in the centre of the map (use the terrain that contains the center point.)



### Groundplane Z-height implementation.  HUGE
- the ground plane is currently a single plane at z=0.

- Terrain centres, and edgepoints then District centres and boundaries, then Junctions, Gutter points, plotcorners will all render a z-height.  
- when city and Terrain are terrain plots are generated z-heights of all points are randomized in a thin band.  
- Terrain types set, and drag adjacent parts of the map up or down, proportional to the type, 
  - sea - a lot, and all terrain plot z-heights are set to the same value.
  - lake - a bit, and all terrain plot z-heights are set to the same value.
  - swamp - same as lake, and all terrain plot z-heights are smoothed
  - rivers set their z-heights so end point to end point is a consistent gradient.  
  - plains and deserts are flat.
  - Cliffs detect the direction of drop off, (if same then randomly select one.) 
   - split the vertices, separate the adjacent terrain plot z-heights, add a cliff face geometry
  - hills increase a bit and all terrain plot z-heights are multiplied.
  - mountains increase a lot and all terrain plot z-heights are multiplied even more.  
- during Terrain application, the z-heights of all 
- District boundaries set, and drag adjacent parts of the map up or down, proportional to the type
 - Canals decrease slightly.  
- Streets are rendered along z-heights.  
- plots are unaffected and run along the z-heights too.  
- buidings are generated in the same ways as currently, with wings, unaffected by z-height. 
- Wings will will quantize their ground level height to be the first level where the highest vert is above ground.
- wings merge to buidings as normal. 
- When The difference between a gutter and the junction centre is above a certain value, the gutter and the Plot boundary are separated and a berm wall is added.  Some plots may also have a maximum gradient value, that also enforces that.


