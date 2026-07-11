// Spec for resolveNodeRegistryIds (ADR-0020 Stage C, plan "typed-giggling-giraffe"
// Addendum 2) — written BEFORE the implementation, per explicit instruction: these
// must be RED against the current stub, then implemented to turn GREEN. Run with:
//   node server/engine/CityGenerator/StreetVoronoiGenerator.registryIds.test.mjs
import { resolveNodeRegistryIds } from './StreetVoronoiGenerator.js'
import GroundPointRegistry from './GroundPointRegistry.js'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++ } else { fail++; console.log(`FAIL: ${name}`) }
}

// Test 1: a node with a tracked source edgePoint id reuses that EXACT id — no new
// point minted, and the registry's point count doesn't grow.
{
  const reg = new GroundPointRegistry()
  const edgePt = reg.create(5, 5, 0, 'terrain')   // stands in for a real district-edge point
  const nodes = [{ id: 0, x: 5, y: 5 }]
  const source = new Map([[0, edgePt.id]])
  const before = reg.toJSON().length

  const result = resolveNodeRegistryIds(nodes, source, reg, 'street')

  check('reused id matches the tracked source id exactly', result.get(0) === edgePt.id)
  check('no new point was minted for a reused id', reg.toJSON().length === before)
}

// Test 2: a node with NO tracked source mints a fresh registry point at its own x,y.
{
  const reg = new GroundPointRegistry()
  const nodes = [{ id: 0, x: 12, y: -3 }]
  const source = new Map()   // nothing tracked

  const result = resolveNodeRegistryIds(nodes, source, reg, 'street')
  const newId = result.get(0)
  const pt = reg.get(newId)

  check('a fresh point was minted', typeof newId === 'number')
  check('the minted point sits at the node\'s own coordinates', pt?.x === 12 && pt?.y === -3)
  check('the minted point has the requested kind', pt?.kind === 'street')
}

// Test 3: two different local nodes tracking the SAME source edgePoint id both
// resolve to that same registry id (defensive — shouldn't normally happen, but must
// not crash or mint two conflicting points).
{
  const reg = new GroundPointRegistry()
  const edgePt = reg.create(1, 1, 0, 'terrain')
  const nodes = [{ id: 0, x: 1, y: 1 }, { id: 1, x: 1, y: 1 }]
  const source = new Map([[0, edgePt.id], [1, edgePt.id]])

  const result = resolveNodeRegistryIds(nodes, source, reg, 'street')
  check('both nodes resolve to the same shared source id', result.get(0) === edgePt.id && result.get(1) === edgePt.id)
}

// Test 4: a stale/dangling source reference (points at an id that no longer exists in
// the registry) falls back to minting fresh, rather than propagating an invalid id.
{
  const reg = new GroundPointRegistry()
  const nodes = [{ id: 0, x: 7, y: 8 }]
  const source = new Map([[0, 99999]])   // no such point in this registry

  const result = resolveNodeRegistryIds(nodes, source, reg, 'street')
  const pt = reg.get(result.get(0))
  check('dangling source reference falls back to a fresh mint', pt?.x === 7 && pt?.y === 8)
}

// Test 5: a mix of reused and freshly-minted nodes in one call resolves each correctly
// and independently — no cross-contamination between them.
{
  const reg = new GroundPointRegistry()
  const edgePt = reg.create(0, 0, 0, 'terrain')
  const nodes = [
    { id: 0, x: 0, y: 0 },     // reused
    { id: 1, x: 3, y: 4 },     // fresh
    { id: 2, x: -1, y: -2 },   // fresh
  ]
  const source = new Map([[0, edgePt.id]])

  const result = resolveNodeRegistryIds(nodes, source, reg, 'street')
  check('result has one entry per input node', result.size === 3)
  check('node 0 reused the edge point', result.get(0) === edgePt.id)
  const p1 = reg.get(result.get(1)), p2 = reg.get(result.get(2))
  check('node 1 minted fresh at its own position', p1?.x === 3 && p1?.y === 4)
  check('node 2 minted fresh at its own position', p2?.x === -1 && p2?.y === -2)
  check('node 1 and node 2 got DIFFERENT ids', result.get(1) !== result.get(2))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
