

Bugs and tweaks:
1. Character sheet. make the character portrait wider, and actually anchor it to the window. (its currently locked in the top left corner.)  Resize the sheet as indicated:  ![alt text](image.png)
2. Show Purchased HQ upgrades to the right of the HQ image.
3. HQ image isn't working ![alt text](image-1.png)
4. Once an HQ has been selected, you can't change.  (so don't show the button.)  You can rehouse, but it costs 2 round Actions, and you lose all your HQ upgrades.  
5. Selecting a Guild HQ indicates I will have +30 Influence · +20 Standing with district faction, and says I have selected in Residential: Middle, but I don't see those values updated in the Diplomacy or Overview tabs.
6. Allow Hover of any "Pills" to see the actual value.  (Show <Type>: <Value>  ie.  Health: 70 )
7. Need to disambiguate between D&D rounds, (6s) and what I have been also calling rounds (game rounds: ~1 month) Need a new term for that. 


in K:\UnityProjects\Guild-Wars\guild-wars-web\client\ui\MultiplayerUI.js @ 149 use K:\UnityProjects\Guild-Wars\guild-wars-web\resources\d20.svg instead.  


Simplify the combined Squares in the street graph:
- remove streets that have squares on both sides. 
- remove squares that are missing a street on one side. 
- fill holes with a single polygon of type "square"
Now we will have adjacent squares coalesce into single areas, ringed with streets.   
- consider how this will affect path routing on squares now.  


Fix the District Boundary Streets 
I need to do more thinking about this.  
The current state is that prior to district definition a user can define the edge of a District to be a canal/Wall/Main/Road/Dock.  
After it has District defined on one or both sides, the single long boundary changes to be a street, usually not straight. 
But I still want to be able to let a user hover, select that District boundary street, and set it as a canal/Wall/Main/Road/Dock. 
I don't want the District boundary to be drawn over the streets.  it looks ugly.
It seems not to work if you define ie a main street, after the District is set. 
I think I need to
- add "district Boundary" to street definitions.  
- make Streets that are district boundaries hoverable and selectable (the entire street boundary with the adjacent district) if they havent' been defined before.
- render them correctly when they are defined before district definition.
- render them correctly when they are defined after district definition.
- Improve canals, docks rivers, to render them as deeper than ground level
- add working (walkable) bridges over rivers and canals. 
- 


Fix Buildings.  
- Rooves still need to be angled correctly across the top of the walls. 
- Allow Wings of buildings to run at any angle to one another.
- Allow wings of buildings to be different heights to one another.
- Prevent massive Square-ish buildings with one roof span.  
- Correct the townhouse / instanced per district logic. (should be a mix of townhouses.  Some blocks are town houses with sporadic instanced buildings, some blocks are singleton houses, (mix of instanced and generated houses))
- Stop dark stone from being used above ground floor. (and lighten it somewhat.)
- reduce the number of wood uprights on buildings.  There should never be more than about 6 uprights on a long building face, (10+)
- Add arches under buildings
- allow walls to use building generation, to allow for turrets, gates?? 
- Stone windows should be higher on the wall.  

- Docks 

LandMark buildings
- Add the Castle, and allow it to spawn in Noble Districts, Note this will be some work as the castle needs to consume a large "block" area and be walled and grassed and etc.
- Market place stalls
- Better Mages towers
- Better and more varied churches
- Better Industrial buildings 
- Warehouses.

- 



Get into per round Actions.  



Each round each District and trade faction will gain their produced resources.  The base for each is their current health.  But then The District must 


Derive a list of per turn Character Actions from the list of Upgrades, Traits, combat, resource and Service systems. 
