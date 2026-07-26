// Server-side height sampling over the subdivided terrain mesh (ADR-0022 Stage 4a). Ports
// the client's own ground-follow sampler — client/rendering/TerrainRenderer.js's
// getZHeightAtWorldPos + client/rendering/utils/renderUtils.js's interpolateZAtPoint — to
// the server, so District height generation can read the SAME authoritative subdivided
// heights the client renders, instead of DistrictZHeight.js's IDW-from-coarse-corners
// (which never looks at the actual Catmull-Clark mesh at all).
//
// Bbox-grid indexed the same way WorldRenderer._plotSpatialIndex/_plotsNear indexes city
// plots for click/hover + its own height sampling (client/rendering/WorldRenderer.js) —
// same technique auditGroundplane.js already uses for its own AREA_OVERLAP bbox grid.
// Every subdivideTerrain output quad is bucketed into every grid cell its bbox overlaps,
// so a single-cell lookup at the query point always finds every quad that could contain it.
//
// Every quad subdivideTerrain emits is EXACTLY 4 points (catmullClarkFresh's own per-face
// quad-fan emission — see that file's doc comment), so unlike TerrainSubdivision.js's own
// triangulate() (general ear-clipping, for arbitrary coarse-plot n-gons), sampling only
// ever needs to test the fixed 2-triangle fan of a quad — no ear-clipping needed here.

const DEFAULT_CELL_SIZE = 4   // tuned like auditGroundplane.js's own bbox-grid cellSize

function cellKey(gx, gy) { return `${gx},${gy}` }

// Barycentric interpolation of z at (x,y) within triangle (a,b,c) — same math as
// client/rendering/utils/renderUtils.js's interpolateZAtPoint. Returns null if (x,y) is
// outside the triangle.
function zInTriangle(x, y, a, b, c) {
  const v0x = b.x - a.x, v0y = b.y - a.y
  const v1x = c.x - a.x, v1y = c.y - a.y
  const v2x = x - a.x, v2y = y - a.y
  const den = v0x * v1y - v1x * v0y
  if (Math.abs(den) < 1e-12) return null
  const v = (v2x * v1y - v1x * v2y) / den
  const w = (v0x * v2y - v2x * v0y) / den
  const u = 1 - v - w
  const EPS = -1e-9
  if (u < EPS || v < EPS || w < EPS) return null
  const za = a.z ?? 0, zb = b.z ?? 0, zc = c.z ?? 0
  return u * za + v * zb + w * zc
}

// z at (x,y) within a quad's own polygon — tries both triangles of the fixed [0,1,2]/[0,2,3]
// fan (see this file's own doc comment for why a general n-gon triangulation isn't needed).
function zInQuad(x, y, poly) {
  if (!poly || poly.length !== 4) return null
  const [a, b, c, d] = poly
  return zInTriangle(x, y, a, b, c) ?? zInTriangle(x, y, a, c, d)
}

// Builds a height index over `terrainSurfaces` (subdivideTerrain's own output — see
// TerrainSubdivision.js). Rebuilt fresh by every caller (no caching/invalidation) — matches
// ADR-0022 §10's "full re-subdivide every edit, one always-correct path" philosophy; the
// mesh is small enough (low thousands of quads) that this is cheap.
export function buildTerrainHeightIndex(terrainSurfaces, cellSize = DEFAULT_CELL_SIZE) {
  const grid = new Map()   // "gx,gy" -> quad[]
  const addToCell = (gx, gy, quad) => {
    const key = cellKey(gx, gy)
    let bucket = grid.get(key)
    if (!bucket) { bucket = []; grid.set(key, bucket) }
    bucket.push(quad)
  }
  for (const quad of terrainSurfaces || []) {
    const poly = quad.polygon
    if (!poly || poly.length !== 4) continue
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of poly) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    const gx0 = Math.floor(minX / cellSize), gx1 = Math.floor(maxX / cellSize)
    const gy0 = Math.floor(minY / cellSize), gy1 = Math.floor(maxY / cellSize)
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) addToCell(gx, gy, poly)
  }

  return {
    // z at (x,y) sampled from whichever subdivided quad contains it; null if the mesh
    // doesn't cover that point (outside the world, or a genuinely uncovered gap).
    sampleZ(x, y) {
      const gx = Math.floor(x / cellSize), gy = Math.floor(y / cellSize)
      const bucket = grid.get(cellKey(gx, gy))
      if (!bucket) return null
      for (const poly of bucket) {
        const z = zInQuad(x, y, poly)
        if (z != null) return z
      }
      return null
    },
  }
}
