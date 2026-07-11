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

// ── Test 6: river-mouth splice validation (the "Plot 79" fix) ───────────────────────
// splitVertexGeneral's vA/vB offsets are clamped only against LAND edge lengths, so a
// water face can be overshot. The caller now validates the prospective polygon BEFORE
// splicing and falls back to the single-position split when it would self-intersect.
// Note a SYMMETRIC overshoot (offsets parallel to the far shore) legitimately produces
// a simple trapezoid — flush with both banks — which the guard correctly allows; only
// genuinely-crossing outcomes (oblique overshoot past a non-adjacent edge, or a wrong
// fan order producing a bowtie) must fall back.
{
  const simple = (poly) => !SetupPhase.prototype._polygonSelfIntersects(poly)

  // groupWest/groupEast must be the SAME object references in `deltas` and `ambiguous`
  // — reference identity is the group key throughout the real pipeline
  // (getOrCreateSplitVertex memoization), so the test must respect it too.
  const run = (waterPoly, groupWest, groupEast, groupsInOrder) => {
    const reg = new GroundPointRegistry()
    const sp = new SetupPhase({ pointRegistry: reg, worldTerrainData: { edges: {} } })
    const mint = (p) => reg.create(p.x, p.y, 0, 'terrain').id
    const v = mint({ x: 0, y: 0 })

    // L1 west of the river (shares v), L2 east (shares v), W the water face at the mouth.
    const L1 = [{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: -3, y: 3 }, { x: -3, y: 0 }]
    const L2 = [{ x: 0, y: 3 }, { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }]
    const idsL1 = [v, ...L1.slice(1).map(mint)]
    const idsL2 = [idsL1[1], v, ...L2.slice(2).map(mint)]
    const idsW = [v, ...waterPoly.slice(1).map(mint)]

    const zero = { dx: 0, dy: 0 }
    const deltas = [
      [groupWest, zero, zero, zero],
      [zero, groupEast, zero, zero],
      [groupEast, ...waterPoly.slice(1).map(() => zero)],   // W's own baked-in single-position winner
    ]
    const ambiguous = new Map([[v, groupsInOrder]])
    const { results } = sp._dcelPullbackMaterialize(
      [L1, L2, waterPoly], [idsL1, idsL2, idsW], deltas, ambiguous, 'test-split', (fi) => fi === 2
    )
    return results[2]
  }

  const bigW = [{ x: 0, y: 0 }, { x: -3, y: -2 }, { x: 3, y: -2 }]
  const tinyW = [{ x: 0, y: 0 }, { x: -0.3, y: -0.2 }, { x: 0.3, y: -0.2 }]

  // (a) Oblique overshoot: the west bank's push angles down INTO the tiny water
  // triangle, past its far shore — the spliced loop would cross the bottom edge.
  {
    const west = { dx: -0.05, dy: -0.6 }, east = { dx: 0.35, dy: 0 }
    const r = run(tinyW, west, east, [east, west])
    check('oblique overshoot: falls back to single-position (3 vertices)', r?.pointIds.length === 3)
    check('oblique overshoot: result stays a simple polygon', !!r && simple(r.polygon))
  }

  // (b) Symmetric overshoot on the same tiny triangle: offsets parallel to the far
  // shore produce a legal trapezoid, flush with both banks — guard must ALLOW it.
  {
    const west = { dx: -0.5, dy: 0 }, east = { dx: 0.5, dy: 0 }
    const r = run(tinyW, west, east, [east, west])
    check('symmetric overshoot: splice allowed (4 vertices)', r?.pointIds.length === 4)
    check('symmetric overshoot: result is a simple polygon', !!r && simple(r.polygon))
  }

  // (c) Big water triangle, correct fan order — clean splice, face gains a vertex.
  {
    const west = { dx: -0.5, dy: 0 }, east = { dx: 0.5, dy: 0 }
    const r = run(bigW, west, east, [east, west])
    check('clean splice: water face gains a vertex (4)', r?.pointIds.length === 4)
    check('clean splice: result is a simple polygon', !!r && simple(r.polygon))
  }

  // (d) Same big triangle, WRONG order — bowtie; the guard must catch it and fall back.
  {
    const west = { dx: -0.5, dy: 0 }, east = { dx: 0.5, dy: 0 }
    const r = run(bigW, west, east, [west, east])
    check('wrong fan order: guard falls back (3 vertices)', r?.pointIds.length === 3)
    check('wrong fan order: result stays a simple polygon', !!r && simple(r.polygon))
  }
}

// ── Test 7: river width consistency across independently-tessellated banks ──────────
// Bank A has a short far edge near the shared vertices (triggers _pullBackPolygon's
// effHw clamp); bank B has a long far edge (no clamp). Before the fix, each bank's
// push magnitude was computed independently, so the river's actual width (the gap
// between the two banks) varied — invisible under the old fixed-thickness stroke,
// directly visible now that this gap IS the rendered face. After the fix, both banks
// must agree on the SMALLER (more-constrained) magnitude at every shared vertex.
{
  const sp = new SetupPhase({})
  const p0 = { x: 0, y: 0 }, p1 = { x: 0, y: 4 }
  const bankA = [p0, { x: -0.3, y: 0 }, { x: -0.3, y: 4 }, p1]        // short far edge -> effHw clamps hard
  const bankB = [p1, { x: 5, y: 4 }, { x: 5, y: 0 }, p0]              // long far edge -> little/no clamp
  const idsA = [100, 200, 201, 101]
  const idsB = [101, 300, 301, 100]
  const segs = [{ seg: [p0, p1], sourceEdgeId: 'e' }]

  // Each bank's fully independent result (what _pullBackPolygon alone would produce,
  // exactly the old pre-reconciliation behavior) — establishes the two banks genuinely
  // DO disagree on this geometry before any fix is applied.
  const beforeA = sp._pullBackPolygon(bankA, segs, 0.35).deltas
  const beforeB = sp._pullBackPolygon(bankB, segs, 0.35).deltas
  const magBeforeA_p0 = Math.hypot(beforeA[0].dx, beforeA[0].dy)
  const magBeforeB_p0 = Math.hypot(beforeB[3].dx, beforeB[3].dy)
  check(`sanity: the two banks disagree before reconciliation (${magBeforeA_p0.toFixed(4)} vs ${magBeforeB_p0.toFixed(4)})`, Math.abs(magBeforeA_p0 - magBeforeB_p0) > 0.01)

  const { deltas } = sp._computeRiverCliffDeltas([bankA, bankB], [idsA, idsB], segs, 0.35)
  const magA_p0 = Math.hypot(deltas[0][0].dx, deltas[0][0].dy)     // bank A's own delta at p0 (index 0)
  const magB_p0 = Math.hypot(deltas[1][3].dx, deltas[1][3].dy)     // bank B's own delta at p0 (index 3)
  const magA_p1 = Math.hypot(deltas[0][3].dx, deltas[0][3].dy)     // bank A's own delta at p1 (index 3)
  const magB_p1 = Math.hypot(deltas[1][0].dx, deltas[1][0].dy)     // bank B's own delta at p1 (index 0)

  check(`p0: both banks agree after reconciliation (${magA_p0.toFixed(4)} vs ${magB_p0.toFixed(4)})`, Math.abs(magA_p0 - magB_p0) < 1e-9)
  check(`p1: both banks agree after reconciliation (${magA_p1.toFixed(4)} vs ${magB_p1.toFixed(4)})`, Math.abs(magA_p1 - magB_p1) < 1e-9)
  check('p0: reconciled magnitude is the SMALLER of the two independent values (never grows a push)', Math.abs(magA_p0 - Math.min(magBeforeA_p0, magBeforeB_p0)) < 1e-9)
}

// ── Test 8: land-only confluence splice (no water face involved) ────────────────────
// Two Cliff chains meeting at a corner where a THIRD land region also touches — e.g.
// Ice Sheet auto-cliffing two edges at once (see plan Addendum 2, "Ice Sheet" process
// trace). The confluence-splice search must find the corner face by "no vote of its
// own" (hasOwnVote), not by a water flag — this is the actual generalization under
// test. Mirrors Test 6's L1/L2/W topology exactly, but W here is an ordinary land face
// with `water` never set, proving the water flag isn't what makes this work.
{
  const reg = new GroundPointRegistry()
  const sp = new SetupPhase({ pointRegistry: reg, worldTerrainData: { edges: {} } })
  const mint = (p) => reg.create(p.x, p.y, 0, 'terrain').id
  const v = mint({ x: 0, y: 0 })

  const L1 = [{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: -3, y: 3 }, { x: -3, y: 0 }]
  const L2 = [{ x: 0, y: 3 }, { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }]
  const corner = [{ x: 0, y: 0 }, { x: -3, y: -2 }, { x: 3, y: -2 }]   // the "no vote" land face
  const idsL1 = [v, ...L1.slice(1).map(mint)]
  const idsL2 = [idsL1[1], v, ...L2.slice(2).map(mint)]
  const idsCorner = [v, ...corner.slice(1).map(mint)]

  const west = { dx: -0.5, dy: 0 }, east = { dx: 0.5, dy: 0 }
  const zero = { dx: 0, dy: 0 }
  const deltas = [
    [west, zero, zero, zero],
    [zero, east, zero, zero],
    [zero, zero, zero],   // corner's own vote is irrelevant here — hasOwnVote below is what's checked
  ]
  const hasOwnVote = [
    [true, false, false, false],
    [false, true, false, false],
    [false, false, false],   // corner has NO vote of its own at v (index 0) — the case under test
  ]
  const ambiguous = new Map([[v, [east, west]]])

  // isWaterByIndex returns false for EVERY face — proving the splice fires without any
  // water flag at all, purely from hasOwnVote.
  const { results } = sp._dcelPullbackMaterialize(
    [L1, L2, corner], [idsL1, idsL2, idsCorner], deltas, ambiguous, 'test-split', () => false, null, hasOwnVote
  )

  check('land-only confluence: corner face gains a vertex (4, not 3)', results[2]?.pointIds.length === 4)
  check('land-only confluence: result is a simple polygon', !!results[2] && !SetupPhase.prototype._polygonSelfIntersects(results[2].polygon))
  check('land-only confluence: west bank (L1) still resolves to its own 4-vertex polygon', results[0]?.pointIds.length === 4)
  check('land-only confluence: east bank (L2) still resolves to its own 4-vertex polygon', results[1]?.pointIds.length === 4)
}

// ── Test 9: backward compatibility — omitting hasOwnVote keeps the water-only behavior ──
// A caller that doesn't pass hasOwnVote (the 9th, optional argument) must fall back to
// exactly the old water-flag-only search, not silently treat every face as spliceable.
{
  const reg = new GroundPointRegistry()
  const sp = new SetupPhase({ pointRegistry: reg, worldTerrainData: { edges: {} } })
  const mint = (p) => reg.create(p.x, p.y, 0, 'terrain').id
  const v = mint({ x: 0, y: 0 })
  const L1 = [{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: -3, y: 3 }, { x: -3, y: 0 }]
  const L2 = [{ x: 0, y: 3 }, { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }]
  const corner = [{ x: 0, y: 0 }, { x: -3, y: -2 }, { x: 3, y: -2 }]
  const idsL1 = [v, ...L1.slice(1).map(mint)]
  const idsL2 = [idsL1[1], v, ...L2.slice(2).map(mint)]
  const idsCorner = [v, ...corner.slice(1).map(mint)]
  const west = { dx: -0.5, dy: 0 }, east = { dx: 0.5, dy: 0 }, zero = { dx: 0, dy: 0 }
  const deltas = [[west, zero, zero, zero], [zero, east, zero, zero], [east, zero, zero]]
  const ambiguous = new Map([[v, [east, west]]])

  // No hasOwnVote argument, no water flag — the corner face must NOT be spliced.
  const { results } = sp._dcelPullbackMaterialize(
    [L1, L2, corner], [idsL1, idsL2, idsCorner], deltas, ambiguous, 'test-split', () => false
  )
  check('no hasOwnVote + no water flag: corner face is left unsliced (3 vertices)', results[2]?.pointIds.length === 3)
}

// ── Test 10: Edge→Region conversion + centreline reversion (ADR-0020 decisions 4–6) ──
// A typed River Edge produces a canonical Region record in groundplane.regions, linked
// both ways (edge.regionId, face.regionId, region.surfaceIds) and carrying
// centrelinePointIds as the reversal anchor. Clearing the Edge's type and re-syncing
// removes the Region and the back-reference — reversion by not-recreating, no delete
// logic (same recompute-from-pristine philosophy as the pullback itself).
{
  const gp = { regions: [{ id: 'other:1', type: 'District' }] }   // pre-existing non-linear Region must survive
  const edges = {
    'e1': { pointIds: [1, 2, 3], assignedType: 'River', name: 'The Rush', description: 'fast' },
    'e2': { pointIds: [4, 5], assignedType: null },
  }
  const sp = new SetupPhase({ groundplane: gp, worldTerrainData: { edges } })
  const faces = [
    { id: 10, sourceEdgeId: 'e1', assignedType: 'River', pointIds: [], polygon: [] },
    { id: 11, sourceEdgeId: 'e1', assignedType: 'River', pointIds: [], polygon: [] },
  ]

  sp._syncLinearFeatureRegions(faces)
  const region = gp.regions.find(r => r.id === 'linear:e1')
  check('typed Edge produced a Region record', !!region && region.type === 'River')
  check('Region stores the centreline point ids (reversal anchor)', JSON.stringify(region?.centrelinePointIds) === JSON.stringify([1, 2, 3]))
  check('Region links its face Surfaces (canonical rcf: ids)', JSON.stringify(region?.surfaceIds) === JSON.stringify(['rcf:10', 'rcf:11']))
  check('Region carries the Edge\'s name/description', region?.name === 'The Rush' && region?.description === 'fast')
  check('edge gained a regionId back-reference', edges['e1'].regionId === 'linear:e1')
  check('faces gained regionId forward links', faces.every(f => f.regionId === 'linear:e1'))
  check('untyped Edge produced no Region', !gp.regions.some(r => r.id === 'linear:e2'))
  check('pre-existing non-linear Region preserved', gp.regions.some(r => r.id === 'other:1'))

  // Reversion: clear the River (rule 1b's de-typing), re-sync — Region gone, edge clean.
  edges['e1'].assignedType = null
  sp._syncLinearFeatureRegions([])
  check('cleared Edge\'s Region is gone after re-sync', !gp.regions.some(r => r.id === 'linear:e1'))
  check('cleared Edge lost its regionId back-reference', !('regionId' in edges['e1']))
  check('cleared Edge still has its centreline pointIds (the reconstructed undefined Edge)', JSON.stringify(edges['e1'].pointIds) === JSON.stringify([1, 2, 3]))
  check('non-linear Region still preserved after re-sync', gp.regions.some(r => r.id === 'other:1'))
}

// ── Test 11: river-to-lake CONFLUENCE face assembly (plan Addendum 2, Stage B
// remaining-gap fix) ─────────────────────────────────────────────────────────────────
// A river with one plain (map-boundary-style) terminus at p0 and one genuine confluence
// terminus at v, where a Lake face W meets both banks. v is fully surrounded (L1, F1, W,
// F2, L2, in rotational order, zero gaps) via two zero-delta filler faces — matching a
// real Voronoi tessellation, where every interior vertex has faces all the way around it;
// without the fillers, outgoingFan's walk hits a void gap and never reaches L1/L2's own
// corners at v to redirect them, an artifact of the simplified 3-face topology, not of
// the mechanism under test. Before the fix, _buildRiverCliffFaces only accepted a pairing
// that closed within RIVER_CLIFF_MATCH_TOL*4 coordinate distance — which p0's small,
// closely-spaced bank offsets satisfy, but v's bank offsets (pulled back by a much larger,
// deliberately-exaggerated 3-unit push on each side, mirroring a wide river mouth) do NOT:
// they land 6 units apart, well outside tol=4. That pairing can only close via the direct
// half-edge splitVertexGeneral already spliced into W's loop (the "mouth opening" edge) —
// exactly the case this fix adds. Confirms the chain that used to silently vanish (falls
// back to stroke, which doesn't render in District mode — see plan) now assembles into
// one real face.
{
  const reg = new GroundPointRegistry()
  const mint = (x, y) => reg.create(x, y, 0, 'terrain').id
  const p0 = mint(0, 0)
  const v = mint(0, 4)
  const aFar0 = mint(-2, 0), aFar1 = mint(-2, 4)
  const bFar0 = mint(2, 0), bFar1 = mint(2, 4)
  const wFar0 = mint(-5, 6), wFar1 = mint(5, 6)

  const idsL1 = [p0, aFar0, aFar1, v]
  const idsL2 = [p0, v, bFar1, bFar0]
  const idsW = [v, wFar0, wFar1]
  const idsF1 = [v, aFar1, wFar0]   // closes the L1<->W gap in v's fan
  const idsF2 = [v, wFar1, bFar1]   // closes the W<->L2 gap in v's fan
  const rawIds = [idsL1, idsL2, idsW, idsF1, idsF2]
  const rawPolys = rawIds.map(ids => new Array(ids.length))   // only .length is read

  const zero = { dx: 0, dy: 0 }
  const groupWestSmall = { dx: -0.35, dy: 0 }, groupEastSmall = { dx: 0.35, dy: 0 }   // p0 (plain terminus)
  const groupWestBig = { dx: -3, dy: 0 }, groupEastBig = { dx: 3, dy: 0 }              // v (confluence)

  const deltas = [
    [groupWestSmall, zero, zero, groupWestBig],
    [groupEastSmall, groupEastBig, zero, zero],
    [zero, zero, zero],
    [zero, zero, zero],
    [zero, zero, zero],
  ]
  const hasOwnVote = [
    [true, false, false, true],
    [true, true, false, false],
    [false, false, false],
    [false, false, false],
    [false, false, false],
  ]
  const edgeSourceIds = [
    [null, null, null, 'chainR'],
    ['chainR', null, null, null],
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ]
  const ambiguous = new Map([[v, [groupEastBig, groupWestBig]]])

  const sp = new SetupPhase({
    pointRegistry: reg,
    worldTerrainData: { edges: { chainR: { pointIds: [p0, v], assignedType: 'River' } } },
  })

  const { results, riverCliffFaces } = sp._dcelPullbackMaterialize(
    rawPolys, rawIds, deltas, ambiguous, 'test-split', (fi) => fi === 2, edgeSourceIds, hasOwnVote
  )

  check('both land faces still resolve (4 vertices each)', results[0]?.pointIds.length === 4 && results[1]?.pointIds.length === 4)
  check('the Lake face gained a vertex at the confluence (4, not 3)', results[2]?.pointIds.length === 4)
  check('exactly one river/cliff face built spanning the whole chain (plain terminus + confluence terminus)', riverCliffFaces.length === 1)

  if (riverCliffFaces.length === 1) {
    const face = riverCliffFaces[0]
    check('face has 4 vertices (2 per bank: plain-terminus point + confluence point)', face.polygon.length === 4)
    check('face assignedType is River', face.assignedType === 'River')
    check('face sourceEdgeId is chainR', face.sourceEdgeId === 'chainR')
    check('face is a simple (non-self-intersecting) polygon', !SetupPhase.prototype._polygonSelfIntersects(face.polygon))
    // Trapezoid: bottom width 0.7 (p0's small split) at y=0, top width 6 (v's big
    // confluence split) at y=4 -> area = (0.7+6)/2 * 4 = 13.4.
    check(`face area is ~13.4 (got ${area(face.polygon).toFixed(4)})`, Math.abs(area(face.polygon) - 13.4) < 1e-6)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
