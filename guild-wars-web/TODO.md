# Bugs:

- Map movement at full zoom out is brdoken.  The map goes to the top of the screen and can't move the map down.  zoom in fixes it, but we want to be able to zoom out to the point that the whole map is visible and we can still pan around.  
- Fix rooves. Make sure they Gable correctly on the ends of wings.  

# Baby Features:
## Names 
- Don't name Threats and Trade Routes.  Allow the option to rename it, but mainly we're looking for the description.
- Don't name Walls, Canals, Main Roads.


# Features:
## Districts
- Don't auto identify a Leadership district at start of District Setup.  
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

### Walls as buildings. 
change wall generation to use building generation, to allow for turrets, gates, walls to have internal rooms.  Need to add some standard capabilities: wall pieces.  Crenelations, etc.  

### Add arches under buildings
Archways, Portals or passages that pass under a building to the Courtyard beyond.  
- only on ground floor. 
- one or two bays wide. 
- only up to 3 bays deep.
- These are simple, internal walls facing inward to the archway 
- Just leave the ceiling open at the moment.  We will add wood ceiling and knees later.

### Generate Docks 

### LandMark buildings
- Add the Castle, and allow it to spawn in Noble Districts, Note this will be some work as the castle needs to consume a large "block" area and be walled and grassed and etc.
- Market place stalls
- Better Mages towers
- Better and more varied churches
- Better Industrial buildings 
- Warehouses.
 
### Building Type 
- buildings (including all Landmark buildings) have a Type. 
- Type can be Residental, Industial, Commercial, Military, Public
- All Types also have Subtypes:  Residential: [Slum, MiddleClass, Noble], Commercial:[ <resource>trader, (incl food and Labour), Banks, MoneyLenders, etc.], Industial:[forge, smelter,blacksmith, bowyer-fletcher, etc. ], Public: [tavern, inn, whorehouse, buskers alley, etc.], etc.  
- Type and subtype influence the Buildings initial geometry. 


### District and Building Customization.
- When players select a district, they will see a list of the building types, and subtypes available, based on the district type settings, and also sliders, set at the intial defaults, for the amount of those buildings in a district.   These sliders sum to 100% and increasing one slider reduces the others, proportinal to how much weight they all have.  (reducing one slider slowly to 100% would reduce all sliders to 0% at the same time) 
When the player changes the slider, buildings are generated, (on stop sliding.)



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
