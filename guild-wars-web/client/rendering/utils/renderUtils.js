// Shared geometry utility functions used across renderer classes.

// Stable integer seed from a world position (x, y). Used to make procedural building
// decisions a function of WHERE a plot is, not its (globally unstable) plot id — so a
// locked district's buildings stay put when a neighbouring district is added/changed.
// Quantised to ~1mm to absorb negligible float drift.
export function posHash(x, y) {
  const xi = Math.round(x * 1000) | 0
  const yi = Math.round(y * 1000) | 0
  let h = (Math.imul(xi, 73856093) ^ Math.imul(yi, 19349663)) >>> 0
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15
  return h >>> 0
}

// Resolve an ordered list of Point registry ids to their current {x,y,z} coordinates
// (see server/engine/CityGenerator/GroundPointRegistry.js). Missing ids are dropped
// rather than throwing, matching GroundPointRegistry.resolve's own behavior — a polygon
// with one stale/missing corner should still draw the rest, not crash the frame. Returns
// null (not []) when there's nothing to resolve, so callers can fall back to a
// server-sent .polygon convenience copy with a simple `resolvePolygon(...) ?? obj.polygon`.
export function resolvePolygon(pointIds, pointsById) {
  if (!pointIds || !pointsById) return null
  const out = []
  for (const id of pointIds) {
    const p = pointsById.get(id)
    if (p) out.push({ x: p.x, y: p.y, z: p.z ?? 0 })
  }
  return out.length ? out : null
}

// Remove a mesh (or a Group containing several, e.g. a wall-with-towers) from the scene
// AND free its GPU-side geometry buffers/shader programs. scene.remove(obj) alone only
// unlinks it from the render graph — geometry and material (and the compiled shader
// program backing it) stay allocated on the GPU until explicitly disposed. Every "clear
// and rebuild from scratch" loop across the renderer classes (TerrainRenderer/
// GroundRenderer/DistrictRenderer) used to skip this, so every regeneration pass (Apply,
// Regenerate streets, a fresh terrain sync — confirmed live 2026-07-16, setTerrainData
// firing 3x on a single page load) leaked that pass's entire mesh set. Confirmed as the
// direct cause of a live `THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false`
// (GPU/driver resource exhaustion after repeated leaked rebuilds) — a failed shader
// compile renders the affected mesh solid black/broken, matching the "dark scattered
// shapes" visual report that motivated this fix.
// Traverses so a Group (e.g. DistrictRenderer's wall-plus-tower groups) disposes every
// child, not just itself. Does not dispose texture maps — every material disposed via
// this helper (across Terrain/Ground/District) is a freshly-`new`'d, per-instance
// MeshStandardMaterial/LineBasicMaterial with no texture map, confirmed by reading each
// call site before wiring this in.
// Skips any material tagged `userData.shared` (see PartLibrary.js) — GroundRenderer's
// wood fences reassign their material to the library's shared `floorWoodMaterial`
// singleton (also used by every building's floor); disposing it here on ONE fence's
// clear would corrupt it for every other mesh still holding that same reference. Do NOT
// reuse this helper for BuildingRenderer's own parametric building groups without
// checking first — those also reuse shared PartLibrary GEOMETRY (not just materials,
// via lib.get(slot)), a risk this flag alone doesn't cover.
export function disposeMesh(obj) {
  if (!obj) return
  obj.traverse?.(child => {
    child.geometry?.dispose()
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    for (const m of mats) { if (m && !m.userData?.shared) m.dispose() }
  })
}

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

// Ear-clipping triangulation — correct for any simple (non-self-intersecting) polygon,
// convex or concave, unlike a naive fan from one vertex/the centroid (which only works
// when that point can "see" every edge — river/cliff pullback routinely clips a notch
// into a terrain-plot or district polygon, producing exactly the concave, non-star-
// shaped shape a centroid fan renders wrong: missing/inverted triangles that looked like
// the whole plot had vanished). Returns [[i0,i1,i2], ...] index triples into `polygon`.
export function triangulatePolygon(polygon) {
  // Dedupe consecutive coincident points (e.g. a "closed ring" convention — first point
  // repeated at the end — common output from polygon-clipping libraries like the one
  // River/Cliff pullback uses) before triangulating: a zero-length edge between two
  // coincident points makes that vertex's turn angle degenerate, which can stop the ear
  // search from ever finding a valid ear there and make it terminate early, leaving part
  // of the polygon untriangulated. Indices returned still refer to the ORIGINAL array.
  const origIndex = []
  const pts = []
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]
    const prev = pts[pts.length - 1]
    if (prev && (p.x - prev.x) ** 2 + (p.y - prev.y) ** 2 < 1e-12) continue
    pts.push(p)
    origIndex.push(i)
  }
  if (pts.length > 1) {
    const first = pts[0], last = pts[pts.length - 1]
    if ((first.x - last.x) ** 2 + (first.y - last.y) ** 2 < 1e-12) { pts.pop(); origIndex.pop() }
  }

  const n = pts.length
  if (n < 3) return []
  if (n === 3) return [[origIndex[0], origIndex[1], origIndex[2]]]
  const polyLocal = pts

  let area = 0
  for (let i = 0; i < n; i++) {
    const a = polyLocal[i], b = polyLocal[(i + 1) % n]
    area += a.x * b.y - b.x * a.y
  }
  const ccw = area > 0

  // Side test for point-in-triangle: sign of (x-o)×(y-o).
  const cross = (o, x, y) => (x.x - o.x) * (y.y - o.y) - (x.y - o.y) * (y.x - o.x)
  const inTriangle = (p, a, b, c) => {
    const d1 = cross(p, a, b), d2 = cross(p, b, c), d3 = cross(p, c, a)
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0
    return !(hasNeg && hasPos)
  }
  // Turn direction at B given consecutive vertices A,B,C: sign of (B-A)×(C-B). NOT the
  // same as cross(a,b,c) above (that tests a point against an edge, pivoted at a) — this
  // needs the actual turning angle at the middle vertex, pivoted at b, or every convexity
  // test silently uses the wrong vector pair and the ear search degrades until it can't
  // find any valid ear, terminating early and leaving part of the polygon untriangulated.
  const turnCross = (a, b, c) => (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)

  const indices = Array.from({ length: n }, (_, i) => i)
  const triangles = []
  let guard = 0
  while (indices.length > 3 && guard++ < n * n) {
    let clipped = false
    for (let i = 0; i < indices.length; i++) {
      const iPrev = indices[(i - 1 + indices.length) % indices.length]
      const iCurr = indices[i]
      const iNext = indices[(i + 1) % indices.length]
      const a = polyLocal[iPrev], b = polyLocal[iCurr], c = polyLocal[iNext]
      const cr = turnCross(a, b, c)
      const isConvexVertex = ccw ? cr > 1e-12 : cr < -1e-12
      if (!isConvexVertex) continue
      let anyInside = false
      for (const j of indices) {
        if (j === iPrev || j === iCurr || j === iNext) continue
        if (inTriangle(polyLocal[j], a, b, c)) { anyInside = true; break }
      }
      if (anyInside) continue
      triangles.push([iPrev, iCurr, iNext])
      indices.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) break   // degenerate/near-collinear leftover — stop rather than loop forever
  }
  if (indices.length === 3) triangles.push([indices[0], indices[1], indices[2]])
  return triangles.map(([a, b, c]) => [origIndex[a], origIndex[b], origIndex[c]])
}
