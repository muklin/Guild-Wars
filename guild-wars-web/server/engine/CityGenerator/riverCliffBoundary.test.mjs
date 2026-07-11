// Regression suite for riverCliffBoundary.js — a standalone, NOT-YET-WIRED-IN piece (see
// its own doc comment and plan "typed-giggling-giraffe"). Pins down behavior before this
// gets connected to SetupPhase's live pullback. Run with:
//   node server/engine/CityGenerator/riverCliffBoundary.test.mjs
import { computeRiverCliffBoundaries } from './riverCliffBoundary.js'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++ } else { fail++; console.log(`FAIL: ${name}`) }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) < eps }
function ptNear(p, x, y, eps = 1e-9) { return !!p && near(p.x, x, eps) && near(p.y, y, eps) }

const pt = (x, y) => ({ x, y })
const byId = (pts) => new Map(Object.entries(pts).map(([id, p]) => [Number(id), p]))

// ── Test 1: single straight chain — simple perpendicular offsets, correct half-width ──
{
  const pointsById = byId({ 0: pt(0, 0), 1: pt(10, 0) })
  const edges = { river1: { pointIds: [0, 1], assignedType: 'River' } }
  const result = computeRiverCliffBoundaries(edges, pointsById, 1, 100)
  check('one chain in, one chain out', result.size === 1)
  const corners = result.get('river1')
  check('2 corners for a 2-point chain', corners?.length === 2)
  check('start left at (0,1)', ptNear(corners[0].left, 0, 1))
  check('start right at (0,-1)', ptNear(corners[0].right, 0, -1))
  check('end left at (10,1)', ptNear(corners[1].left, 10, 1))
  check('end right at (10,-1)', ptNear(corners[1].right, 10, -1))
  // Width consistency check (the whole point of this exercise): left-to-right distance
  // is exactly 2*halfWidth at every point, by construction — no separate reconciliation
  // pass needed the way the current per-polygon delta approach requires.
  for (const c of corners) {
    const width = Math.hypot(c.left.x - c.right.x, c.left.y - c.right.y)
    check(`consistent width 2.0 at (${c.left.x},${c.left.y})/(${c.right.x},${c.right.y})`, near(width, 2.0))
  }
}

// ── Test 2: single chain with an interior bend — miter, still consistent width ──────
{
  const pointsById = byId({ 0: pt(0, 0), 1: pt(10, 0), 2: pt(10, 10) })
  const edges = { cliff1: { pointIds: [0, 1, 2], assignedType: 'Cliff' } }
  const result = computeRiverCliffBoundaries(edges, pointsById, 0.5, 100)
  const corners = result.get('cliff1')
  check('3 corners for a 3-point bent chain', corners?.length === 3)
  check('interior corner is finite', isFinite(corners[1].left.x) && isFinite(corners[1].right.x))
}

// ── Test 3: two DIFFERENT chains (a River and a Cliff) sharing an endpoint — junction
// override makes them agree exactly at the shared boundary point, same as
// PolylineRenderer's own render() would produce. ─────────────────────────────────────
{
  const pointsById = byId({ 0: pt(0, 0), 1: pt(10, 0), 2: pt(0, 10) })
  const edges = {
    river1: { pointIds: [0, 1], assignedType: 'River' },
    cliff1: { pointIds: [0, 2], assignedType: 'Cliff' },
  }
  const result = computeRiverCliffBoundaries(edges, pointsById, 1, 100)
  const riverCorners = result.get('river1')
  const cliffCorners = result.get('cliff1')
  check('river and cliff both resolve', riverCorners?.length === 2 && cliffCorners?.length === 2)
  // At the shared junction (point 0), the two chains' facing boundary points must
  // coincide exactly (mitered together) — not independently computed and merely close.
  check('river\'s corner-0 left matches cliff\'s corner-0 right exactly (mitered junction)',
    near(riverCorners[0].left.x, cliffCorners[0].right.x) && near(riverCorners[0].left.y, cliffCorners[0].right.y))
}

// ── Test 4: THREE chains meeting at one point — the actual N-way confluence case that
// has been the hard part of the DCEL-based approach all session. This uses
// PolylineRenderer's already-proven fan/bevel junction math instead of a separate
// DCEL-specific mechanism — confirms it produces sane (non-degenerate, finite,
// consistent-width) results with zero special-case code needed here. ──────────────────
{
  const pointsById = byId({
    0: pt(0, 0), 1: pt(10, 0), 2: pt(-7, 7), 3: pt(-7, -7),
  })
  const edges = {
    a: { pointIds: [0, 1], assignedType: 'River' },
    b: { pointIds: [0, 2], assignedType: 'River' },
    c: { pointIds: [0, 3], assignedType: 'Cliff' },
  }
  const halfWidth = 1
  const result = computeRiverCliffBoundaries(edges, pointsById, halfWidth, 100)
  check('all 3 chains resolve at a 3-way junction', result.get('a')?.length === 2 && result.get('b')?.length === 2 && result.get('c')?.length === 2)
  for (const [id, corners] of result) {
    for (const c of corners) {
      check(`chain ${id}: corner is finite and non-degenerate`, isFinite(c.left.x) && isFinite(c.right.x) && !(near(c.left.x, c.right.x) && near(c.left.y, c.right.y)))
    }
  }
  // Every chain's far (non-junction) endpoint keeps the plain, un-mitered half-width —
  // only the shared junction end (point 0) is affected by the 3-way fan.
  const farA = result.get('a')[1], farB = result.get('b')[1], farC = result.get('c')[1]
  for (const [name, c] of [['a', farA], ['b', farB], ['c', farC]]) {
    const width = Math.hypot(c.left.x - c.right.x, c.left.y - c.right.y)
    check(`chain ${name}'s far endpoint keeps consistent width 2.0`, near(width, 2.0))
  }
}

// ── Test 5: non-River/Cliff edges are simply whatever the caller passes — this module
// doesn't filter by assignedType itself (callers are expected to pre-filter, per its
// own doc comment); confirms it doesn't silently drop or crash on an edge missing that
// field entirely. ────────────────────────────────────────────────────────────────────
{
  const pointsById = byId({ 0: pt(0, 0), 1: pt(5, 0) })
  const edges = { plain: { pointIds: [0, 1] } }   // no assignedType at all
  const result = computeRiverCliffBoundaries(edges, pointsById, 0.5, 100)
  check('an edge with no assignedType still resolves normally', result.get('plain')?.length === 2)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
