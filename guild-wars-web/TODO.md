# Bugs:

- Map movement at full zoom out is broken.  The map goes to the top of the screen and can't move the map down.  zoom in fixes it, but we want to be able to zoom out to the point that the whole map is visible and we can still pan around.  
- Terrain plots still showing after Conversion to district. 
- No Docks visible. 
- Claude was verifying against current code: your plot_underfill_bug memory implies a shared computeVoronoiCells exists for world/city scales — it doesn't. TerrainVoronoiGenerator and StreetVoronoiGenerator each keep their own local circumcenter code; only the half-plane variant is actually shared. 
- Foreign Powers going around corners produces artifacts.  I still don't like the FP indication.  FP names are often not rendered.

- Archways are not appearing in game.  I've not yet found one.  

- Mines, Forestry, when defined, seem to apply to their whole terrain, not just the terrain plot
- For Factions producing resources, the ingredients should still be specified, on existing resources.  

- Only Gold is showing across the top in the resources section, in Guild setup.  

- http://localhost:5173/buildingparts.html doesn't render any buildings.


# Baby Features:
## Names 
- Don't name Threats and Trade Routes.  Allow the option to rename it, but mainly we're looking for the description.
- Cliff Names are optional.  
- Add a "regenerate names" option.  
- Triple the number of random Names in all district, etc, naming categories.  (not character names)

- we may consider changing away from a forced square World area to a circular-ish set of terrains.  

- Add Concept of City Gate.
- Trade routes should establish a road in the direction of the Foreign Power, back to the nearest city gate.  
- Forestry, mines, etc, regional improvements should add a small number of roads and buildings, AND a road back to the nearest city gate. 

- Hovering ie Mines, Fishing Factions, doesn't highlight their position onthe map.  it should. 
- Hovering Foreign Powers (Trade routes or Threats) doesn't highlight their position onthe map.  it should. 

Changes to Rivers.  
1. Rivers can begin and end at Mountains.
2. Rivers and Canals should be the same colour as Lakes.
2. River endpoints should appear to flow out of/into seas and lakes.   
 - To achieve this alter the polyline Junctions ONLY At river endpoints to be 4 side fan generation, rather than 3 sided tris.  P

Replace the Resource graph with a proper connected resource/service value stream 
Also show this during Resource Creation in District setup Phase. 



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


The Market Phase is a Live trading game, where users buy from the market in real-time.  They buy at a price based on their own relationship with the seller, but the purchase decreases supply, and increases the price of the next purchase made of that item, and fractionally reduces the price of all other items, in the market at the time, as attention in that product wanes. 

Trade routes can supply all items, but again, the users relationship with the trade route affects price, AND the Trade route sells more expensively, AND buys for less, to begin with.  





# Features:
## Districts
- Ensure exactly one Leadership District is selected by the end of District Setup.  
  - If one isn't, randomly select one unapplied city plot, OR terrain plot adjacent to the existing city to become a random LEadership district.
- Add Tutorial text around Leadership districts. 
- Allow non city plots to be made into District plots, when they're adjacent to the existing city. 
- Monarchy + Tyrant Leadership Districts MUST be a castle.  
- Add a "% walled" and "% external walled feature to District specs, default 0% & 0%.  That percentage of the district is walled.  
 - Monarchy, Tyrant are 100% & 100%
 - Noble and Military are 50% & 100%
 - Market is 0% & 100%
 - Religious is 10% & 80%


## Buildings 
### Special Junctions
Junctions that are "wall" should have a chance of being a gate.  use the t1.glb model for now.
Junctions that are "Canal" should have a chance of being a bridge.  

The chance, when the right district is null, is very low, maybe 1%
The chance, when districts are the same type, is high, 80%
The chance, when districts are a different type, is lower, 30%. 


I am considering how best to create models that fit in well with the game look and feel.  But I do plan to explore adding a "customize building" toolset in the future, so that may be what we use to add castles too.  


### Walls as buildings. 
change wall generation to use building generation, to allow for turrets, gates, walls to have internal rooms.  Need to add some standard capabilities: wall pieces.  Crenelations, etc.  

- Fix rooves. Make sure they Gable correctly on the ends of wings.  




### LandMark buildings
- Add the Castle, and allow it to spawn in Noble Districts, Note this will be some work as the castle needs to consume a large "block" area and be walled and grassed and etc.
- Market place stalls
- Better Mages towers
- Better and more varied churches
- Better Industrial buildings 
- Warehouses.
 
## Groundplane Z-height implementation.  HUGE
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



## per round Actions

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







