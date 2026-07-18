// Spec for _assembleDistrictEdgeFacePoints (ADR-0020 Stage C, plan
// "typed-giggling-giraffe" Addendum 2) — written BEFORE the implementation, per
// explicit instruction: these must be RED against the current stub, then implemented
// to turn GREEN. Run with:
//   node server/engine/SetupPhase.districtEdgeFaces.test.mjs
import SetupPhase from './SetupPhase.js'
import GroundPointRegistry from './CityGenerator/GroundPointRegistry.js'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++ } else { fail++; console.log(`FAIL: ${name}`) }
}

function area(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y }
  return Math.abs(a) / 2
}

const assemble = (chain) => SetupPhase.prototype._assembleDistrictEdgeFacePoints(chain)

// Test 1: a straight 2-junction chain produces a 4-point quad, left points forward
// then right points reversed, forming a simple non-self-intersecting rectangle.
{
  const chain = [
    { gutterLeft: { x: 0, y: 0 }, gutterRight: { x: 0, y: 1 } },
    { gutterLeft: { x: 10, y: 0 }, gutterRight: { x: 10, y: 1 } },
  ]
  const poly = assemble(chain)
  check('straight chain produces exactly 4 points', poly?.length === 4)
  check('point order is left[0], left[1], right[1], right[0]', poly && JSON.stringify(poly) === JSON.stringify([
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 1 }, { x: 0, y: 1 },
  ]))
  check('resulting rectangle has area 10 (10 long x 1 wide)', poly && Math.abs(area(poly) - 10) < 1e-9)
  check('resulting polygon is simple (non-self-intersecting)', poly && !SetupPhase.prototype._polygonSelfIntersects(poly))
}

// Test 2: a 3-junction chain (one bend) produces a 6-point hexagon in the correct
// left-forward-then-right-reversed order, and stays a simple polygon.
//
// Fixture note: the original coordinates here ({6,5} as the bend's right gutter)
// produced a mathematically self-intersecting hexagon under the sole specified
// assembly algorithm (left-forward, right-reversed) — edges P0-P1 and P4-P5 crossed
// at (3,3), confirmed via _segmentsProperlyCross independent of any implementation
// choice, since this test also pins the exact expected point order. Replaced with a
// symmetric chevron bend (apex at the bend, uniform width-1 offset) that is provably
// simple while keeping the same intent (3 junctions, one genuine bend, 6 points).
{
  const chain = [
    { gutterLeft: { x: 0, y: 0 }, gutterRight: { x: 0, y: -1 } },
    { gutterLeft: { x: 5, y: 5 }, gutterRight: { x: 5, y: 4 } },   // bend
    { gutterLeft: { x: 10, y: 0 }, gutterRight: { x: 10, y: -1 } },
  ]
  const poly = assemble(chain)
  check('bent 3-junction chain produces exactly 6 points', poly?.length === 6)
  check('order is left[0..2] then right[2..0] reversed', poly && JSON.stringify(poly) === JSON.stringify([
    { x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 },
    { x: 10, y: -1 }, { x: 5, y: 4 }, { x: 0, y: -1 },
  ]))
  check('bent chain result is a simple polygon', poly && !SetupPhase.prototype._polygonSelfIntersects(poly))
}

// Test 3: degenerate inputs return null rather than a garbage/partial polygon.
{
  check('empty chain returns null', assemble([]) === null)
  check('single-junction chain returns null (need at least 2 to form a strip)', assemble([
    { gutterLeft: { x: 0, y: 0 }, gutterRight: { x: 0, y: 1 } },
  ]) === null)
  check('null input returns null, does not throw', assemble(null) === null)
}

// Test 4: a longer straight chain (4 junctions) still assembles into one clean strip,
// not per-segment quads — confirms the whole chain becomes ONE face, matching how
// _buildRiverCliffFaces assembles one face per whole chain, not per edge segment.
{
  const chain = [
    { gutterLeft: { x: 0, y: 0 }, gutterRight: { x: 0, y: 1 } },
    { gutterLeft: { x: 5, y: 0 }, gutterRight: { x: 5, y: 1 } },
    { gutterLeft: { x: 10, y: 0 }, gutterRight: { x: 10, y: 1 } },
    { gutterLeft: { x: 15, y: 0 }, gutterRight: { x: 15, y: 1 } },
  ]
  const poly = assemble(chain)
  check('4-junction straight chain produces exactly 8 points (one face, not per-segment)', poly?.length === 8)
  check('4-junction chain area is 15 (15 long x 1 wide)', poly && Math.abs(area(poly) - 15) < 1e-9)
  check('4-junction chain result is a simple polygon', poly && !SetupPhase.prototype._polygonSelfIntersects(poly))
}

// Test 5: _buildDistrictEdgeFaces orientation handling. A boundary chain's two ends
// walk the physical street graph in OPPOSITE local directions, so a junction's raw
// gutterLeft/gutterRight (computed relative to ITS OWN outgoing direction along a
// connection — see StreetVoronoiGenerator.buildJunctions) does not stay on one
// consistent absolute side by itself. This constructs a synthetic 3-junction bent Wall
// chain between districts 'A' and 'B' where: J1's connection is in the forward frame
// (left:'A'), the interior junction J2 has TWO connections matching this boundary (one
// back toward J1 in the REVERSED frame — left:'B' — one forward toward J3 — left:'A'),
// deliberately both resolving to the SAME shared corner (as a correctly-mitered
// straight-through junction would), and J3's connection is forward-frame again.
// Asserts the extraction still produces the exact same non-self-intersecting hexagon
// as Test 2's direct _assembleDistrictEdgeFacePoints call, regardless of which of J2's
// two matching connections _buildDistrictEdgeFaces happens to pick — proving the
// district-id-anchored canonicalization (not raw gutterLeft/gutterRight) is what
// determines each point's side.
{
  const streetGraph = {
    junctions: [
      { id: 1, connections: [
        { toId: 2, edgeKind: 'Wall', left: 'A', right: 'B', gutterLeft: { x: 0, y: 0 }, gutterRight: { x: 0, y: -1 } },
      ] },
      { id: 2, connections: [
        { toId: 1, edgeKind: 'Wall', left: 'B', right: 'A', gutterLeft: { x: 5, y: 4 }, gutterRight: { x: 5, y: 5 } },
        { toId: 3, edgeKind: 'Wall', left: 'A', right: 'B', gutterLeft: { x: 5, y: 5 }, gutterRight: { x: 5, y: 4 } },
      ] },
      { id: 3, connections: [
        { toId: 2, edgeKind: 'Wall', left: 'A', right: 'B', gutterLeft: { x: 10, y: 0 }, gutterRight: { x: 10, y: -1 } },
      ] },
    ],
  }
  const edges = { 'A-B': { assignedType: 'Wall', districtA: 'A', districtB: 'B' } }
  const fake = Object.create(SetupPhase.prototype)
  fake.gameStateManager = { pointRegistry: new GroundPointRegistry(), cityDistrictData: { streetGraph, edges } }
  const faces = fake._buildDistrictEdgeFaces()

  check('exactly one face built for the one Wall edge', faces.length === 1)
  const face = faces[0]
  check('face polygon matches the canonicalized hexagon (district-A side forward, district-B side reversed)',
    face && JSON.stringify(face.polygon) === JSON.stringify([
      { x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 },
      { x: 10, y: -1 }, { x: 5, y: 4 }, { x: 0, y: -1 },
    ]))
  check('face polygon is simple (non-self-intersecting)', face && !fake._polygonSelfIntersects(face.polygon))
  check('face carries sourceEdgeId back to the district edge key', face?.sourceEdgeId === 'A-B')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
