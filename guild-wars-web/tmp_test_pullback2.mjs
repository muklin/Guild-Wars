import GameStateManager from './server/engine/GameStateManager.js'
import SetupPhase from './server/engine/SetupPhase.js'

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy)
}

const gsm = new GameStateManager()
const sp = new SetupPhase(gsm)
sp.initialize()

const regions = gsm.worldTerrainData.regions
const cityRegion = regions.find(r => r.assignedType === 'City')
console.log('city region id', cityRegion.id)

const edges = gsm.worldTerrainData.edges
const candidateEdges = Object.entries(edges).filter(([id, e]) =>
  (e.regionA === cityRegion.id || e.regionB === cityRegion.id) && !e.assignedType
)
candidateEdges.sort((a, b) => (b[1].pointIds.length - a[1].pointIds.length))
const [edgeId, edge] = candidateEdges[0]

sp.assignEdgeType(edgeId, 'River')
console.log('assigned River to', edgeId, 'pts', edge.pointIds.length)

sp.finishTerrain()

const terrPtMap = new Map((gsm.worldTerrainData.edgePoints || []).map(p => [p.id, p]))
const riverPts = edge.pointIds.map(id => terrPtMap.get(id))
const riverSegs = []
for (let i = 0; i < riverPts.length - 1; i++) riverSegs.push([riverPts[i], riverPts[i+1]])

// find which city district(s) actually border this river edge geometrically
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
console.log('districts geometrically bordering the river edge:', matching)

if (!matching.length) { console.log('NO MATCHING DISTRICTS - cannot test further'); process.exit(0) }

const targetId = matching[0]
const target = districts.find(d => d.id === targetId)
const beforePoly = target.polygon.map(v => ({x:v.x,y:v.y}))

// Lock the target district as Leadership (bypasses most resource validation)
const result = sp.assignDistrictType(targetId, 'Leadership', 'test', '', [], null, 'Monarchy')
console.log('assignDistrictType result ok?', result.ok)

const afterPoly = target.polygon.map(v => ({x:v.x,y:v.y}))
let changed = false
if (beforePoly.length !== afterPoly.length) changed = true
else for (let i=0;i<beforePoly.length;i++) if (Math.hypot(beforePoly[i].x-afterPoly[i].x, beforePoly[i].y-afterPoly[i].y) > 1e-6) changed = true

console.log('target district polygon changed by full pipeline (locked)?', changed)
console.log('before len', beforePoly.length, 'after len', afterPoly.length)
console.log('before', JSON.stringify(beforePoly))
console.log('after', JSON.stringify(afterPoly))
console.log('_rawPolygon', JSON.stringify(target._rawPolygon))
