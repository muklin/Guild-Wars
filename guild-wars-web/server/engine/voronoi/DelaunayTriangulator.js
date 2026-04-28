import Point from './Point.js'
import Triangle from './Triangle.js'
import Edge from './Edge.js'

export default class DelaunayTriangulator {
  constructor(points) {
    this.points = points
    this.triangulation = []
    this.pointIdCounter = 0

    // Assign unique IDs to points for edge canonicalization
    this.points.forEach(p => {
      p._id = this.pointIdCounter++
    })
  }

  bowyerWatson() {
    // Create super-triangle that contains all points
    const minX = Math.min(...this.points.map(p => p.x))
    const maxX = Math.max(...this.points.map(p => p.x))
    const minY = Math.min(...this.points.map(p => p.y))
    const maxY = Math.max(...this.points.map(p => p.y))

    const dx = (maxX - minX) * 0.1 || 1
    const dy = (maxY - minY) * 0.1 || 1

    const p1 = new Point(minX - dx, minY - dy * 3)
    const p2 = new Point(maxX + dx, minY - dy * 3)
    const p3 = new Point((minX + maxX) / 2, maxY + dy * 3)

    p1._id = this.pointIdCounter++
    p2._id = this.pointIdCounter++
    p3._id = this.pointIdCounter++

    const superTriangle = new Triangle(p1, p2, p3)
    this.triangulation.push(superTriangle)

    // Add points one by one
    for (let pointIdx = 0; pointIdx < this.points.length; pointIdx++) {
      const point = this.points[pointIdx]
      const badTriangles = []

      // Find all triangles whose circumcircle contains the point
      for (const triangle of this.triangulation) {
        if (triangle.isPointInsideCircumcircle(point)) {
          badTriangles.push(triangle)
        }
      }

      // Find the polygon hole (edges of bad triangles not shared with other bad triangles)
      const polygon = []
      const edgeMap = new Map()

      for (const triangle of badTriangles) {
        for (let i = 0; i < 3; i++) {
          const edge = new Edge(triangle.vertices[i], triangle.vertices[(i + 1) % 3])
          const key = edge.getCanonicalKey()

          if (edgeMap.has(key)) {
            edgeMap.delete(key)
          } else {
            edgeMap.set(key, edge)
          }
        }
      }

      for (const edge of edgeMap.values()) {
        polygon.push(edge)
      }

      // Remove bad triangles
      this.triangulation = this.triangulation.filter(t => !badTriangles.includes(t))

      // Add new triangles formed by polygon edges and new point
      for (const edge of polygon) {
        const newTriangle = new Triangle(edge.point1, edge.point2, point)
        this.triangulation.push(newTriangle)
      }
    }

    // Remove triangles that use super-triangle vertices
    this.triangulation = this.triangulation.filter(triangle =>
      !triangle.vertices.some(v => v === p1 || v === p2 || v === p3)
    )
  }

  generateEdgesFromDelaunay() {
    const edgeMap = new Map()

    // Collect all edges and count how many triangles use them
    for (const triangle of this.triangulation) {
      for (let i = 0; i < 3; i++) {
        const p1 = triangle.vertices[i]
        const p2 = triangle.vertices[(i + 1) % 3]
        const edge = new Edge(p1, p2)
        const key = edge.getCanonicalKey()

        if (!edgeMap.has(key)) {
          edgeMap.set(key, [])
        }
        edgeMap.get(key).push(edge)
      }
    }

    // Return edges used by exactly one triangle (boundary edges)
    const boundaryEdges = []
    for (const edges of edgeMap.values()) {
      if (edges.length === 1) {
        boundaryEdges.push(edges[0])
      }
    }

    return boundaryEdges
  }

  static createFromPoints(points) {
    const triangulator = new DelaunayTriangulator(points)
    triangulator.bowyerWatson()
    return triangulator
  }
}
