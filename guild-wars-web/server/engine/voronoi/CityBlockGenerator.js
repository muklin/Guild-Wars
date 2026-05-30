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

function normalizeAngle(a) {
  while (a >  Math.PI) a -= 2 * Math.PI
  while (a <= -Math.PI) a += 2 * Math.PI
  return a
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

      // ── City block: too small to subdivide ──────────────────────────────────
      if (area < params.minBlockSize) {
        blocks.push({ id: blockId++, districtId, vertices, area, blockType: 'square' })
        continue
      }

      // ── Seed along cell edges ────────────────────────────────────────────────
      // Every cell vertex is a Voronoi vertex where three or more cells meet,
      // so the dead zone (lotWidth/2 pull-back) applies at every endpoint.
      const halfWidth = params.lotWidth / 2
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
          seeds.push({ x: uv.x + ux * t, y: uv.y + uy * t })
        }
      }

      // Add centroid as interior seed to break collinearity of edge seeds.
      // Centroid of a convex polygon is always inside, giving every edge seed
      // at least one non-collinear Delaunay triangle → valid circumcenters.
      if (seeds.length > 0) {
        const cx = vertices.reduce((s, v) => s + v.x, 0) / vertices.length
        const cy = vertices.reduce((s, v) => s + v.y, 0) / vertices.length
        seeds.push({ x: cx, y: cy })
      }

      const bId = blockId++

      // ── Single plot: above threshold but no seeds fit ────────────────────────
      if (seeds.length === 0) {
        blocks.push({ id: bId, districtId, vertices, area, blockType: 'single' })
        plots.push({ id: plotId++, blockId: bId, districtId, vertices })
        continue
      }

      // ── Subdivided: plot Voronoi clipped to cell ─────────────────────────────
      blocks.push({ id: bId, districtId, vertices, area, blockType: 'subdivided' })
      for (const plotCell of computeVoronoiCells(seeds, vertices)) {
        plots.push({ id: plotId++, blockId: bId, districtId, vertices: plotCell.polygon })
      }
    }

    const sq = blocks.filter(b => b.blockType === 'square').length
    const si = blocks.filter(b => b.blockType === 'single').length
    const sd = blocks.filter(b => b.blockType === 'subdivided').length
    console.log(`CityBlockGenerator: ${blocks.length} blocks (${sq} city, ${si} single, ${sd} subdivided), ${plots.length} plots`)
    return { blocks, plots }
  }
}
