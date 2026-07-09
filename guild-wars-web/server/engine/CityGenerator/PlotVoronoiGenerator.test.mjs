// Regression suite for PlotVoronoiGenerator's DCEL-backed _mergeSmallPlots (see plan
// "typed-giggling-giraffe", DCEL Step 2). Run with:
//   node server/engine/CityGenerator/PlotVoronoiGenerator.test.mjs
import PlotVoronoiGenerator from './PlotVoronoiGenerator.js'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++ } else { fail++; console.log(`FAIL: ${name}`) }
}

function area(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y }
  return Math.abs(a) / 2
}

// 4 unit-square cells in a row, each sharing a full edge with the next. All undersized
// relative to minPlotSize=2.5, so the merge loop should coalesce them.
{
  const gen = new PlotVoronoiGenerator()
  const cells = [
    { polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
    { polygon: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }] },
    { polygon: [{ x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 1 }, { x: 2, y: 1 }] },
    { polygon: [{ x: 3, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }, { x: 3, y: 1 }] },
  ]
  const result = gen._mergeSmallPlots(cells, 2.5)
  const totalArea = result.reduce((s, c) => s + area(c.polygon), 0)
  check(`total area conserved exactly (got ${totalArea.toFixed(4)})`, Math.abs(totalArea - 4) < 1e-9)
  check('every survivor meets minPlotSize (or only one remains)',
    result.every(c => area(c.polygon) >= 2.5 - 1e-9) || result.length === 1)
}

// A single isolated cell with no neighbours passes through unchanged.
{
  const gen = new PlotVoronoiGenerator()
  const isolated = [{ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }]
  const result = gen._mergeSmallPlots(isolated, 2.5)
  check('single isolated cell passes through unchanged', result.length === 1 && Math.abs(area(result[0].polygon) - 1) < 1e-9)
}

// minPlotSize <= 0 or a single cell is a documented no-op.
{
  const gen = new PlotVoronoiGenerator()
  const cells = [{ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }]
  check('minPlotSize=0 is a no-op', gen._mergeSmallPlots(cells, 0) === cells)
}

// generate() must respect a block already flagged blockType:'single' by
// CityBlockGenerator's B3 self-intersecting-block quarantine — NOT attempt Voronoi
// subdivision on it (that gap was the actual cause of a live "extra black sliver
// appearing specifically during District conversion" bug — the block's own
// self-intersection check happens upstream in CityBlockGenerator, but PlotVoronoiGenerator's
// early-exit here only ever checked for 'square', never 'single').
{
  const gen = new PlotVoronoiGenerator()
  // A deliberately self-intersecting (bowtie) block, pre-flagged 'single' exactly as
  // CityBlockGenerator's B3 would have done — generate() must NOT subdivide it.
  const bowtie = [{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 2, y: 0 }, { x: 0, y: 2 }]
  const block = { id: 1, districtId: 1, blockCorners: bowtie, area: 2, streetEdges: [], blockType: 'single' }
  const result = gen.generate([block], [{ id: 1, assignedType: 'Residential' }], [], [])
  check('a block already flagged single produces exactly one whole-block plot', result.plots.length === 1)
  check('that plot keeps the original (unsubdivided) blockCorners', result.plots[0]?.blockCorners === bowtie)
  check('block.blockType is left as single, not overwritten to subdivided', block.blockType === 'single')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
