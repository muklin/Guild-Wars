// Regression suite for shared/polylineGeometry.js — extracted verbatim from
// PolylineRenderer.js (see that file and plan "typed-giggling-giraffe" for why: the
// server-side river/cliff pullback is meant to reuse this SAME computation next, so the
// pulled-back terrain data and the rendered stroke agree by construction). These tests
// pin down the extracted behavior before anything else consumes it. Run with:
//   node shared/polylineGeometry.test.mjs
import { computeJunctionData, computeEdgeCorners } from './polylineGeometry.js'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++ } else { fail++; console.log(`FAIL: ${name}`) }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) < eps }
function ptNear(p, x, y, eps = 1e-9) { return !!p && near(p.x, x, eps) && near(p.y, y, eps) }

const pt = (x, y) => ({ x, y })
const byId = (pts) => new Map(Object.entries(pts).map(([id, p]) => [Number(id), p]))

// ── Test 1: straight 2-point edge — simple perpendicular offset at both ends ────────
{
  const pointsById = byId({ 0: pt(0, 0), 1: pt(10, 0) })
  const edge = { pointIds: [0, 1] }
  const corners = computeEdgeCorners(edge, 'e1', new Map(), pointsById, 1, 5)
  check('straight edge produces 2 corners', corners?.length === 2)
  check('start left is (0,1)', ptNear(corners[0].left, 0, 1))
  check('start right is (0,-1)', ptNear(corners[0].right, 0, -1))
  check('end left is (10,1)', ptNear(corners[1].left, 10, 1))
  check('end right is (10,-1)', ptNear(corners[1].right, 10, -1))
}

// ── Test 2: interior bend — 90° corner miters to a single point on each side ────────
{
  // (0,0) -> (10,0) -> (10,10): a clean 90° bend, well within any reasonable miter limit.
  const pointsById = byId({ 0: pt(0, 0), 1: pt(10, 0), 2: pt(10, 10) })
  const edge = { pointIds: [0, 1, 2] }
  const corners = computeEdgeCorners(edge, 'e1', new Map(), pointsById, 1, 100)
  check('bend edge produces 3 corners', corners?.length === 3)
  // At a 90° outer bend the miter point sits at distance r*sqrt(2) from the vertex,
  // offset equally along both incident directions — (10-1,1) and (10+1,-1)... solve
  // directly: bank offsets are perpendicular to each segment (first seg +x, second +y),
  // so left offset direction rotates from (0,1) to (-1,0) — miter bisects between them.
  const midCorner = corners[1]
  check('interior miter point is finite and off the vertex', isFinite(midCorner.left.x) && isFinite(midCorner.right.x))
  // Left side: perpendicular-left of seg1 (0,1) and perpendicular-left of seg2 (-1,0)
  // intersect at (10-1, 0+1) = (9,1).
  check(`interior left miter at (9,1) (got ${JSON.stringify(midCorner.left)})`, ptNear(midCorner.left, 9, 1))
  // Right side: perpendicular-right of seg1 (0,-1) and of seg2 (1,0) intersect at (11,-1).
  check(`interior right miter at (11,-1) (got ${JSON.stringify(midCorner.right)})`, ptNear(midCorner.right, 11, -1))
}

// ── Test 3: very sharp interior bend clamps to miterLimitDist, doesn't spike ────────
{
  // A near-180°-reversal bend (back on itself) produces an extremely distant raw miter
  // point — clamping must bound it to miterLimitDist from the vertex.
  const pointsById = byId({ 0: pt(0, 0), 1: pt(10, 0), 2: pt(0.001, 0) })
  const edge = { pointIds: [0, 1, 2] }
  const miterLimitDist = 2
  const corners = computeEdgeCorners(edge, 'e1', new Map(), pointsById, 1, miterLimitDist)
  const mid = corners[1]
  const distL = Math.hypot(mid.left.x - 10, mid.left.y - 0)
  const distR = Math.hypot(mid.right.x - 10, mid.right.y - 0)
  check(`clamped left corner stays within miterLimitDist (got ${distL.toFixed(3)})`, distL <= miterLimitDist + 1e-6)
  check(`clamped right corner stays within miterLimitDist (got ${distR.toFixed(3)})`, distR <= miterLimitDist + 1e-6)
}

// ── Test 4: 2-way junction, wide angle — miters to a single shared point ────────────
{
  // Two edges sharing endpoint (0,0): edge A going to (10,0), edge B going to (0,10) —
  // a clean 90° junction, well within the miter limit.
  const pointsById = byId({ 0: pt(0, 0), 1: pt(10, 0), 2: pt(0, 10) })
  const edges = { a: { pointIds: [0, 1] }, b: { pointIds: [0, 2] } }
  const fills = new Map()
  const overrides = computeJunctionData(edges, pointsById, 1, 100, fills)
  const aAt0 = overrides.get('a_0'), bAt0 = overrides.get('b_0')
  check('both edges got an override at the shared point', !!aAt0 && !!bAt0)
  check('a and b agree on the shared boundary point (mitered, not beveled)',
    near(aAt0.trueLeft.x, bAt0.trueRight.x) && near(aAt0.trueLeft.y, bAt0.trueRight.y))
  check('2-way junction produces no fan-cap (only 3+-way junctions do)', !fills.has(0))
}

// ── Test 5: 3-way junction — fan-cap data present, exactly 3 boundary points ────────
{
  const pointsById = byId({ 0: pt(0, 0), 1: pt(10, 0), 2: pt(-7, 7), 3: pt(-7, -7) })
  const edges = { a: { pointIds: [0, 1] }, b: { pointIds: [0, 2] }, c: { pointIds: [0, 3] } }
  const fills = new Map()
  computeJunctionData(edges, pointsById, 1, 100, fills)
  check('3-way junction produces a fan-cap entry', fills.has(0))
  const fill = fills.get(0)
  check('fan-cap has 3 boundary points (one per incident edge)', fill.boundaryPts.length === 3)
  check('fan-cap centre is the junction point', ptNear(fill.center, 0, 0))
  check('fan-cap references all 3 edge ids', fill.edgeIds.size === 3 && ['a', 'b', 'c'].every(id => fill.edgeIds.has(id)))
}

// ── Test 6: narrow-angle junction bevels (two distinct points) instead of spiking ───
{
  // Two edges leaving (0,0) at a very shallow angle from each other — the raw miter
  // point would be far away; with a tight miterLimitDist it must bevel (q1 !== q2).
  const pointsById = byId({ 0: pt(0, 0), 1: pt(10, 0), 2: pt(10, 0.05) })
  const edges = { a: { pointIds: [0, 1] }, b: { pointIds: [0, 2] } }
  const miterLimitDist = 2
  const overrides = computeJunctionData(edges, pointsById, 1, miterLimitDist, new Map())
  const aAt0 = overrides.get('a_0')
  const dist = Math.hypot(aAt0.trueLeft.x - aAt0.trueRight.x, aAt0.trueLeft.y - aAt0.trueRight.y)
  check('narrow-angle junction bevels into two DISTINCT points, not one spike', dist > 1e-6)
}

// ── Test 7: composition — an edge's own endpoint corner exactly matches the junction
// override it should be using (proving computeEdgeCorners + computeJunctionData
// compose the same way PolylineRenderer.render() relies on). ───────────────────────
{
  const pointsById = byId({ 0: pt(0, 0), 1: pt(10, 0), 2: pt(0, 10) })
  const edges = { a: { pointIds: [0, 1] }, b: { pointIds: [0, 2] } }
  const overrides = computeJunctionData(edges, pointsById, 1, 100, new Map())
  const cornersA = computeEdgeCorners(edges.a, 'a', overrides, pointsById, 1, 100)
  const aOvr = overrides.get('a_0')
  check('edge A\'s own corner-0 exactly matches its junction override',
    ptNear(cornersA[0].left, aOvr.trueLeft.x, aOvr.trueLeft.y) && ptNear(cornersA[0].right, aOvr.trueRight.x, aOvr.trueRight.y))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
