// Regression suite for CityBlockGenerator's DCEL-backed _mergeSquareClusters (see plan
// "typed-giggling-giraffe", DCEL Step 2). Run with:
//   node server/engine/CityGenerator/CityBlockGenerator.test.mjs
import CityBlockGenerator from './CityBlockGenerator.js'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++ } else { fail++; console.log(`FAIL: ${name}`) }
}

function area(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y }
  return Math.abs(a) / 2
}

// 3 unit-square blocks in a row, each separated by a thin "road face" strip:
// block0 (0,0)-(1,0)-(1,1)-(0,1), road01 (1..1.2), block1 (1.2..2.2), road12 (2.2..2.4),
// block2 (2.4..3.4).
{
  const gen = new CityBlockGenerator()
  const blocks = [
    { id: 0, districtId: 1, blockCorners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], area: 1, blockType: 'square' },
    { id: 1, districtId: 1, blockCorners: [{ x: 1.2, y: 0 }, { x: 2.2, y: 0 }, { x: 2.2, y: 1 }, { x: 1.2, y: 1 }], area: 1, blockType: 'square' },
    { id: 2, districtId: 1, blockCorners: [{ x: 2.4, y: 0 }, { x: 3.4, y: 0 }, { x: 3.4, y: 1 }, { x: 2.4, y: 1 }], area: 1, blockType: 'square' },
  ]
  const roadFacePolys = [
    [{ x: 1, y: 0 }, { x: 1.2, y: 0 }, { x: 1.2, y: 1 }, { x: 1, y: 1 }],
    [{ x: 2.2, y: 0 }, { x: 2.4, y: 0 }, { x: 2.4, y: 1 }, { x: 2.2, y: 1 }],
  ]
  // findStreetFacingEdges needs roadEdges near STREET_HALF_WIDTH of the merged
  // boundary or rule 2 (no street access) drops the whole cluster.
  const roadEdges = [{ nodeA: 'a', nodeB: 'b', ax: -1, ay: 0, bx: 5, by: 0, type: 'Brick', roadId: 'r1' }]

  gen._mergeSquareClusters(blocks, roadFacePolys, roadEdges)

  check('3 blocks collapse into 1 merged square', blocks.length === 1)
  const merged = blocks[0]
  check('merged block keeps blockType square', merged?.blockType === 'square')
  // The algorithm absorbs the connecting road strips too (that's the point — "removing
  // the streets between them and filling the combined area"): 3 unit blocks (3.0) + 2
  // connector strips (0.2 each = 0.4) = 3.4, not just 3.0.
  check(`merged area is exactly 3.4 (got ${area(merged?.blockCorners || []).toFixed(4)})`, Math.abs(area(merged?.blockCorners || []) - 3.4) < 1e-9)
}

// Two isolated (non-adjacent) squares with no connecting road face — nothing to merge.
{
  const gen = new CityBlockGenerator()
  const blocks = [
    { id: 0, districtId: 1, blockCorners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], area: 1, blockType: 'square' },
    { id: 1, districtId: 1, blockCorners: [{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 11, y: 11 }, { x: 10, y: 11 }], area: 1, blockType: 'square' },
  ]
  gen._mergeSquareClusters(blocks, [], [])
  check('no road faces -> no merge, both blocks survive unchanged', blocks.length === 2)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
