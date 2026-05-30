import Point from './Point.js'
import DelaunayTriangulator from './DelaunayTriangulator.js'

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

  const pip = (px, py) => {
    let inside = false
    const n = polygon.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y, xj = polygon[j].x, yj = polygon[j].y
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
        inside = !inside
    }
    return inside
  }

  const seeds = []
  for (let gx = minX; gx <= maxX + dx; gx += dx) {
    for (let gy = minY; gy <= maxY + dy; gy += dy) {
      const x = gx + (rng() - 0.5) * 2 * jx
      const y = gy + (rng() - 0.5) * 2 * jy
      if (pip(x, y)) seeds.push({ x, y })
    }
  }
  return seeds
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
