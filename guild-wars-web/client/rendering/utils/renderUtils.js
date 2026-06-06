// Shared geometry utility functions used across renderer classes.

// Ray-cast point-in-polygon test using the crossing-number algorithm.
export function pointInPolygon(x, y, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi) / (yj - yi) + xi))
    if (intersect) inside = !inside
  }
  return inside
}

// Return the shortest distance from point (px, py) to line segment (x1,y1)–(x2,y2).
export function distanceToLineSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
  const closestX = x1 + t * dx
  const closestY = y1 + t * dy
  const distX = px - closestX
  const distY = py - closestY
  return Math.sqrt(distX * distX + distY * distY)
}

// Return the arithmetic centroid {x, y} of a polygon, or null if empty.
export function centroid(poly) {
  if (!poly?.length) return null
  return {
    x: poly.reduce((s, v) => s + v.x, 0) / poly.length,
    y: poly.reduce((s, v) => s + v.y, 0) / poly.length
  }
}

// Clip a polygon to an axis-aligned bounding box using Sutherland-Hodgman per edge.
export function clipPolygonToBox(polygon, minX, maxX, minY, maxY) {
  const clip = (pts, inside, intersect) => {
    if (pts.length === 0) return []
    const out = []
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], nxt = pts[(i + 1) % pts.length]
      const ci = inside(cur), ni = inside(nxt)
      if (ci) out.push(cur)
      if (ci !== ni) out.push(intersect(cur, nxt))
    }
    return out
  }
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  let poly = [...polygon]
  poly = clip(poly, p => p.x >= minX, (a, b) => lerp(a, b, (minX - a.x) / (b.x - a.x)))
  poly = clip(poly, p => p.x <= maxX, (a, b) => lerp(a, b, (maxX - a.x) / (b.x - a.x)))
  poly = clip(poly, p => p.y >= minY, (a, b) => lerp(a, b, (minY - a.y) / (b.y - a.y)))
  poly = clip(poly, p => p.y <= maxY, (a, b) => lerp(a, b, (maxY - a.y) / (b.y - a.y)))
  return poly
}
