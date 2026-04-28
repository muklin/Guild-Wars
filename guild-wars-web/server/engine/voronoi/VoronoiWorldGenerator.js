import Point from './Point.js'
import DelaunayTriangulator from './DelaunayTriangulator.js'

export default class VoronoiWorldGenerator {
  constructor() {
    this.worldSize = 50
  }

  generate(regionCount = 15, worldSize = 50) {
    this.worldSize = worldSize

    // Generate random seed points
    const seedPoints = []
    const delaunayPoints = []
    const random = Math.random.bind(Math)

    const borderMargin = 0
    for (let i = 0; i < regionCount; i++) {
      const x = random() * (worldSize - 2 * borderMargin) + borderMargin
      const y = random() * (worldSize - 2 * borderMargin) + borderMargin

      seedPoints.push({ x, y })
      delaunayPoints.push(new Point(x, y))
    }

    // Run Bowyer-Watson Delaunay triangulation
    const triangulator = new DelaunayTriangulator(delaunayPoints)
    triangulator.bowyerWatson()

    // Build Voronoi cells from circumcenters
    const regions = []

    for (let i = 0; i < seedPoints.length; i++) {
      const seedPoint = seedPoints[i]
      const delaunayPoint = delaunayPoints[i]

      // Find all triangles containing this seed point
      const trianglesWithSeed = triangulator.triangulation.filter(t =>
        t.vertices.includes(delaunayPoint)
      )

      if (trianglesWithSeed.length === 0) continue

      // Collect circumcenters and sort by angle
      const circumcenters = trianglesWithSeed.map(t => t.circumcenter)
      const sortedVertices = this.sortByAngle(seedPoint, circumcenters)

      // Clip polygon to world bounds
      const clippedVertices = this.sutherlandHodgmanClip(sortedVertices, worldSize)

      if (clippedVertices.length >= 3) {
        // Validate polygon area is reasonable
        const area = this.polygonArea(clippedVertices)
        const maxReasonableArea = worldSize * worldSize

        if (area > maxReasonableArea * 0.5) {
          console.warn(`Region ${i}: clipped polygon area ${area.toFixed(2)} is suspiciously large (>50% of world)`)
        }

        const region = {
          id: i,
          seedPoint,
          polygon: clippedVertices,
          assignedType: null,
          gridX: Math.floor(seedPoint.x / 10),
          gridZ: Math.floor(seedPoint.y / 10),
          description: ''
        }
        regions.push(region)
      }
    }

    // Identify city region (largest central region)
    const cityRegion = this.findCityRegion(regions, worldSize)
    if (cityRegion) {
      cityRegion.assignedType = 'City'
    }

    // Log region statistics
    console.log(`Generated ${regions.length} regions:`)
    regions.forEach(r => {
      const area = this.polygonArea(r.polygon)
      const bounds = this.getPolygonBounds(r.polygon)
      const verts = r.polygon.map(v => `(${v.x.toFixed(1)},${v.y.toFixed(1)})`).join(' ')
      console.log(`  Region ${r.id}: ${r.polygon.length} verts, area=${area.toFixed(2)}, bounds=[${bounds.minX.toFixed(1)}-${bounds.maxX.toFixed(1)}, ${bounds.minY.toFixed(1)}-${bounds.maxY.toFixed(1)}]`)
      console.log(`    Vertices: ${verts}`)
    })

    // Generate edges between adjacent regions
    const edges = this.generateEdges(regions)

    return {
      worldSize,
      regions,
      edges
    }
  }

  sortByAngle(center, points) {
    return points.sort((a, b) => {
      const angleA = Math.atan2(a.y - center.y, a.x - center.x)
      const angleB = Math.atan2(b.y - center.y, b.x - center.x)
      return angleA - angleB
    })
  }

  sutherlandHodgmanClip(polygon, worldSize) {
    if (polygon.length < 3) return polygon

    let output = [...polygon]

    // Clip against each boundary edge
    output = this.clipAgainstEdge(output, true, 0, worldSize) // Left edge (x = 0)
    if (output.length < 3) return output

    output = this.clipAgainstEdge(output, true, worldSize, worldSize) // Right edge (x = worldSize)
    if (output.length < 3) return output

    output = this.clipAgainstEdge(output, false, 0, worldSize) // Bottom edge (y = 0)
    if (output.length < 3) return output

    output = this.clipAgainstEdge(output, false, worldSize, worldSize) // Top edge (y = worldSize)

    return output
  }

  clipAgainstEdge(polygon, isVerticalEdge, edgePos, worldSize) {
    if (polygon.length === 0) return polygon

    const output = []

    for (let i = 0; i < polygon.length; i++) {
      const current = polygon[i]
      const next = polygon[(i + 1) % polygon.length]

      const currentInside = this.isInsideEdge(current, isVerticalEdge, edgePos)
      const nextInside = this.isInsideEdge(next, isVerticalEdge, edgePos)

      if (nextInside) {
        if (!currentInside) {
          // Entering the inside region
          const intersection = this.lineIntersection(current, next, isVerticalEdge, edgePos)
          if (intersection) output.push(intersection)
        }
        output.push(next)
      } else if (currentInside) {
        // Leaving the inside region
        const intersection = this.lineIntersection(current, next, isVerticalEdge, edgePos)
        if (intersection) output.push(intersection)
      }
    }

    return output
  }

  isInsideEdge(point, isVerticalEdge, edgePos) {
    if (isVerticalEdge) {
      // Vertical edge: left (x=0) inside if x >= 0, right (x=worldSize) inside if x <= worldSize
      return edgePos === 0 ? point.x >= -0.01 : point.x <= edgePos + 0.01
    } else {
      // Horizontal edge: bottom (y=0) inside if y >= 0, top (y=worldSize) inside if y <= worldSize
      return edgePos === 0 ? point.y >= -0.01 : point.y <= edgePos + 0.01
    }
  }

  lineIntersection(p1, p2, isVerticalEdge, edgePos) {
    if (isVerticalEdge) {
      // Intersection with vertical edge at x = edgePos
      const denom = p2.x - p1.x
      if (Math.abs(denom) < 0.0001) return null
      const t = (edgePos - p1.x) / denom
      if (t < -0.0001 || t > 1.0001) return null
      return {
        x: edgePos,
        y: p1.y + t * (p2.y - p1.y)
      }
    } else {
      // Intersection with horizontal edge at y = edgePos
      const denom = p2.y - p1.y
      if (Math.abs(denom) < 0.0001) return null
      const t = (edgePos - p1.y) / denom
      if (t < -0.0001 || t > 1.0001) return null
      return {
        x: p1.x + t * (p2.x - p1.x),
        y: edgePos
      }
    }
  }

  findCityRegion(regions, worldSize) {
    const margin = 0.5

    // Find regions that don't touch the map boundary
    const centralRegions = regions.filter(r =>
      !r.polygon.some(v =>
        v.x < margin || v.x > (worldSize - margin) ||
        v.y < margin || v.y > (worldSize - margin)
      )
    )

    if (centralRegions.length === 0) {
      // Fallback: use largest region
      return regions.reduce((a, b) =>
        a.polygon.length > b.polygon.length ? a : b
      )
    }

    // Select the largest central region
    return centralRegions.reduce((a, b) =>
      a.polygon.length > b.polygon.length ? a : b
    )
  }

  generateEdges(regions) {
    const edges = {}
    let edgeId = 0
    const processed = new Set()

    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        if (this.areRegionsAdjacent(regions[i], regions[j])) {
          const key = `${Math.min(i, j)}_${Math.max(i, j)}`
          if (!processed.has(key)) {
            processed.add(key)
            const sharedVertices = this.findSharedBoundaryVertices(regions[i], regions[j])

            if (sharedVertices.length >= 2) {
              edges[edgeId] = {
                id: edgeId,
                regionA: regions[i].id,
                regionB: regions[j].id,
                startPoint: sharedVertices[0],
                endPoint: sharedVertices[sharedVertices.length - 1],
                assignedType: null
              }
              edgeId++
            }
          }
        }
      }
    }

    return edges
  }

  areRegionsAdjacent(a, b) {
    const proximity = 1.5

    for (const vertexA of a.polygon) {
      for (const vertexB of b.polygon) {
        const dist = Math.hypot(vertexA.x - vertexB.x, vertexA.y - vertexB.y)
        if (dist < proximity) return true
      }
    }

    return false
  }

  findSharedBoundaryVertices(a, b) {
    const shared = []
    const threshold = 1.0

    for (const vertexA of a.polygon) {
      for (const vertexB of b.polygon) {
        const dist = Math.hypot(vertexA.x - vertexB.x, vertexA.y - vertexB.y)
        if (dist < threshold) {
          // Check if we already have this vertex
          const alreadyAdded = shared.some(v =>
            Math.hypot(v.x - vertexA.x, v.y - vertexA.y) < 0.01
          )
          if (!alreadyAdded) {
            shared.push(vertexA)
          }
        }
      }
    }

    // Sort shared vertices along the line connecting them
    if (shared.length >= 2) {
      const dir = {
        x: shared[shared.length - 1].x - shared[0].x,
        y: shared[shared.length - 1].y - shared[0].y
      }
      const dirLength = Math.hypot(dir.x, dir.y)
      if (dirLength > 0) {
        dir.x /= dirLength
        dir.y /= dirLength
        shared.sort((p1, p2) => {
          const dot1 = (p1.x - shared[0].x) * dir.x + (p1.y - shared[0].y) * dir.y
          const dot2 = (p2.x - shared[0].x) * dir.x + (p2.y - shared[0].y) * dir.y
          return dot1 - dot2
        })
      }
    }

    return shared
  }

  polygonArea(polygon) {
    // Shoelace formula for polygon area
    let area = 0
    for (let i = 0; i < polygon.length; i++) {
      const p1 = polygon[i]
      const p2 = polygon[(i + 1) % polygon.length]
      area += p1.x * p2.y - p2.x * p1.y
    }
    return Math.abs(area) / 2
  }

  getPolygonBounds(polygon) {
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    polygon.forEach(p => {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    })
    return { minX, maxX, minY, maxY }
  }
}
