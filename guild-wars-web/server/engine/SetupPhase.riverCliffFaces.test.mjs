// Regression suite for River/Cliff-as-DCEL-Face construction (see plan
// "typed-giggling-giraffe" addendum: SetupPhase._buildRiverCliffFaces,
// SetupPhase._linearizeRiverBank, DCEL.getOrCreateChain/tagChain). Run with:
//   node server/engine/SetupPhase.riverCliffFaces.test.mjs
import SetupPhase from './SetupPhase.js'
import GroundPointRegistry from './CityGenerator/GroundPointRegistry.js'
import DCEL from './CityGenerator/DCEL.js'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++ } else { fail++; console.log(`FAIL: ${name}`) }
}

function area(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y }
  return Math.abs(a) / 2
}

// ── Test 1: straight 2-bank river, two plots per bank (deliberately mismatched bank
// vertex spacing isn't exercised here — see plan's Stage-1 unit test list for that;
// this test's job is the core stitching path: 4 land faces, sharing raw ids along the
// river centreline, independently split to two banks, then reassembled into one river
// face using the CORRECTED he.origin/he.next.origin walk (not he.twin — see
// _linearizeRiverBank's doc comment for why the twin pointer goes stale here). ────────
{
  const reg = new GroundPointRegistry()
  const p0 = reg.create(0, 0, 0, 'terrain').id
  const p1 = reg.create(0, 2, 0, 'terrain').id
  const p2 = reg.create(0, 4, 0, 'terrain').id
  const aFar0 = reg.create(-2, 0, 0, 'terrain').id
  const aFar1 = reg.create(-2, 2, 0, 'terrain').id
  const aFar2 = reg.create(-2, 4, 0, 'terrain').id
  const bFar0 = reg.create(2, 0, 0, 'terrain').id
  const bFar1 = reg.create(2, 2, 0, 'terrain').id
  const bFar2 = reg.create(2, 4, 0, 'terrain').id

  // fi0=A0 (bank A, y 0-2), fi1=A1 (bank A, y 2-4), fi2=B0 (bank B, y 0-2), fi3=B1 (bank B, y 2-4)
  const rawIds = [
    [p0, aFar0, aFar1, p1],
    [p1, aFar1, aFar2, p2],
    [p0, p1, bFar1, bFar0],
    [p1, p2, bFar2, bFar1],
  ]
  const rawPolys = rawIds.map(ids => new Array(ids.length))   // _dcelPullbackMaterialize only reads .length

  const zero = { dx: 0, dy: 0 }
  const groupA = { dx: -0.35, dy: 0 }
  const groupB = { dx: 0.35, dy: 0 }
  const deltas = [
    [groupA, zero, zero, groupA],
    [groupA, zero, zero, groupA],
    [groupB, groupB, zero, zero],
    [groupB, groupB, zero, zero],
  ]
  const edgeSourceIds = [
    [null, null, null, 'chain1'],
    [null, null, null, 'chain1'],
    ['chain1', null, null, null],
    ['chain1', null, null, null],
  ]

  const sp = new SetupPhase({
    pointRegistry: reg,
    worldTerrainData: { edges: { chain1: { pointIds: [p0, p1, p2], assignedType: 'River' } } },
  })

  const { results, riverCliffFaces } = sp._dcelPullbackMaterialize(
    rawPolys, rawIds, deltas, new Map(), 'test-split', () => false, edgeSourceIds
  )

  check('all 4 land faces still resolve', results.every(r => r && r.polygon.length === 4))
  check('exactly one river/cliff face built', riverCliffFaces.length === 1)

  if (riverCliffFaces.length === 1) {
    const face = riverCliffFaces[0]
    check('face has 6 vertices (3 per bank, no confluence caps)', face.polygon.length === 6)
    check('face assignedType is River', face.assignedType === 'River')
    check('face sourceEdgeId is chain1', face.sourceEdgeId === 'chain1')
    // Rectangle x in [-0.35, 0.35], y in [0,4] -> area 0.7 * 4 = 2.8
    check(`face area is ~2.8 (got ${area(face.polygon).toFixed(4)})`, Math.abs(area(face.polygon) - 2.8) < 1e-6)
    check('every vertex sits on the split banks (x = ±0.35)', face.polygon.every(v => Math.abs(Math.abs(v.x) - 0.35) < 1e-9))
  }
}

// ── Test 2: _linearizeRiverBank branch detection ────────────────────────────────────
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  // A tiny "Y" fan: three triangles sharing vertex v, each contributing an outgoing
  // half-edge FROM v — feeding all three in together is a genuine branch (v maps to 3
  // different destinations), which must be rejected outright, not silently resolved.
  const v = reg.create(0, 0, 0, 'terrain').id
  const rim = [reg.create(1, 0, 0, 'terrain').id, reg.create(0, 1, 0, 'terrain').id, reg.create(-1, 0, 0, 'terrain').id, reg.create(0, -1, 0, 'terrain').id]
  const faces = []
  for (let i = 0; i < 3; i++) faces.push(dcel.insertFace([v, rim[i], rim[i + 1]], 'terrain-plot', {}))
  const heIds = faces.map(f => dcel._faceHalfEdges(f.id)[0].id)   // each face's own outgoing arm at v
  const result = SetupPhase.prototype._extractRiverBankPaths(dcel, heIds)
  check('branching half-edge set returns null (not decomposable into simple paths)', result === null)
}

// ── Test 3: _extractRiverBankPaths on a single simple chain ─────────────────────────
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  const a = reg.create(0, 0, 0, 'terrain').id, b = reg.create(1, 0, 0, 'terrain').id, c = reg.create(2, 0, 0, 'terrain').id
  const far = reg.create(1, -1, 0, 'terrain').id
  // Two triangles sharing edge (a,far)/(far,?) is awkward for a plain chain test — use
  // two independent faces whose own outgoing arms at a->b and b->c are what's chained,
  // mirroring how _buildRiverCliffFaces only ever feeds it ONE outgoing arm per face.
  const f1 = dcel.insertFace([a, b, far], 'terrain-plot', {})
  const f2 = dcel.insertFace([b, c, far], 'terrain-plot', {})
  const he1 = dcel._faceHalfEdges(f1.id)[0]   // a -> b
  const he2 = dcel._faceHalfEdges(f2.id)[0]   // b -> c
  const result = SetupPhase.prototype._extractRiverBankPaths(dcel, [he1.id, he2.id])
  check('single chain yields exactly one path', result?.length === 1)
  check('path linearizes a -> b -> c', JSON.stringify(result?.[0]) === JSON.stringify([a, b, c]))
}

// ── Test 4: _extractRiverBankPaths decomposes TWO disjoint banks (fed together, no
// pre-classification) purely from vertex connectivity — the fix for the axis-based
// approach failing on sharp zigzag chains. ──────────────────────────────────────────
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  // Bank A: a0 -> a1 -> a2 (disjoint vertex set from bank B below — mirrors real split
  // vertices, which never collide across banks). Bank B: b0 -> b1 -> b2.
  const a0 = reg.create(-1, 0, 0, 'terrain').id, a1 = reg.create(-1, 1, 0, 'terrain').id, a2 = reg.create(-1, 2, 0, 'terrain').id
  const b0 = reg.create(1, 0, 0, 'terrain').id, b1 = reg.create(1, 1, 0, 'terrain').id, b2 = reg.create(1, 2, 0, 'terrain').id
  const farA = reg.create(-2, 0.5, 0, 'terrain').id, farA2 = reg.create(-2, 1.5, 0, 'terrain').id
  const farB = reg.create(2, 0.5, 0, 'terrain').id, farB2 = reg.create(2, 1.5, 0, 'terrain').id
  const fA0 = dcel.insertFace([a0, a1, farA], 'terrain-plot', {})
  const fA1 = dcel.insertFace([a1, a2, farA2], 'terrain-plot', {})
  const fB0 = dcel.insertFace([b0, b1, farB], 'terrain-plot', {})
  const fB1 = dcel.insertFace([b1, b2, farB2], 'terrain-plot', {})
  const heIds = [fA0, fA1, fB0, fB1].map(f => dcel._faceHalfEdges(f.id)[0].id)   // each face's own a->b style arm
  const result = SetupPhase.prototype._extractRiverBankPaths(dcel, heIds)
  check('two disjoint banks decompose into exactly 2 paths', result?.length === 2)
  if (result?.length === 2) {
    const byStart = new Map(result.map(p => [p[0], p]))
    check('bank A path is a0 -> a1 -> a2', JSON.stringify(byStart.get(a0)) === JSON.stringify([a0, a1, a2]))
    check('bank B path is b0 -> b1 -> b2', JSON.stringify(byStart.get(b0)) === JSON.stringify([b0, b1, b2]))
  }
}

// ── Test 5: _mergeNearbyPathFragments bridges a small tagging gap (bank A split into
// two fragments by one untagged edge, e.g. at a T-junction) without touching a genuine
// third bank sitting far away. ────────────────────────────────────────────────────────
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  // Bank A fragment 1: a0 -> a1. Gap (untagged, so a1->a2 never became a path edge).
  // Bank A fragment 2: a2 -> a3. These should merge (a1 is close to a2).
  const a0 = reg.create(0, 0, 0, 'terrain').id, a1 = reg.create(0, 1, 0, 'terrain').id
  const a2 = reg.create(0, 1.05, 0, 'terrain').id, a3 = reg.create(0, 2, 0, 'terrain').id
  // A genuine, unrelated second bank far away — must NOT get merged into anything.
  const c0 = reg.create(50, 0, 0, 'terrain').id, c1 = reg.create(50, 1, 0, 'terrain').id

  const fragA1 = [a0, a1], fragA2 = [a2, a3], fragC = [c0, c1]
  const merged = SetupPhase.prototype._mergeNearbyPathFragments(dcel, [fragA1, fragA2, fragC], 1.0)

  check('3 fragments merge down to 2 (the close pair bridges, the far one stays separate)', merged.length === 2)
  const bridged = merged.find(p => p.length === 4)
  const untouched = merged.find(p => p.length === 2)
  check('the two close fragments bridged into one 4-vertex path (a0..a3)', !!bridged && bridged[0] === a0 && bridged[bridged.length - 1] === a3)
  check('the far-away fragment is untouched', JSON.stringify(untouched) === JSON.stringify(fragC))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
