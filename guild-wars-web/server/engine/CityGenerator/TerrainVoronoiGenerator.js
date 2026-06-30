import Point from '../voronoi/Point.js'
import DelaunayTriangulator from '../voronoi/DelaunayTriangulator.js'
import { clipToPolygon } from '../voronoi/VoronoiUtils.js'

export default class TerrainVoronoiGenerator {
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
    
    const plotCount = Math.max(regionCount * 10, 150)
    console.log(`Generating: ${plotCount} terrain plots → ${regionCount} merged regions`)

    // Step 1: Single triangulation for all terrain plots. Staggered sentinels keep
    // every real seed interior → bounded, valid circumcenter polygons.
    const { regions: allTerrainPlots } = this.generateRawVoronoi(plotCount, worldSize)
    let validTerrainPlots = allTerrainPlots.filter(c =>
      c.polygon && c.polygon.length >= 3 &&
      c.seedPoint.x >= 0 && c.seedPoint.x <= worldSize &&
      c.seedPoint.y >= 0 && c.seedPoint.y <= worldSize
    )
    console.log(`${validTerrainPlots.length}/${plotCount} terrain plots valid`)

    // Step 1.5: Merge circumcenter vertices that are closer than mergeDistance.
    // This eliminates T-junction artefacts where multiple near-coincident
    // circumcenters produce slivers and overlapping edge markers.
    if (mergeDistance > 0) {
      this.mergeNearbyVertices(validTerrainPlots, mergeDistance)
      validTerrainPlots = validTerrainPlots.filter(c => c.polygon.length >= 3)
      console.log(`After vertex merge: ${validTerrainPlots.length} terrain plots valid`)
    }

    // Step 2: Pick region seeds using greedy farthest-point from interior plots
    // so seeds are evenly spread across the map, not biased toward large boundary plots.
    const selectedSeeds = this.selectSeeds(validTerrainPlots, regionCount, worldSize)
    console.log(`Selected ${selectedSeeds.length} seed points`)

    // Step 3: Assign each terrain plot to its nearest seed
    for (const plot of validTerrainPlots) {
      plot.parentRegionId = this.findNearestSeed(plot.seedPoint, selectedSeeds)
    }

    // Step 3.5: Resolve exclaves — isolated terrain plots that belong to a region
    // but are disconnected from that region's main body. Must run here, while
    // polygon vertices are still shared objects (reference equality gives adjacency).
    const exclavesFixed = this.resolveExclaves(validTerrainPlots)
    if (exclavesFixed > 0) console.log(`Resolved ${exclavesFixed} exclave terrain plots`)

    // Step 4: Assign global vertex IDs. Must happen before any clipping —
    // clipping creates new vertex objects, breaking the shared circumcenter
    // references that findSharedEdge relies on.
    let nextVertexId = 0
    const seenVertices = new Set()
    for (const plot of validTerrainPlots) {
      for (const v of plot.polygon) {
        if (!seenVertices.has(v)) { seenVertices.add(v); v.id = nextVertexId++ }
      }
    }

    // Step 5: Boundary edges via reference equality on unclipped polygons
    const { edges, edgePoints } = this.generateBoundaryEdges(validTerrainPlots, regionCount)
    console.log(`Generated ${Object.keys(edges).length} boundary edges, ${edgePoints.length} edge points`)

    // Step 5.5: Clip terrain plot polygons to world bounds for client rendering.
    // Must happen AFTER edge detection — clipping creates new vertex objects that
    // break the reference equality used by findSharedEdge. Clipped polygons improve
    // click-detection accuracy and eliminate huge sentinel-extended polys from the renderer.
    const W = worldSize
    const worldRect = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: W }, { x: 0, y: W }]
    for (const plot of validTerrainPlots) {
      const clipped = clipToPolygon(plot.polygon, worldRect)
      if (clipped) plot.polygon = clipped
    }

    // Step 6: Build merged region convex hulls (used for click hit-testing fallback)
    const vertsByRegion = new Map()
    for (let i = 0; i < selectedSeeds.length; i++) vertsByRegion.set(i, [])
    for (const plot of validTerrainPlots) {
      const bucket = vertsByRegion.get(plot.parentRegionId)
      if (bucket) {
        for (const v of plot.polygon) {
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

    return { worldSize, regions, terrainPlots: validTerrainPlots, edges, edgePoints }
  }

  // Finds terrain plots that are disconnected from their region's largest contiguous
  // component and reassigns them to the dominant neighbouring region. Runs once
  // after the initial nearest-seed assignment; a single pass eliminates isolated
  // islands (the common case). Adjacency uses shared vertex object references,
  // which are valid before Step 5.5 clips polygons.
  resolveExclaves(plots) {
    // Build vertex → plots map by reference equality
    const vertexPlots = new Map()
    for (const plot of plots) {
      for (const v of plot.polygon) {
        if (!vertexPlots.has(v)) vertexPlots.set(v, [])
        vertexPlots.get(v).push(plot)
      }
    }

    // Build full plot adjacency (plots sharing at least one vertex)
    const adj = new Map()
    for (const plot of plots) adj.set(plot, new Set())
    for (const group of vertexPlots.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          adj.get(group[i]).add(group[j])
          adj.get(group[j]).add(group[i])
        }
      }
    }

    // BFS to find connected components restricted to same-region plots
    const visited = new Set()
    const plotComponent = new Map()  // plot → component array

    for (const plot of plots) {
      if (visited.has(plot)) continue
      const component = []
      const queue = [plot]
      visited.add(plot)
      while (queue.length) {
        const cur = queue.shift()
        component.push(cur)
        for (const nb of adj.get(cur)) {
          if (!visited.has(nb) && nb.parentRegionId === cur.parentRegionId) {
            visited.add(nb)
            queue.push(nb)
          }
        }
      }
      for (const p of component) plotComponent.set(p, component)
    }

    // For each region, keep the largest component; everything else is an exclave
    const mainByRegion = new Map()
    for (const [plot, comp] of plotComponent) {
      const rid = plot.parentRegionId
      if (!mainByRegion.has(rid) || comp.length > mainByRegion.get(rid).length) {
        mainByRegion.set(rid, comp)
      }
    }

    // Reassign exclave plots to the most common neighbouring region
    let reassigned = 0
    for (const plot of plots) {
      if (plotComponent.get(plot) === mainByRegion.get(plot.parentRegionId)) continue

      const counts = new Map()
      for (const nb of adj.get(plot)) {
        const r = nb.parentRegionId
        if (r !== plot.parentRegionId) counts.set(r, (counts.get(r) || 0) + 1)
      }
      if (!counts.size) continue

      let bestRegion = null, bestCount = -1
      for (const [r, n] of counts) {
        if (n > bestCount) { bestCount = n; bestRegion = r }
      }
      if (bestRegion !== null) { plot.parentRegionId = bestRegion; reassigned++ }
    }

    return reassigned
  }

  selectSeeds(plots, count, worldSize) {
    // Prefer interior plots so region seeds are evenly spread, not boundary-biased.
    const margin = worldSize * 0.15
    const pool = plots.filter(c =>
      c.seedPoint.x >= margin && c.seedPoint.x <= worldSize - margin &&
      c.seedPoint.y >= margin && c.seedPoint.y <= worldSize - margin
    )
    const source = pool.length >= count ? pool : plots

    // Greedy farthest-point: each new seed maximises its minimum distance to
    // already-selected seeds, ensuring even spatial coverage.
    const selected = []
    const used = new Set()

    // Start from the plot closest to world centre
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

  mergeNearbyVertices(plots, mergeDistance) {
    // Collect all unique circumcenter vertex objects
    const allVerts = []
    const seen = new Set()
    for (const cell of plots) {
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
    for (const cell of plots) {
      const dedup = new Set()
      cell.polygon = cell.polygon.map(v => find(v)).filter(v => {
        if (dedup.has(v)) return false
        dedup.add(v)
        return true
      })
    }
  }

  generateBoundaryEdges(plots, regionCount) {
    // Build vertex → cells map by reference so we can find which cells share
    // each polygon segment without an O(n²) cell-pair scan.
    const vertexCells = new Map()
    for (const cell of plots) {
      for (const v of cell.polygon) {
        if (!vertexCells.has(v)) vertexCells.set(v, [])
        vertexCells.get(v).push(cell)
      }
    }

    const edgePointsMap = new Map()
    const segmentsByKey = new Map() // edgeKey → [{v1, v2}]
    const metaByKey     = new Map() // edgeKey → {regionA, regionB}
    const registeredPairs = new Set()

    for (const cell of plots) {
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

}
