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
//
// TERRAIN_TYPES/CLIFF_LOW_TYPES/CLIFF_HIGH_TYPES/CLIFF_MIN_SEPARATION/
// CLIFF_SPLIT_EQUAL_TOLERANCE live in worldConfig/terrainConfig.js (the single source of
// truth for every terrain tunable, alongside worldConfig/districtConfig.js's district
// equivalent) — re-exported here so every existing caller of THIS file keeps working
// unchanged. CLIFF_LERP_T retired (ADR-0022 Cliff redesign, 2026-07-26): a Cliff split
// vertex now snaps straight to its own local natural neighbour average — see
// computeCliffChainSides' own doc comment — instead of an 80/20 blend toward a
// chain-wide one, so there is no lerp factor left to tune. CLIFF_Z_RULE retired
// 2026-07-27 (folded into TERRAIN_TYPES.Cliff) — its own hopCount/curve are now read
// straight off TERRAIN_TYPES.Cliff wherever still needed. TERRAIN_TYPE_Z_RULES itself
// renamed to TERRAIN_TYPES the same day (TERRAIN_COLORS merged into it — every type now
// carries its own `.color` alongside whatever z-effect fields it has, or none).
import { TERRAIN_TYPES, CLIFF_LOW_TYPES, CLIFF_HIGH_TYPES, CLIFF_MIN_SEPARATION, CLIFF_SPLIT_EQUAL_TOLERANCE } from '../../../worldConfig/terrainConfig.js'
export { TERRAIN_TYPES, CLIFF_HIGH_TYPES, CLIFF_MIN_SEPARATION }

function lerp(a, b, t) { return a + (b - a) * t }

// Cliff chains keep a CONSISTENT high side along any one stretch — never a silent flip
// mid-run (user-confirmed 2026-07-26) — but unlike the original 2026-07-14 design, the
// actual height TARGET is now LOCAL: each edge's own high/low target is the average z of
// its OWN immediate neighbours (one-hop graph, excluding points on the run itself), not
// a single value averaged across the entire run. The old whole-run average diluted a
// locally-flat stretch's target toward whatever the rest of a long run happened to
// average to (an artificial hump/berm where the terrain was actually flat), and diluted a
// locally-steep stretch the same way (separation that read as "lost") — confirmed live
// 2026-07-26 against real generated cliffs. `GroundplaneAudit.js`'s z-hook also drops the
// old CLIFF_LERP_T 80/20 blend toward this target — it now snaps straight to it, so the
// cliff's own midpoint at any point is EXACTLY the average of its two local natural
// heights, by construction (user-confirmed requirement).
//
// A region touching CLIFF_LOW_TYPES (worldConfig/terrainConfig.js) is always the low
// side for its whole run — never a locally-decided candidate for inversion (see below).
//
// Local inversion (a stretch whose own two sides are naturally the OPPOSITE way up from
// the run's established high key) is resolved, not ignored (user-confirmed design,
// 2026-07-26): group the run into maximal segments of consecutive edges that agree on
// their own local high key; at each segment boundary, compare
// `strength = avgLocalHeightDiff * edgeCount` between the two adjacent segments — the
// clearly weaker one is downgraded (its edges' Cliff assignment is cleared entirely,
// reported via the returned `downgradeEdgeIds`, same as reverting to ordinary terrain);
// roughly-equal strength (within CLIFF_SPLIT_EQUAL_TOLERANCE) is left as a genuine split,
// each segment keeping its own independently-decided high key.
//
// Groups Cliff-assigned edges into runs (graph-connected via shared endpoint pointIds,
// regardless of how many different region pairs they cross) and returns
// `{ sidesByEdge, downgradeEdgeIds }`:
//   sidesByEdge: Map<edgeId, Map<regionId, {side, targetAvg}>> — targetAvg is that
//     edge's OWN local neighbour average for that side (null for a forced-low side that's
//     also always-locked — see worldConfig/terrainConfig.js's ALWAYS_LOCKED_TERRAIN_
//     TYPES — which never reaches the z-hook at all). Consumed by
//     GroundplaneAudit._computeCliffSideAtVertex, which further keys this by vertex and
//     drops entries for always-locked region types.
//   downgradeEdgeIds: Set<edgeId> — edges the caller should clear Cliff from entirely
//     (weak side of a resolved local inversion). Never populated for a forced-low run —
//     forced sidedness is absolute, not a locally-decided candidate.
export function computeCliffChainSides(edges, terrainPlots, registry, regionsById) {
  const sidesByEdge = new Map()
  const downgradeEdgeIds = new Set()

  // Ice Sheet next to Ice Sheet: there is no valid edge type between two Ice Sheets,
  // EVER, even a Cliff that was genuinely valid before both sides became Ice Sheet
  // (user-confirmed 2026-07-26). A STANDING invariant, checked here on every call (every
  // pullback pass), not just a one-time guard at the moment an Ice Sheet is placed
  // (TerrainSetup._clearIceSheetAdjacentCliffs, which only fires when THAT specific
  // region is placed/re-confirmed) — confirmed live via a real save: a Cliff between two
  // Ice Sheets can persist indefinitely once created, since nothing else ever re-visits
  // an edge whose OWN two regions never change again. Filtered out before run-grouping
  // entirely — never a sidedness/local-inversion candidate.
  const isIceSheetVsIceSheet = (e) => regionsById.get(e.regionA)?.assignedType === 'Ice Sheet' && regionsById.get(e.regionB)?.assignedType === 'Ice Sheet'
  const cliffEntries = []
  for (const entry of Object.entries(edges)) {
    const [id, e] = entry
    if (e.assignedType !== 'Cliff') continue
    if (isIceSheetVsIceSheet(e)) { downgradeEdgeIds.add(id); continue }
    cliffEntries.push(entry)
  }
  if (!cliffEntries.length) return { sidesByEdge, downgradeEdgeIds }

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

  // 2. Physical-edge -> bordering-plots index, for the local-average step. Keyed by
  // undirected point-id pair, not by vertex adjacency — deliberately NOT a vertex-
  // neighbour graph walk (tried first, reverted 2026-07-26): a Cliff run's own shared
  // junction vertex between two consecutive edges is a graph-neighbour of BOTH edges at
  // once, so filtering by region id alone still let a neighbouring edge's own bordering
  // plot leak into THIS edge's "local" average whenever consecutive edges share the same
  // two regions (the common case — most of one long boundary between two big regions,
  // just chopped into straight segments). Keying by the EXACT physical edge a plot
  // borders has no such leak: two different Cliff edges never share a physical edge.
  const plotsByPhysicalEdge = new Map()   // "idLo,idHi" -> plot[]
  for (const plot of terrainPlots) {
    const ids = plot.pointIds
    if (!ids || ids.length < 2) continue
    for (let i = 0; i < ids.length; i++) {
      const p1 = ids[i], p2 = ids[(i + 1) % ids.length]
      if (p1 === p2) continue
      const key = p1 < p2 ? `${p1},${p2}` : `${p2},${p1}`
      if (!plotsByPhysicalEdge.has(key)) plotsByPhysicalEdge.set(key, [])
      plotsByPhysicalEdge.get(key).push(plot)
    }
  }

  for (const run of runs) {
    const runEdges = run.map(id => edgeById.get(id))

    // 3. Assign a sideKey ('A'/'B') per region touched by the run, propagated across
    // edges via shared regions — a region recurring in two consecutive edges of the run
    // must stay on the same sideKey both times. Topology only — unaffected by the local
    // vs. whole-run target change below.
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

    // 4. Forced-low/high check (Sea/Swamp/Lake force LOW; Mountains/Hills/Ice Sheet force
    // HIGH — worldConfig/terrainConfig.js) — absolute for the WHOLE run, same as before; a
    // forced run is never a local-inversion candidate. The two sets are just two ways of
    // saying the same thing (a bucket is "definitively low" either because it's a
    // CLIFF_LOW_TYPES type itself, OR because the OTHER bucket is a CLIFF_HIGH_TYPES type),
    // so they're combined per-side before the usual "exactly one side is forced" check —
    // both sides forced the same direction (e.g. Mountains vs Hills, or a genuine
    // contradiction) is left undetermined, same as today's both-forced-low case, and falls
    // through to the local-average decision below.
    const regionIdsByKey = { A: [], B: [] }
    for (const [rid, key] of sideKeyByRegion) regionIdsByKey[key].push(rid)
    const isType = (rid, set) => set.has(regionsById.get(rid)?.assignedType)
    const aLowType = regionIdsByKey.A.some(rid => isType(rid, CLIFF_LOW_TYPES))
    const bLowType = regionIdsByKey.B.some(rid => isType(rid, CLIFF_LOW_TYPES))
    const aHighType = regionIdsByKey.A.some(rid => isType(rid, CLIFF_HIGH_TYPES))
    const bHighType = regionIdsByKey.B.some(rid => isType(rid, CLIFF_HIGH_TYPES))
    const aForced = aLowType || bHighType
    const bForced = bLowType || aHighType
    const forcedHighKey = aForced && !bForced ? 'B' : bForced && !aForced ? 'A' : null

    // 5. Per-EDGE local average (replaces the old whole-run averageLinkedNeighbors/
    // runPointSet): for each physical segment of the edge, find the ONE plot that
    // segment actually borders on `regionId`'s side (via plotsByPhysicalEdge), and
    // average THAT plot's own other corners. Precise by construction — never touches a
    // neighbouring Cliff edge's own bordering plot, even one sharing a junction vertex.
    const edgePointSet = (e) => new Set(e.pointIds)
    const localAverage = (e, regionId) => {
      const excl = edgePointSet(e)
      const ids = e.pointIds
      let sum = 0, cnt = 0
      for (let i = 0; i < ids.length - 1; i++) {
        const a = ids[i], b = ids[i + 1]
        if (a === b) continue
        const key = a < b ? `${a},${b}` : `${b},${a}`
        const plot = (plotsByPhysicalEdge.get(key) || []).find(p => p.parentRegionId === regionId)
        if (!plot) continue
        for (const pid of plot.pointIds) {
          if (excl.has(pid)) continue   // exclude corners that are ALSO on this cliff edge
          const p = registry.get(pid)
          if (!p || !isFinite(p.z)) continue
          sum += p.z; cnt++
        }
      }
      return cnt ? sum / cnt : null
    }

    const perEdge = runEdges.map((e, i) => ({
      id: run[i], edge: e, avgA: localAverage(e, e.regionA), avgB: localAverage(e, e.regionB),
    }))

    // 6. Each edge's own locally-preferred high key (forced runs never disagree with
    // themselves — every edge just inherits forcedHighKey). avgA/avgB are this edge's
    // OWN regionA/regionB averages (step 5) — mapped through sideKeyByRegion, NOT
    // assumed to line up with the 'A'/'B' letters directly (a later edge in the run can
    // easily have its OWN regionA be the side that everyone else calls 'B').
    for (const info of perEdge) {
      const keyA = sideKeyByRegion.get(info.edge.regionA)
      const keyB = sideKeyByRegion.get(info.edge.regionB)
      info.highKey = forcedHighKey ?? ((info.avgA ?? 0) >= (info.avgB ?? 0) ? keyA : keyB)
    }

    // 7. Group into maximal same-highKey segments, in run order (a forced run is always
    // exactly one segment).
    const segments = []
    for (const info of perEdge) {
      const last = segments[segments.length - 1]
      if (last && last.highKey === info.highKey) last.infos.push(info)
      else segments.push({ highKey: info.highKey, infos: [info] })
    }

    // 8. Resolve every adjacent-segment boundary: downgrade the clearly weaker segment,
    // or let a roughly-equal-strength boundary stand as a genuine split. Skipped
    // entirely for a forced run (always exactly one segment, no boundaries).
    const strengthOf = (seg) => {
      let sum = 0, cnt = 0
      for (const info of seg.infos) {
        const aIsHigh = sideKeyByRegion.get(info.edge.regionA) === info.highKey
        const hi = aIsHigh ? info.avgA : info.avgB
        const lo = aIsHigh ? info.avgB : info.avgA
        if (hi == null || lo == null) continue
        sum += Math.max(0, hi - lo); cnt++
      }
      return (cnt ? sum / cnt : 0) * seg.infos.length
    }
    const downgradedSegments = new Set()
    for (let i = 0; i < segments.length - 1; i++) {
      const segA = segments[i], segB = segments[i + 1]
      const sA = strengthOf(segA), sB = strengthOf(segB)
      const ratio = Math.min(sA, sB) / Math.max(sA, sB, 1e-9)
      if (ratio >= CLIFF_SPLIT_EQUAL_TOLERANCE) continue   // roughly equal — genuine split, both stand
      downgradedSegments.add(sA < sB ? segA : segB)
    }
    for (const seg of downgradedSegments) {
      for (const info of seg.infos) downgradeEdgeIds.add(info.id)
    }

    // 9. Record per-edge output — skipped for a downgraded edge (no side info at all;
    // its z-hook leaves the split copy at its own raw z, same as an untyped edge).
    for (const info of perEdge) {
      if (downgradeEdgeIds.has(info.id)) continue
      const e = info.edge
      const aIsHigh = sideKeyByRegion.get(e.regionA) === info.highKey
      const highAvg = aIsHigh ? info.avgA : info.avgB
      const lowAvg = aIsHigh ? info.avgB : info.avgA
      const perRegion = new Map()
      const aKey = sideKeyByRegion.get(e.regionA), bKey = sideKeyByRegion.get(e.regionB)
      perRegion.set(e.regionA, aKey === info.highKey ? { side: 'high', targetAvg: highAvg } : { side: 'low', targetAvg: lowAvg })
      perRegion.set(e.regionB, bKey === info.highKey ? { side: 'high', targetAvg: highAvg } : { side: 'low', targetAvg: lowAvg })
      sidesByEdge.set(info.id, perRegion)
    }
  }

  return { sidesByEdge, downgradeEdgeIds }
}

// Forces a fresh Cliff edge's two sides to at least CLIFF_MIN_SEPARATION apart, right at
// definition time (user-confirmed 2026-07-26: "one side should be forced to be higher, at
// time of application" — today's computeCliffChainSides/z-hook is purely reactive, with no
// such moment; this restores it as a real, one-time terrain-shaping action, the same way
// every TERRAIN_TYPES effect applies a real delta on Apply). Splits any shortfall
// 50/50 around the edge's own existing natural midpoint — the high side's own local
// neighbours nudge up, the low side's nudge down — then a short outward blend
// (propagateFromPoints, same primitive the ongoing Cliff propagation uses) so it isn't an
// isolated notch. One-time only: every LATER pullback pass reads this as the new "local
// natural" state via computeCliffChainSides' own per-edge average, so it can still drift/
// change afterwards as neighbouring terrain edits happen ("it can still change afterwards").
// `allEdges`/`edgeId`: called with the edge ALREADY assignedType='Cliff' in `allEdges`, so
// computeCliffChainSides picks up run-context from any already-adjacent Cliff correctly.
export function forceInitialCliffSeparation(registry, allEdges, edgeId, terrainPlots, regionsById) {
  const { sidesByEdge } = computeCliffChainSides(allEdges, terrainPlots, registry, regionsById)
  const sides = sidesByEdge.get(edgeId)
  if (!sides) return   // downgraded immediately (e.g. a weak flip against an adjacent run) — nothing to force

  const edge = allEdges[edgeId]
  const regionAInfo = sides.get(edge.regionA), regionBInfo = sides.get(edge.regionB)
  if (!regionAInfo || !regionBInfo) return   // an always-locked region has no entry — never forced
  const highInfo = regionAInfo.side === 'high' ? regionAInfo : regionBInfo
  const lowInfo = regionAInfo.side === 'high' ? regionBInfo : regionAInfo
  if (highInfo.targetAvg == null || lowInfo.targetAvg == null) return

  const shortfall = CLIFF_MIN_SEPARATION - (highInfo.targetAvg - lowInfo.targetAvg)
  if (shortfall <= 0) return   // already separated enough

  const highRegionId = regionAInfo.side === 'high' ? edge.regionA : edge.regionB
  const lowRegionId = regionAInfo.side === 'high' ? edge.regionB : edge.regionA

  // Same physical-edge-keyed lookup as computeCliffChainSides' own localAverage (NOT a
  // vertex-graph walk — reverted here 2026-07-26 for the exact reason localAverage itself
  // was rewritten: a shared junction vertex is a graph-neighbour of every plot touching
  // it, including plots of an entirely different region at a DIFFERENT physical edge, so
  // the old `graph.get(pid)` walk could add the same point id to both the high-side AND
  // low-side neighbour sets. Since the two nudge loops below write `p.z` directly and
  // unconditionally, that collision let the low-side write silently clobber the
  // high-side write on the same point — confirmed live against a real save (2026-07-26):
  // several freshly-forced Cliff edges showed near-zero or exactly-zero separation
  // despite genuinely-distinct high/low point ids, traced back to this exact collision.
  // Scoping by physical edge instead guarantees each segment maps to exactly the ONE
  // real bordering plot per region — the identical set `localAverage` will read back on
  // every later pullback pass, so the forced push and the ongoing reactive average never
  // disagree about which points are "this edge's own neighbours".
  const plotsByPhysicalEdge = new Map()
  for (const plot of terrainPlots) {
    const ids = plot.pointIds
    if (!ids || ids.length < 2) continue
    for (let i = 0; i < ids.length; i++) {
      const p1 = ids[i], p2 = ids[(i + 1) % ids.length]
      if (p1 === p2) continue
      const key = p1 < p2 ? `${p1},${p2}` : `${p2},${p1}`
      if (!plotsByPhysicalEdge.has(key)) plotsByPhysicalEdge.set(key, [])
      plotsByPhysicalEdge.get(key).push(plot)
    }
  }
  const edgePointSet = new Set(edge.pointIds)
  const neighborsInRegion = (regionId) => {
    const ids = new Set()
    const pts = edge.pointIds
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      if (a === b) continue
      const key = a < b ? `${a},${b}` : `${b},${a}`
      const plot = (plotsByPhysicalEdge.get(key) || []).find(p => p.parentRegionId === regionId)
      if (!plot) continue
      for (const pid of plot.pointIds) {
        if (edgePointSet.has(pid)) continue
        ids.add(pid)
      }
    }
    return [...ids]
  }

  const half = shortfall / 2
  const highTargets = new Map()
  for (const id of neighborsInRegion(highRegionId)) {
    const p = registry.get(id)
    if (!p || p.zLocked) continue
    p.z = (p.z ?? 0) + half
    highTargets.set(id, p.z)
  }
  const lowTargets = new Map()
  for (const id of neighborsInRegion(lowRegionId)) {
    const p = registry.get(id)
    if (!p || p.zLocked) continue
    p.z = (p.z ?? 0) - half
    lowTargets.set(id, p.z)
  }
  if (highTargets.size) propagateFromPoints(registry, terrainPlots, [...highTargets.keys()], highTargets, 1, 'linear', 'up')
  if (lowTargets.size) propagateFromPoints(registry, terrainPlots, [...lowTargets.keys()], lowTargets, 1, 'linear', 'down')
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
  const rule = TERRAIN_TYPES[region.assignedType]
  // `!rule?.mode`, not `!rule` (2026-07-27, TERRAIN_TYPES merge) — every type now has AT
  // LEAST a `color` entry (Plains/Forest included), so plain truthiness no longer means
  // "has a z-effect"; `mode` is the actual signal.
  if (!rule?.mode) return   // Plains/Forest/unrecognized: no effect
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
  } else if (rule.mode === 'delta' || rule.mode === 'deltaandextterrainplots') {
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
// `direction` ('up'|'down', from TERRAIN_TYPES): a safety clamp (user-confirmed
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
// point's pre-split z, snapped to its side's own local neighbour average — see
// computeCliffChainSides), so a single global blend target
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
