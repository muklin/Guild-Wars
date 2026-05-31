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
    const districtMap = new Map(districts.map(d => [d.id, d]))
    const cells = streetGraph?.cells || []
    const blocks = []
    const plots  = []
    let blockId = 0, plotId = 0

    for (const cell of cells) {
      const vertices = cell.polygon
      if (!vertices || vertices.length < 3) continue

      // Use absolute area — cells may be wound either way after clipping.
      let area = 0
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i], b = vertices[(i + 1) % vertices.length]
        area += a.x * b.y - b.x * a.y
      }
      area = Math.abs(area) / 2
      if (area < 1e-6) continue

      const district  = districtMap.get(cell.districtId)
      const params    = getParams(district)
      const districtId = cell.districtId

      // ── City block: too small to subdivide — one plot = whole block ────────
      if (area < params.minBlockSize) {
        const bId = blockId++
        blocks.push({ id: bId, districtId, vertices, area, blockType: 'square' })
        plots.push({ id: plotId++, blockId: bId, districtId, vertices })
        continue
      }

      // ── Seed along cell edges, inset slightly toward centroid ─────────────────
      // Seeds placed exactly on the perimeter are collinear for elongated blocks,
      // causing degenerate Delaunay triangles with circumcenters far outside the
      // polygon. Pushing each seed inward by halfWidth/2 breaks collinearity
      // while keeping the edge-aligned plot character.
      const halfWidth = params.lotWidth / 2
      const insetAmount = halfWidth * 0.5
      const bcx = vertices.reduce((s, v) => s + v.x, 0) / vertices.length
      const bcy = vertices.reduce((s, v) => s + v.y, 0) / vertices.length
      const seeds = []
      const n = vertices.length
      for (let i = 0; i < n; i++) {
        const uv = vertices[i], vv = vertices[(i + 1) % n]
        const dx = vv.x - uv.x, dy = vv.y - uv.y
        const edgeLen = Math.sqrt(dx * dx + dy * dy)
        if (edgeLen < 1e-10) continue
        const startDist = halfWidth
        const endDist   = edgeLen - halfWidth
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

      // ── Single plot: above threshold but no seeds fit ────────────────────────
      if (seeds.length === 0) {
        blocks.push({ id: bId, districtId, vertices, area, blockType: 'single' })
        plots.push({ id: plotId++, blockId: bId, districtId, vertices })
        continue
      }

      // ── Subdivided: plot Voronoi clipped to cell ─────────────────────────────
      const plotCells = computeVoronoiCells(seeds, vertices)
      if (plotCells.length === 0) {
        // Voronoi degenerated (collinear seeds, non-convex polygon, etc.) — whole block = one plot
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
}
