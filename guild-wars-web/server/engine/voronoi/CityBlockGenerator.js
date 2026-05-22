import { computeVoronoiCells } from './VoronoiUtils.js'

const DISTRICT_BUILDING_PARAMS = {
  Market:               { minBlockSize: 0.3, maxAspectRatio: 4.0, minLotSize: 1.0, lotSpacing: 0.50, setback: 0.06, lotWidth: 0.25, lotDepth: 0.35, alleyWidth: 0.15, metric: 'manhattan' },
  Military:             { minBlockSize: 0.5, maxAspectRatio: 5.0, minLotSize: 1.5, lotSpacing: 0.80, setback: 0.08, lotWidth: 0.40, lotDepth: 0.55, alleyWidth: 0.20, metric: 'manhattan' },
  Residential:          { minBlockSize: 0.3, maxAspectRatio: 4.0, minLotSize: 0.8, lotSpacing: 0.50, setback: 0.04, lotWidth: 0.20, lotDepth: 0.30, alleyWidth: 0.12, metric: 'manhattan' },
  'Residential-Middle': { minBlockSize: 0.3, maxAspectRatio: 4.0, minLotSize: 0.8, lotSpacing: 0.50, setback: 0.04, lotWidth: 0.20, lotDepth: 0.30, alleyWidth: 0.12, metric: 'manhattan' },
  'Residential-Noble':  { minBlockSize: 0.5, maxAspectRatio: 3.5, minLotSize: 1.5, lotSpacing: 0.80, setback: 0.08, lotWidth: 0.30, lotDepth: 0.45, alleyWidth: 0.18, metric: 'manhattan' },
  'Residential-Slums':  { minBlockSize: 0.2, maxAspectRatio: 5.0, minLotSize: 0.5, lotSpacing: 0.35, setback: 0.02, lotWidth: 0.15, lotDepth: 0.22, alleyWidth: 0.10, metric: 'manhattan' },
  Leadership:           { minBlockSize: 0.8, maxAspectRatio: 3.0, minLotSize: 2.5, lotSpacing: 1.00, setback: 0.10, lotWidth: 0.35, lotDepth: 0.55, alleyWidth: 0.25, metric: 'manhattan' },
  Entertainment:        { minBlockSize: 0.3, maxAspectRatio: 4.0, minLotSize: 1.0, lotSpacing: 0.60, setback: 0.07, lotWidth: 0.28, lotDepth: 0.38, alleyWidth: 0.16, metric: 'manhattan' },
  Religious:            { minBlockSize: 0.5, maxAspectRatio: 3.0, minLotSize: 2.0, lotSpacing: 0.70, setback: 0.10, lotWidth: 0.30, lotDepth: 0.50, alleyWidth: 0.20, metric: 'manhattan' },
  Magical:              { minBlockSize: 0.3, maxAspectRatio: 4.0, minLotSize: 1.0, lotSpacing: 0.55, setback: 0.08, lotWidth: 0.25, lotDepth: 0.40, alleyWidth: 0.15, metric: 'manhattan' },
  Industry:             { minBlockSize: 0.5, maxAspectRatio: 6.0, minLotSize: 2.0, lotSpacing: 0.90, setback: 0.05, lotWidth: 0.45, lotDepth: 0.60, alleyWidth: 0.20, metric: 'manhattan' },
  default:              { minBlockSize: 0.3, maxAspectRatio: 4.0, minLotSize: 1.0, lotSpacing: 0.55, setback: 0.05, lotWidth: 0.22, lotDepth: 0.32, alleyWidth: 0.14, metric: 'manhattan' },
}

export { DISTRICT_BUILDING_PARAMS }

function getParams(district) {
  if (!district) return DISTRICT_BUILDING_PARAMS.default
  const type = district.assignedType
  const cls = district.residentialClass
  let key = type
  if (type === 'Residential' && cls === 'Noble') key = 'Residential-Noble'
  else if (type === 'Residential' && cls === 'Slums') key = 'Residential-Slums'
  else if (type === 'Residential' && cls === 'Middle') key = 'Residential-Middle'
  return DISTRICT_BUILDING_PARAMS[key] ?? DISTRICT_BUILDING_PARAMS.default
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a <= -Math.PI) a += 2 * Math.PI
  return a
}

export default class CityBlockGenerator {
  generate(districts, streetGraph) {
    const districtMap = new Map(districts.map(d => [d.id, d]))
    const { nodes, edges } = streetGraph
    const nodeById = new Map(nodes.map(n => [n.id, n]))

    // Edge lookup by directed node pair for districtId tagging during face tracing
    const edgeDistrictByKey = new Map()
    for (const edge of edges) {
      edgeDistrictByKey.set(`${edge.nodeA}-${edge.nodeB}`, edge.districtId)
      edgeDistrictByKey.set(`${edge.nodeB}-${edge.nodeA}`, edge.districtId)
    }

    // ── Phase 1: Build angle-sorted adjacency for planar face tracing ──────────
    const adj = new Map()
    for (const node of nodes) adj.set(node.id, [])

    for (const edge of edges) {
      const nA = nodeById.get(edge.nodeA), nB = nodeById.get(edge.nodeB)
      if (!nA || !nB || edge.nodeA === edge.nodeB) continue
      const angle = Math.atan2(nB.y - nA.y, nB.x - nA.x)
      adj.get(edge.nodeA).push({ neighborId: edge.nodeB, angle: normalizeAngle(angle) })
      adj.get(edge.nodeB).push({ neighborId: edge.nodeA, angle: normalizeAngle(angle + Math.PI) })
    }

    for (const [nodeId, list] of adj) {
      const seen = new Set()
      const deduped = []
      for (const nb of list) {
        if (!seen.has(nb.neighborId)) { seen.add(nb.neighborId); deduped.push(nb) }
      }
      deduped.sort((a, b) => a.angle - b.angle)
      adj.set(nodeId, deduped)
    }

    // For directed half-edge u→v, return w where v→w continues the same face.
    function next(u, v) {
      const list = adj.get(v)
      if (!list?.length) return null
      const idx = list.findIndex(nb => nb.neighborId === u)
      if (idx === -1) return null
      return list[(idx - 1 + list.length) % list.length].neighborId
    }

    // ── Phase 2: Trace faces → blocks, classify, generate lots ───────────────
    const visited = new Set()
    const blocks = []
    const buildings = []
    let blockId = 0, buildingId = 0
    let squareCount = 0, singleCount = 0, subdivCount = 0

    for (const node of nodes) {
      for (const nb of (adj.get(node.id) || [])) {
        const startKey = `${node.id}→${nb.neighborId}`
        if (visited.has(startKey)) continue

        const faceNodes = []
        const faceEdgeKeys = []
        let u = node.id, v = nb.neighborId
        let iters = 0

        while (true) {
          const key = `${u}→${v}`
          if (visited.has(key) || ++iters > nodes.length + 5) break
          visited.add(key)
          faceNodes.push(nodeById.get(u))
          faceEdgeKeys.push(`${u}-${v}`)
          const w = next(u, v)
          if (w === null) break
          u = v; v = w
        }

        if (faceNodes.length < 3) continue

        // Shoelace signed area — interior faces are positive in y-down screen coords
        let area = 0
        for (let i = 0; i < faceNodes.length; i++) {
          const a = faceNodes[i], b = faceNodes[(i + 1) % faceNodes.length]
          area += a.x * b.y - b.x * a.y
        }
        area /= 2
        if (area <= 0.001) continue

        // Tag block with the majority districtId from its bounding half-edges
        const districtVotes = new Map()
        for (const key of faceEdgeKeys) {
          const dId = edgeDistrictByKey.get(key)
          if (dId != null) districtVotes.set(dId, (districtVotes.get(dId) || 0) + 1)
        }
        let districtId = null, maxVotes = 0
        for (const [dId, votes] of districtVotes) {
          if (votes > maxVotes) { maxVotes = votes; districtId = dId }
        }

        const vertices = faceNodes.map(n => ({ x: n.x, y: n.y }))

        // ── Block classification ───────────────────────────────────────────────
        const district = districtId != null ? districtMap.get(districtId) : null
        const params = getParams(district)

        // AABB aspect ratio: max extent / min extent
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (const v of vertices) {
          if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x
          if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y
        }
        const w = maxX - minX, h = maxY - minY
        const aspectRatio = Math.max(w, h) / Math.max(Math.min(w, h), 1e-6)

        let blockType
        if (area < params.minBlockSize || aspectRatio > params.maxAspectRatio) {
          blockType = 'square'
        } else if (area < params.minLotSize) {
          blockType = 'single'
        } else {
          blockType = 'subdivided'
        }

        const block = { id: blockId++, districtId, vertices, area, blockType }
        blocks.push(block)

        if (blockType === 'square') {
          squareCount++
          continue
        }

        if (blockType === 'single') {
          singleCount++
          buildings.push({ id: buildingId++, blockId: block.id, districtId, vertices })
          continue
        }

        // ── Phase 3: Voronoi lots seeded along block boundary ─────────────────
        subdivCount++
        const spacing = params.lotSpacing

        const rawSeeds = []
        for (let i = 0; i < vertices.length; i++) {
          const pA = vertices[i], pB = vertices[(i + 1) % vertices.length]
          rawSeeds.push({ x: pA.x, y: pA.y })
          const dx = pB.x - pA.x, dy = pB.y - pA.y
          const len = Math.hypot(dx, dy)
          const steps = Math.floor(len / spacing)
          for (let k = 1; k < steps; k++) {
            const t = k / steps
            rawSeeds.push({ x: pA.x + t * dx, y: pA.y + t * dy })
          }
        }

        const minDist = spacing * 0.4
        const seeds = []
        for (const s of rawSeeds) {
          if (!seeds.some(e => Math.hypot(s.x - e.x, s.y - e.y) < minDist)) seeds.push(s)
        }
        if (seeds.length < 3) continue

        for (const cell of computeVoronoiCells(seeds, vertices, params.metric ?? 'euclidean')) {
          buildings.push({ id: buildingId++, blockId: block.id, districtId, vertices: cell.polygon })
        }
      }
    }

    console.log(`CityBlockGenerator: ${blocks.length} blocks (${squareCount} squares, ${singleCount} single, ${subdivCount} subdivided), ${buildings.length} lots`)
    return { blocks, buildings }
  }
}
