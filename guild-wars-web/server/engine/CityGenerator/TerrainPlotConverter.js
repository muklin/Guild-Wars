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

// Convert raw terrain plots (Voronoi cells from TerrainVoronoiGenerator) into
// renderable plot objects. Terrain plots belonging to the city footprint are excluded by
// the caller (parentRegionId filter) rather than clipped after the fact — no boolean
// polygon clipping (see plan "typed-giggling-giraffe" ADR-0020 decision 2).
// tradeRoadWaypoints: array of waypoint arrays [[{x,y}, ...], ...] — consecutive pairs
// form road centreline segments. Plots crossed by a road are flagged `hasRoad: true`.
// worldRegions: coarse terrain region array for assignedType lookup.
// riverCliffFaces: real DCEL River/Cliff faces (see SetupPhase._buildRiverCliffFaces,
// plan "typed-giggling-giraffe" addendum) — appended as synthesized `type:'terrain'`
// plots so GroundRenderer (which takes over from TerrainRenderer once District Setup
// finishes) fills them too, instead of the pre-DCEL stroke-only rendering leaving a
// bare gap. `terrainPlotId`/`regionId`/`blockId`/`districtId` are all null — a
// river/cliff face spans two regions and isn't a promotable, seed-having cell like a
// normal terrain plot.
export function convertTerrainCellsToPlots(terrainPlots, tradeRoadWaypoints = [], worldRegions = [], riverCliffFaces = []) {
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

  for (const cell of terrainPlots) {
    const poly = cell.polygon.map(v => ({ x: v.x, y: v.y }))
    if (!poly || poly.length < 3) continue

    const hasRoad = roadSegments.some(seg => polygonCrossesSegment(poly, seg.a, seg.b))

    plots.push({
      id: `t${plotId++}`,
      terrainPlotId: cell.id,
      regionId: cell.parentRegionId,
      blockId: null,
      districtId: null,
      assignedType: cell.assignedType ?? inferTerrainType(cell, regionTypeById, worldRegions),
      blockCorners: poly,
      streetEdges: [],
      type: 'terrain',
      hasRoad,
    })
  }

  for (const face of riverCliffFaces) {
    const poly = (face.polygon || []).map(v => ({ x: v.x, y: v.y }))
    if (poly.length < 3) continue
    plots.push({
      id: `rcf${face.id}`,
      terrainPlotId: null,
      regionId: null,
      blockId: null,
      districtId: null,
      assignedType: face.assignedType,
      blockCorners: poly,
      streetEdges: [],
      type: 'terrain',
      hasRoad: false,
    })
  }

  const failed = terrainPlots.length - (plots.length - riverCliffFaces.length)
  console.log(`TerrainPlotConverter: ${plots.length - riverCliffFaces.length} terrain plots from ${terrainPlots.length} raw plots (${failed} degenerate), ${riverCliffFaces.length} river/cliff face(s)`)
  return plots
}
