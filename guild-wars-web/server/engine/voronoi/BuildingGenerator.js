const BUILDING_HEIGHT = 0.8

const DISTRICT_BUILDING_PARAMS = {
  Market:              { setback: 0.1,  lotWidth: 0.2, lotDepth: 0.7, lotSpacing: 0.15, rotJitter: 0.05, placeJitter: 0.10, placementAlgo: 'frontage' },
  Military:            { setback: 0.25, lotWidth: 0.8, lotDepth: 1.5, lotSpacing: 0.10, rotJitter: 0.02, placeJitter: 0.05, placementAlgo: 'poisson', poissonRadius: 1.5 },
  Residential:         { setback: 0.0,  lotWidth: 0.2, lotDepth: 0.5, lotSpacing: 0.20, rotJitter: 0.10, placeJitter: 0.15, placementAlgo: 'frontage' },
  'Residential-Noble': { setback: 0.6,  lotWidth: 1.2, lotDepth: 1.5, lotSpacing: 0.30, rotJitter: 0.05, placeJitter: 0.20, placementAlgo: 'poisson', poissonRadius: 1.5 },
  'Residential-Slums': { setback: 0.0,  lotWidth: 0.2, lotDepth: 0.5, lotSpacing: 0.20, rotJitter: 0.10, placeJitter: 0.15, placementAlgo: 'poisson', poissonRadius: 0.5 },
  Leadership:          { setback: 0.2,  lotWidth: 0.5, lotDepth: 1.0, lotSpacing: 0.40, rotJitter: 0.02, placeJitter: 0.10, placementAlgo: 'poisson', poissonRadius: 0.5 },
  Entertainment:       { setback: 0.2,  lotWidth: 1.1, lotDepth: 0.9, lotSpacing: 0.25, rotJitter: 0.10, placeJitter: 0.20, placementAlgo: 'poisson', poissonRadius: 0.7 },
  default:             { setback: 0.2,  lotWidth: 0.9, lotDepth: 0.7, lotSpacing: 0.20, rotJitter: 0.10, placeJitter: 0.15, placementAlgo: 'frontage' },
}

export { BUILDING_HEIGHT, DISTRICT_BUILDING_PARAMS }

function getParams(district) {
  const type = district.assignedType
  const cls = district.residentialClass
  let key = type
  if (type === 'Residential' && cls === 'Noble') key = 'Residential-Noble'
  else if (type === 'Residential' && cls === 'Slums') key = 'Residential-Slums'
  return DISTRICT_BUILDING_PARAMS[key] ?? DISTRICT_BUILDING_PARAMS.default
}

function makePrng(seed) {
  let s = ((seed + 1) * 2654435761) >>> 0
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0x100000000 }
}

function pointInPolygon(px, py, polygon) {
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

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function obbCorners(cx, cy, width, depth, rot) {
  const hw = width / 2, hd = depth / 2
  const cos = Math.cos(rot), sin = Math.sin(rot)
  return [
    [cx + cos * hw - sin * hd, cy + sin * hw + cos * hd],
    [cx - cos * hw - sin * hd, cy - sin * hw + cos * hd],
    [cx - cos * hw + sin * hd, cy - sin * hw - cos * hd],
    [cx + cos * hw + sin * hd, cy + sin * hw - cos * hd],
  ]
}

function polyCentroid(polygon) {
  let cx = 0, cy = 0
  for (const v of polygon) { cx += v.x; cy += v.y }
  return { x: cx / polygon.length, y: cy / polygon.length }
}

export default class BuildingGenerator {
  generate(districts, streetGraph) {
    const nodeById = new Map(streetGraph.nodes.map(n => [n.id, n]))
    const buildings = []
    let nextId = 0

    for (const district of districts) {
      const params = getParams(district)
      const polygon = district.polygon
      const cent = polyCentroid(polygon)
      const districtEdges = streetGraph.edges.filter(e => e.districtId === district.id)
      const rng = makePrng(district.id)
      const placed = []

      const minSep = Math.max(params.lotWidth, params.lotDepth) * 0.85

      const tryPlace = (cx, cy, rot) => {
        const jx = (rng() - 0.5) * 2 * params.placeJitter
        const jy = (rng() - 0.5) * 2 * params.placeJitter
        const x = cx + jx, y = cy + jy
        const finalRot = rot + (rng() - 0.5) * 2 * params.rotJitter

        const corners = obbCorners(x, y, params.lotWidth, params.lotDepth, finalRot)
        if (!corners.every(([cx2, cy2]) => pointInPolygon(cx2, cy2, polygon))) return
        if (placed.some(p => Math.hypot(p.x - x, p.y - y) < minSep)) return

        placed.push({ x, y })
        buildings.push({ id: nextId++, districtId: district.id, x, y, width: params.lotWidth, depth: params.lotDepth, rotation: finalRot })
      }

      if (params.placementAlgo === 'frontage') {
        for (const edge of districtEdges) {
          const nA = nodeById.get(edge.nodeA), nB = nodeById.get(edge.nodeB)
          if (!nA || !nB) continue
          const dx = nB.x - nA.x, dy = nB.y - nA.y
          const len = Math.hypot(dx, dy)
          if (len < params.lotWidth) continue
          const ux = dx / len, uy = dy / len
          const rot = Math.atan2(dy, dx)
          const offset = params.setback + params.lotDepth / 2

          for (let t = params.lotWidth / 2; t <= len - params.lotWidth / 2; t += params.lotWidth + params.lotSpacing) {
            const ex = nA.x + ux * t, ey = nA.y + uy * t
            for (const sign of [1, -1]) {
              const px = ex + (-uy) * sign * offset
              const py = ey + ux * sign * offset
              tryPlace(px, py, rot)
            }
          }
        }
      } else {
        // Poisson disk sampling
        const allEdgeSegs = districtEdges.map(e => {
          const nA = nodeById.get(e.nodeA), nB = nodeById.get(e.nodeB)
          return nA && nB ? [nA.x, nA.y, nB.x, nB.y] : null
        }).filter(Boolean)

        const xs = polygon.map(v => v.x), ys = polygon.map(v => v.y)
        const minX = Math.min(...xs), maxX = Math.max(...xs)
        const minY = Math.min(...ys), maxY = Math.max(...ys)
        const r = params.poissonRadius ?? 1.5
        const cellSize = r / Math.SQRT2
        const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize))
        const rows = Math.max(1, Math.ceil((maxY - minY) / cellSize))
        const grid = new Array(cols * rows).fill(null)
        const active = []
        const samples = []

        const gridIdx = (x, y) => {
          const c = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cellSize)))
          const ro = Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cellSize)))
          return ro * cols + c
        }

        const tooClose = (x, y) => {
          const c = Math.floor((x - minX) / cellSize)
          const ro = Math.floor((y - minY) / cellSize)
          for (let dc = -2; dc <= 2; dc++) {
            for (let dr = -2; dr <= 2; dr++) {
              const nc = c + dc, nr = ro + dr
              if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
              const s = grid[nr * cols + nc]
              if (s && Math.hypot(s[0] - x, s[1] - y) < r) return true
            }
          }
          return false
        }

        if (pointInPolygon(cent.x, cent.y, polygon)) {
          const gi = gridIdx(cent.x, cent.y)
          grid[gi] = [cent.x, cent.y]
          active.push([cent.x, cent.y])
          samples.push([cent.x, cent.y])
        }

        while (active.length > 0) {
          const idx = Math.floor(rng() * active.length)
          const pt = active[idx]
          let found = false
          for (let k = 0; k < 20; k++) {
            const angle = rng() * 2 * Math.PI
            const d = r + rng() * r
            const nx = pt[0] + Math.cos(angle) * d
            const ny = pt[1] + Math.sin(angle) * d
            if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue
            if (!pointInPolygon(nx, ny, polygon)) continue
            if (tooClose(nx, ny)) continue
            const gi = gridIdx(nx, ny)
            grid[gi] = [nx, ny]
            active.push([nx, ny])
            samples.push([nx, ny])
            found = true
            break
          }
          if (!found) active.splice(idx, 1)
        }

        const minEdgeDist = params.setback + params.lotDepth / 2
        for (const [sx, sy] of samples) {
          if (allEdgeSegs.some(([ax, ay, bx, by]) => distToSegment(sx, sy, ax, ay, bx, by) < minEdgeDist)) continue

          let bestDist = Infinity, bestRot = 0
          for (const [ax, ay, bx, by] of allEdgeSegs) {
            const d = distToSegment(sx, sy, ax, ay, bx, by)
            if (d < bestDist) { bestDist = d; bestRot = Math.atan2(by - ay, bx - ax) }
          }

          tryPlace(sx, sy, bestRot)
        }
      }
    }

    return buildings
  }
}
