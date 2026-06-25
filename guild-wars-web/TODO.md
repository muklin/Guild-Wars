

# Bugs:
- party walls should NOT be removed between buildings.  They should have walls added.  No Windows or doors on those walls.  
- coming out of Debug mode doesn't revert terrain colours to normal.
- sometimes Terrain Regions fine voronois are not adjacent.  This results in missing edges.  
- Fix rooves. Make sure they Gable correctly on the ends of wings.  

# Baby Features:


# Features:

## City Setup 

### Terrain plots
move the plot conversion for terrain to happen when a terrain is defined.  this can happen either: 
- when the user specifes the terrain in Terrain mode.  
- when the terrain is auto assigned (plain) when leaving terrain mode.  

The reason is, we want to let users define plots, not whole terrains as forrestry / fishing / mining / agriculture / trade / threat, etc, and follow rules to add infrastructure (roads / buildings, etc.) at that time, during city setup.  

### Walls as buildings. 
change wall generation to use building generation, to allow for turrets, gates, walls to have internal rooms.  Need to add some standard capabilities: wall pieces.  Crenelations, etc.  


### Resources.  
When players go to create a new resource, we will popup a dialogue to help them name, choose an icon for, set the initial value of (in gold)

### District Definition 
- When players select a district, they will see a list of the building types, and subtypes available, based on the district type settings, and also sliders, set at the intial defaults, for the amount of those buildings in a district.   These sliders sum to 100% and increasing one slider reduces the others, proportinal to how much weight they all have.  (reducing one slider slowly to 100% would reduce all sliders to 0% at the same time) 
When the player changes the slider, buildings are generated, (on stop sliding.)

## Special Junctions

Junctions that are "wall" should have a chance of being a gate.  use the t1.glb model for now.
Junctions that are "Canal" should have a chance of being a bridge.  

The chance, when the right district is null, is very low, maybe 1%
The chance, when districts are the same type, is high, 80%
The chance, when districts are a different type, is lower, 30%. 

## Buildings 
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
 
## Building Type 
- buildings (including all Landmark buildings) have a Type. 
- Type can be Residental, Industial, Commercial, Military, Public
- All Types also have Subtypes:  Residential: [Slum, MiddleClass, Noble], Commercial:[ <resource>trader, (incl food and Labour), Banks, MoneyLenders, etc.], Industial:[forge, smelter,blacksmith, bowyer-fletcher, etc. ], Public: [tavern, inn, whorehouse, buskers alley, etc.], etc.  
- Type and subtype influence the Buildings initial geometry. 



## Gameplay during terrain 
During Terrain setup players define
 - remote Cities / towns / Aggressors
 - gods
 - Special Terrain: Volcano, edge of ice sheet ... etc? 



## Groundplane Z-height implementation.  HUGE
- the ground plane is currently a single plane at z=0.

- Terrain centres, and edgepoints then District centres and boundaries, then Junctions, Gutter points, plotcorners will all render a z-height.  
- when city and Terrain are fine voronois are generated z-heights of all points are randomized in a thin band.  
- Terrain types set, and drag adjacent parts of the map up or down, proportional to the type, 
  - sea - a lot, and all fine voronoi z-heights are set to the same value.
  - lake - a bit, and all fine voronoi z-heights are set to the same value.
  - swamp - same as lake, and all fine voronoi z-heights are smoothed
  - rivers set their z-heights so end point to end point is a consistent gradient.  
  - plains and deserts are flat.
  - Cliffs detect the direction of drop off, (if same then randomly select one.) 
   - split the vertices, separate the adjacent fine voronoi z-heights, add a cliff face geometry
  - hills increase a bit and all fine voronoi z-heights are multiplied.
  - mountains increase a lot and all fine voronoi z-heights are multiplied even more.  
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


Each round each District and trade faction will gain their produced resources.  The base for each is their current health.  But then The District must 


Derive a list of per turn Character Actions from the list of Upgrades, Traits, combat, resource and Service systems. 
