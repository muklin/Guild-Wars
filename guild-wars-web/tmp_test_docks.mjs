import GameStateManager from './server/engine/GameStateManager.js'
import SetupPhase from './server/engine/SetupPhase.js'

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy)
}

let successes = 0
const TRIALS = 8
for (let trial = 0; trial < TRIALS; trial++) {
  const gsm = new GameStateManager()
  const sp = new SetupPhase(gsm)
  sp.initialize()

  const regions = gsm.worldTerrainData.regions
  const cityRegion = regions.find(r => r.assignedType === 'City')
  const edges = gsm.worldTerrainData.edges

  const candidateEdges = Object.entries(edges).filter(([id, e]) =>
    (e.regionA === cityRegion.id || e.regionB === cityRegion.id) && !e.assignedType
  )
  if (!candidateEdges.length) { console.log(`trial ${trial}: no candidate terrain edges`); continue }
  candidateEdges.sort((a, b) => (b[1].pointIds.length - a[1].pointIds.length))
  const [edgeId, edge] = candidateEdges[0]
  sp.assignEdgeType(edgeId, 'River')
  sp.finishTerrain()

  // Find a district bordering this river edge (reuse geometry check)
  const terrPtMap = new Map((gsm.worldTerrainData.edgePoints || []).map(p => [p.id, p]))
  const riverPts = edge.pointIds.map(id => terrPtMap.get(id))
  const riverSegs = []
  for (let i = 0; i < riverPts.length - 1; i++) riverSegs.push([riverPts[i], riverPts[i+1]])

  const districts = gsm.cityDistrictData.districts
  const matching = []
  for (const d of districts) {
    const poly = d.polygon
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i+1) % poly.length]
      const mx = (a.x+b.x)/2, my = (a.y+b.y)/2
      if (riverSegs.some(([p,q]) => segDist(mx,my,p.x,p.y,q.x,q.y) < 1.0)) { matching.push(d.id); break }
    }
  }
  if (!matching.length) { console.log(`trial ${trial}: no districts border the river`); continue }

  const targetId = matching[0]
  sp.assignDistrictType(targetId, 'Leadership', 'test', '', [], null, 'Monarchy')

  // Now find this district's OUTER city edge(s) (districtB null) and test _cityEdgeIsNearWater
  const cityEdges = gsm.cityDistrictData.edges
  const allForTarget = Object.entries(cityEdges).filter(([id, e]) => e.districtA === targetId || e.districtB === targetId)
  console.log(`  district ${targetId} has ${allForTarget.length} total city edges:`, allForTarget.map(([id,e]) => `${id}:A=${e.districtA},B=${e.districtB},type=${e.assignedType}`))
  const outerEdgeIds = Object.entries(cityEdges)
    .filter(([id, e]) => (e.districtA === targetId || e.districtB === targetId) && e.districtB == null && !e.assignedType)
    .map(([id]) => id)

  let dockableEdgeId = null
  for (const id of outerEdgeIds) {
    if (sp._cityEdgeIsNearWater(id)) { dockableEdgeId = id; break }
  }
  console.log(`trial ${trial}: district ${targetId}, ${outerEdgeIds.length} outer edges, dockable=${dockableEdgeId}`)
  if (!dockableEdgeId) continue

  const result = sp.assignCityEdgeType(dockableEdgeId, 'Docks')
  console.log(`  assignCityEdgeType Docks -> ok=${result.ok}`)
  successes++
}
console.log(`\n${successes}/${TRIALS} trials produced an assignable Docks edge`)
