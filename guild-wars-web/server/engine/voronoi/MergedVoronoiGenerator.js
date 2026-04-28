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

  generateRawVoronoi(regionCount, worldSize) {
    // Generate unclipped Voronoi cells (used for merging)
    const seedPoints = []
    const delaunayPoints = []

    for (let i = 0; i < regionCount; i++) {
      const x = Math.random() * worldSize
      const y = Math.random() * worldSize
      seedPoints.push({ x, y })
      delaunayPoints.push(new Point(x, y))
    }

    const triangulator = new DelaunayTriangulator(delaunayPoints)
    triangulator.bowyerWatson()

    const regions = []
    for (let i = 0; i < seedPoints.length; i++) {
      const seedPoint = seedPoints[i]
      const delaunayPoint = delaunayPoints[i]

      const trianglesWithSeed = triangulator.triangulation.filter(t =>
        t.vertices.includes(delaunayPoint)
      )

      if (trianglesWithSeed.length === 0) continue

      const circumcenters = trianglesWithSeed.map(t => t.circumcenter)
      const sortedVertices = this.fineGenerator.sortByAngle(seedPoint, circumcenters)

      // NO CLIPPING - keep raw polygon
      regions.push({
        id: i,
        seedPoint,
        polygon: sortedVertices.reverse(), // Reverse for correct winding
        assignedType: null,
        gridX: Math.floor(seedPoint.x / 10),
        gridZ: Math.floor(seedPoint.y / 10),
        description: ''
      })
    }

    return { worldSize, regions, edges: {} }
  }

  generate(regionCount = 15, worldSize = 50) {
    // Generate fine-grained Voronoi cells WITHOUT clipping first
    const fineCount = Math.max(regionCount * 4, 60)
    console.log(`Generating merged Voronoi: ${fineCount} fine cells → ${regionCount} regions`)

    // Generate raw Delaunay/Voronoi without clipping
    const fineVoronoi = this.generateRawVoronoi(fineCount, worldSize)
    const fineCells = fineVoronoi.regions

    // Select seed points from largest fine cells
    const selectedSeeds = this.selectSeeds(fineCells, regionCount, worldSize)
    console.log(`Selected ${selectedSeeds.length} seed points`)

    // Generate proper Voronoi from selected seeds (guarantees no overlap)
    const mergedVoronoi = this.generateVoronoiFromSeeds(selectedSeeds, worldSize)
    const mergedRegions = mergedVoronoi.regions.map((region, idx) => ({
      ...region,
      id: idx
    }))

    // Generate edges for merged regions
    const edges = this.generateEdges(mergedRegions)

    return {
      worldSize,
      regions: mergedRegions,
      edges
    }
  }

  selectSeeds(fineCells, count, worldSize) {
    // Select seeds by largest area (most dominant fine cells)
    const sorted = [...fineCells]
      .map((cell, idx) => ({
        idx,
        cell,
        area: this.polygonArea(cell.polygon)
      }))
      .sort((a, b) => b.area - a.area)

    return sorted.slice(0, count).map(s => s.cell.seedPoint)
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
              startPoint: shared[0],
              endPoint: shared[shared.length - 1],
              assignedType: null
            })
          }
        }
      }
    }

    return Object.fromEntries(edges)
  }

  findSharedEdge(polygon1, polygon2) {
    const shared = []
    for (const v1 of polygon1) {
      for (const v2 of polygon2) {
        const dx = v1.x - v2.x
        const dy = v1.y - v2.y
        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
          shared.push(v1)
          break
        }
      }
    }
    return shared
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
