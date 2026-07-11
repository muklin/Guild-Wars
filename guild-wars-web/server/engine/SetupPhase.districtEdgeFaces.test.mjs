// Spec for _assembleDistrictEdgeFacePoints (ADR-0020 Stage C, plan
// "typed-giggling-giraffe" Addendum 2) — written BEFORE the implementation, per
// explicit instruction: these must be RED against the current stub, then implemented
// to turn GREEN. Run with:
//   node server/engine/SetupPhase.districtEdgeFaces.test.mjs
import SetupPhase from './SetupPhase.js'

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
{
  const chain = [
    { gutterLeft: { x: 0, y: 0 }, gutterRight: { x: 0, y: 1 } },
    { gutterLeft: { x: 5, y: 5 }, gutterRight: { x: 6, y: 5 } },   // bend
    { gutterLeft: { x: 10, y: 10 }, gutterRight: { x: 10, y: 11 } },
  ]
  const poly = assemble(chain)
  check('bent 3-junction chain produces exactly 6 points', poly?.length === 6)
  check('order is left[0..2] then right[2..0] reversed', poly && JSON.stringify(poly) === JSON.stringify([
    { x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 },
    { x: 10, y: 11 }, { x: 6, y: 5 }, { x: 0, y: 1 },
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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
