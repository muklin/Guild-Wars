// Standalone regression suite for DCEL.js, decoupled from SetupPhase.js — per plan
// "typed-giggling-giraffe" (full DCEL groundplane topology). Run with:
//   node server/engine/CityGenerator/DCEL.test.mjs
import GroundPointRegistry from './GroundPointRegistry.js'
import DCEL from './DCEL.js'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++ } else { fail++; console.log(`FAIL: ${name}`) }
}

function area(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y }
  return Math.abs(a) / 2
}

// ── Test 1: 2x2 grid of 4 unit squares ──────────────────────────────────────
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  const grid = {}
  for (let gx = 0; gx <= 2; gx++) for (let gy = 0; gy <= 2; gy++) grid[`${gx},${gy}`] = reg.create(gx, gy, 0, 'terrain').id

  const faces = []
  for (let gx = 0; gx < 2; gx++) {
    for (let gy = 0; gy < 2; gy++) {
      const ids = [grid[`${gx},${gy}`], grid[`${gx + 1},${gy}`], grid[`${gx + 1},${gy + 1}`], grid[`${gx},${gy + 1}`]]
      faces.push(dcel.insertFace(ids, 'terrain-plot', { seedPoint: { x: gx + 0.5, y: gy + 0.5 } }))
    }
  }
  check('4 faces created', dcel._facesById.size === 4)

  for (const f of faces) {
    const poly = dcel.walkFacePolygon(f.id)
    check(`face ${f.id} has 4 vertices`, poly.length === 4)
    const resolved = dcel.resolveFacePolygon(f.id)
    check(`face ${f.id} area is 1`, Math.abs(area(resolved) - 1) < 1e-9)
  }

  // Interior shared edge between the two bottom squares should be properly twinned
  // (both sides reference real faces, not void).
  const bottomLeft = faces[0], bottomRight = faces[2]  // gx=0,gy=0 then gx=1,gy=0
  const heBL = dcel._faceHalfEdges(bottomLeft.id)
  const sharedHe = heBL.find(he => dcel.getHalfEdge(he.twin)?.face === bottomRight.id)
  check('bottom-left/bottom-right share a real (non-void) twin edge', !!sharedHe)

  // Outer boundary half-edges should be void (face: null).
  let voidCount = 0
  for (const he of dcel._halfEdgesById.values()) if (he.face === null) voidCount++
  // Perimeter of the 2x2 grid = 8 unit segments = 8 void half-edges.
  check(`outer boundary has 8 void half-edges (got ${voidCount})`, voidCount === 8)
}

// ── Test 2: mergeFaces on two adjacent unit squares ─────────────────────────
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  const p00 = reg.create(0, 0, 0, 'terrain').id, p10 = reg.create(1, 0, 0, 'terrain').id
  const p11 = reg.create(1, 1, 0, 'terrain').id, p01 = reg.create(0, 1, 0, 'terrain').id
  const p20 = reg.create(2, 0, 0, 'terrain').id, p21 = reg.create(2, 1, 0, 'terrain').id

  const faceA = dcel.insertFace([p00, p10, p11, p01], 'block', {})
  const faceB = dcel.insertFace([p10, p20, p21, p11], 'block', {})

  const merged = dcel.mergeFaces(faceA.id, faceB.id)
  check('mergeFaces returns a face', !!merged)
  check('faceB is deleted', !dcel.getFace(faceB.id))
  const poly = dcel.resolveFacePolygon(merged.id)
  check(`merged polygon has 6 vertices (got ${poly.length})`, poly.length === 6)
  check(`merged area is 2 (got ${area(poly).toFixed(4)})`, Math.abs(area(poly) - 2) < 1e-9)

  // Merging two non-adjacent faces should return null, not throw.
  const reg2 = new GroundPointRegistry()
  const dcel2 = new DCEL(reg2)
  const a = [reg2.create(0, 0, 0, 't').id, reg2.create(1, 0, 0, 't').id, reg2.create(1, 1, 0, 't').id]
  const b = [reg2.create(10, 10, 0, 't').id, reg2.create(11, 10, 0, 't').id, reg2.create(11, 11, 0, 't').id]
  const fA = dcel2.insertFace(a, 'block', {}), fB = dcel2.insertFace(b, 'block', {})
  check('mergeFaces on non-adjacent faces returns null', dcel2.mergeFaces(fA.id, fB.id) === null)
}

// ── Test 3: splitVertexSimple — two faces sharing a corner, opposite-direction
// pushes (mirrors the Stage-4 "district river split" regression case) ─────────
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  const v = reg.create(0, 0, 0, 'terrain').id
  // Realistic construction: faceA and faceB share a boundary edge (v-a1) that
  // TERMINATES at v — like two adjacent districts whose common boundary meets the
  // outer edge at a corner (the actual river/cliff pullback topology, not two
  // isolated point-touching triangles).
  const a1 = reg.create(-1, 1, 0, 'terrain').id, a2 = reg.create(-1, -1, 0, 'terrain').id
  const b1 = reg.create(1, -1, 0, 'terrain').id
  const faceA = dcel.insertFace([v, a1, a2], 'district', { label: 'A' })
  const faceB = dcel.insertFace([a1, v, b1], 'district', { label: 'B' })
  check('faceA/faceB share a real twin edge at v-a1', dcel._faceHalfEdges(faceA.id)[0].twin === dcel._faceHalfEdges(faceB.id)[0].id)

  // groupOf: A's own outgoing corner at v pushes toward groupA, B's toward groupB —
  // opposite banks retreating in different directions.
  const groupA = { dx: -0.25, dy: 0 }, groupB = { dx: 0.25, dy: 0 }
  const groupOf = (heOut) => {
    if (heOut.face === faceA.id) return groupA
    if (heOut.face === faceB.id) return groupB
    return null
  }
  const posFor = (group) => ({ x: 0 + group.dx, y: 0 + group.dy, z: 0 })
  dcel.splitVertexSimple(v, groupOf, posFor, 'district-split')

  const heA0 = dcel._faceHalfEdges(faceA.id)[0]
  const heB1 = dcel._faceHalfEdges(faceB.id)[1]   // faceB's [a1, v, b1] -> index 1 departs from v
  const vA = reg.get(heA0.origin), vB = reg.get(heB1.origin)
  check(`face A corner moved to (-0.25,0), got (${vA.x},${vA.y})`, Math.abs(vA.x - (-0.25)) < 1e-9 && Math.abs(vA.y) < 1e-9)
  check(`face B corner moved to (0.25,0), got (${vB.x},${vB.y})`, Math.abs(vB.x - 0.25) < 1e-9 && Math.abs(vB.y) < 1e-9)
  check('original vertex v is no longer referenced by either face corner', heA0.origin !== v && heB1.origin !== v)

  // Two DIFFERENT half-edges resolving to the SAME group object land on the exact same
  // split vertex id by construction — the core guarantee this mechanism exists for.
  // Here they resolve to DIFFERENT groups (opposite banks), so assert they're DIFFERENT
  // split vertices; re-querying the same group again must return the SAME id already
  // assigned (memoized, not re-minted).
  check('opposite-bank groups produce different split vertices', heA0.origin !== heB1.origin)
  const requeried = reg.getOrCreateSplit(v, groupA, -0.25, 0, 0, 'district-split')
  check('re-querying groupA split returns the same id already assigned to face A', requeried.id === heA0.origin)
}

// ── Test 4: fully-interior vertex — closed fan, no void gap ─────────────────
// A "pinwheel" of 6 triangles sharing a common center vertex, fully surrounding it
// (like an interior Voronoi vertex where every neighboring cell is present). Exercises
// the backward-walk-closes-the-loop / forward-walk-returns-to-start paths in
// outgoingFan, never touched by the boundary-vertex tests above.
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  const center = reg.create(0, 0, 0, 'terrain').id
  const N = 6
  const rim = []
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    rim.push(reg.create(Math.cos(a) * 2, Math.sin(a) * 2, 0, 'terrain').id)
  }
  const faces = []
  for (let i = 0; i < N; i++) {
    faces.push(dcel.insertFace([center, rim[i], rim[(i + 1) % N]], 'district', { label: `T${i}` }))
  }

  const fan = dcel.outgoingFan(center)
  check(`interior vertex fan has all ${N} faces (got ${fan.length})`, fan.length === N)
  const distinctFaces = new Set(fan.map(he => he.face))
  check('every fan half-edge belongs to a distinct face', distinctFaces.size === N)

  // Split the center vertex into 3 groups (a 3-bank confluence-shaped test, not just
  // the 2-group case above) — every-other triangle pushed one of 3 directions.
  const groups = [{ dx: 1, dy: 0 }, { dx: -0.5, dy: 0.87 }, { dx: -0.5, dy: -0.87 }]
  const groupOf = (heOut) => groups[faces.findIndex(f => f.id === heOut.face) % 3]
  const posFor = (g) => ({ x: g.dx * 0.3, y: g.dy * 0.3, z: 0 })
  dcel.splitVertexSimple(center, groupOf, posFor, 'district-split')

  const resultIds = new Set()
  for (const f of faces) resultIds.add(dcel._faceHalfEdges(f.id)[0].origin)
  check(`3-group split on a 6-face fan produces exactly 3 distinct split vertices (got ${resultIds.size})`, resultIds.size === 3)
  for (const f of faces) {
    const poly = dcel.resolveFacePolygon(f.id)
    check(`face ${f.label} still has 3 vertices after split`, poly.length === 3)
  }
}

// ── Test 5: splitVertexGeneral — river-mouth / multi-bank confluence ────────
// Classic Y-junction: 2 land banks + 1 water face meeting at a vertex, banks retreating
// in geometrically incompatible directions. The water face must gain a vertex (not just
// move its one corner), flush with EACH bank's own retreated position.
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  const v = reg.create(0, 0, 0, 'terrain').id
  const N = 3
  const rim = []
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    rim.push(reg.create(Math.cos(a) * 2, Math.sin(a) * 2, 0, 'terrain').id)
  }
  const faces = []
  for (let i = 0; i < N; i++) {
    faces.push(dcel.insertFace([v, rim[i], rim[(i + 1) % N]], 'district', { label: `F${i}` }))
  }

  // Find the water face's position in the fan programmatically (don't hand-derive which
  // insertion index ends up where — verify via outgoingFan, matching how a real caller
  // would identify it).
  const fan = dcel.outgoingFan(v)
  check('fan has all 3 faces', fan.length === 3)
  const waterIdx = 1   // arbitrarily designate the fan's 2nd element as "water"
  const waterHe = fan[waterIdx]
  const predFace = dcel.getFace(fan[(waterIdx - 1 + 3) % 3].face)
  const succFace = dcel.getFace(fan[(waterIdx + 1) % 3].face)

  const groupA = { dx: -0.3, dy: 0.1 }   // predecessor bank's retreat direction
  const groupB = { dx: 0.2, dy: -0.25 }  // successor bank's retreat direction — incompatible with groupA

  const result = dcel.splitVertexGeneral(v, waterHe, groupA, groupB, 'district-split')
  check('splitVertexGeneral reports inserted:true for distinct groups', result.inserted === true)
  check('vA and vB are distinct vertices', result.vA.id !== result.vB.id)

  const waterFaceId = dcel.getFace(waterHe.face).id
  const waterPoly = dcel.resolveFacePolygon(waterFaceId)
  check(`water face gained a vertex (was 3, now ${waterPoly.length})`, waterPoly.length === 4)

  // Now split the two banks' OWN corners at v via splitVertexSimple, using the SAME
  // group objects — by construction (getOrCreateSplitVertex memoization) they must
  // land on the EXACT SAME split vertices splitVertexGeneral already produced.
  const groupOf = (heOut) => {
    if (heOut.face === predFace.id) return groupA
    if (heOut.face === succFace.id) return groupB
    return null   // water face's corner already handled — its remaining outgoing arm origin is now vB, not v, so this callback won't even see it
  }
  dcel.splitVertexSimple(v, groupOf, (g) => ({ x: g.dx, y: g.dy, z: 0 }), 'district-split')

  const predOut = dcel._faceHalfEdges(predFace.id).find(he => he.origin === result.vA.id || he.origin === result.vB.id)
  const succOut = dcel._faceHalfEdges(succFace.id).find(he => he.origin === result.vA.id || he.origin === result.vB.id)
  check('predecessor bank\'s own corner landed on the same split vertex as the water face\'s groupA corner', !!predOut && predOut.origin === result.vA.id)
  check('successor bank\'s own corner landed on the same split vertex as the water face\'s groupB corner', !!succOut && succOut.origin === result.vB.id)

  check('predecessor bank still a simple triangle (3 vertices)', dcel.resolveFacePolygon(predFace.id).length === 3)
  check('successor bank still a simple triangle (3 vertices)', dcel.resolveFacePolygon(succFace.id).length === 3)

  // Degenerate case: passing the SAME group object as both groupA and groupB (a
  // confluence angle so acute both sides resolve identically) must report inserted:false
  // and not corrupt the topology.
  const reg2 = new GroundPointRegistry()
  const dcel2 = new DCEL(reg2)
  const v2 = reg2.create(0, 0, 0, 'terrain').id
  const rim2 = []
  for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; rim2.push(reg2.create(Math.cos(a) * 2, Math.sin(a) * 2, 0, 'terrain').id) }
  const faces2 = []
  for (let i = 0; i < 3; i++) faces2.push(dcel2.insertFace([v2, rim2[i], rim2[(i + 1) % 3]], 'district', {}))
  const fan2 = dcel2.outgoingFan(v2)
  const sameGroup = { dx: 0.1, dy: 0.1 }
  const result2 = dcel2.splitVertexGeneral(v2, fan2[1], sameGroup, sameGroup, 'district-split')
  check('identical groupA/groupB reports inserted:false', result2.inserted === false)
  check('identical groupA/groupB returns the same vertex for vA and vB', result2.vA.id === result2.vB.id)
}

// ── Test 6: getOrCreateChain / tagChain / findHalfEdge ──────────────────────
// (plan "typed-giggling-giraffe" addendum — River/Cliff-as-Face groundwork)
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  const a = reg.create(0, 0, 0, 'terrain').id, b = reg.create(1, 0, 0, 'terrain').id
  const c = reg.create(1, 1, 0, 'terrain').id, d = reg.create(0, 1, 0, 'terrain').id
  const face = dcel.insertFace([a, b, c, d], 'terrain-plot', {})
  const heAB = dcel._faceHalfEdges(face.id)[0]   // a -> b

  check('no chain exists yet', dcel.getChain('riverA') === undefined)
  dcel.tagChain(heAB.id, 'riverA')
  const chain = dcel.getChain('riverA')
  check('getOrCreateChain lazily created the chain', !!chain && chain.id === 'riverA')
  check('tagChain recorded the half-edge on the chain', chain.halfEdges.includes(heAB.id))
  check('tagChain stamped .chain on the half-edge itself', dcel.getHalfEdge(heAB.id).chain === 'riverA')
  check('getAllChains includes the new chain', dcel.getAllChains().some(c => c.id === 'riverA'))

  // Tag a second half-edge onto the same chain — accumulates, doesn't overwrite.
  const heBC = dcel._faceHalfEdges(face.id)[1]   // b -> c
  dcel.tagChain(heBC.id, 'riverA')
  check('second tag accumulates onto the same chain', dcel.getChain('riverA').halfEdges.length === 2)

  check('findHalfEdge finds the real a->b edge', dcel.findHalfEdge(a, b)?.id === heAB.id)
  check('findHalfEdge finds the void b->a placeholder', dcel.findHalfEdge(b, a)?.face === null)
  check('findHalfEdge returns null for a non-existent directed pair', dcel.findHalfEdge(a, c) === null)

  check('tagChain throws on an unknown half-edge id', (() => {
    try { dcel.tagChain(999999, 'riverB'); return false } catch { return true }
  })())
}

// ── Test: rechainEdge splits a face's boundary segment through intermediate vertices ──
// See plan "logical-booping-bonbon" (StreetVoronoiGenerator DCEL rewrite) §2(c) —
// replaces absorbCollinearNodes' "delete edge A->B, insert A->N1,N1->N2,...,Nk->B".
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  const p1 = reg.create(0, 0, 0, 'street').id, p2 = reg.create(10, 0, 0, 'street').id
  const p3 = reg.create(10, 10, 0, 'street').id, p4 = reg.create(0, 10, 0, 'street').id
  const square = dcel.insertFace([p1, p2, p3, p4], 'terrain-plot', {})

  const he12 = dcel.findHalfEdge(p1, p2)
  check('starting half-edge p1->p2 exists', !!he12)

  const v3 = reg.create(3, 0, 0, 'street').id, v7 = reg.create(7, 0, 0, 'street').id
  dcel.rechainEdge(he12.id, [v3, v7])

  const poly = dcel.walkFacePolygon(square.id)
  check('face boundary now has 6 vertices (was 4)', poly.length === 6)
  check('boundary order is p1,v3,v7,p2,p3,p4', JSON.stringify(poly) === JSON.stringify([p1, v3, v7, p2, p3, p4]))
  const resolved = dcel.resolveFacePolygon(square.id)
  check('area unchanged (10x10=100) — intermediate points are exactly collinear', Math.abs(area(resolved) - 100) < 1e-9)

  check('old direct p1->p2 directed pair no longer resolves', dcel.findHalfEdge(p1, p2) === null)
  check('new forward chain resolves: p1->v3', dcel.findHalfEdge(p1, v3)?.face === square.id)
  check('new forward chain resolves: v3->v7', dcel.findHalfEdge(v3, v7)?.face === square.id)
  check('new forward chain resolves: v7->p2', dcel.findHalfEdge(v7, p2)?.face === square.id)
  check('reversed void chain resolves: p2->v7', dcel.findHalfEdge(p2, v7)?.face === null)
  check('reversed void chain resolves: v7->v3', dcel.findHalfEdge(v7, v3)?.face === null)
  check('reversed void chain resolves: v3->p1', dcel.findHalfEdge(v3, p1)?.face === null)

  // A second face inserted against the FINER vertex sequence should cleanly reclaim
  // every void placeholder the rechain left behind — proving the reversed chain is
  // correctly stitched (next/prev), not just individually resolvable.
  const p5 = reg.create(5, -5, 0, 'street').id
  const belowFace = dcel.insertFace([p2, v7, v3, p1, p5], 'block', {})
  const belowPoly = dcel.walkFacePolygon(belowFace.id)
  check('second face against the finer sequence closes cleanly (5 vertices)', belowPoly.length === 5)
  check('second face reclaimed the void placeholders (no fresh unrelated mint)', dcel.findHalfEdge(p2, v7).face === belowFace.id)

  // outgoingFan sanity: the new intermediate vertices are real, walkable topology.
  check('v3 has a valid outgoing fan (not orphaned)', dcel.outgoingFan(v3).length > 0)
  check('v7 has a valid outgoing fan (not orphaned)', dcel.outgoingFan(v7).length > 0)

  check('empty throughVertexIds is a no-op', (() => {
    const before = dcel._halfEdgesById.size
    dcel.rechainEdge(dcel.findHalfEdge(p1, v3).id, [])
    return dcel._halfEdgesById.size === before
  })())

  check('rechainEdge throws on an unknown half-edge id', (() => {
    try { dcel.rechainEdge(999999, [v3]); return false } catch { return true }
  })())

  check('rechainEdge throws when a new directed pair already exists elsewhere', (() => {
    // p4->p1 is a real existing boundary edge; routing p3->p4's edge through p1 would
    // collide with it.
    const he34 = dcel.findHalfEdge(p3, p4)
    try { dcel.rechainEdge(he34.id, [p1]); return false } catch { return true }
  })())
}

// ── Test: deleteDanglingEdge on a standalone void-void chain ────────────────────────
// See plan "logical-booping-bonbon" §2(e) — pruneAcuteStubs/removeOrphanComponents'
// DCEL-native replacement. A real street-graph stub has no face on EITHER side (streets
// aren't faces at all until buildJunctions closes gutters downstream), so this is built
// directly via the same low-level mint/link calls insertFace itself uses internally —
// not through insertFace, which always produces a real face on one side.
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  const p6 = reg.create(20, 0, 0, 'street').id
  const p7 = reg.create(21, 0, 0, 'street').id
  const p8 = reg.create(22, 0, 0, 'street').id

  const he67 = dcel._mintHalfEdge(p6, null), he76 = dcel._mintHalfEdge(p7, null)
  he67.twin = he76.id; he76.twin = he67.id
  dcel._heByDirectedPair.set(`${p6},${p7}`, he67.id)
  dcel._heByDirectedPair.set(`${p7},${p6}`, he76.id)

  const he78 = dcel._mintHalfEdge(p7, null), he87 = dcel._mintHalfEdge(p8, null)
  he78.twin = he87.id; he87.twin = he78.id
  dcel._heByDirectedPair.set(`${p7},${p8}`, he78.id)
  dcel._heByDirectedPair.set(`${p8},${p7}`, he87.id)

  // Chain the forward walk p6->p7->p8 (he67.next = he78) and the reverse walk
  // p8->p7->p6 (he87.next = he76) — exactly what rechainEdge itself produces for a
  // multi-hop void chain.
  he67.next = he78.id; he78.prev = he67.id
  he87.next = he76.id; he76.prev = he87.id
  dcel._setVertexAnchor(p6, he67.id)
  dcel._setVertexAnchor(p7, he78.id)   // p7's anchor deliberately set to the segment being pruned
  dcel._setVertexAnchor(p8, he87.id)

  dcel.deleteDanglingEdge(he78.id)

  check('deleted half-edge no longer resolves (forward)', dcel.getHalfEdge(he78.id) === undefined)
  check('deleted half-edge no longer resolves (twin)', dcel.getHalfEdge(he87.id) === undefined)
  check('p7->p8 directed pair gone', dcel.findHalfEdge(p7, p8) === null)
  check('p8->p7 directed pair gone', dcel.findHalfEdge(p8, p7) === null)
  check('remaining p6->p7 segment survives, now a true dead end (.next cleared)', dcel.getHalfEdge(he67.id)?.next === null)
  check('remaining p7->p6 segment survives, .prev cleared', dcel.getHalfEdge(he76.id)?.prev === null)
  check("p7's anchor (was the deleted segment) re-pointed to the surviving he76", reg.get(p7).halfEdge === he76.id)
  check('p8 is now fully isolated (anchor -> null, no other edge originates there)', reg.get(p8).halfEdge === null)

  check('throws deleting an edge with a real face on one side', (() => {
    const a = reg.create(0, 100, 0).id, b = reg.create(1, 100, 0).id
    const c = reg.create(1, 101, 0).id, d = reg.create(0, 101, 0).id
    dcel.insertFace([a, b, c, d], 'terrain-plot', {})
    const heAB = dcel.findHalfEdge(a, b)
    try { dcel.deleteDanglingEdge(heAB.id); return false } catch { return true }
  })())

  check('throws on an unknown half-edge id', (() => {
    try { dcel.deleteDanglingEdge(999999); return false } catch { return true }
  })())
}

// ── Test: insertEdge — raw graph edges usable by rechainEdge/deleteDanglingEdge ────
{
  const reg = new GroundPointRegistry()
  const dcel = new DCEL(reg)
  const a = reg.create(0, 0, 0, 'street').id
  const b = reg.create(1, 0, 0, 'street').id
  const c = reg.create(2, 0, 0, 'street').id

  const he = dcel.insertEdge(a, b)
  check('insertEdge returns the a->b half-edge', he.origin === a)
  check('insertEdge mints a void twin', dcel.getHalfEdge(he.twin)?.face === null)
  check('insertEdge leaves the forward side void too', he.face === null)
  check('a->b is findable', dcel.findHalfEdge(a, b)?.id === he.id)
  check('b->a is findable', dcel.findHalfEdge(b, a)?.id === he.twin)
  check('no next/prev linkage yet (forward)', he.next === null && he.prev === null)
  check('no next/prev linkage yet (twin)', dcel.getHalfEdge(he.twin).next === null && dcel.getHalfEdge(he.twin).prev === null)
  check("a's anchor points at the new edge", reg.get(a).halfEdge === he.id)
  check("b's anchor points at the new edge's twin", reg.get(b).halfEdge === he.twin)

  check('throws inserting a duplicate directed pair', (() => {
    try { dcel.insertEdge(a, b); return false } catch { return true }
  })())
  check('throws inserting the reverse of an existing pair', (() => {
    try { dcel.insertEdge(b, a); return false } catch { return true }
  })())

  // A lone insertEdge'd segment (both sides void, no next/prev) is exactly the shape
  // deleteDanglingEdge expects — confirms the two primitives compose without any extra
  // manual wiring, unlike the hand-built fixtures earlier in this file.
  dcel.deleteDanglingEdge(he.id)
  check('deleteDanglingEdge accepts a bare insertEdge result', dcel.getHalfEdge(he.id) === undefined)
  check("a's anchor cleared (fully isolated)", reg.get(a).halfEdge === null)
  check("b's anchor cleared (fully isolated)", reg.get(b).halfEdge === null)

  // rechainEdge splicing an insertEdge'd segment through an intermediate vertex — the
  // other half of the "raw graph edge, no face" contract.
  const he2 = dcel.insertEdge(b, c)
  dcel.rechainEdge(he2.id, [])   // empty chain is documented as a no-op
  check('rechainEdge([]) is a no-op', dcel.findHalfEdge(b, c)?.id === he2.id)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
