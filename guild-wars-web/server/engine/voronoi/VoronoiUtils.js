// ── Primitive geometry ────────────────────────────────────────────────────────

export function pip(px, py, polygon) {
  let inside = false
  const n = polygon.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y, xj = polygon[j].x, yj = polygon[j].y
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

// Squared distance from point (px,py) to segment (ax,ay)–(bx,by).
export function distToSegSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return (px - ax) ** 2 + (py - ay) ** 2
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
}

// Axis-aligned bounding box of a vertex array, returned as a 4-point polygon.
export function polygonBBox(vertices) {
  const xs = vertices.map(v => v.x), ys = vertices.map(v => v.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  return [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]
}

// Minimum distance from point (px,py) to any edge of polygon.
export function distToPolygonBoundary(px, py, polygon) {
  let best = Infinity
  const n = polygon.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = Math.sqrt(distToSegSq(px, py, polygon[j].x, polygon[j].y, polygon[i].x, polygon[i].y))
    if (d < best) best = d
  }
  return best
}

// Nearest point on the polygon boundary to (px,py).
export function projectToPolygon(px, py, polygon) {
  let bestDist = Infinity, bestX = px, bestY = py
  const n = polygon.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = polygon[j].x, ay = polygon[j].y, bx = polygon[i].x, by = polygon[i].y
    const dx = bx - ax, dy = by - ay
    const lenSq = dx * dx + dy * dy
    if (lenSq === 0) continue
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
    const cx = ax + t * dx, cy = ay + t * dy
    const d = Math.hypot(px - cx, py - cy)
    if (d < bestDist) { bestDist = d; bestX = cx; bestY = cy }
  }
  return { x: bestX, y: bestY }
}

// Strictly-interior segment intersection (excludes endpoints within eps).
// Returns {x, y, t, s} where t is parameter along AB, s along CD; null otherwise.
export function segIntersect(a, b, c, d) {
  const r1x = b.x - a.x, r1y = b.y - a.y
  const r2x = d.x - c.x, r2y = d.y - c.y
  const denom = r1x * r2y - r1y * r2x
  if (Math.abs(denom) < 1e-12) return null
  const sx = c.x - a.x, sy = c.y - a.y
  const t = (sx * r2y - sy * r2x) / denom
  const s = (sx * r1y - sy * r1x) / denom
  const eps = 1e-6
  if (t < eps || t > 1 - eps || s < eps || s > 1 - eps) return null
  return { x: a.x + t * r1x, y: a.y + t * r1y, t, s }
}

// ── Polygon clipping ──────────────────────────────────────────────────────────

// Sutherland-Hodgman clip of `subject` polygon against convex `clip` polygon.
// Uses centroid to determine "inside" so winding order of clip polygon doesn't matter.
export function clipToPolygon(subject, clip) {
  const n = clip.length
  const cx = clip.reduce((s, v) => s + v.x, 0) / n
  const cy = clip.reduce((s, v) => s + v.y, 0) / n
  let out = [...subject]
  for (let i = 0; i < n && out.length > 0; i++) {
    const A = clip[i], B = clip[(i + 1) % n]
    const ABx = B.x - A.x, ABy = B.y - A.y
    const cSide = ABx * (cy - A.y) - ABy * (cx - A.x)
    const inside = p => (ABx * (p.y - A.y) - ABy * (p.x - A.x)) * cSide >= 0
    const intersect = (P, Q) => {
      const dx = Q.x - P.x, dy = Q.y - P.y
      const denom = ABx * dy - ABy * dx
      if (Math.abs(denom) < 1e-10) return P
      const t = (ABy * (P.x - A.x) - ABx * (P.y - A.y)) / denom
      return { x: P.x + t * dx, y: P.y + t * dy }
    }
    const inp = out; out = []
    for (let j = 0; j < inp.length; j++) {
      const cur = inp[j], prev = inp[(j + inp.length - 1) % inp.length]
      const ci = inside(cur), pi = inside(prev)
      if (ci) { if (!pi) out.push(intersect(prev, cur)); out.push(cur) }
      else if (pi) out.push(intersect(prev, cur))
    }
  }
  return out.length >= 3 ? out : null
}

// Compute the Voronoi vertex position for a triangle under a given metric.
// 'euclidean': exact circumcenter (equidistant under L2)
// 'chebyshev': bounding-box midpoint in original space → cells tend toward squares (approx L∞)
// 'manhattan': bounding-box midpoint in 45°-rotated space, transformed back → cells tend toward diamonds (approx L1)
// 'centroid':  triangle centroid → smoother, more uniform cells
export function triangleCenter(tri, metric) {
  const [v0, v1, v2] = tri.vertices
  if (metric === 'euclidean') {
    const c = tri.circumcenter
    return c ? { x: c.x, y: c.y } : null
  }
  if (metric === 'centroid') {
    return { x: (v0.x + v1.x + v2.x) / 3, y: (v0.y + v1.y + v2.y) / 3 }
  }
  if (metric === 'chebyshev') {
    const minX = Math.min(v0.x, v1.x, v2.x), maxX = Math.max(v0.x, v1.x, v2.x)
    const minY = Math.min(v0.y, v1.y, v2.y), maxY = Math.max(v0.y, v1.y, v2.y)
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  }
  if (metric === 'manhattan') {
    // Transform: T(x,y) = (x+y, x-y). L1 dist in original = L∞ dist in T-space.
    // Find bbox midpoint in T-space, then invert: T⁻¹(u,v) = ((u+v)/2, (u-v)/2).
    const us = [v0.x + v0.y, v1.x + v1.y, v2.x + v2.y]
    const vs = [v0.x - v0.y, v1.x - v1.y, v2.x - v2.y]
    const uc = (Math.min(...us) + Math.max(...us)) / 2
    const vc = (Math.min(...vs) + Math.max(...vs)) / 2
    return { x: (uc + vc) / 2, y: (uc - vc) / 2 }
  }
  return null
}

// Generate seeds on a regular grid covering `polygon`, with per-point jitter.
// density:  seeds per unit area  (controls grid spacing)
// xyRatio:  dx/dy spacing ratio  (>1 = wider columns, <1 = taller rows; 1 = square)
// jitter:   max displacement as fraction of the respective axis spacing  (0 = rigid grid)
// rngSeed:  integer seed for the deterministic RNG
export function generateGridSeeds(polygon, density, xyRatio = 1.0, jitter = 0.3, rngSeed = 0) {
  let s = (rngSeed * 2654435761) >>> 0
  const rng = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0x100000000 }

  // dx·dy = 1/density, dx/dy = xyRatio
  const dx = Math.sqrt(xyRatio / density)
  const dy = Math.sqrt(1 / (density * xyRatio))
  const jx = dx * jitter
  const jy = dy * jitter

  const xs = polygon.map(v => v.x), ys = polygon.map(v => v.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)

  const seeds = []
  for (let gx = minX; gx <= maxX + dx; gx += dx) {
    for (let gy = minY; gy <= maxY + dy; gy += dy) {
      const x = gx + (rng() - 0.5) * 2 * jx
      const y = gy + (rng() - 0.5) * 2 * jy
      if (pip(x, y, polygon)) seeds.push({ x, y })
    }
  }
  return seeds
}

// Clip convex `poly` to the half-plane { p : nx·p.x + ny·p.y <= d }.
// Returns the clipped polygon, or null if nothing (≥3 verts) remains.
function clipHalfPlane(poly, nx, ny, d) {
  const out = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const A = poly[i], B = poly[(i + 1) % n]
    const da = nx * A.x + ny * A.y - d
    const db = nx * B.x + ny * B.y - d
    const inA = da <= 1e-12, inB = db <= 1e-12
    if (inA) out.push(A)
    if (inA !== inB) {
      const t = da / (da - db)
      out.push({ x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y) })
    }
  }
  return out.length >= 3 ? out : null
}

// Robust Euclidean Voronoi via half-plane intersection. Each seed's cell is
// `clipPolygon` clipped by the perpendicular bisector against every other seed.
// `clipPolygon` may be convex or concave — clipHalfPlane is a single half-plane
// S-H step that works on any input polygon. Unlike computeVoronoiCells (Delaunay
// circumcenters), this is exact for collinear / near-collinear seeds and always
// tiles clipPolygon with no gaps or dropped cells — ideal for boundary-seeded
// plot subdivision. O(n²) per diagram; intended for small seed counts.
// Returns [{seedPoint: {x,y}, polygon: [{x,y}]}].
export function computeVoronoiCellsHalfPlane(seeds, clipPolygon) {
  // Dedupe coincident seeds: identical points have no bisector and would yield
  // overlapping cells.
  const uniq = []
  const seen = new Set()
  for (const s of seeds) {
    const key = `${s.x.toFixed(6)},${s.y.toFixed(6)}`
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(s)
  }

  const cells = []
  const n = uniq.length
  for (let i = 0; i < n; i++) {
    const s = uniq[i]
    let cell = clipPolygon.map(p => ({ x: p.x, y: p.y }))
    for (let j = 0; j < n && cell; j++) {
      if (j === i) continue
      const o = uniq[j]
      const nx = o.x - s.x, ny = o.y - s.y
      const d = nx * (s.x + o.x) / 2 + ny * (s.y + o.y) / 2
      cell = clipHalfPlane(cell, nx, ny, d)
    }
    if (cell) cells.push({ seedPoint: s, polygon: cell })
  }
  return cells
}

// ── Shared polygon clipping utilities (used by PlotVoronoiGenerator + TerrainPlotConverter) ──

// True if any edge of `poly` properly crosses segment (c,d) — interior
// crossing only (shared endpoints / grazing touches don't count).
export function polygonCrossesSegment(poly, c, d) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const r1x = b.x - a.x, r1y = b.y - a.y, r2x = d.x - c.x, r2y = d.y - c.y
    const den = r1x * r2y - r1y * r2x
    if (Math.abs(den) < 1e-12) continue
    const sx = c.x - a.x, sy = c.y - a.y
    const t = (sx * r2y - sy * r2x) / den
    const u = (sx * r1y - sy * r1x) / den
    if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) return true
  }
  return false
}

// Clip `poly` to the half-plane bounded by the infinite line through (la, lb)
// that contains `ref`. Works on convex or concave polygons. Returns the clipped
// polygon (≥3 verts) or null.
export function clipPolygonToSide(poly, la, lb, ref) {
  const nx = -(lb.y - la.y), ny = (lb.x - la.x)
  const side = (p) => nx * (p.x - la.x) + ny * (p.y - la.y)
  const sRef = side(ref)
  if (sRef === 0) return poly
  const out = []
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length]
    const dA = side(A), dB = side(B)
    const inA = dA * sRef >= -1e-9
    if (inA) out.push(A)
    if ((dA < 0) !== (dB < 0)) {
      const t = dA / (dA - dB)
      out.push({ x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y) })
    }
  }
  return out.length >= 3 ? out : null
}

// Clip a (possibly concave) subject polygon by a convex clip polygon.
// Unlike Sutherland–Hodgman, concave splits produce SEPARATE pieces rather than
// being bridged across the notch — the only correct behaviour for concave subjects.
// convexClip must be convex (any winding; centroid determines inside).
// Returns an array of polygon pieces (may be empty). Slivers (area < 1e-6) are discarded.
export function clipPolygonByConvex(subject, convexClip) {
  const nc = convexClip.length
  if (nc < 3 || subject.length < 3) return []

  const ccx = convexClip.reduce((s, v) => s + v.x, 0) / nc
  const ccy = convexClip.reduce((s, v) => s + v.y, 0) / nc

  let pieces = [subject]

  for (let e = 0; e < nc && pieces.length > 0; e++) {
    const A = convexClip[e], B = convexClip[(e + 1) % nc]
    const ABx = B.x - A.x, ABy = B.y - A.y
    const cSide = ABx * (ccy - A.y) - ABy * (ccx - A.x)
    if (Math.abs(cSide) < 1e-12) continue

    const next = []
    for (const piece of pieces) {
      const clipped = _clipByHalfEdge(piece, A, ABx, ABy, cSide)
      for (const c of clipped) next.push(c)
    }
    pieces = next
  }

  const MIN_AREA = 1e-6
  return pieces.filter(p => {
    let a = 0
    for (let i = 0; i < p.length; i++) {
      const pi = p[i], qi = p[(i + 1) % p.length]
      a += pi.x * qi.y - qi.x * pi.y
    }
    return Math.abs(a) * 0.5 >= MIN_AREA
  })
}

// Clip one simple polygon by one half-plane edge; returns 0–many polygon pieces.
// "Inside" is the side of the line through A with direction (ABx,ABy) that contains the
// clip centroid (cSide > 0 → left side, cSide < 0 → right side).
//
// The inside boundary breaks into one or more arcs (entry-crossing → inside verts →
// exit-crossing). They must be stitched back together ALONG the clip line: each exit
// connects to the entry that is adjacent along the line and whose joining segment lies
// inside the polygon (the inside line-run). Closing each arc by its OWN chord instead
// (exit→entry of the same arc) is wrong whenever a notch makes the crossings interleave
// along the line — the chord then runs outside the block, leaking the plot across the
// gutter. With a single arc the chord IS the only inside line-run, so that case is exact.
function _clipByHalfEdge(poly, A, ABx, ABy, cSide) {
  const EPS = 1e-9
  const n = poly.length
  if (n < 3) return []

  const score = p => { const s = ABx * (p.y - A.y) - ABy * (p.x - A.x); return cSide > 0 ? s : -s }
  const tAlong = (x, y) => ABx * (x - A.x) + ABy * (y - A.y)   // param along the clip line
  const sc = poly.map(score)
  const ins = sc.map(s => s >= -EPS)

  if (ins.every(Boolean)) return [poly]
  if (ins.every(v => !v)) return []

  // Collect inside arcs. Starting at an outside vertex makes every arc a clean
  // entry → inside-verts → exit run.
  let start = 0
  for (let i = 0; i < n; i++) { if (!ins[i]) { start = i; break } }
  const arcs = []   // { pts:[...], entryT, exitT }
  let arc = null
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n, j = (start + k + 1) % n
    const Av = poly[i], Bv = poly[j]
    const inA = ins[i], inB = ins[j]
    if (!inA && inB) {                                   // entry crossing → new arc
      const t = sc[i] / (sc[i] - sc[j])
      const e = { x: Av.x + t * (Bv.x - Av.x), y: Av.y + t * (Bv.y - Av.y) }
      arc = { pts: [e], entryT: tAlong(e.x, e.y), exitT: 0 }
    } else if (inA && !inB) {                            // exit crossing → close arc
      if (arc) {
        arc.pts.push({ x: Av.x, y: Av.y })
        const t = sc[i] / (sc[i] - sc[j])
        const e = { x: Av.x + t * (Bv.x - Av.x), y: Av.y + t * (Bv.y - Av.y) }
        arc.pts.push(e); arc.exitT = tAlong(e.x, e.y)
        arcs.push(arc); arc = null
      }
    } else if (inA && inB && arc) {                      // interior vertex
      arc.pts.push({ x: Av.x, y: Av.y })
    }
  }
  if (!arcs.length) return []
  if (arcs.length === 1) return arcs[0].pts.length >= 3 ? [arcs[0].pts] : []

  // Stitch: each arc's exit joins the entry adjacent along the clip line whose midpoint
  // segment lies inside the polygon (the inside line-run) — robust to interleaving.
  const ends = []
  arcs.forEach((a, ai) => {
    ends.push({ t: a.entryT, kind: 0, ai, x: a.pts[0].x, y: a.pts[0].y })
    ends.push({ t: a.exitT,  kind: 1, ai, x: a.pts[a.pts.length - 1].x, y: a.pts[a.pts.length - 1].y })
  })
  ends.sort((p, q) => p.t - q.t)
  const nextArc = new Map()
  for (let i = 0; i < ends.length; i++) {
    if (ends[i].kind !== 1) continue                     // start from an exit
    for (const ni of [i + 1, i - 1]) {
      const c = ends[ni]
      if (!c || c.kind !== 0) continue
      if (pip((ends[i].x + c.x) / 2, (ends[i].y + c.y) / 2, poly)) { nextArc.set(ends[i].ai, c.ai); break }
    }
  }

  const used = new Set(), out = []
  for (let s = 0; s < arcs.length; s++) {
    if (used.has(s)) continue
    const loop = []
    let ai = s, guard = 0
    while (ai != null && !used.has(ai) && guard++ <= arcs.length) {
      used.add(ai)
      for (const p of arcs[ai].pts) loop.push(p)
      ai = nextArc.get(ai)
    }
    if (loop.length >= 3) out.push(loop)
  }
  return out
}
