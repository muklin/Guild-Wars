// River network z-height (plan "splendid-beaming-narwhal", 2026-08-01 redesign — supersedes
// TerrainZHeight.js's old `applyRiverZGradient`, which graded one River Edge's own chain in
// isolation with no notion of the wider network it belonged to). Split into its own file rather
// than growing TerrainZHeight.js further — River's network/branching/Waterfall logic is
// comparably self-contained to that file's own Cliff section, and this codebase already keeps
// River/Cliff-specific geometry in separate files sharing common primitives (ShoreBands.js /
// CliffEdgeBands.js both build on TransitionBand.js).
//
// Source/mouth rule (user-confirmed, not previously written down anywhere in this repo): at
// calculation time, compare the CURRENT z of a river network's free ends (leaves) — the lowest
// is the mouth (a Sea-adjacent leaf wins automatically, since Sea's own locked z is always the
// map's lowest, with no region-type special-casing needed), every other leaf is a source. A
// branching network (two tributaries merging before reaching the mouth) grades each source down
// to its own confluence independently, then one shared gradient continues from the confluence to
// the mouth — this falls out for free from a single consistent mouth-outward walk (see below)
// rather than needing separate branch/trunk code paths.
//
// Waterfall (CONTEXT_WorldTerrain.md): "the crossing point where a River's path passes through a
// Cliff Edge, producing a discrete vertical drop equal to the Cliff's own high/low z gap, rather
// than a continuous grade." The old implementation only ever froze whatever z already happened to
// be at a crossing (never computed an actual gap) — this version reads the real gap from
// TerrainZHeight.computeCliffChainSides' own `sidesByEdge` output, the single source of truth for
// a Cliff's own high/low split, rather than re-deriving it.
import { computeCliffChainSides } from './TerrainZHeight.js'

// Groups River-assigned edges into connected networks (shared endpoint pointIds, exactly like
// TerrainZHeight.computeCliffChainSides' own run-grouping, generalized from a linear chain to a
// tree/graph — a river network is allowed to branch, a Cliff run never is). Returns
// `Array<{ edgeIds: string[], endpointDegree: Map<pointId, count> }>` — degree 1 is a free end
// (leaf: a source or the mouth), degree >= 3 is a confluence, degree 2 is an ordinary interior
// junction between two consecutive edges of the same network.
export function computeRiverNetworks(edges) {
  const endpointsOf = (e) => [e.pointIds[0], e.pointIds[e.pointIds.length - 1]]
  const riverEntries = Object.entries(edges || {}).filter(([, e]) => e.assignedType === 'River')
  if (!riverEntries.length) return []

  const edgeIdsByEndpoint = new Map()
  for (const [id, e] of riverEntries) {
    for (const ep of endpointsOf(e)) {
      if (!edgeIdsByEndpoint.has(ep)) edgeIdsByEndpoint.set(ep, [])
      edgeIdsByEndpoint.get(ep).push(id)
    }
  }
  const edgeById = new Map(riverEntries)
  const visited = new Set()
  const networks = []
  for (const [id] of riverEntries) {
    if (visited.has(id)) continue
    const edgeIds = []
    const queue = [id]
    visited.add(id)
    while (queue.length) {
      const curId = queue.shift()
      edgeIds.push(curId)
      for (const ep of endpointsOf(edgeById.get(curId))) {
        for (const nbId of edgeIdsByEndpoint.get(ep) || []) {
          if (!visited.has(nbId)) { visited.add(nbId); queue.push(nbId) }
        }
      }
    }
    const endpointDegree = new Map()
    for (const eid of edgeIds) {
      for (const ep of endpointsOf(edgeById.get(eid))) {
        endpointDegree.set(ep, (endpointDegree.get(ep) ?? 0) + 1)
      }
    }
    networks.push({ edgeIds, endpointDegree })
  }
  return networks
}

// pointId -> the largest Waterfall gap (Cliff high targetAvg - low targetAvg) at that point,
// across EVERY point of EVERY assigned Cliff edge's own polyline (not just its two endpoints —
// matching the old cliffPointIds' own "every pointId on any currently-assigned Cliff edge"
// convention, since a river can cross a Cliff's path at an interior bend, not only at a Cliff
// chain's own start/end corner). A Cliff edge with no resolved sidesByEdge entry (downgraded, or
// an always-locked region on one side with no targetAvg) contributes nothing — that point is
// then just an ORDINARY interior point, graded through normally like any non-crossing point
// (not frozen at some arbitrary pre-existing value with no real height data to justify it — a
// deliberate change from the old implementation's own blanket freeze, which had no notion of
// "resolved" vs "unresolved" at all).
function buildCliffGapByPoint(edges, sidesByEdge) {
  const gapByPoint = new Map()
  for (const [edgeId, e] of Object.entries(edges || {})) {
    if (e.assignedType !== 'Cliff') continue
    const sides = sidesByEdge.get(edgeId)
    if (!sides) continue
    let highTarget = null, lowTarget = null
    for (const info of sides.values()) {
      if (info.side === 'high') highTarget = info.targetAvg
      else if (info.side === 'low') lowTarget = info.targetAvg
    }
    if (highTarget == null || lowTarget == null) continue
    const gap = highTarget - lowTarget
    if (!(gap > 0)) continue
    for (const pid of e.pointIds || []) {
      if (!gapByPoint.has(pid) || gapByPoint.get(pid) < gap) gapByPoint.set(pid, gap)
    }
  }
  return gapByPoint
}

// Grades one whole River network: determines its mouth/sources from the CURRENT z of its own
// leaves (read once, before any write in this pass — same discipline Lake/Ice-Sheet already use
// in TerrainZHeight.js), then walks the network mouth-outward, grading continuously toward each
// TRUE anchor — a leaf, a real branching confluence (degree >= 3), or a Waterfall crossing.
// `sidesByEdge`: TerrainZHeight.computeCliffChainSides' own output, computed once by the caller
// and passed in (never re-derived here).
//
// A degree-2 point (where a network happens to be split across two coarse Edge objects with no
// actual tributary joining there — a bend, or simply drawn in two separate clicks) is NOT a true
// anchor and must NOT be frozen (found live, against a real save: freezing every non-leaf point
// at its own raw/natural terrain z — this function's first version — produced a river that rose
// and fell following the bumpy ambient terrain at every one of these ordinary joints, instead of
// grading straight through them; the reported "river bed rises where it should keep falling" bug
// was exactly this). The walk below accumulates a single continuous point+distance run across as
// many coarse Edges as needed, only stopping at a genuine anchor, and grades that whole run in
// one pass — this is what makes an ordinary multi-Edge river (no real branching at all, just a
// long path split into several coarse Edges) grade as ONE smooth, monotonic gradient rather than
// several independently-anchored fragments.
//
// Deliberately NOT `gradeRange`'s old "whichever end is currently higher, walk from there" auto-
// detection: that heuristic is per-stretch local and can pick the wrong direction when an anchor
// point's own raw/natural z happens to be anomalous relative to the network's TRUE mouth/source
// ordering (e.g. a small terrain bump sitting right at a junction) — established topology (BFS
// distance from the mouth) is what "a consistent gradient" actually requires here, not a local
// raw-z comparison. A TRUE anchor's own z is only ever READ, never written by this function
// (matching the old "endpoints are fixed" rule) — this is what makes branching fall out for free:
// every tributary run reads the same already-existing confluence z as its own downstream target,
// regardless of which order runs happen to be processed in.
export function applyRiverNetworkZGradient(registry, edges, network, sidesByEdge) {
  const { edgeIds, endpointDegree } = network
  const endpointsOf = (e) => [e.pointIds[0], e.pointIds[e.pointIds.length - 1]]
  const edgeById = new Map(edgeIds.map(id => [id, edges[id]]))

  const leaves = [...endpointDegree.entries()].filter(([, deg]) => deg === 1).map(([id]) => id)
  if (leaves.length < 2) return   // degenerate network (a closed loop, or malformed data) — nothing to grade between

  let mouthId = null, mouthZ = Infinity
  for (const id of leaves) {
    const p = registry.get(id)
    if (!p || !isFinite(p.z)) continue
    if (p.z < mouthZ || (p.z === mouthZ && (mouthId == null || id < mouthId))) { mouthZ = p.z; mouthId = id }
  }
  if (mouthId == null) return

  const edgeIdsByEndpoint = new Map()
  for (const id of edgeIds) {
    for (const ep of endpointsOf(edgeById.get(id))) {
      if (!edgeIdsByEndpoint.has(ep)) edgeIdsByEndpoint.set(ep, [])
      edgeIdsByEndpoint.get(ep).push(id)
    }
  }

  const gapByPoint = buildCliffGapByPoint(edges, sidesByEdge)
  // A true anchor is a leaf/confluence (degree !== 2) ONLY — a Waterfall crossing is
  // deliberately NOT treated as a run-stopping anchor here, even when it happens to also
  // sit exactly at a degree-2 coarse-Edge boundary (a real, if less common, case: a
  // player's second River segment starting right where the first crosses a Cliff). It's
  // handled entirely inside gradeRun's own interior loop instead, which can compute its
  // real drop relative to whichever true anchor is upstream of it regardless of which
  // coarse Edge(s) it happens to straddle — stopping the run AT it here would strand it as
  // a boundary point between two runs, with neither run's interior loop ever reaching it to
  // compute its value (confirmed live while adding regression coverage for exactly this).
  const isTrueAnchor = (id) => (endpointDegree.get(id) ?? 0) !== 2

  // Grades one continuous run of points (runIds/runPts, in downstream-to-upstream order,
  // both ends already-resolved true anchors) — the same anchor-to-anchor directional lerp
  // the original per-edge design had, just over a run that can now span multiple coarse
  // Edges. Waterfall crossings partway through the run still get their own real computed
  // drop, same as before.
  const gradeRun = (runIds, runPts) => {
    if (runPts.some(p => !p) || runPts.length < 2) return
    const cum = [0]
    for (let i = 1; i < runPts.length; i++) cum.push(cum[i - 1] + Math.hypot(runPts[i].x - runPts[i - 1].x, runPts[i].y - runPts[i - 1].y))
    if (cum[cum.length - 1] === 0) return
    const gradeDirectional = (fromIdx, toIdx) => {
      const step = toIdx > fromIdx ? 1 : -1
      const fromZ = runPts[fromIdx].z, toZ = runPts[toIdx].z
      const totalDist = Math.abs(cum[toIdx] - cum[fromIdx])
      if (totalDist <= 0) return
      for (let i = fromIdx + step; i !== toIdx; i += step) {
        if (runPts[i].zLocked) continue
        const t = Math.abs(cum[i] - cum[fromIdx]) / totalDist
        runPts[i].z = fromZ + (toZ - fromZ) * t
      }
    }
    // Walk UPSTREAM-to-downstream (high index to low) to resolve Waterfall crossings — a
    // drop is relative to whichever anchor is upstream/already-resolved-higher of it, not
    // the downstream one (water falls FROM the high side, it doesn't get subtracted from
    // the low side it hasn't reached yet). Collected high-to-low, then reversed so the
    // final anchor list is in the increasing-index order gradeDirectional's pairwise loop
    // expects.
    const anchorIdxs = [runIds.length - 1]
    for (let i = runIds.length - 2; i >= 1; i--) {
      const gap = gapByPoint.get(runIds[i])
      if (gap == null) continue
      const prevAnchorIdx = anchorIdxs[anchorIdxs.length - 1]
      if (!runPts[i].zLocked) runPts[i].z = runPts[prevAnchorIdx].z - gap
      anchorIdxs.push(i)
    }
    anchorIdxs.push(0)
    anchorIdxs.reverse()
    for (let a = 0; a < anchorIdxs.length - 1; a++) gradeDirectional(anchorIdxs[a], anchorIdxs[a + 1])
  }

  // Mouth-outward walk: from each true anchor already reached, follow every not-yet-
  // processed edge touching it, accumulating points/distance across as many further edges
  // as needed (passing straight through any plain degree-2 joint) until the next true
  // anchor is hit, then grade that whole accumulated run in one pass.
  const processedEdges = new Set()
  const visitedAnchors = new Set([mouthId])
  const anchorQueue = [mouthId]
  while (anchorQueue.length) {
    const startAnchor = anchorQueue.shift()
    for (const firstEdgeId of edgeIdsByEndpoint.get(startAnchor) || []) {
      if (processedEdges.has(firstEdgeId)) continue
      const runIds = [startAnchor]
      let curEdgeId = firstEdgeId, curStart = startAnchor, farEnd = null
      for (let guard = 0; guard < edgeIds.length + 1; guard++) {
        processedEdges.add(curEdgeId)
        const edge = edgeById.get(curEdgeId)
        const path = (edge.pointIds || []).slice()
        if (!path.length) break
        if (path[path.length - 1] === curStart) path.reverse()
        for (let i = 1; i < path.length; i++) runIds.push(path[i])
        farEnd = path[path.length - 1]
        if (isTrueAnchor(farEnd)) break
        const nextEdges = (edgeIdsByEndpoint.get(farEnd) || []).filter(id => !processedEdges.has(id))
        if (nextEdges.length !== 1) break   // dead end / malformed topology — stop the run defensively
        curEdgeId = nextEdges[0]; curStart = farEnd
      }
      if (farEnd == null) continue
      if (!visitedAnchors.has(farEnd)) { visitedAnchors.add(farEnd); anchorQueue.push(farEnd) }
      const runPts = runIds.map(id => registry.get(id))
      gradeRun(runIds, runPts)
    }
  }
}

// Convenience wrapper for callers that just want "regrade every River network on the map right
// now" (TerrainSetup.assignEdgeType's River branch) without threading computeCliffChainSides
// through themselves.
export function regradeAllRiverNetworks(registry, edges, terrainPlots, regionsById) {
  const { sidesByEdge } = computeCliffChainSides(edges, terrainPlots, registry, regionsById)
  for (const network of computeRiverNetworks(edges)) {
    applyRiverNetworkZGradient(registry, edges, network, sidesByEdge)
  }
}
