// Peak cones for High-ground clusters (ADR-0024 — see TerrainErosion.js for the other half
// of the same design). Supersedes the ADR-0023 version of this file: that one found ONE
// highest point per REGION, once, additively. This version finds N peaks across an entire
// High-ground CLUSTER (a maximal connected group of Mountains+Hills regions — the two types
// freely connect to each other, not just their own kind), and is fully REGENERATABLE:
// `regenerateHighGroundCluster` can be called any number of times and always produces the
// same result from the same underlying terrain, because it always writes `p.z = p.baseZ +
// <cone contribution>` (a plain assignment) rather than accumulating on its own prior
// output. `p.baseZ` (TerrainZHeight.js) is the canonical "terrain before any relief" height
// — set once by the delta/taper step, never touched by this file.
//
// Regeneration is triggered from TerrainSetup.assignTerrainToRegion whenever a region's
// type-assignment changes a cluster's own membership (direct Apply, or auto-revealed/
// absorbed) — never by an unrelated later edit once membership is stable (see docs/adr/0024).
import { TERRAIN_TYPES, PEAK_PLOTS_PER_PEAK, PEAK_MIN_SEPARATION_FRACTION } from '../../../worldConfig/terrainConfig.js'
import { getRegionDomainPointIds } from './TerrainZHeight.js'

const HIGH_GROUND_TYPES = new Set(['Mountains', 'Hills'])

// Every maximal connected group of Mountains/Hills regions currently in the world, walking
// `edges` (worldTerrainData.edges) for adjacency — the same graph Region-to-Region Terrain
// Edges already live in. Hidden regions are excluded (no real `assignedType` to cluster by
// yet); a region touching no same-family neighbour is still its own single-member cluster.
export function findHighGroundClusters(regions, edges) {
  const byId = new Map((regions || []).filter(r => !r.hidden && HIGH_GROUND_TYPES.has(r.assignedType)).map(r => [r.id, r]))
  const adjacency = new Map()
  for (const id of byId.keys()) adjacency.set(id, new Set())
  for (const edge of Object.values(edges || {})) {
    const a = edge.regionA, b = edge.regionB
    if (byId.has(a) && byId.has(b)) { adjacency.get(a).add(b); adjacency.get(b).add(a) }
  }
  const visited = new Set()
  const clusters = []
  for (const id of byId.keys()) {
    if (visited.has(id)) continue
    const cluster = []
    const queue = [id]
    visited.add(id)
    while (queue.length) {
      const cur = queue.shift()
      cluster.push(byId.get(cur))
      for (const nb of adjacency.get(cur)) if (!visited.has(nb)) { visited.add(nb); queue.push(nb) }
    }
    clusters.push(cluster)
  }
  return clusters
}

// The single cluster containing `regionId` — null if that region isn't Mountains/Hills at
// all (nothing to cluster). Falls back to `[region]` alone if `findHighGroundClusters`
// somehow doesn't surface it (defensive only; every Mountains/Hills region is always in
// exactly one cluster, even a single-member one).
export function findHighGroundClusterContaining(regionId, regions, edges) {
  const region = (regions || []).find(r => r.id === regionId)
  if (!region || !HIGH_GROUND_TYPES.has(region.assignedType)) return null
  const clusters = findHighGroundClusters(regions, edges)
  return clusters.find(c => c.some(r => r.id === regionId)) || [region]
}

// A cluster's own TRUE external boundary corners — edges where exactly one side is IN the
// cluster. An edge between two cluster members is an ordinary interior seam now (a Peak may
// legitimately apex there), not an exclusion boundary — unlike TerrainZHeight's own
// getRegionCornerIds, which returns a region's FULL boundary (every neighbour, cluster
// sibling or not) and would wrongly exclude those interior seams here.
export function getClusterCornerIds(edges, clusterRegionIds) {
  const clusterSet = new Set(clusterRegionIds)
  const ids = new Set()
  for (const edge of Object.values(edges || {})) {
    const inA = clusterSet.has(edge.regionA), inB = clusterSet.has(edge.regionB)
    if (inA !== inB) for (const id of edge.pointIds || []) ids.add(id)
  }
  return [...ids]
}

// Regenerates every Peak (location + height) for one High-ground cluster, from scratch, and
// the resulting cone height field over the cluster's own combined domain. `clusterRegions`:
// every region in the cluster (findHighGroundClusters/findHighGroundClusterContaining).
// `clusterCornerIds`: getClusterCornerIds's own output for this same cluster.
export function regenerateHighGroundCluster(registry, clusterRegions, terrainPlots, clusterCornerIds) {
  if (!clusterRegions?.length) return

  // Union domain across every member region. A point shared between two members (an
  // interior cluster seam) is attributed to whichever region's own iteration reaches it
  // first — arbitrary but deterministic, and only matters if that exact point becomes a
  // Peak's own apex (decides whose CONE_RADIUS_FRACTION/CONE_HEIGHT_RATIO sizes it).
  const regionOfPoint = new Map()
  const domainIdSet = new Set()
  for (const region of clusterRegions) {
    for (const id of getRegionDomainPointIds(terrainPlots, region.id)) {
      domainIdSet.add(id)
      if (!regionOfPoint.has(id)) regionOfPoint.set(id, region)
    }
  }
  const domainPoints = [...domainIdSet].map(id => registry.get(id)).filter(p => p && !p.zLocked && p.baseZ != null)
  if (!domainPoints.length) return

  const cornerIdSet = new Set(clusterCornerIds)
  const interiorPoints = domainPoints.filter(p => !cornerIdSet.has(p.id))
  const peakCandidates = interiorPoints.length ? interiorPoints : domainPoints

  // Cluster's own overall bounding radius (own centroid to farthest domain point) — only
  // used to scale the minimum separation between chosen Peaks, not their individual size.
  let cx = 0, cy = 0
  for (const r of clusterRegions) { cx += r.seedPoint.x; cy += r.seedPoint.y }
  cx /= clusterRegions.length; cy /= clusterRegions.length
  const clusterBoundingRadius = domainPoints.reduce((m, p) => Math.max(m, Math.hypot(p.x - cx, p.y - cy)), 0)
  const minSeparation = PEAK_MIN_SEPARATION_FRACTION * clusterBoundingRadius

  // Peak count scales with the cluster's own total terrain-plot count (a cheap, always-
  // available area proxy — avoids computing true polygon area over possibly-concave region
  // hulls).
  const plotCount = clusterRegions.reduce((s, r) =>
    s + (terrainPlots || []).filter(p => p.parentRegionId === r.id && !p.hidden).length, 0)
  const peakCount = Math.max(1, Math.round(plotCount / PEAK_PLOTS_PER_PEAK))

  // Each region's own bounding radius (seed to its own farthest domain point) — same
  // formula ADR-0023's version used, just resolved per-peak (by containing region) instead
  // of once for the whole region.
  const regionBoundingRadius = new Map()
  const boundingRadiusFor = (region) => {
    if (regionBoundingRadius.has(region.id)) return regionBoundingRadius.get(region.id)
    const pts = getRegionDomainPointIds(terrainPlots, region.id).map(id => registry.get(id)).filter(Boolean)
    const r = pts.reduce((m, p) => Math.max(m, Math.hypot(p.x - region.seedPoint.x, p.y - region.seedPoint.y)), 0)
    regionBoundingRadius.set(region.id, r)
    return r
  }

  // Greedy selection: highest baseZ first, skipping any candidate too close to an
  // already-chosen Peak. Falls back to ignoring separation (fills remaining slots from the
  // same height-sorted list) if too few candidates satisfy it — same graceful-degrade
  // spirit as the interior/corner fallback above, rather than silently placing fewer Peaks
  // than `peakCount` calls for.
  const sorted = [...peakCandidates].sort((a, b) => b.baseZ - a.baseZ)
  const chosen = []
  for (const p of sorted) {
    if (chosen.length >= peakCount) break
    if (chosen.every(c => Math.hypot(c.x - p.x, c.y - p.y) >= minSeparation)) chosen.push(p)
  }
  for (const p of sorted) {
    if (chosen.length >= peakCount) break
    if (!chosen.includes(p)) chosen.push(p)
  }

  const peaks = chosen.map(p => {
    const region = regionOfPoint.get(p.id) || clusterRegions[0]
    const rule = TERRAIN_TYPES[region.assignedType]
    const boundingRadius = boundingRadiusFor(region)
    return {
      x: p.x, y: p.y, region,
      coneRadius: rule.CONE_RADIUS_FRACTION * boundingRadius,
      peakBump: rule.CONE_HEIGHT_RATIO * boundingRadius,
    }
  }).filter(peak => peak.coneRadius > 0)

  // Height: baseZ + the TALLEST reaching Peak's own cosine-falloff contribution (not
  // summed) — where two Peaks' cones overlap, the taller one wins at each point, giving a
  // natural saddle between summits instead of a fused blob (confirmed live 2026-07-30).
  for (const p of domainPoints) {
    let bump = 0
    for (const peak of peaks) {
      const d = Math.hypot(p.x - peak.x, p.y - peak.y)
      if (d >= peak.coneRadius) continue
      const t = d / peak.coneRadius
      const contribution = peak.peakBump * (Math.cos(t * Math.PI) + 1) * 0.5
      if (contribution > bump) bump = contribution
    }
    p.z = p.baseZ + bump
  }

  // Persist by containing region (region.peaks, plural — replaces the old singular
  // region.peakPoint). Cleared for EVERY member first: a region regenerating as part of a
  // cluster it just joined (or one that just grew/shrank) must not keep a stale set from
  // whatever cluster shape it had last time.
  for (const region of clusterRegions) region.peaks = []
  for (const peak of peaks) peak.region.peaks.push({ x: peak.x, y: peak.y })
}
