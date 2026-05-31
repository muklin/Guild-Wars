import { computeVoronoiCells } from './VoronoiUtils.js'


const DISTRICT_PARAMS = {
  Market:               { minBlockSize: 0.3, lotWidth: 0.25 },
  Military:             { minBlockSize: 0.5, lotWidth: 0.40 },
  Residential:          { minBlockSize: 0.3, lotWidth: 0.20 },
  'Residential-Middle': { minBlockSize: 0.3, lotWidth: 0.20 },
  'Residential-Noble':  { minBlockSize: 0.5, lotWidth: 0.30 },
  'Residential-Slums':  { minBlockSize: 0.2, lotWidth: 0.15 },
  Leadership:           { minBlockSize: 0.8, lotWidth: 0.35 },
  Entertainment:        { minBlockSize: 0.3, lotWidth: 0.28 },
  Religious:            { minBlockSize: 0.5, lotWidth: 0.30 },
  Magical:              { minBlockSize: 0.3, lotWidth: 0.25 },
  Industry:             { minBlockSize: 0.5, lotWidth: 0.45 },
  default:              { minBlockSize: 0.3, lotWidth: 0.22 },
}

export { DISTRICT_PARAMS }

function getParams(district) {
  if (!district) return DISTRICT_PARAMS.default
  const type = district.assignedType
  const cls  = district.residentialClass
  let key = type
  if (type === 'Residential' && cls === 'Noble')   key = 'Residential-Noble'
  else if (type === 'Residential' && cls === 'Slums')   key = 'Residential-Slums'
  else if (type === 'Residential' && cls === 'Middle')  key = 'Residential-Middle'
  return DISTRICT_PARAMS[key] ?? DISTRICT_PARAMS.default
}

export default class CityBlockGenerator {
  generate(districts, streetGraph) {
    const nodes = streetGraph?.nodes || []
    const edges = streetGraph?.edges || []
    const blocks = []
    const plots  = []
    let blockId = 0, plotId = 0

    const faces = this._traceFaces(nodes, edges)

    for (const vertices of faces) {
      if (vertices.length < 3) continue

      let area = 0
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i], b = vertices[(i + 1) % vertices.length]
        area += a.x * b.y - b.x * a.y
      }
      area = Math.abs(area) / 2
      if (area < 1e-6) continue

      const districtId = this._findDistrict(vertices, districts)
      const district   = districts.find(d => d.id === districtId)
      const params     = getParams(district)

      // ── City block: too small to subdivide — one plot = whole block ────────
      if (area < params.minBlockSize) {
        const bId = blockId++
        blocks.push({ id: bId, districtId, vertices, area, blockType: 'square' })
        plots.push({ id: plotId++, blockId: bId, districtId, vertices })
        continue
      }

      // ── Seed along face edges, inset slightly toward centroid ─────────────
      const insetAmount = params.lotWidth * 0.5 
      const bcx = vertices.reduce((s, v) => s + v.x, 0) / vertices.length
      const bcy = vertices.reduce((s, v) => s + v.y, 0) / vertices.length
      const seeds = []
      const n = vertices.length
      for (let i = 0; i < n; i++) {
        const uv = vertices[i], vv = vertices[(i + 1) % n]
        const dx = vv.x - uv.x, dy = vv.y - uv.y
        const edgeLen = Math.sqrt(dx * dx + dy * dy)
        if (edgeLen < 1e-10) continue
        const startDist = params.lotWidth 
        const endDist   = edgeLen - params.lotWidth 
        if (startDist >= endDist) continue
        const ux = dx / edgeLen, uy = dy / edgeLen
        for (let t = startDist; t <= endDist; t += params.lotWidth) {
          const sx = uv.x + ux * t, sy = uv.y + uy * t
          const toCx = bcx - sx, toCy = bcy - sy
          const d = Math.sqrt(toCx * toCx + toCy * toCy)
          if (d > 1e-10) {
            const push = Math.min(insetAmount, d * 0.5)
            seeds.push({ x: sx + toCx / d * push, y: sy + toCy / d * push })
          } else {
            seeds.push({ x: sx, y: sy })
          }
        }
      }

      const bId = blockId++

      if (seeds.length === 0) {
        blocks.push({ id: bId, districtId, vertices, area, blockType: 'single' })
        plots.push({ id: plotId++, blockId: bId, districtId, vertices })
        continue
      }

      const plotCells = computeVoronoiCells(seeds, vertices)
      if (plotCells.length === 0) {
        blocks.push({ id: bId, districtId, vertices, area, blockType: 'single' })
        plots.push({ id: plotId++, blockId: bId, districtId, vertices })
      } else {
        blocks.push({ id: bId, districtId, vertices, area, blockType: 'subdivided' })
        for (const plotCell of plotCells) {
          plots.push({ id: plotId++, blockId: bId, districtId, vertices: plotCell.polygon })
        }
      }
    }

    const sq = blocks.filter(b => b.blockType === 'square').length
    const si = blocks.filter(b => b.blockType === 'single').length
    const sd = blocks.filter(b => b.blockType === 'subdivided').length
    console.log(`CityBlockGenerator: ${blocks.length} blocks (${sq} city, ${si} single, ${sd} subdivided), ${plots.length} plots`)
    return { blocks, plots }
  }

  // Trace all interior faces of the planar street graph.
  // For each directed edge, walk by always taking the most-clockwise turn at each
  // junction — this traces the face to the right of travel direction.
  // Interior faces have negative signed area (clockwise winding).
  _traceFaces(nodes, edges) {
    if (!nodes.length || !edges.length) return []

    const nodeById = new Map(nodes.map(n => [n.id, n]))

    // Build adjacency: nodeId → [neighborId, ...]
    const adj = new Map(nodes.map(n => [n.id, []]))
    for (const edge of edges) {
      adj.get(edge.nodeA)?.push(edge.nodeB)
      adj.get(edge.nodeB)?.push(edge.nodeA)
    }

    // Sort each node's neighbor list counterclockwise by angle (needed for getNext)
    for (const [nodeId, neighbors] of adj) {
      const node = nodeById.get(nodeId)
      if (!node) continue
      neighbors.sort((a, b) => {
        const na = nodeById.get(a), nb = nodeById.get(b)
        if (!na || !nb) return 0
        return Math.atan2(na.y - node.y, na.x - node.x) -
               Math.atan2(nb.y - node.y, nb.x - node.x)
      })
    }

    // Given directed edge from→to, return the next node in the face walk:
    // the neighbor of 'to' that requires the smallest counterclockwise rotation
    // from the reverse-of-arrival direction — equivalent to the most-clockwise turn.
    const getNext = (from, to) => {
      const fromNode = nodeById.get(from), toNode = nodeById.get(to)
      if (!fromNode || !toNode) return null
      const reverseAngle = Math.atan2(fromNode.y - toNode.y, fromNode.x - toNode.x)
      const neighbors = adj.get(to) || []
      let best = null, bestDiff = Infinity
      for (const nb of neighbors) {
        const nbNode = nodeById.get(nb)
        if (!nbNode) continue
        const outAngle = Math.atan2(nbNode.y - toNode.y, nbNode.x - toNode.x)
        let diff = (outAngle - reverseAngle + 2 * Math.PI) % (2 * Math.PI)
        if (diff < 1e-10) diff = 2 * Math.PI  // near-zero = U-turn, use as last resort
        if (diff < bestDiff) { bestDiff = diff; best = nb }
      }
      return best
    }

    const visited = new Set()
    const faces   = []
    const maxSteps = nodes.length + 2

    for (const edge of edges) {
      for (const [u, v] of [[edge.nodeA, edge.nodeB], [edge.nodeB, edge.nodeA]]) {
        if (visited.has(`${u},${v}`)) continue

        const faceVerts = []
        let cu = u, cv = v, steps = 0

        do {
          visited.add(`${cu},${cv}`)
          const node = nodeById.get(cu)
          if (node) faceVerts.push({ x: node.x, y: node.y })
          const next = getNext(cu, cv)
          if (next == null) break
          cu = cv; cv = next
        } while ((cu !== u || cv !== v) && ++steps < maxSteps)

        if (faceVerts.length < 3) continue

        // Keep only clockwise-wound faces (negative signed area = interior blocks).
        // The outer / terrain face winds counterclockwise and is discarded.
        let area = 0
        for (let i = 0; i < faceVerts.length; i++) {
          const a = faceVerts[i], b = faceVerts[(i + 1) % faceVerts.length]
          area += a.x * b.y - b.x * a.y
        }
        if (area < 0) faces.push(faceVerts)
      }
    }

    return faces
  }

  // Find which district a face belongs to by testing its centroid.
  _findDistrict(vertices, districts) {
    const cx = vertices.reduce((s, v) => s + v.x, 0) / vertices.length
    const cy = vertices.reduce((s, v) => s + v.y, 0) / vertices.length
    for (const d of districts) {
      if (this._pip(cx, cy, d.polygon)) return d.id
    }
    return null
  }


  _pip(px, py, polygon) {
    let inside = false
    const n = polygon.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y
      const xj = polygon[j].x, yj = polygon[j].y
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
        inside = !inside
    }
    return inside
  }
}
