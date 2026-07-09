import GameStateManager from './server/engine/GameStateManager.js'
import SetupPhase from './server/engine/SetupPhase.js'

const gsm = new GameStateManager()
const sp = new SetupPhase(gsm)

// cellLand: touches the river along its edge (1,1)-(1,2) [north of the shared vertex].
// cellLake: shares vertex (1,1) with cellLand, but its OWN edges — (1,1)-(1,0) and
// (1,1)-(0,1) — run AWAY from the river (simulating a de-typed shoreline edge). Neither
// of cellLake's own edges independently matches _edgeNearRiverCliff.
const cellLand = { id: 1, polygon: [{x:1,y:1},{x:1,y:2},{x:0,y:2},{x:0,y:1}] }
const cellLake = { id: 2, polygon: [{x:1,y:1},{x:0,y:1},{x:0,y:0},{x:1,y:0}] }
gsm.worldTerrainData = { terrainPlots: [cellLand, cellLake], edges: {}, edgePoints: [], worldSize: 50 }

// Only the upstream segment (1,1)-(1,2) is "still typed" — matches the real bug's setup
// where the Lake-bordering segment (which would be (1,0)-(1,1)) has been nulled away.
const riverCliffSegs = [[{x:1,y:1},{x:1,y:2}]]
sp._riverCliffSegments = () => riverCliffSegs

sp._applyRiverCliffPullbackToTerrainPlots()
console.log('cellLand polygon:', cellLand.polygon.map(v=>`(${v.x.toFixed(4)},${v.y.toFixed(4)})`).join(' | '))
console.log('cellLake polygon:', cellLake.polygon.map(v=>`(${v.x.toFixed(4)},${v.y.toFixed(4)})`).join(' | '))

// Both cells originally shared vertex (1,1). Check they still agree after pullback.
const landV = cellLand.polygon.find(v => Math.abs(v.x-1)<0.3 && Math.abs(v.y-1)<0.3)
const lakeV = cellLake.polygon.find(v => Math.abs(v.x-1)<0.3 && Math.abs(v.y-1)<0.3)
console.log(`\nland's version of shared corner: (${landV.x.toFixed(4)},${landV.y.toFixed(4)})`)
console.log(`lake's version of shared corner: (${lakeV.x.toFixed(4)},${lakeV.y.toFixed(4)})`)
console.log(`gap distance: ${Math.hypot(landV.x-lakeV.x, landV.y-lakeV.y).toFixed(6)}`)
