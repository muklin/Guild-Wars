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
// registry: GroundPointRegistry (TODO.md "Groundplane Z-height implementation", plan
// "rustling-churning-finch") — resolves each vertex's real z by id, since cell.polygon
// itself never carries z (only the registry Point does). Without this, GroundRenderer
// (which owns terrain-plot rendering from District Setup onward, taking over from
// TerrainRenderer) rendered every terrain plot dead flat regardless of the Terrain
// Setup z-height work — confirmed live 2026-07-12 ("assigning one district cleared all
// z heights", actually a rendering-handoff gap, not a data wipe).
export function convertTerrainCellsToPlots(terrainPlots, tradeRoadWaypoints = [], worldRegions = [], riverCliffFaces = [], registry = null, cliffEdgeBands = []) {
  const regionTypeById = new Map(worldRegions.map(r => [r.id, r.assignedType]))
  // Resolves by ID, not by reading `.id` off the vertex object (user-confirmed
  // 2026-07-15, "SOMETHING at the end of District setup or start of Guild setup sets
  // all the central terrain back to lower height values"): cell.polygon's vertices are
  // plain {x,y} once a plot has gone through ANY pullback pass (see
  // _dcelPullbackMaterialize's own output: `{x: p.x, y: p.y}`, never an .id) — they
  // never carried an .id field to check in the first place, so the old `v.id != null`
  // test was always false and this silently fell back to 0 for virtually every plot.
  // Real z lives only in the PARALLEL cell.pointIds array, matched to cell.polygon by
  // index (both built from the same half-edge walk, same length, same order — see
  // _dcelPullbackMaterialize) — callers below now pass the id directly instead of the
  // vertex object.
  const zOf = (id) => (id != null ? registry?.get(id)?.z : null) ?? 0

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
    // Stage D (ADR-0020): prefer cell.polygon when it's already present — it's the
    // freshly-computed value for THIS pass and must win over a registry read, which
    // could disagree if some other kind's mintDeduped call touched a shared vertex
    // between when cell.polygon was set and now (self-heal snaps by kind, but a stale
    // read here would still be wrong-by-construction to prefer). Only resolve through
    // the registry when polygon is genuinely absent (a save with blockCorners-style
    // fields stripped) — same priority order as every other site touched this stage.
    const poly = cell.polygon
      ? cell.polygon.map((v, i) => ({ x: v.x, y: v.y, z: v.z ?? zOf(cell.pointIds?.[i]) }))
      : (cell.pointIds?.length && registry
        ? cell.pointIds.map(id => registry.get(id)).filter(Boolean).map(p => ({ x: p.x, y: p.y, z: p.z }))
        : null)
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
    const poly = face.polygon?.length
      ? face.polygon.map((v, i) => ({ x: v.x, y: v.y, z: v.z ?? zOf(face.pointIds?.[i]) }))
      : (face.pointIds?.length && registry
        ? face.pointIds.map(id => registry.get(id)).filter(Boolean).map(p => ({ x: p.x, y: p.y, z: p.z }))
        : [])
    if (poly.length < 3) continue
    plots.push({
      id: `rcf${face.id}`,
      terrainPlotId: null,
      regionId: null,
      blockId: null,
      districtId: null,
      assignedType: face.assignedType,
      // Computed once, server-side, in GroundplaneAudit._buildRiverCliffFacesDirect —
      // a Cliff face bordering Ice Sheet always renders white (user-confirmed
      // 2026-07-26), and GroundRenderer (which owns this plot from here on) has no
      // edges/regions data of its own to re-derive this from.
      iceSheetAdjacent: !!face.iceSheetAdjacent,
      blockCorners: poly,
      streetEdges: [],
      type: 'terrain',
      hasRoad: false,
    })
  }

  // Cliff-Edge bands (ADR-0022 Stage 2, CliffEdgeBands.js): the SAME pull-back that opens
  // room for these bands also permanently moves the bordering LAND plot's own cliff-side
  // corners inland (TransitionBand.js "Rule 2: swap the inland copy into EVERY kept
  // plot"), on the raw `terrainPlots` this function reads too — meaning the strip between
  // a Cliff face and its now-set-back land plot is real, un-rendered void in walk mode
  // unless something fills it. Terrain Setup mode's ADR-0022 terrainSurfaces merges these
  // bands into its own subdivided mesh (_syncGroundplaneSurfaces), but that pipeline is
  // never used here — GroundRenderer (which owns terrain from District Setup onward) only
  // ever consumed riverCliffFaces above, so a Cliff-Edge band was a real, walkable-through
  // gap right at every cliff's own land edge (confirmed live 2026-07-26: "terrain edge
  // still showing"/"the high side berm" — the exposed, un-pulled-back sliver of the OLD
  // land-plot edge peeking through). Converted exactly like riverCliffFaces above.
  for (const band of cliffEdgeBands) {
    const poly = band.polygon?.length
      ? band.polygon.map((v, i) => ({ x: v.x, y: v.y, z: v.z ?? zOf(band.pointIds?.[i]) }))
      : (band.pointIds?.length && registry
        ? band.pointIds.map(id => registry.get(id)).filter(Boolean).map(p => ({ x: p.x, y: p.y, z: p.z }))
        : [])
    if (poly.length < 3) continue
    plots.push({
      id: `ceb${band.id}`,
      terrainPlotId: null,
      regionId: band.parentRegionId ?? null,
      blockId: null,
      districtId: null,
      assignedType: band.assignedType,
      iceSheetAdjacent: !!band.iceSheetAdjacent,
      blockCorners: poly,
      streetEdges: [],
      type: 'terrain',
      hasRoad: false,
    })
  }

  const failed = terrainPlots.length - (plots.length - riverCliffFaces.length - cliffEdgeBands.length)
  console.log(`TerrainPlotConverter: ${plots.length - riverCliffFaces.length - cliffEdgeBands.length} terrain plots from ${terrainPlots.length} raw plots (${failed} degenerate), ${riverCliffFaces.length} river/cliff face(s), ${cliffEdgeBands.length} cliff-edge band(s)`)
  return plots
}
