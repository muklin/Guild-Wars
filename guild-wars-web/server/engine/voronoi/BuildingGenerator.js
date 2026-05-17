import { computeVoronoiCells } from './VoronoiUtils.js'

const DISTRICT_BUILDING_PARAMS = {
  Market:              { lotSpacing: 0.50, setback: 0.06, lotWidth: 0.25, lotDepth: 0.35, alleyWidth: 0.15 },
  Military:            { lotSpacing: 0.80, setback: 0.08, lotWidth: 0.40, lotDepth: 0.55, alleyWidth: 0.20 },
  Residential:         { lotSpacing: 0.50, setback: 0.04, lotWidth: 0.20, lotDepth: 0.30, alleyWidth: 0.12 },
  'Residential-Noble': { lotSpacing: 0.80, setback: 0.08, lotWidth: 0.30, lotDepth: 0.45, alleyWidth: 0.18 },
  'Residential-Slums': { lotSpacing: 0.35, setback: 0.02, lotWidth: 0.15, lotDepth: 0.22, alleyWidth: 0.10 },
  Leadership:          { lotSpacing: 1.00, setback: 0.10, lotWidth: 0.35, lotDepth: 0.55, alleyWidth: 0.25 },
  Entertainment:       { lotSpacing: 0.60, setback: 0.07, lotWidth: 0.28, lotDepth: 0.38, alleyWidth: 0.16 },
  default:             { lotSpacing: 0.55, setback: 0.05, lotWidth: 0.22, lotDepth: 0.32, alleyWidth: 0.14 },
}

export { DISTRICT_BUILDING_PARAMS }

function getParams(district) {
  const type = district.assignedType
  const cls = district.residentialClass
  let key = type
  if (type === 'Residential' && cls === 'Noble') key = 'Residential-Noble'
  else if (type === 'Residential' && cls === 'Slums') key = 'Residential-Slums'
  return DISTRICT_BUILDING_PARAMS[key] ?? DISTRICT_BUILDING_PARAMS.default
}


export default class BuildingGenerator {
  generate(districts, streetGraph) {
    const nodeById = new Map(streetGraph.nodes.map(n => [n.id, n]))
    const buildings = []
    const alleys = []
    const nextId = [0]
    let totalLots = 0

    for (const district of districts) {
      const params = getParams(district)
      const spacing = params.lotSpacing

      // ── 1. Collect seeds along every street edge in this district ────────────
      const districtEdges = streetGraph.edges.filter(e => e.districtId === district.id)
      if (!districtEdges.length) continue

      const rawSeeds = []
      for (const edge of districtEdges) {
        const nA = nodeById.get(edge.nodeA), nB = nodeById.get(edge.nodeB)
        if (!nA || !nB) continue
        rawSeeds.push({ x: nA.x, y: nA.y })
        rawSeeds.push({ x: nB.x, y: nB.y })
        const dx = nB.x - nA.x, dy = nB.y - nA.y
        const len = Math.hypot(dx, dy)
        const steps = Math.floor(len / spacing)
        for (let k = 1; k < steps; k++) {
          const t = k / steps
          rawSeeds.push({ x: nA.x + t * dx, y: nA.y + t * dy })
        }
      }

      // ── 1b. Add seeds along district polygon boundary ───────────────────────
      const poly = district.polygon
      for (let i = 0; i < poly.length; i++) {
        const pA = poly[i], pB = poly[(i + 1) % poly.length]
        rawSeeds.push({ x: pA.x, y: pA.y })
        const dx = pB.x - pA.x, dy = pB.y - pA.y
        const len = Math.hypot(dx, dy)
        const steps = Math.floor(len / spacing)
        for (let k = 1; k < steps; k++) {
          const t = k / steps
          rawSeeds.push({ x: pA.x + t * dx, y: pA.y + t * dy })
        }
      }

      // ── 2. Deduplicate seeds ────────────────────────────────────────────────
      const minDist = spacing * 0.4
      const seeds = []
      for (const s of rawSeeds) {
        let dup = false
        for (const e of seeds) {
          if (Math.hypot(s.x - e.x, s.y - e.y) < minDist) { dup = true; break }
        }
        if (!dup) seeds.push(s)
      }
      if (seeds.length < 3) continue

      // ── 3-4. Voronoi cells from seeds, clipped to district polygon ──────────
      for (const cell of computeVoronoiCells(seeds, district.polygon)) {
        buildings.push({ id: nextId[0]++, districtId: district.id, vertices: cell.polygon })
        totalLots++
      }
    }

    console.log(`Lot Voronoi: ${totalLots} lots across ${districts.length} districts`)
    return { buildings, alleys }
  }
}
