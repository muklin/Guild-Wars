// Pure graph walk: given a street graph's junctions, find the ordered chain of
// junctions along the boundary between two districts for a specific edge kind
// (Wall/MainRoad/Canal/Docks). No THREE.js/DOM/server dependency — usable from both
// client/rendering/DistrictRenderer.js (existing caller, ported here unchanged) and
// server/engine/SetupPhase.js (new caller, building District Edge face Surfaces —
// see plan "typed-giggling-giraffe" Addendum 2 Stage C).
//
// streetGraph: { junctions: [{ id, connections: [{ toId, edgeKind, left, right, ... }] }] }
// Returns the ordered junction array (length >= 2), or null if fewer than 2 matching
// junctions exist along this boundary.
export function extractBoundaryChain(streetGraph, districtA, districtB, edgeKind) {
  const junctions = streetGraph?.junctions
  if (!junctions?.length) return null

  // StreetVoronoiGenerator rewrites a connection's null left/right (outer edge, facing
  // unclaimed land) to the string 'terrain' once terrain plots exist nearby — which is
  // as soon as any building generation has run, i.e. essentially always. An outer edge
  // here is passed in with districtB === null (see callers), so treat 'terrain' the
  // same as null or every Docks/Wall/Canal/MainRoad chain on an outer boundary silently
  // fails to resolve (no chain found → no mesh built, even though the junctions exist).
  const norm = (v) => (v === 'terrain' ? null : v)
  const matchesConn = (c) =>
    c.edgeKind === edgeKind &&
    ((norm(c.left) === districtA && norm(c.right) === districtB) ||
     (norm(c.left) === districtB && norm(c.right) === districtA))

  // A junction is in the chain if it has at least one connection along this boundary.
  const matches = junctions.filter(j => (j.connections || []).some(matchesConn))
  if (matches.length < 2) return null

  const jMap = new Map(matches.map(j => [j.id, j]))
  const adj = new Map()
  for (const j of matches) {
    adj.set(j.id, (j.connections || []).filter(c => matchesConn(c) && jMap.has(c.toId)).map(c => c.toId))
  }

  // Start from an endpoint (degree 1 within the chain) or any node if it's a loop
  const start = matches.find(j => (adj.get(j.id) || []).length <= 1) ?? matches[0]
  const chain = [start]
  const visited = new Set([start.id])
  let curr = start
  while (true) {
    const next = (adj.get(curr.id) || []).find(id => !visited.has(id))
    if (next == null) break
    const nj = jMap.get(next)
    if (!nj) break
    chain.push(nj)
    visited.add(nj.id)
    curr = nj
  }
  return chain.length >= 2 ? chain : null
}

// The specific connection ON a given junction that matches this boundary (same
// left/right/edgeKind rule extractBoundaryChain uses to pick chain membership) — the
// source of that junction's own {gutterLeft, gutterRight} corners for this edge. Two
// junctions can each have MULTIPLE connections (to different neighbours); this picks
// the one connection matching the district pair and edge kind, not just "any".
export function boundaryConnectionAt(junction, districtA, districtB, edgeKind) {
  const norm = (v) => (v === 'terrain' ? null : v)
  return (junction.connections || []).find(c =>
    c.edgeKind === edgeKind &&
    ((norm(c.left) === districtA && norm(c.right) === districtB) ||
     (norm(c.left) === districtB && norm(c.right) === districtA))
  ) ?? null
}
