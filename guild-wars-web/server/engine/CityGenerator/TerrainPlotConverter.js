import { polygonCrossesSegment } from '../voronoi/VoronoiUtils.js'

// Convert world-level terrain fine Voronoi cells into plot objects.
// City plots render on top at GROUND_Y, terrain plots at GROUND_Y - 0.001, so
// terrain is not visible under the city without needing an explicit gutter clip.
//
// outerGutterPolygon: kept as parameter for backward compatibility but not used.
// tradeRoadWaypoints: array of waypoint arrays [[{x,y}, ...], ...] — consecutive
// pairs form road centreline segments. Terrain plots crossed by a road are flagged
// with `hasRoad: true` for future road-side building placement.
// worldRegions: coarse terrain region array — fine cells always have assignedType: null,
// so we look it up from the parent region.
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
      assignedType: cell.assignedType ?? regionTypeById.get(cell.parentRegionId) ?? null,
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
