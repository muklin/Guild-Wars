import { pip } from '../../voronoi/VoronoiUtils.js'
import { MODEL_BY_NAME, MODEL_SCALE, MODEL_OFFSET, DISTRICT_MODEL_SQUARE, districtModelKey } from '../../../../shared/buildingCatalogue.js'

// Places Landmark buildings (ADR-0005). Square blocks of one district that are joined
// across shared street segments form a Square cluster (a paved plaza); each district's
// DISTRICT_MODEL_SQUARE models are packed, largest-first, onto its clusters without
// overlapping each other and staying inside the district polygon. Returns the placed
// buildings plus their footprint polygons, which PlotVoronoiGenerator uses to drop any
// plot cell sitting under a Landmark.

// ── geometry helpers ──────────────────────────────────────────────────────────
function centroid(poly) {
  if (!poly?.length) return null
  let x = 0, y = 0
  for (const v of poly) { x += v.x; y += v.y }
  return { x: x / poly.length, y: y / poly.length }
}
function polyArea(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y }
  return Math.abs(a) / 2
}
// Four corners of a model footprint (mw × md) centred at (cx,cy), rotated by `rot`.
// Used for PLACEMENT decisions (fit-inside-district + Landmark non-overlap) — kept
// centred on the placement point so placement is lenient and stable.
function footprintCorners(cx, cy, mw, md, rot) {
  const hw = mw / 2, hd = md / 2, cos = Math.cos(rot), sin = Math.sin(rot)
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => ({
    x: cx + lx * cos - lz * sin,
    y: cy + lx * sin + lz * cos,
  }))
}

// The model's TRUE ground projection, used for DROPPING plots. Models are authored
// with their origin at the "front door", so geometry sits behind it (MODEL_OFFSET);
// this projects the bbox [off ± size/2] into world space with Three.js's Y-rotation,
// matching how the model actually renders — so plots under the whole structure (not
// just its entrance) are cleared.
function bodyFootprint(px, py, mw, md, off, rot) {
  const hw = mw / 2, hd = md / 2
  const ox = (off?.x || 0) * MODEL_SCALE, oz = (off?.z || 0) * MODEL_SCALE
  const c = Math.cos(rot), s = Math.sin(rot)
  return [[ox - hw, oz - hd], [ox + hw, oz - hd], [ox + hw, oz + hd], [ox - hw, oz + hd]].map(([lx, lz]) => ({
    x: px + c * lx + s * lz,    // Three.js Y-rotation: worldX = cosθ·x + sinθ·z
    y: py - s * lx + c * lz,    //                      worldZ = -sinθ·x + cosθ·z
  }))
}
function segsIntersect(a, b, c, d) {
  const r1x = b.x - a.x, r1y = b.y - a.y, r2x = d.x - c.x, r2y = d.y - c.y
  const den = r1x * r2y - r1y * r2x
  if (Math.abs(den) < 1e-12) return false
  const sx = c.x - a.x, sy = c.y - a.y
  const t = (sx * r2y - sy * r2x) / den
  const u = (sx * r1y - sy * r1x) / den
  return t > 0 && t < 1 && u > 0 && u < 1
}
// True if convex polygons A and B overlap (vertex-inside either way, or edges cross).
export function polysOverlap(A, B) {
  if (!A?.length || !B?.length) return false
  for (const v of A) if (pip(v.x, v.y, B)) return true
  for (const v of B) if (pip(v.x, v.y, A)) return true
  for (let i = 0; i < A.length; i++) {
    const a1 = A[i], a2 = A[(i + 1) % A.length]
    for (let j = 0; j < B.length; j++) {
      if (segsIntersect(a1, a2, B[j], B[(j + 1) % B.length])) return true
    }
  }
  return false
}

// Deterministic [0,1) RNG + position hash so a Landmark's orientation is stable across
// regenerations (same as the client's posHash/rand).
function posHash(x, y) {
  const xi = Math.round(x * 1000) | 0, yi = Math.round(y * 1000) | 0
  let h = (xi * 73856093) ^ (yi * 19349663)
  return h >>> 0
}
function rand(seed) {
  let s = (seed * 2654435761) >>> 0
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5
  return (s >>> 0) / 0x100000000
}

// A roadId is a real street segment (2 junctions) — not a junction fan/cap mitre or a
// trade road. Only these join squares (the "2 junctions, not 1" rule).
function isRealSegment(roadId) {
  const s = String(roadId)
  return roadId != null && !s.includes('-fan') && !s.includes('-cap') && !s.startsWith('trade')
}

export default class LandmarkPlacer {
  // blocks: from CityBlockGenerator (square blocks carry blockType==='square').
  // Returns { landmarkBuildings: [{x,z,rotY,name,districtId}], footprints: [{polygon,districtId}] }.
  generate(blocks, districts) {
    const districtById = new Map((districts || []).map(d => [d.id, d]))
    const squares = (blocks || []).filter(b => b.blockType === 'square')
    const clusters = this._clusterSquares(squares)

    const byDistrict = new Map()
    for (const c of clusters) {
      if (c.districtId == null) continue
      if (!byDistrict.has(c.districtId)) byDistrict.set(c.districtId, [])
      byDistrict.get(c.districtId).push(c)
    }

    const landmarkBuildings = []
    const footprints = []

    for (const [districtId, dClusters] of byDistrict) {
      const district = districtById.get(districtId)
      const spec = DISTRICT_MODEL_SQUARE[districtModelKey(district)]
      if (!spec) continue

      // One entry per wanted instance, largest footprint first.
      const wanted = []
      for (const name in spec) {
        const m = MODEL_BY_NAME.get(name); const n = spec[name] | 0
        for (let i = 0; i < n && m; i++) wanted.push({ name, m, fpArea: m.width * m.depth })
      }
      if (!wanted.length) continue
      wanted.sort((a, b) => b.fpArea - a.fpArea)
      dClusters.sort((a, b) => b.area - a.area)   // biggest plaza first

      const polygon = district?.polygon
      const placed = []   // footprints already placed in this district
      for (const { name, m } of wanted) {
        const mw = m.width * MODEL_SCALE, md = m.depth * MODEL_SCALE
        const off = MODEL_OFFSET[name]
        let chosen = null
        for (const cluster of dClusters) {
          for (const pos of cluster.positions) {
            // Orientation seeded by position → stable across regenerations.
            for (const rot of [rand(posHash(pos.x, pos.y)) * Math.PI * 2, 0, Math.PI / 2]) {
              const fp = footprintCorners(pos.x, pos.y, mw, md, rot)
              if (polygon && !fp.every(p => pip(p.x, p.y, polygon))) continue   // must fit inside the district
              if (placed.some(f => polysOverlap(fp, f))) continue               // no Landmark overlap
              chosen = { pos, rot, fp }; break
            }
            if (chosen) break
          }
          if (chosen) break
        }
        if (!chosen) continue
        placed.push(chosen.fp)
        landmarkBuildings.push({ x: chosen.pos.x, z: chosen.pos.y, rotY: chosen.rot, name, districtId })
        // Drop plots under the model's TRUE projection (body behind the front door),
        // not the centred placement footprint.
        footprints.push({ polygon: bodyFootprint(chosen.pos.x, chosen.pos.y, mw, md, off, chosen.rot), districtId })
      }
    }
    return { landmarkBuildings, footprints }
  }

  // Union square blocks that share a real street segment (same district) into clusters.
  // Each cluster yields candidate Landmark positions: the area-weighted plaza centroid
  // first (primary), then each constituent square's centroid.
  _clusterSquares(squares) {
    const parent = squares.map((_, i) => i)
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }

    const roadMap = new Map()   // roadId → [squareIndex]
    squares.forEach((b, i) => {
      for (const se of (b.streetEdges || [])) {
        if (!isRealSegment(se.roadId)) continue
        if (!roadMap.has(se.roadId)) roadMap.set(se.roadId, [])
        roadMap.get(se.roadId).push(i)
      }
    })
    for (const [, idxs] of roadMap) {
      for (let k = 1; k < idxs.length; k++) {
        // Same district only → the spanned road is interior to one district.
        if (squares[idxs[0]].districtId === squares[idxs[k]].districtId) union(idxs[0], idxs[k])
      }
    }

    const groups = new Map()
    squares.forEach((b, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(b) })

    const clusters = []
    for (const [, blks] of groups) {
      let ax = 0, ay = 0, aw = 0, totalArea = 0
      const squareCentroids = []
      for (const b of blks) {
        const c = centroid(b.blockCorners), a = polyArea(b.blockCorners)
        if (c) { ax += c.x * a; ay += c.y * a; aw += a; squareCentroids.push(c) }
        totalArea += a
      }
      const plazaCentroid = aw > 0 ? { x: ax / aw, y: ay / aw } : squareCentroids[0]
      const positions = plazaCentroid ? [plazaCentroid, ...squareCentroids] : squareCentroids
      clusters.push({ districtId: blks[0].districtId, area: totalArea, positions })
    }
    return clusters
  }
}
