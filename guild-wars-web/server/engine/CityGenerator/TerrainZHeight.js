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
  // Lake's own flat height is no longer `mode`/`amount`/`cornerAmount` (superseded
  // 2026-07-19 — see the dedicated `region.assignedType === 'Lake'` branch in
  // applyTerrainTypeZEffect: settles to its lowest shore corner instead). Those three
  // fields are dead for Lake now, kept only so this entry stays truthy for the
  // `if (!rule) return` guard; hopCount/curve/direction still govern how the lake's
  // (now corner-derived) height propagates into the surrounding terrain.
  Lake:       { mode: 'delta', amount: -1/3, cornerAmount: -1/3, hopCount: 1,  curve: 'linear', direction: 'down' },
  Hills:      { mode: 'delta', amount: 2/3,  cornerAmount: 1/3,  hopCount: 1,  curve: 'linear', direction: 'up' },
  Mountains:  { mode: 'delta', amount: 1,  cornerAmount: 2/3,  hopCount: 3,  curve: 'linear', direction: 'up' },
  Swamp:      { mode: 'flattenThenDelta', amount: -1/3, floor: 1/3, hopCount: 1, curve: 'linear', direction: 'down' },
  // Ice Sheet (superseded 2026-07-13 — see the dedicated branch in
  // applyTerrainTypeZEffect): map-average-of-centres+3 (or the average of already-
  // placed Ice Sheets), +/-0.25 jitter, permanently locked. This entry only needs to
  // stay truthy so the `if (!rule) return` guard doesn't treat Ice Sheet as a no-op —
  // none of these fields are read for it anymore.
  'Ice Sheet':{ mode: 'delta' },
  Desert:     { mode: 'delta', amount: -1/3, floor: 1/3, cornerAmount: -1/3, hopCount: 1, curve: 'linear', direction: 'down' },
  Plains:     null,
  Forest:     null,
}

// Cliff isn't in TERRAIN_TYPE_Z_RULES: it's an Edge type (Sea/Lake/etc. are Region
// types). Wired up via computeCliffChainSides (below) + SetupPhase.js's
// _dcelPullbackMaterialize (the existing X,Y pullback split, reused for z — see its own
// doc comment) + propagateFromPoints (below, blending each side's newly-split corners
// into their own surrounding terrain). CLIFF_Z_RULE now only carries the OUTWARD
// propagation shape (hopCount/curve) — the split-vertex magnitude itself comes from
// computeCliffChainSides' chain-wide average + CLIFF_LERP_T, not a fixed magnitude.
export const CLIFF_Z_RULE = { hopCount: 4, curve: 'linear' }

// Blend factor for computeCliffChainSides' split-vertex z (plan "typed-gliding-leaf",
// user-confirmed 2026-07-14): a split vertex's new z is 80% of the way from its OWN
// pre-split z toward its side's chain-wide neighbour average — not a full snap (t=1)
// and not the old flat +/-CLIFF_Z_RULE.magnitude step.
export const CLIFF_LERP_T = 0.8

function lerp(a, b, t) { return a + (b - a) * t }

// Cliff chains are consistent along their WHOLE physically-contiguous run (plan
// "typed-gliding-leaf", user-confirmed 2026-07-14): one side is always the high side,
// the other always low, even where the run crosses several different region pairs (e.g.
// 3 highland regions against 4 lowland regions along one continuous Cliff). A region
// touching Sea/Swamp/Ice Sheet/Lake is always the low side; otherwise the side is
// decided by averaging the z of every LINKED point (one-hop graph neighbour, excluding
// points that are themselves on the run) bucketed by side across the whole run — higher
// average wins, for every segment in the run.
const CLIFF_LOW_TYPES = new Set(['Sea', 'Swamp', 'Ice Sheet', 'Lake'])

// Groups Cliff-assigned edges into runs (graph-connected via shared endpoint pointIds,
// regardless of how many different region pairs they cross), decides each run's
// high/low side, and returns Map<edgeId, Map<regionId, {side, targetAvg}>> — targetAvg
// is the chain-wide neighbour average for that side (null for a forced-low side, which
// is zLocked and never lerped — see SetupPhase.ALWAYS_LOCKED_TERRAIN_TYPES). Consumed by
// SetupPhase._computeCliffSideAtVertex, which further keys this by vertex and drops
// entries for always-locked region types.
export function computeCliffChainSides(edges, terrainPlots, registry, regionsById) {
  const cliffEntries = Object.entries(edges).filter(([, e]) => e.assignedType === 'Cliff')
  const result = new Map()
  if (!cliffEntries.length) return result

  // 1. Group into runs via shared endpoint pointIds (first/last id of each edge chain).
  const endpointsOf = (e) => [e.pointIds[0], e.pointIds[e.pointIds.length - 1]]
  const edgeIdsByEndpoint = new Map()
  for (const [id, e] of cliffEntries) {
    for (const ep of endpointsOf(e)) {
      if (!edgeIdsByEndpoint.has(ep)) edgeIdsByEndpoint.set(ep, [])
      edgeIdsByEndpoint.get(ep).push(id)
    }
  }
  const edgeById = new Map(cliffEntries)
  const visited = new Set()
  const runs = []
  for (const [id] of cliffEntries) {
    if (visited.has(id)) continue
    const run = []
    const queue = [id]
    visited.add(id)
    while (queue.length) {
      const curId = queue.shift()
      run.push(curId)
      for (const ep of endpointsOf(edgeById.get(curId))) {
        for (const nbId of edgeIdsByEndpoint.get(ep) || []) {
          if (!visited.has(nbId)) { visited.add(nbId); queue.push(nbId) }
        }
      }
    }
    runs.push(run)
  }

  // 2. Point graph + point->plots index, for the linked-neighbour averaging step.
  const graph = buildPointGraph(terrainPlots)
  const plotsByPoint = new Map()
  for (const plot of terrainPlots) {
    for (const pid of plot.pointIds || []) {
      if (!plotsByPoint.has(pid)) plotsByPoint.set(pid, [])
      plotsByPoint.get(pid).push(plot)
    }
  }

  for (const run of runs) {
    const runEdges = run.map(id => edgeById.get(id))
    const runPointSet = new Set()
    for (const e of runEdges) for (const pid of e.pointIds) runPointSet.add(pid)

    // 3. Assign a sideKey ('A'/'B') per region touched by the run, propagated across
    // edges via shared regions — a region recurring in two consecutive edges of the run
    // must stay on the same sideKey both times.
    const sideKeyByRegion = new Map()
    sideKeyByRegion.set(runEdges[0].regionA, 'A')
    sideKeyByRegion.set(runEdges[0].regionB, 'B')
    let changed = true
    while (changed) {
      changed = false
      for (const e of runEdges) {
        const hasA = sideKeyByRegion.has(e.regionA), hasB = sideKeyByRegion.has(e.regionB)
        if (hasA && !hasB) { sideKeyByRegion.set(e.regionB, sideKeyByRegion.get(e.regionA) === 'A' ? 'B' : 'A'); changed = true }
        else if (hasB && !hasA) { sideKeyByRegion.set(e.regionA, sideKeyByRegion.get(e.regionB) === 'A' ? 'B' : 'A'); changed = true }
        else if (!hasA && !hasB) { sideKeyByRegion.set(e.regionA, 'A'); sideKeyByRegion.set(e.regionB, 'B'); changed = true }
      }
    }

    // 4. Forced-low check (Sea/Swamp/Ice Sheet/Lake on either bucket).
    const regionIdsByKey = { A: [], B: [] }
    for (const [rid, key] of sideKeyByRegion) regionIdsByKey[key].push(rid)
    const isForcedLow = (rid) => CLIFF_LOW_TYPES.has(regionsById.get(rid)?.assignedType)
    const aForced = regionIdsByKey.A.some(isForcedLow)
    const bForced = regionIdsByKey.B.some(isForcedLow)

    const averageLinkedNeighbors = (targetKey) => {
      let sum = 0, cnt = 0
      for (const pid of runPointSet) {
        const myPlots = plotsByPoint.get(pid) || []
        for (const nb of graph.get(pid) || []) {
          if (runPointSet.has(nb)) continue   // exclude points that are themselves on the run
          const nbPlotSet = new Set(plotsByPoint.get(nb) || [])
          const sharedPlot = myPlots.find(p => nbPlotSet.has(p))
          if (!sharedPlot) continue
          if (sideKeyByRegion.get(sharedPlot.parentRegionId) !== targetKey) continue
          const np = registry.get(nb)
          if (!np || !isFinite(np.z)) continue
          sum += np.z; cnt++
        }
      }
      return cnt ? sum / cnt : null
    }

    let highKey, lowKey, highAvg, lowAvg
    if (aForced && !bForced) { lowKey = 'A'; highKey = 'B' }
    else if (bForced && !aForced) { lowKey = 'B'; highKey = 'A' }
    else {
      const avgA = averageLinkedNeighbors('A'), avgB = averageLinkedNeighbors('B')
      if ((avgA ?? 0) >= (avgB ?? 0)) { highKey = 'A'; lowKey = 'B' } else { highKey = 'B'; lowKey = 'A' }
    }
    // Always compute both averages, even on a forced-low side — a forced-low region
    // that's ALSO always-locked (Sea/Lake/Ice Sheet, per SetupPhase.ALWAYS_LOCKED_TERRAIN_
    // TYPES) never reaches the lerp at all (its split copies are skipped upstream via
    // base.zLocked), but Swamp is forced-low here without being always-locked, so it
    // still needs a real target average, not null.
    highAvg = averageLinkedNeighbors(highKey)
    lowAvg = averageLinkedNeighbors(lowKey)

    // 5. Record per-edge output.
    for (let i = 0; i < run.length; i++) {
      const e = runEdges[i]
      const perRegion = new Map()
      const aKey = sideKeyByRegion.get(e.regionA), bKey = sideKeyByRegion.get(e.regionB)
      perRegion.set(e.regionA, aKey === highKey ? { side: 'high', targetAvg: highAvg } : { side: 'low', targetAvg: lowAvg })
      perRegion.set(e.regionB, bKey === highKey ? { side: 'high', targetAvg: highAvg } : { side: 'low', targetAvg: lowAvg })
      result.set(run[i], perRegion)
    }
  }

  return result
}

export { lerp, CLIFF_LOW_TYPES }

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
const _zEffectCallCount = new Map()   // TEMP diagnostic — remove once root cause confirmed
export function applyTerrainTypeZEffect(registry, region, cornerIds, terrainPlots, allRegions = []) {
  const rule = TERRAIN_TYPE_Z_RULES[region.assignedType]
  if (!rule) return   // Plains/Forest/unrecognized: no effect
  {
    const n = (_zEffectCallCount.get(region.id) ?? 0) + 1
    _zEffectCallCount.set(region.id, n)
    console.log(`[zheight-diag] applyTerrainTypeZEffect region=${region.id} type=${region.assignedType} call#${n} seedZ-before=${region.seedPoint?.z?.toFixed?.(3)} zLocked=${!!region.seedPoint?.zLocked} rule.amount=${rule.amount} hopCount=${rule.hopCount}`)
    if (n > 1) console.warn(`[zheight-diag] region ${region.id} (${region.assignedType}) has had its terrain z-effect applied ${n} times — deltas compound on repeat calls`)
  }

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
    let target
    if (region.assignedType === 'Lake') {
      // Lake settles to its lowest shore corner's height (water finds its own level) —
      // user-confirmed 2026-07-19, replacing the old seedPoint+delta rule, which set the
      // lake's flat height relative to wherever its seed happened to land pre-effect —
      // arbitrary relative to the actual shore, and could still read as visibly tilted/
      // faceted once neighbouring Hills/Mountains propagation reshaped the shore after
      // generation. Reads cornerIds (this region's own boundary corners) BEFORE any of
      // this block's writes below, same corners `propagateFromRegion` already blends
      // outward from.
      const cornerZs = (cornerIds || []).map(id => registry.get(id)).filter(p => p && isFinite(p.z)).map(p => p.z)
      target = cornerZs.length ? Math.min(...cornerZs) : region.seedPoint.z
    } else {
      target = rule.mode === 'set' ? rule.amount : region.seedPoint.z + rule.amount
    }
    region.seedPoint.z = target
    region.seedPoint.zLocked = true
    for (const p of domainPoints) {
      p.z = target; p.zLocked = true
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
    // Same shared-boundary-with-an-already-locked-neighbour exclusion as Sea/Lake above.
    const domainPoints = getRegionDomainPointIds(terrainPlots, region.id).map(id => registry.get(id)).filter(p => p && !p.zLocked)
    for (const p of domainPoints) {
      p.z = target + (Math.random() * 2 - 1) * 0.25
      p.zLocked = true
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

  // Internal centre-to-edge taper (user-confirmed 2026-07-14, "should be high in the
  // centre and less high on the edges" — every domain point previously got the exact
  // same flat cornerAmount bump, with no gradient inside the region at all): blend each
  // point's own bump between `amount` (the seed/centre's own value) and `cornerAmount`
  // (at the domain's own farthest point from the seed), proportional to its distance
  // from the seed. A no-op wherever amount === cornerAmount (Desert, Swamp's own path).
  const distToSeed = (p) => Math.hypot(p.x - region.seedPoint.x, p.y - region.seedPoint.y)
  const maxDomainDist = domainPoints.reduce((m, p) => Math.max(m, distToSeed(p)), 0)
  const taperedAmount = (p) => {
    if (maxDomainDist === 0) return rule.cornerAmount
    const t = distToSeed(p) / maxDomainDist
    return rule.amount + (rule.cornerAmount - rule.amount) * t
  }

  if (rule.mode === 'set') {
    if (!region.seedPoint.zLocked) region.seedPoint.z = rule.amount
    for (const p of domainPoints) {
      p.z = taperedAmount(p)
    }
  } else if (rule.mode === 'delta') {
    if (!region.seedPoint.zLocked) region.seedPoint.z += rule.amount
    for (const p of domainPoints) {
      p.z += taperedAmount(p)
      if (rule.floor != null) p.z = Math.max(rule.floor, p.z)
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
      p.z = z
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
  // Blend toward the region's own BOUNDARY height (average of its corners, already
  // updated with cornerAmount) — NOT the centre (seedPoint.z, updated with the
  // different `amount`). Using the centre as the target made a point immediately
  // outside the region's edge blend almost entirely toward it (f(t) -> 1 as distance ->
  // 0), landing HIGHER than the region's own boundary corners for any type where
  // cornerAmount < amount (Hills, Mountains) — confirmed live 2026-07-14, "the mountain
  // itself was flat... the surrounding terrain was higher than all of the mountain
  // region." Using the corners' own average makes the falloff genuinely continuous
  // across the boundary: right at the edge it matches the edge, then fades outward.
  const sourceZ = cornerPoints.reduce((s, p) => s + p.z, 0) / cornerPoints.length
  for (const [id, d] of nearestDistById) {
    const p = registry.get(id)
    if (!p) continue
    const t = d / maxDistance
    const blend = f(t)
    const newZ = p.z + blend * (sourceZ - p.z)
    if (direction === 'up' && newZ < p.z) continue    // never lower a point for a "raise" type
    if (direction === 'down' && newZ > p.z) continue  // never raise a point for a "lower" type
    p.z = newZ
  }
}

// Generalizes propagateFromRegion to MULTIPLE independent source points, each with its
// OWN target z (not one shared region seedPoint.z) — Cliff's own use case (user-
// confirmed 2026-07-13, "both sides of the cliff connect to their adjacent terrain"): a
// jagged Cliff chain's split corners each sit at a locally-different height (the shared
// point's pre-split z, lerped toward its side's chain-wide average — see
// computeCliffChainSides/CLIFF_LERP_T), so a single global blend target
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
    p.z = newZ
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

// River z-gradient (plan "typed-gliding-leaf", per plan "rustling-churning-finch" §7):
// endpoints are fixed at whatever z already exists at the moment the River is drawn —
// this only sets INTERIOR path points, along `edge.pointIds` (the River's own raw
// centreline chain, not a split land copy), weighted by cumulative (x,y) distance.
//
// New Rule for Rivers (user-confirmed 2026-07-14): water can only ever flow downhill —
// grading between two fixed points must never invent an interior rise. Each stretch
// between two fixed points (see gradeRange below) always walks from whichever end is
// HIGHER down to the other, so it's monotonic-decreasing by construction — the old
// approach (always interpolating start-to-end in path order) could invent an uphill
// stretch whenever the "start" happened to be the lower of the two, which is exactly
// the "aqueduct bridging a dip" artifact this fixes.
//
// If the path crosses an already-assigned Cliff at an interior point (`cliffPointIds`,
// every pointId on any currently-assigned Cliff edge), that crossing is a Waterfall: its
// own z (the Cliff split's high/low value) is never overwritten — each stretch either
// side of it (start-to-crossing, crossing-to-end, or crossing-to-crossing for a river
// that crosses more than one Cliff) grades independently, per the same rule, so the
// vertical gap at the crossing itself is exactly the Waterfall drop. A crossing whose
// own fixed value is out of monotonic order relative to its neighbours (a genuinely
// inconsistent River/Cliff combination) still shows as a real jump there — this
// algorithm can't paper over a contradiction in the underlying terrain data, only
// guarantee every stretch it actually computes is internally consistent.
// zLocked points (Sea/Lake/Ice Sheet) are never overwritten, matching every other
// z-height writer in this file.
export function applyRiverZGradient(registry, edge, cliffPointIds = new Set()) {
  const path = edge.pointIds || []
  if (path.length < 2) return
  const pts = path.map(id => registry.get(id))
  if (pts.some(p => !p)) return

  const cum = [0]
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  }
  if (cum[cum.length - 1] === 0) return

  // Walks from whichever of pts[i0]/pts[i1] is HIGHER toward the other, writing every
  // STRICTLY interior point between them (i0/i1 themselves are never touched — they're
  // either the river's own fixed endpoints or a Cliff crossing's fixed Waterfall value)
  // with a straight distance-weighted lerp from the high end down to the low end.
  // Choosing the walk direction per-pair this way is what guarantees each stretch is
  // monotonic-decreasing by construction (interpolating from a high fixed value down to
  // a low fixed value can never produce an interior value above the high end), which is
  // exactly the "New Rule for Rivers" (user-confirmed 2026-07-14): water only flows
  // downhill, never uphill, between two fixed points.
  const gradeRange = (i0, i1) => {
    const forward = pts[i0].z >= pts[i1].z
    const hiIdx = forward ? i0 : i1, loIdx = forward ? i1 : i0
    const step = forward ? 1 : -1
    const hiZ = pts[hiIdx].z, loZ = pts[loIdx].z
    const totalDist = Math.abs(cum[loIdx] - cum[hiIdx])
    if (totalDist <= 0) return
    for (let i = hiIdx + step; i !== loIdx; i += step) {
      if (pts[i].zLocked) continue
      const t = Math.abs(cum[i] - cum[hiIdx]) / totalDist
      pts[i].z = hiZ + (loZ - hiZ) * t
    }
  }

  // Every interior Cliff crossing along this path (a river can cross more than one
  // Cliff) is a fixed anchor, same as the two endpoints — grade independently between
  // each consecutive pair of anchors, never overwriting any of them.
  const anchors = [0]
  for (let i = 1; i < pts.length - 1; i++) {
    if (cliffPointIds.has(path[i])) anchors.push(i)
  }
  anchors.push(pts.length - 1)
  for (let a = 0; a < anchors.length - 1; a++) gradeRange(anchors[a], anchors[a + 1])
}
