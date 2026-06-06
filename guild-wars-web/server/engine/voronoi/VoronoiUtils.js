import Point from './Point.js'
import DelaunayTriangulator from './DelaunayTriangulator.js'

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

// True if point (px,py) lies on segment (ax,ay)–(bx,by) within `tol`.
export function ptOnSeg(px, py, ax, ay, bx, by, tol = 1e-4) {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-12) return Math.hypot(px - ax, py - ay) < tol
  const t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  if (t < -0.02 || t > 1.02) return false
  return Math.hypot(px - ax - t * dx, py - ay - t * dy) < tol
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

// Compute the intersection of two simple polygons.
// `subject` should be convex (Voronoi cell). `clip` may be non-convex.
// Strategy: collect all candidate points (subject verts inside clip, clip verts inside
// subject, edge–edge intersections), then angle-sort around their centroid.
// Correct for any star-shaped intersection; degenerate concave intersections may produce
// slightly incorrect shapes, but never crashes and never drops cells entirely.
export function intersectPolygons(subject, clip) {
  const n_s = subject.length, n_c = clip.length
  if (n_s < 3 || n_c < 3) return null

  const segSeg = (ax, ay, bx, by, cx, cy, dx, dy) => {
    const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy
    const d = rx * sy - ry * sx
    if (Math.abs(d) < 1e-12) return null
    const t = ((cx - ax) * sy - (cy - ay) * sx) / d
    const u = ((cx - ax) * ry - (cy - ay) * rx) / d
    if (t < 0 || t > 1 || u < 0 || u > 1) return null
    return { x: ax + t * rx, y: ay + t * ry }
  }

  const pts = []
  for (const v of subject) { if (pip(v.x, v.y, clip))    pts.push(v) }
  for (const v of clip)    { if (pip(v.x, v.y, subject)) pts.push(v) }
  for (let i = 0; i < n_s; i++) {
    const sa = subject[i], sb = subject[(i + 1) % n_s]
    for (let j = 0; j < n_c; j++) {
      const ca = clip[j], cb = clip[(j + 1) % n_c]
      const p = segSeg(sa.x, sa.y, sb.x, sb.y, ca.x, ca.y, cb.x, cb.y)
      if (p) pts.push(p)
    }
  }

  if (pts.length < 3) return null

  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))

  const EPS_SQ = 1e-10
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = out[out.length - 1]
    if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 > EPS_SQ) out.push(p)
  }
  const last = out[out.length - 1], first = out[0]
  if ((last.x - first.x) ** 2 + (last.y - first.y) ** 2 <= EPS_SQ) out.pop()

  return out.length >= 3 ? out : null
}

// Full pipeline: seeds → Delaunay → cell vertices per seed → angle-sort → clip.
// Returns [{seedPoint: {x,y}, polygon: [{x,y}]}] — degenerate cells omitted.
// Use this when a known bounding polygon exists (district, world bbox, etc.).
// metric: 'euclidean' (default) | 'chebyshev' | 'manhattan' | 'centroid'
export function computeVoronoiCells(seeds, clipPolygon, metric = 'euclidean') {
  if (!seeds.length) return []

  // Add 3 super-seeds forming a large outer triangle so every real seed gets
  // ≥3 Delaunay triangles — boundary seeds otherwise produce no Voronoi cell.
  const xs = seeds.map(s => s.x).concat(clipPolygon.map(v => v.x))
  const ys = seeds.map(s => s.y).concat(clipPolygon.map(v => v.y))
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const pad = Math.max(maxX - minX, maxY - minY) * 3 + 1
  const n = seeds.length
  const allSeeds = [
    ...seeds,
    { x: (minX + maxX) / 2, y: minY - pad },
    { x: maxX + pad,        y: maxY + pad },
    { x: minX - pad,        y: maxY + pad },
  ]

  const points = allSeeds.map(s => new Point(s.x, s.y))
  const triangulator = DelaunayTriangulator.createFromPoints(points)

  const vertexTris = new Map()
  for (const tri of triangulator.triangulation) {
    for (const v of tri.vertices) {
      if (!vertexTris.has(v._id)) vertexTris.set(v._id, [])
      vertexTris.get(v._id).push(tri)
    }
  }

  const cells = []
  for (let i = 0; i < n; i++) {  // n = original seed count, excludes super-seeds
    const seed = seeds[i], point = points[i]
    const corners = []
    for (const tri of (vertexTris.get(point._id) || [])) {
      const c = triangleCenter(tri, metric)
      if (c) corners.push(c)
    }
    if (corners.length < 3) continue
    corners.sort((a, b) =>
      Math.atan2(a.y - seed.y, a.x - seed.x) - Math.atan2(b.y - seed.y, b.x - seed.x)
    )
    const polygon = clipToPolygon(corners, clipPolygon)
    if (polygon) cells.push({ seedPoint: seed, polygon })
  }
  return cells
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
// `clipPolygon` (must be convex — e.g. a bbox) clipped by the perpendicular
// bisector against every other seed. Unlike computeVoronoiCells (Delaunay
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
