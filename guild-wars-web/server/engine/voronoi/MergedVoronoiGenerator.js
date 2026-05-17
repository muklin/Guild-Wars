import VoronoiWorldGenerator from './VoronoiWorldGenerator.js'
import Point from './Point.js'
import DelaunayTriangulator from './DelaunayTriangulator.js'

export default class MergedVoronoiGenerator {
  constructor() {
    this.fineGenerator = new VoronoiWorldGenerator()
  }

  generateVoronoiFromSeeds(seeds, worldSize) {
    // Generate Voronoi directly from provided seed points
    const delaunayPoints = seeds.map(seed => new Point(seed.x, seed.y))

    const triangulator = new DelaunayTriangulator(delaunayPoints)
    triangulator.bowyerWatson()

    const regions = []
    for (let i = 0; i < seeds.length; i++) {
      const seedPoint = seeds[i]
      const delaunayPoint = delaunayPoints[i]

      const trianglesWithSeed = triangulator.triangulation.filter(t =>
        t.vertices.includes(delaunayPoint)
      )

      if (trianglesWithSeed.length === 0) continue

      const circumcenters = trianglesWithSeed.map(t => t.circumcenter)
      const polygon = this.fineGenerator.sortByAngle(seedPoint, circumcenters)
      polygon.reverse()

      // Keep unclipped Voronoi - mathematically guaranteed non-overlapping
      if (polygon.length >= 3) {
        regions.push({
          id: i,
          seedPoint,
          polygon,
          assignedType: null,
          gridX: Math.floor(seedPoint.x / 10),
          gridZ: Math.floor(seedPoint.y / 10),
          description: ''
        })
      }
    }

    return { worldSize, regions, edges: {} }
  }

  generateRawVoronoi(regionCount, worldSize, manhattan = 0) {
    const seedPoints = []
    const delaunayPoints = []

    // Generate random seed positions
    for (let i = 0; i < regionCount; i++) {
      seedPoints.push({ x: Math.random() * worldSize, y: Math.random() * worldSize })
    }

    // Manhattan grid generation: lerp each seed toward its nearest grid point
    
    if (manhattan > 0) {
      const cols = Math.ceil(Math.sqrt(regionCount))
      const step = worldSize / cols
      const half = step * 0.5
      
      for (const sp of seedPoints) {
        if(Math.random() < manhattan){
          const gx = Math.max(half, Math.min(worldSize - half, Math.round(sp.x / step) * step))
          const gy = Math.max(half, Math.min(worldSize - half, Math.round(sp.y / step) * step))
          sp.x += (gx - sp.x)
          sp.y += (gy - sp.y)
        }
      }
    }

    for (const sp of seedPoints) {
      delaunayPoints.push(new Point(sp.x, sp.y))
    }

    // Sentinels placed 3× worldSize outside the map boundary so that every
    // sentinel-triangle circumcenter lands far outside [0, worldSize]. This prevents
    // boundary-cell Voronoi vertices from appearing inside or near the map edge.
    // Opposite sides are staggered by step/2 (a vs b) so no pair shares a coordinate,
    // which would produce collinear degenerate triangles with d≈0.
    const sm     = worldSize * 3   // e.g. 150 for worldSize=50
    const nSteps = 8
    const step   = worldSize / nSteps
    for (let i = 0; i <= nSteps; i++) {
      const a = i * step - step / 4  // -1.5625, 4.6875, ..., 48.4375
      const b = i * step + step / 4  //  1.5625, 7.8125, ..., 51.5625
      delaunayPoints.push(new Point(a, -sm))
      delaunayPoints.push(new Point(b, worldSize + sm))
      delaunayPoints.push(new Point(-sm,            a))
      delaunayPoints.push(new Point(worldSize + sm, b))
    }
    delaunayPoints.push(new Point(-sm,            -sm))
    delaunayPoints.push(new Point(worldSize + sm, -sm))
    delaunayPoints.push(new Point(-sm,            worldSize + sm))
    delaunayPoints.push(new Point(worldSize + sm, worldSize + sm))

    const triangulator = new DelaunayTriangulator(delaunayPoints)
    triangulator.bowyerWatson()

    const regions = []
    for (let i = 0; i < regionCount; i++) {   // only real seeds, not sentinels
      const seedPoint = seedPoints[i]
      const delaunayPoint = delaunayPoints[i]

      const trianglesWithSeed = triangulator.triangulation.filter(t =>
        t.vertices.includes(delaunayPoint)
      )

      if (trianglesWithSeed.length === 0) continue

      const circumcenters = trianglesWithSeed.map(t => t.circumcenter)

      // convexHull preserves circumcenter object references (same objects, just reordered)
      // so reference equality in findSharedEdge still works. It also guarantees convexity,
      // fixing the ~15% of cells where sortByAngle produced non-convex polygons (due to
      // multiple sentinel-side circumcenters clustering at similar angles).
      // convexHull returns CCW; reverse() gives CW for +y normal in fan triangulation.
      const polygon = this.convexHull(circumcenters)
      polygon.reverse()

      if (polygon.length < 3) continue

      regions.push({
        id: i,
        seedPoint,
        polygon,
        assignedType: null,
        gridX: Math.floor(seedPoint.x / 10),
        gridZ: Math.floor(seedPoint.y / 10),
        description: ''
      })
    }

    return { worldSize, regions, edges: {} }
  }

  generate(regionCount = 15, worldSize = 50, mergeDistance = 0, manhattan = 0) {
    
    const fineCount = Math.max(regionCount * 10, 150)
    console.log(`Generating: ${fineCount} fine cells → ${regionCount} merged regions`)

    // Step 1: Single triangulation for all fine cells. Staggered sentinels keep
    // every real seed interior → bounded, valid circumcenter polygons.
    const { regions: allFineCells } = this.generateRawVoronoi(fineCount, worldSize)
    let validFineCells = allFineCells.filter(c =>
      c.polygon && c.polygon.length >= 3 &&
      c.seedPoint.x >= 0 && c.seedPoint.x <= worldSize &&
      c.seedPoint.y >= 0 && c.seedPoint.y <= worldSize
    )
    console.log(`${validFineCells.length}/${fineCount} fine cells valid`)

    // Step 1.5: Merge circumcenter vertices that are closer than mergeDistance.
    // This eliminates T-junction artefacts where multiple near-coincident
    // circumcenters produce slivers and overlapping edge markers.
    if (mergeDistance > 0) {
      this.mergeNearbyVertices(validFineCells, mergeDistance)
      validFineCells = validFineCells.filter(c => c.polygon.length >= 3)
      console.log(`After vertex merge: ${validFineCells.length} fine cells valid`)
    }

    // Step 2: Pick region seeds using greedy farthest-point from interior cells
    // so seeds are evenly spread across the map, not biased toward large boundary cells.
    const selectedSeeds = this.selectSeeds(validFineCells, regionCount, worldSize)
    console.log(`Selected ${selectedSeeds.length} seed points`)

    // Step 3: Assign each fine cell to its nearest seed
    for (const cell of validFineCells) {
      cell.parentRegionId = this.findNearestSeed(cell.seedPoint, selectedSeeds)
    }

    // Step 4: Assign global vertex IDs. Must happen before any clipping —
    // clipping creates new vertex objects, breaking the shared circumcenter
    // references that findSharedEdge relies on.
    let nextVertexId = 0
    const seenVertices = new Set()
    for (const cell of validFineCells) {
      for (const v of cell.polygon) {
        if (!seenVertices.has(v)) { seenVertices.add(v); v.id = nextVertexId++ }
      }
    }

    // Step 5: Boundary edges via reference equality on unclipped polygons
    const { edges, edgePoints } = this.generateBoundaryEdges(validFineCells, regionCount)
    console.log(`Generated ${Object.keys(edges).length} boundary edges, ${edgePoints.length} edge points`)

    // Step 5.5: Clip fine cell polygons to world bounds for client rendering.
    // Must happen AFTER edge detection — clipping creates new vertex objects that
    // break the reference equality used by findSharedEdge. Clipped polygons improve
    // click-detection accuracy and eliminate huge sentinel-extended polys from the renderer.
    for (const cell of validFineCells) {
      const clipped = this.clipToWorldBoundsProper(cell.polygon, 0, worldSize, 0, worldSize)
      if (clipped.length >= 3) cell.polygon = clipped
    }

    // Step 6: Build merged region convex hulls (used for click hit-testing fallback)
    const vertsByRegion = new Map()
    for (let i = 0; i < selectedSeeds.length; i++) vertsByRegion.set(i, [])
    for (const cell of validFineCells) {
      const bucket = vertsByRegion.get(cell.parentRegionId)
      if (bucket) {
        for (const v of cell.polygon) {
          if (isFinite(v.x) && isFinite(v.y)) bucket.push(v)
        }
      }
    }
    const regions = selectedSeeds.map((seed, i) => ({
      id: i,
      seedPoint: seed,
      polygon: this.convexHull(vertsByRegion.get(i) || []),
      assignedType: null,
      description: ''
    }))

    return { worldSize, regions, fineCells: validFineCells, edges, edgePoints }
  }

  clipToWorldBoundsProper(polygon, minX, maxX, minY, maxY) {
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

  selectSeeds(fineCells, count, worldSize) {
    // Prefer interior cells so region seeds are evenly spread, not boundary-biased.
    const margin = worldSize * 0.15
    const pool = fineCells.filter(c =>
      c.seedPoint.x >= margin && c.seedPoint.x <= worldSize - margin &&
      c.seedPoint.y >= margin && c.seedPoint.y <= worldSize - margin
    )
    const source = pool.length >= count ? pool : fineCells

    // Greedy farthest-point: each new seed maximises its minimum distance to
    // already-selected seeds, ensuring even spatial coverage.
    const selected = []
    const used = new Set()

    // Start from the cell closest to world centre
    const cx = worldSize / 2, cy = worldSize / 2
    let bestIdx = 0, bestDist = Infinity
    for (let i = 0; i < source.length; i++) {
      const d = (source[i].seedPoint.x - cx) ** 2 + (source[i].seedPoint.y - cy) ** 2
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    selected.push(source[bestIdx].seedPoint)
    used.add(bestIdx)

    while (selected.length < count) {
      let farthest = -1, farthestDist = -Infinity
      for (let i = 0; i < source.length; i++) {
        if (used.has(i)) continue
        let minDist = Infinity
        for (const s of selected) {
          const d = (source[i].seedPoint.x - s.x) ** 2 + (source[i].seedPoint.y - s.y) ** 2
          if (d < minDist) minDist = d
        }
        if (minDist > farthestDist) { farthestDist = minDist; farthest = i }
      }
      if (farthest === -1) break
      selected.push(source[farthest].seedPoint)
      used.add(farthest)
    }

    return selected
  }

  findNearestSeed(point, seeds) {
    let minDist = Infinity
    let nearest = 0
    seeds.forEach((seed, idx) => {
      const dx = point.x - seed.x
      const dy = point.y - seed.y
      const dist = dx * dx + dy * dy
      if (dist < minDist) {
        minDist = dist
        nearest = idx
      }
    })
    return nearest
  }

  mergeCells(fineCells, selectedSeeds, assignments, regionCount, worldSize) {
    const mergedRegions = []

    assignments.forEach((cellIndices, seedIdx) => {
      if (cellIndices.length === 0) return

      const seedPoint = selectedSeeds[seedIdx]

      // Collect all vertices from assigned fine cells
      const allVertices = []
      cellIndices.forEach(idx => {
        allVertices.push(...fineCells[idx].polygon)
      })

      // Compute convex hull to get outer boundary
      let mergedPolygon = this.convexHull(allVertices)

      // Clip merged boundary to world bounds
      if (mergedPolygon && mergedPolygon.length >= 3) {
        mergedPolygon = this.clipToWorldBounds(mergedPolygon, worldSize)
      }

      if (mergedPolygon && mergedPolygon.length >= 3) {
        mergedRegions.push({
          id: mergedRegions.length,
          seedPoint,
          polygon: mergedPolygon,
          assignedType: null,
          gridX: Math.floor(seedPoint.x / 10),
          gridZ: Math.floor(seedPoint.y / 10),
          description: ''
        })
      }
    })

    console.log(`Merged into ${mergedRegions.length} regions`)
    return mergedRegions
  }

  clipToWorldBounds(polygon, worldSize) {
    // Sutherland-Hodgman clip to axis-aligned world bounds
    let output = [...polygon]
    const bounds = [0, worldSize, 0, worldSize] // [minX, maxX, minY, maxY]

    // Clip against left edge (x >= 0)
    output = this.clipAgainstLine(output, p => p.x >= -0.01)
    if (output.length < 3) return output

    // Clip against right edge (x <= worldSize)
    output = this.clipAgainstLine(output, p => p.x <= worldSize + 0.01)
    if (output.length < 3) return output

    // Clip against bottom edge (y >= 0)
    output = this.clipAgainstLine(output, p => p.y >= -0.01)
    if (output.length < 3) return output

    // Clip against top edge (y <= worldSize)
    output = this.clipAgainstLine(output, p => p.y <= worldSize + 0.01)

    return output
  }

  clipAgainstLine(polygon, testFunc) {
    const output = []
    for (let i = 0; i < polygon.length; i++) {
      const current = polygon[i]
      const next = polygon[(i + 1) % polygon.length]
      const currentInside = testFunc(current)
      const nextInside = testFunc(next)

      if (nextInside) {
        if (!currentInside) {
          const intersection = this.lineIntersection(current, next)
          if (intersection) output.push(intersection)
        }
        output.push(next)
      } else if (currentInside) {
        const intersection = this.lineIntersection(current, next)
        if (intersection) output.push(intersection)
      }
    }
    return output
  }

  lineIntersection(p1, p2) {
    // Simple linear interpolation for line clipping
    return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
  }

  mergePolygons(polygons) {
    if (polygons.length === 0) return []
    if (polygons.length === 1) return polygons[0]

    // Collect all unique vertices from all polygons
    const vertexSet = new Set()
    const vertices = []
    const vertexMap = new Map()

    polygons.forEach(poly => {
      poly.forEach(v => {
        const key = `${v.x.toFixed(6)},${v.y.toFixed(6)}`
        if (!vertexSet.has(key)) {
          vertexSet.add(key)
          vertices.push(v)
          vertexMap.set(key, v)
        }
      })
    })

    if (vertices.length < 3) return []

    // Find convex hull of all vertices (Graham scan)
    return this.convexHull(vertices)
  }

  convexHull(points) {
    if (points.length < 3) return points

    // Sort by x, then by y
    const sorted = [...points].sort((a, b) => {
      return a.x !== b.x ? a.x - b.x : a.y - b.y
    })

    // Build lower hull
    const lower = []
    for (const p of sorted) {
      while (lower.length >= 2 && this.cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
        lower.pop()
      }
      lower.push(p)
    }

    // Build upper hull
    const upper = []
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i]
      while (upper.length >= 2 && this.cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
        upper.pop()
      }
      upper.push(p)
    }

    // Remove last point of each half because it's repeated
    lower.pop()
    upper.pop()

    return lower.concat(upper)
  }

  cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  }

  mergeNearbyVertices(fineCells, mergeDistance) {
    // Collect all unique circumcenter vertex objects
    const allVerts = []
    const seen = new Set()
    for (const cell of fineCells) {
      for (const v of cell.polygon) {
        if (!seen.has(v)) { seen.add(v); allVerts.push(v) }
      }
    }

    // Spatial grid for O(n) neighbour lookup
    const gs = mergeDistance
    const grid = new Map()
    for (const v of allVerts) {
      const key = `${Math.floor(v.x / gs)},${Math.floor(v.y / gs)}`
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key).push(v)
    }

    // Union-Find: track which vertex each vertex is replaced by
    const rep = new Map()
    const find = (v) => { while (rep.has(v)) v = rep.get(v); return v }

    for (const v of allVerts) {
      const gx = Math.floor(v.x / gs)
      const gy = Math.floor(v.y / gs)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const n of (grid.get(`${gx + dx},${gy + dy}`) || [])) {
            if (n === v) continue
            if (Math.hypot(v.x - n.x, v.y - n.y) < mergeDistance) {
              const rv = find(v), rn = find(n)
              if (rv !== rn) rep.set(rn, rv)
            }
          }
        }
      }
    }

    // Apply replacements and deduplicate within each polygon
    for (const cell of fineCells) {
      const dedup = new Set()
      cell.polygon = cell.polygon.map(v => find(v)).filter(v => {
        if (dedup.has(v)) return false
        dedup.add(v)
        return true
      })
    }
  }

  generateEdges(regions) {
    const edges = new Map()
    const edgeSet = new Set()

    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const shared = this.findSharedEdge(regions[i].polygon, regions[j].polygon)
        if (shared && shared.length >= 2) {
          const edgeId = `${i}-${j}`
          const edgeKey = `${Math.min(i, j)}-${Math.max(i, j)}`

          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey)
            edges.set(edgeId, {
              regionA: i,
              regionB: j,
              vertices: shared,
              startPoint: shared[0].id,
              endPoint: shared[shared.length - 1].id,
              assignedType: null
            })
          }
        }
      }
    }

    return Object.fromEntries(edges)
  }

  generateBoundaryEdges(fineCells, regionCount) {
    // Build vertex → cells map by reference so we can find which cells share
    // each polygon segment without an O(n²) cell-pair scan.
    const vertexCells = new Map()
    for (const cell of fineCells) {
      for (const v of cell.polygon) {
        if (!vertexCells.has(v)) vertexCells.set(v, [])
        vertexCells.get(v).push(cell)
      }
    }

    const edgePointsMap = new Map()
    const segmentsByKey = new Map() // edgeKey → [{v1, v2}]
    const metaByKey     = new Map() // edgeKey → {regionA, regionB}
    const registeredPairs = new Set()

    for (const cell of fineCells) {
      const regionA = cell.parentRegionId
      const poly    = cell.polygon
      for (let i = 0; i < poly.length; i++) {
        const va = poly[i]
        const vb = poly[(i + 1) % poly.length]
        if (va.id === undefined || vb.id === undefined) continue

        // Canonical key — each physical edge is processed exactly once
        const lo = Math.min(va.id, vb.id), hi = Math.max(va.id, vb.id)
        const pairKey = `${lo}:${hi}`
        if (registeredPairs.has(pairKey)) continue
        registeredPairs.add(pairKey)

        // Cells containing BOTH va and vb are the two cells on opposite sides
        // of this Delaunay edge (reference equality preserved throughout).
        const cellsOfB = new Set(vertexCells.get(vb) || [])
        const sharedCells = (vertexCells.get(va) || []).filter(c => cellsOfB.has(c))
        const neighborIds = [...new Set(sharedCells.map(c => c.parentRegionId).filter(r => r !== regionA))]

        // Only register edges between two DIFFERENT merged regions.
        // Skip same-region internal boundaries and world-boundary segments.
        if (neighborIds.length === 0) continue

        const regionB = neighborIds[0]
        const rA = Math.min(regionA, regionB)
        const rB = Math.max(regionA, regionB)
        const edgeKey = `${rA}-${rB}`

        for (const v of [va, vb]) {
          if (!edgePointsMap.has(v.id)) {
            edgePointsMap.set(v.id, { id: v.id, x: v.x, y: v.y })
          }
        }

        if (!segmentsByKey.has(edgeKey)) {
          segmentsByKey.set(edgeKey, [])
          metaByKey.set(edgeKey, { regionA: rA, regionB: rB })
        }
        segmentsByKey.get(edgeKey).push({ v1: va, v2: vb })
      }
    }

    const edges = {}
    for (const [edgeKey, segments] of segmentsByKey) {
      const meta     = metaByKey.get(edgeKey)
      const polyline = this.sortSegmentsIntoPolyline(segments)
      if (polyline.length < 2) continue
      edges[edgeKey] = {
        regionA:      meta.regionA,
        regionB:      meta.regionB,
        pointIds:     polyline.map(v => v.id),
        assignedType: null
      }
    }

    return { edges, edgePoints: Array.from(edgePointsMap.values()) }
  }

  sortSegmentsIntoPolyline(segments) {
    if (segments.length === 0) return []
    if (segments.length === 1) return [segments[0].v1, segments[0].v2]

    // Build adjacency: vertex → [{segIdx, otherVertex}]
    const adj = new Map()
    for (let i = 0; i < segments.length; i++) {
      const { v1, v2 } = segments[i]
      if (!adj.has(v1)) adj.set(v1, [])
      if (!adj.has(v2)) adj.set(v2, [])
      adj.get(v1).push({ idx: i, other: v2 })
      adj.get(v2).push({ idx: i, other: v1 })
    }

    // Find an endpoint: a vertex connected to exactly one segment
    // (chain ends). Fall back to segments[0].v1 for loops (shouldn't occur).
    let start = segments[0].v1
    for (const [v, links] of adj) {
      if (links.length === 1) { start = v; break }
    }

    const result = [start]
    const used   = new Set()
    let current  = start

    while (used.size < segments.length) {
      const links = adj.get(current) || []
      let found = false
      for (const { idx, other } of links) {
        if (used.has(idx)) continue
        used.add(idx)
        result.push(other)
        current = other
        found = true
        break
      }
      if (!found) break
    }

    return result
  }

  findSharedEdge(polygon1, polygon2) {
    // Use reference equality: adjacent regions share the same circumcenter objects
    return polygon1.filter(v => polygon2.includes(v))
  }

  clipToBox(polygon, bounds) {
    // Simple axis-aligned box clipping
    let output = [...polygon]

    // Clip left (x >= min)
    output = output.filter(p => p.x >= bounds.min - 0.01)
    if (output.length < 3) return output

    // Clip right (x <= max)
    output = output.filter(p => p.x <= bounds.max + 0.01)
    if (output.length < 3) return output

    // Clip bottom (y >= min)
    output = output.filter(p => p.y >= bounds.min - 0.01)
    if (output.length < 3) return output

    // Clip top (y <= max)
    output = output.filter(p => p.y <= bounds.max + 0.01)

    return output
  }

  polygonArea(polygon) {
    let area = 0
    for (let i = 0; i < polygon.length; i++) {
      const p1 = polygon[i]
      const p2 = polygon[(i + 1) % polygon.length]
      area += p1.x * p2.y - p2.x * p1.y
    }
    return Math.abs(area) / 2
  }
}
