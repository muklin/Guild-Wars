// Terrain z-height propagation (TODO.md "Groundplane Z-height implementation", plan
// "rustling-churning-finch", ADR-0021). Pure functions, independent of SetupPhase.js so
// they're unit-testable against synthetic meshes — see TerrainZHeight.test.mjs.
//
// A terrain type's z effect (applied when the player hits Apply — see
// SetupPhase.assignTerrainToRegion) sets a delta on the source region's own corners,
// then propagates outward by walking the FINE Point/Edge graph (not the coarse
// terrain-region graph) from all of the source region's corners, blending each reached
// point's current z toward the source region's z using a distance-based falloff curve
// whose zero point is fixed at the farthest point actually reached — no discontinuity,
// no separately-calibrated endpoint.

// Every terrain type's delta + propagation shape. Sea/Lake use an S-curve (gradual near
// the source, steepest at the midpoint); everything else linear. Hop-count is the BFS
// bound (how far the wave is allowed to travel along the fine Point/Edge graph), NOT the
// falloff parameter — the falloff itself is a continuous function of Euclidean distance,
// see propagateFromRegion.
// Live tuning pass (2026-07-12, user feedback: original magnitudes "a bit too much"
// once actually rendered) — every non-zero amount below is the original design value /3.
// `direction`: the ONLY way this type's propagation is allowed to move a point (fixed
// 2026-07-13, user-confirmed "the only direction Hills should move terrain points is
// upwards") — a safety clamp in propagateFromRegion, independent of the domain-exclusion
// fix below (belt-and-suspenders: even a point legitimately reached by propagation, not
// already handled by the domain write, must not be pushed the "wrong" way for this type).
export const TERRAIN_TYPE_Z_RULES = {
  Sea:        { mode: 'set',   amount: 0,    cornerAmount: 0,    hopCount: 8, curve: 'scurve', direction: 'down' },
  Lake:       { mode: 'delta', amount: -2/3, cornerAmount: -2/3, hopCount: 6,  curve: 'scurve', direction: 'down' },
  Hills:      { mode: 'delta', amount: 1,  cornerAmount: 2/3,  hopCount: 6,  curve: 'linear', direction: 'up' },
  Mountains:  { mode: 'delta', amount: 5/3,  cornerAmount: 1,  hopCount: 8,  curve: 'linear', direction: 'up' },
  Swamp:      { mode: 'flattenThenDelta', amount: -1/3, floor: 1/3, hopCount: 0, curve: 'linear', direction: 'down' },
  // Ice Sheet (superseded 2026-07-13 — see the dedicated branch in
  // applyTerrainTypeZEffect): map-average-of-centres+3 (or the average of already-
  // placed Ice Sheets), +/-0.25 jitter, permanently locked. This entry only needs to
  // stay truthy so the `if (!rule) return` guard doesn't treat Ice Sheet as a no-op —
  // none of these fields are read for it anymore.
  'Ice Sheet':{ mode: 'delta' },
  Desert:     { mode: 'delta', amount: -1/3, floor: 1/3, cornerAmount: -1/3, hopCount: 4, curve: 'linear', direction: 'down' },
  Plains:     null,
  Forest:     null,
}

// Cliff isn't in TERRAIN_TYPE_Z_RULES: it's an Edge type (Sea/Lake/etc. are Region
// types), its magnitude is a fixed +1/-1 split rather than a settable/deltable region
// value. Wired up (user-confirmed 2026-07-13, "fix cliffs — by definition, joins between
// significantly different z-heights, both sides connect to their adjacent terrain") via
// determineCliffSide (below) + SetupPhase.js's _dcelPullbackMaterialize (the existing
// X,Y pullback split, reused for z — see its own doc comment) + propagateFromPoints
// (below, blending each side's newly-split corners into their own surrounding terrain).
export const CLIFF_Z_RULE = { magnitude: 1/3, hopCount: 4, curve: 'linear' }

// Plan "rustling-churning-finch" §4's side-determination rule, per-edge (not yet the
// full multi-segment chain-consistency averaging the plan also describes — deliberately
// scoped down to the common single-chain case for this pass): a region touching
// Mountains/Hills is the HIGH side; Sea/Swamp/Ice Sheet/Lake is the LOW side; if neither
// list matches (or, degenerately, BOTH regions match the same list), fall back to
// comparing their actual current terrain-centre heights — higher wins. Returns
// { [regionA.id]: 'high'|'low', [regionB.id]: 'high'|'low' } — regionA/regionB are the
// full region objects (need .assignedType and .seedPoint.z), not bare ids.
const CLIFF_HIGH_TYPES = new Set(['Mountains', 'Hills'])
const CLIFF_LOW_TYPES = new Set(['Sea', 'Swamp', 'Ice Sheet', 'Lake'])
export function determineCliffSide(regionA, regionB) {
  const aHigh = CLIFF_HIGH_TYPES.has(regionA.assignedType), bHigh = CLIFF_HIGH_TYPES.has(regionB.assignedType)
  const aLow = CLIFF_LOW_TYPES.has(regionA.assignedType), bLow = CLIFF_LOW_TYPES.has(regionB.assignedType)
  if (aHigh && !bHigh) return { [regionA.id]: 'high', [regionB.id]: 'low' }
  if (bHigh && !aHigh) return { [regionA.id]: 'low', [regionB.id]: 'high' }
  if (aLow && !bLow) return { [regionA.id]: 'low', [regionB.id]: 'high' }
  if (bLow && !aLow) return { [regionA.id]: 'high', [regionB.id]: 'low' }
  const az = regionA.seedPoint?.z ?? 0, bz = regionB.seedPoint?.z ?? 0
  return az >= bz ? { [regionA.id]: 'high', [regionB.id]: 'low' } : { [regionA.id]: 'low', [regionB.id]: 'high' }
}

export function smoothstepFalloff(t) {
  const c = Math.max(0, Math.min(1, t))
  return 1 - (3 * c * c - 2 * c * c * c)
}

export function linearFalloff(t) {
  return Math.max(0, 1 - Math.max(0, Math.min(1, t)))
}

export function falloffFor(curve) {
  return curve === 'scurve' ? smoothstepFalloff : linearFalloff
}

// Adjacency over the fine Point/Edge graph: two points are adjacent if they're
// consecutive corners of the SAME terrain plot polygon (wrap-around included). Built
// fresh per call — terrainPlots don't change after generation, and Apply is a rare,
// player-paced action, so this isn't a hot path worth caching yet.
export function buildPointGraph(terrainPlots) {
  const graph = new Map()
  const link = (a, b) => {
    if (!graph.has(a)) graph.set(a, new Set())
    graph.get(a).add(b)
  }
  for (const plot of terrainPlots) {
    const ids = plot.pointIds
    if (!ids || ids.length < 2) continue
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length]
      if (a === b) continue
      link(a, b); link(b, a)
    }
  }
  return graph
}

// Multi-source BFS from `sourceIds`, out to `maxHops` hops along `graph`. Returns the
// Set of point ids reached (sources included at hop 0). Bounded by construction — a hole
// in the point graph (acknowledged as still occurring occasionally post-DCEL-rewrite)
// just truncates the wave locally rather than throwing.
export function bfsReachable(graph, sourceIds, maxHops) {
  const reached = new Set(sourceIds)
  let frontier = [...sourceIds]
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next = []
    for (const id of frontier) {
      for (const nb of graph.get(id) || []) {
        if (!reached.has(nb)) { reached.add(nb); next.push(nb) }
      }
    }
    frontier = next
  }
  return reached
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// Applies one terrain type's z effect to `region` (must already have `assignedType` set
// by the caller) and propagates it outward. Mutates registry Points and `region.seedPoint`
// in place. `cornerIds`: this region's own boundary corners (union of every Edge chain's
// pointIds where this region is regionA/regionB — see SetupPhase's edge iteration
// pattern). `terrainPlots`: worldTerrainData.terrainPlots, used to build the fine
// Point/Edge graph for propagation, and (Sea/Lake/Ice Sheet) to find the region's full
// domain. `allRegions`: worldTerrainData.regions — every kept region's own seedPoint.z,
// needed only for Ice Sheet's map-average calculation (see below).
export function applyTerrainTypeZEffect(registry, region, cornerIds, terrainPlots, allRegions = []) {
  const rule = TERRAIN_TYPE_Z_RULES[region.assignedType]
  if (!rule) return   // Plains/Forest/unrecognized: no effect

  // Sea/Lake (user-confirmed 2026-07-12): EVERY point in the region's full domain (not
  // just its boundary corners) is set to one flat value, then permanently locked —
  // water doesn't tilt, and this is a deliberate, narrow exception to "adjust, don't
  // freeze": no later terrain's own-delta write or propagation wave may ever touch a
  // locked point again (checked via Point.zLocked everywhere z gets written below).
  if (region.assignedType === 'Sea' || region.assignedType === 'Lake') {
    const domainIds = getRegionDomainPointIds(terrainPlots, region.id)
    // A shared boundary point between this region and an already-locked neighbour
    // (Ice Sheet, or an earlier Sea/Lake) counts as "domain" for BOTH sides — exclude
    // already-locked points here too (fixed 2026-07-13), or whichever region gets
    // Applied second silently clobbers the first's permanent lock at their shared edge.
    const domainPoints = domainIds.map(id => registry.get(id)).filter(p => p && !p.zLocked)
    const target = rule.mode === 'set' ? rule.amount : region.seedPoint.z + rule.amount
    region.seedPoint.z = target
    region.seedPoint.zLocked = true
    for (const p of domainPoints) {
      const before = p.z
      p.z = target; p.zLocked = true
      console.log(`[TerrainZHeight] region ${region.id} (${region.assignedType}): point ${p.id} z ${before.toFixed(4)} -> ${p.z.toFixed(4)} (domain set, locked)`)
    }
    if (!rule.hopCount) return
    propagateFromRegion(registry, region, cornerIds, terrainPlots, rule.hopCount, rule.curve, rule.direction, domainIds)
    return
  }

  // Ice Sheet (user-confirmed 2026-07-13, supersedes the flat delta/propagation rule):
  // target = the average of every OTHER already-placed Ice Sheet region's own centre
  // (terrain centre = seedPoint.z), if any exist yet; otherwise the current map-wide
  // average of every region's centre, +3. Every domain point (whole region, not just
  // corners — same reasoning as Hills/Mountains/Desert below) gets that target jittered
  // +/-0.25, and — user-confirmed — permanently locked exactly like Sea/Lake: "Ice
  // sheets should also not be affected by adjacent changes."
  if (region.assignedType === 'Ice Sheet') {
    const others = (allRegions || []).filter(r => r.id !== region.id && r.assignedType === 'Ice Sheet' && r.seedPoint && isFinite(r.seedPoint.z))
    let target
    if (others.length) {
      target = others.reduce((s, r) => s + r.seedPoint.z, 0) / others.length
    } else {
      const withCentres = (allRegions || []).filter(r => r.id !== region.id && r.seedPoint && isFinite(r.seedPoint.z))
      const mapAvg = withCentres.length ? withCentres.reduce((s, r) => s + r.seedPoint.z, 0) / withCentres.length : 0
      target = mapAvg + 1
    }
    region.seedPoint.z = target
    region.seedPoint.zLocked = true
    console.log(`[TerrainZHeight] region ${region.id} (Ice Sheet): seedPoint z -> ${target.toFixed(4)} (locked)`)
    // Same shared-boundary-with-an-already-locked-neighbour exclusion as Sea/Lake above.
    const domainPoints = getRegionDomainPointIds(terrainPlots, region.id).map(id => registry.get(id)).filter(p => p && !p.zLocked)
    for (const p of domainPoints) {
      const before = p.z
      p.z = target + (Math.random() * 2 - 1) * 0.25
      p.zLocked = true
      console.log(`[TerrainZHeight] region ${region.id} (Ice Sheet): point ${p.id} z ${before.toFixed(4)} -> ${p.z.toFixed(4)} (domain set, locked)`)
    }
    return   // no propagation for Ice Sheet — unchanged from the prior rule
  }

  // Whole domain, not just the shared boundary (fixed 2026-07-13 — a multi-plot
  // region's true INTERIOR points, touching no neighbor, were never written at all
  // before this: only the outer rim got the delta, so a large Hills/Mountains/Desert
  // region's centre stayed at raw generation baseline — confirmed live as "Hills
  // appears to decrease" when really its interior was simply never elevated).
  // Propagation (below) still radiates outward from the boundary into neighbors —
  // `cornerIds` is unchanged for that — this only widens the DIRECT write.
  const domainIds = getRegionDomainPointIds(terrainPlots, region.id)
  const domainPoints = domainIds.map(id => registry.get(id)).filter(p => p && !p.zLocked)

  if (rule.mode === 'set') {
    if (!region.seedPoint.zLocked) region.seedPoint.z = rule.amount
    for (const p of domainPoints) {
      const before = p.z
      p.z = rule.cornerAmount
      console.log(`[TerrainZHeight] region ${region.id} (${region.assignedType}): point ${p.id} z ${before.toFixed(4)} -> ${p.z.toFixed(4)} (domain set)`)
    }
  } else if (rule.mode === 'delta') {
    if (!region.seedPoint.zLocked) region.seedPoint.z += rule.amount
    for (const p of domainPoints) {
      const before = p.z
      p.z += rule.cornerAmount
      if (rule.floor != null) p.z = Math.max(rule.floor, p.z)
      console.log(`[TerrainZHeight] region ${region.id} (${region.assignedType}): point ${p.id} z ${before.toFixed(4)} -> ${p.z.toFixed(4)} (domain delta)`)
    }
    if (rule.floor != null && !region.seedPoint.zLocked) region.seedPoint.z = Math.max(rule.floor, region.seedPoint.z)
  } else if (rule.mode === 'flattenThenDelta') {
    // Swamp: flatten to its own average z first, then apply the delta — no propagation.
    const avg = domainPoints.length
      ? domainPoints.reduce((s, p) => s + p.z, 0) / domainPoints.length
      : region.seedPoint.z
    const z = Math.max(rule.floor, avg + rule.amount)
    if (!region.seedPoint.zLocked) region.seedPoint.z = z
    for (const p of domainPoints) {
      const before = p.z
      p.z = z
      console.log(`[TerrainZHeight] region ${region.id} (${region.assignedType}): point ${p.id} z ${before.toFixed(4)} -> ${p.z.toFixed(4)} (flatten+delta)`)
    }
  }

  if (!rule.hopCount) return   // Swamp, Ice Sheet: no propagation

  propagateFromRegion(registry, region, cornerIds, terrainPlots, rule.hopCount, rule.curve, rule.direction, domainIds)
}

// Propagation algorithm (plan "rustling-churning-finch" §5):
//  1. BFS the fine Point/Edge graph from every corner of the source region, out to
//     `hopCount` hops — this is the bound on which points are even considered.
//  2. For each reached point, its distance-to-nearest-source-corner (Euclidean).
//  3. The MAXIMUM such nearest-corner distance, across the whole reached set, defines
//     the falloff curve's zero point — f(maxDistance) = 0 exactly, by construction.
//  4. Blend each point's z toward the source region's (already-updated) seedPoint.z by
//     f(t), t = that point's own nearest-corner distance / maxDistance.
// `direction` ('up'|'down', from TERRAIN_TYPE_Z_RULES): a safety clamp (user-confirmed
// 2026-07-13, "the only direction Hills should move terrain points is upwards") — skip
// a point entirely rather than move it the wrong way.
// `excludeIds`: the source region's own FULL domain (fixed 2026-07-13) — the BFS graph
// is undirected, so it re-enters the source's own interior (already correctly written
// by applyTerrainTypeZEffect's domain loop) unless explicitly excluded; re-blending
// those points a second time toward seedPoint.z could move them either direction
// depending on how their (different-magnitude) cornerAmount bump compared to the seed's
// own amount — confirmed live as Hills interior points moving down after being
// correctly bumped up.
export function propagateFromRegion(registry, region, cornerIds, terrainPlots, hopCount, curve, direction = null, excludeIds = null) {
  const cornerPoints = cornerIds.map(id => registry.get(id)).filter(Boolean)
  if (!cornerPoints.length) return

  const excludeSet = excludeIds ? new Set(excludeIds) : new Set(cornerIds)

  const graph = buildPointGraph(terrainPlots)
  const reached = bfsReachable(graph, cornerIds, hopCount)

  const nearestDistById = new Map()
  let maxDistance = 0
  for (const id of reached) {
    if (excludeSet.has(id)) continue   // the source's own full domain isn't propagated onto
    const p = registry.get(id)
    if (!p || p.zLocked) continue   // Sea/Lake's permanent lock — no wave may ever touch it
    let d = Infinity
    for (const c of cornerPoints) d = Math.min(d, dist(p, c))
    nearestDistById.set(id, d)
    if (d > maxDistance) maxDistance = d
  }
  if (maxDistance === 0) return   // nothing beyond the source's own domain was reached

  const f = falloffFor(curve)
  const sourceZ = region.seedPoint.z
  for (const [id, d] of nearestDistById) {
    const p = registry.get(id)
    if (!p) continue
    const t = d / maxDistance
    const blend = f(t)
    const newZ = p.z + blend * (sourceZ - p.z)
    if (direction === 'up' && newZ < p.z) continue    // never lower a point for a "raise" type
    if (direction === 'down' && newZ > p.z) continue  // never raise a point for a "lower" type
    const before = p.z
    p.z = newZ
    console.log(`[TerrainZHeight] region ${region.id} (${region.assignedType}): point ${id} z ${before.toFixed(4)} -> ${p.z.toFixed(4)} (propagated)`)
  }
}

// Generalizes propagateFromRegion to MULTIPLE independent source points, each with its
// OWN target z (not one shared region seedPoint.z) — Cliff's own use case (user-
// confirmed 2026-07-13, "both sides of the cliff connect to their adjacent terrain"): a
// jagged Cliff chain's split corners each sit at a locally-different height (the shared
// point's pre-split z, ±CLIFF_Z_RULE.magnitude), so a single global blend target
// (propagateFromRegion's model) can't represent it — every reached point instead blends
// toward whichever SOURCE point is nearest it (multi-source flood-fill, same idea as a
// discrete Voronoi-from-seeds), using that nearest source's own target z and its own
// distance for the falloff curve. Sources are naturally confined to one side of the
// cliff already (the DCEL split gives each side distinct point ids — see
// _dcelPullbackMaterialize's doc comment — so the fine Point/Edge graph never connects a
// high-side id straight to a low-side one), so this never needs an explicit "stay on
// your own side" check.
// `targetZById`: Map<pointId, z> — every id in `sourceIds` must have an entry.
export function propagateFromPoints(registry, terrainPlots, sourceIds, targetZById, hopCount, curve, direction = null) {
  if (!sourceIds?.length) return
  const graph = buildPointGraph(terrainPlots)
  const sourceSet = new Set(sourceIds)

  // Multi-source BFS that also records, per reached point, WHICH source first reached
  // it (its "owner") — a discrete flood-fill/Voronoi-from-seeds, bounded to hopCount.
  const ownerById = new Map(sourceIds.map(id => [id, id]))
  let frontier = [...sourceIds]
  for (let hop = 0; hop < hopCount && frontier.length; hop++) {
    const next = []
    for (const id of frontier) {
      const owner = ownerById.get(id)
      for (const nb of graph.get(id) || []) {
        if (!ownerById.has(nb)) { ownerById.set(nb, owner); next.push(nb) }
      }
    }
    frontier = next
  }

  const nearestDistById = new Map()
  const maxDistByOwner = new Map()
  for (const [id, ownerId] of ownerById) {
    if (sourceSet.has(id)) continue   // sources themselves aren't propagated onto
    const p = registry.get(id)
    if (!p || p.zLocked) continue     // Sea/Lake/Ice Sheet's permanent lock
    const source = registry.get(ownerId)
    if (!source) continue
    const d = dist(p, source)
    nearestDistById.set(id, { d, ownerId })
    if (d > (maxDistByOwner.get(ownerId) ?? 0)) maxDistByOwner.set(ownerId, d)
  }

  const f = falloffFor(curve)
  for (const [id, { d, ownerId }] of nearestDistById) {
    const p = registry.get(id)
    const maxDistance = maxDistByOwner.get(ownerId)
    if (!p || !maxDistance) continue
    const t = d / maxDistance
    const blend = f(t)
    const targetZ = targetZById.get(ownerId)
    if (targetZ == null) continue
    const newZ = p.z + blend * (targetZ - p.z)
    if (direction === 'up' && newZ < p.z) continue
    if (direction === 'down' && newZ > p.z) continue
    const before = p.z
    p.z = newZ
    console.log(`[TerrainZHeight] cliff source ${ownerId}: point ${id} z ${before.toFixed(4)} -> ${p.z.toFixed(4)} (cliff propagated)`)
  }
}

// Every point id belonging to any terrain plot whose parentRegionId is `regionId` —
// the region's FULL domain, not just its shared boundary corners. Used exclusively for
// Sea/Lake's whole-body flatten (see applyTerrainTypeZEffect): must be called AFTER any
// hidden-terrain reveal/absorb has updated plot.parentRegionId (SetupPhase calls this
// after _revealAdjacentHiddenTerrain, not right after region.assignedType is set) or
// newly-absorbed plots' points are silently missed.
export function getRegionDomainPointIds(terrainPlots, regionId) {
  const ids = new Set()
  for (const plot of terrainPlots || []) {
    if (plot.parentRegionId !== regionId) continue
    for (const id of plot.pointIds || []) ids.add(id)
  }
  return [...ids]
}

// Union of every Edge chain's pointIds where `regionId` is regionA or regionB — this
// region's own boundary corners, per CONTEXT_WorldTerrain.md's Edge/Region model. Every
// region-to-region boundary already exists as an Edge object regardless of its
// assignedType (River/Cliff/undefined), so this works before any typing has happened.
export function getRegionCornerIds(edges, regionId) {
  const ids = new Set()
  for (const edge of Object.values(edges)) {
    if (edge.regionA === regionId || edge.regionB === regionId) {
      for (const id of edge.pointIds) ids.add(id)
    }
  }
  return [...ids]
}
