import { polygonCrossesSegment } from '../voronoi/VoronoiUtils.js'

// For cells belonging to the City coarse region (gap-strip cells between the outer
// gutter and the world Voronoi boundary), look up the nearest non-City region's type
// so the visible strip matches the surrounding terrain rather than rendering as
// 'unassigned' brown.
function inferTerrainType(cell, regionTypeById, worldRegions) {
  const t = regionTypeById.get(cell.parentRegionId)
  if (t && t !== 'City') return t

  // City-region cell: find nearest non-City coarse region by seed distance.
  const poly = cell.polygon
  const cx = poly.reduce((s, v) => s + v.x, 0) / poly.length
  const cy = poly.reduce((s, v) => s + v.y, 0) / poly.length
  let bestDist = Infinity, bestType = null
  for (const r of worldRegions) {
    if (r.assignedType === 'City' || !r.assignedType) continue
    const sp = r.seedPoint
    if (!sp) continue
    const d = (sp.x - cx) ** 2 + (sp.y - cy) ** 2
    if (d < bestDist) { bestDist = d; bestType = r.assignedType }
  }
  return bestType ?? 'Plains'
}

// Convert world-level terrain fine Voronoi cells into plot objects.
// City plots render on top at GROUND_Y, terrain plots at GROUND_Y - 0.001, so
// terrain is not visible under the city without needing an explicit gutter clip.
//
// outerGutterPolygon: kept as parameter for backward compatibility but not used.
// tradeRoadWaypoints: array of waypoint arrays [[{x,y}, ...], ...] — consecutive
// pairs form road centreline segments. Terrain plots crossed by a road are flagged
// with `hasRoad: true` for future road-side building placement.
// worldRegions: coarse terrain region array — fine cells always have assignedType: null,
// so we look it up from the parent region (City-region cells get the nearest non-City
// region's type so the gap strip between gutter and Voronoi boundary looks correct).
export function convertTerrainCellsToPlots(terrainFineCells, outerGutterPolygon, tradeRoadWaypoints = [], worldRegions = []) {
  const regionTypeById = new Map(worldRegions.map(r => [r.id, r.assignedType]))

  // Flatten trade road waypoints into segments [{a,b}]
  const roadSegments = []
  for (const waypoints of tradeRoadWaypoints) {
    for (let i = 0; i < waypoints.length - 1; i++) {
      roadSegments.push({ a: waypoints[i], b: waypoints[i + 1] })
    }
  }

  const plots = []
  let plotId = 0

  for (const cell of terrainFineCells) {
    // Use the cell polygon as-is (no gutter clip). The star-shaped city gutter
    // polygon is non-convex, so edge-by-edge half-plane clipping produces incorrect
    // results near concave gutter corners. City plots render on top of terrain plots
    // at the same Y, so unclipped terrain plots are invisible under the city.
    const poly = cell.polygon.map(v => ({ x: v.x, y: v.y }))
    if (!poly || poly.length < 3) continue

    const hasRoad = roadSegments.some(seg => polygonCrossesSegment(poly, seg.a, seg.b))

    plots.push({
      id: `t${plotId++}`,
      blockId: null,
      districtId: null,
      assignedType: cell.assignedType ?? inferTerrainType(cell, regionTypeById, worldRegions),
      blockCorners: poly,
      streetEdges: [],
      type: 'terrain',
      hasRoad,
    })
  }

  const failed = terrainFineCells.length - plots.length
  console.log(`TerrainPlotConverter: ${plots.length} terrain plots from ${terrainFineCells.length} cells (${failed} clipped/degenerate)`)
  return plots
}
