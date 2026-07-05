import GameStateManager from './server/engine/GameStateManager.js'
import SetupPhase from './server/engine/SetupPhase.js'

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }

for (let trial = 0; trial < 5; trial++) {
  const gsm = new GameStateManager()
  const sp = new SetupPhase(gsm)
  sp.initialize()

  const regions = gsm.worldTerrainData.regions
  const cityRegion = regions.find(r => r.assignedType === 'City')
  if (!cityRegion) { console.log('no city region found this trial'); continue }

  const edges = gsm.worldTerrainData.edges
  const candidateEdges = Object.entries(edges).filter(([id, e]) =>
    (e.regionA === cityRegion.id || e.regionB === cityRegion.id) && !e.assignedType
  )
  console.log(`trial ${trial}: city region ${cityRegion.id}, ${candidateEdges.length} candidate boundary edges out of ${Object.keys(edges).length} total`)
  if (!candidateEdges.length) continue

  candidateEdges.sort((a, b) => (b[1].pointIds.length - a[1].pointIds.length))
  const [edgeId, edge] = candidateEdges[0]
  edge.assignedType = 'River'
  console.log(`  assigned River to edge ${edgeId} (${edge.pointIds.length} pts) between region ${edge.regionA}/${edge.regionB}`)

  const districts = gsm.cityDistrictData.districts
  console.log(`  ${districts.length} city districts before pullback`)

  const before = districts.map(d => d.polygon.map(v => ({ x: v.x, y: v.y })))

  sp._applyRiverCliffPullback(districts)

  let changedCount = 0
  for (let i = 0; i < districts.length; i++) {
    const b = before[i], a = districts[i].polygon
    if (a.length !== b.length) { changedCount++; continue }
    for (let j = 0; j < a.length; j++) {
      if (dist(a[j], b[j]) > 1e-6) { changedCount++; break }
    }
  }
  console.log(`  ${changedCount} district(s) polygon actually changed by pullback`)
  console.log('---')
}
