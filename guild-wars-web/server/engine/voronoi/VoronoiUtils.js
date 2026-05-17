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

// Full pipeline: seeds → Delaunay → circumcenters per seed → angle-sort → clip.
// Returns [{seedPoint: {x,y}, polygon: [{x,y}]}] — degenerate cells omitted.
// Use this when a known bounding polygon exists (district, world bbox, etc.).
export function computeVoronoiCells(seeds, clipPolygon) {
  const points = seeds.map(s => new Point(s.x, s.y))
  const triangulator = DelaunayTriangulator.createFromPoints(points)

  const vertexTris = new Map()
  for (const tri of triangulator.triangulation) {
    for (const v of tri.vertices) {
      if (!vertexTris.has(v._id)) vertexTris.set(v._id, [])
      vertexTris.get(v._id).push(tri)
    }
  }

  const cells = []
  for (let i = 0; i < points.length; i++) {
    const seed = seeds[i], point = points[i]
    const corners = (vertexTris.get(point._id) || [])
      .filter(t => t.circumcenter)
      .map(t => ({ x: t.circumcenter.x, y: t.circumcenter.y }))
    if (corners.length < 3) continue
    corners.sort((a, b) =>
      Math.atan2(a.y - seed.y, a.x - seed.x) - Math.atan2(b.y - seed.y, b.x - seed.x)
    )
    const polygon = clipToPolygon(corners, clipPolygon)
    if (polygon) cells.push({ seedPoint: seed, polygon })
  }
  return cells
}
