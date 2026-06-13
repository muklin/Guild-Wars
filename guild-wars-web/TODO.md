Multiplayer
Electron App

Parametric buildings + Fit to blocks.  
- wood post, door, archway (carriage passage under/through building to courtyard), windows, etc.
- walls: stone, Wood panels, plaster + posts (many), etc
- Rooves, gables, eaves, 
- Chimneys, roof windows, parapets, and outer walkways 
- scaffolds

Change building placement order: 
- streets - Squares: find centre of joined Squares.
- Place Landmarks.
- Generate plots, (landmark ground removed. )
- scatter specialist buildings.
- generate and place buildings for the plots

Guild setup:
user selects any Building to be their Guildhouse.
Generate and record relations with all Factions.
new screens / UI panels for :
- Diplomacy / Faction Standings and health.
- "Influence" Map overlay.
- Characters / Leader Info. 
- Guildhouse info - Layout / Traps / Storage / Special rooms.  
- Resources 
- Special (Guild powers, Magic, Religion, Espionage, Combat, Marketting)
All Factions have a "Health" metric, which affects how many "produced" resources they produce per turn.

Characters: 
- Player sheets
- Generation, Selection, promotion.
- Character Dolls - Modular, Animations. ???  




/grill-with-docs
next step is to improve these buildings to be generated for any footprint, 
and then to start integrating with the plots,
We need to allow for buildings to be empty along one side, until a specific floor.    
This is to allow that some districts will follow a protion of their plots to have a "townhouse" style : where a set distance of the front of the plot is the footprint, and the houses are literally "connected."  Taller houses need full side walls rendered.  Lower ones don't   We could just rende internal walls, but I'm worried about polygon counts. 

In general the Building generator also needs to be able to generate buildings on any shape.   ie, acute, and obtuse angles between wings.  

We should consider creating "standard" houses and reinstancing those across a district, if that would increase performance, too.  
   