export default class Triangle {
  constructor(vertex1, vertex2, vertex3) {
    this.vertices = [vertex1, vertex2, vertex3]
    this.edges = []
    this.circumcenter = null
    this.radiusSquared = 0

    // Ensure counter-clockwise winding
    if (!this.isCounterClockwise()) {
      this.vertices = [vertex1, vertex3, vertex2]
    }

    this.updateCircumcircle()
  }

  isCounterClockwise() {
    const p1 = this.vertices[0]
    const p2 = this.vertices[1]
    const p3 = this.vertices[2]

    const cross = (p2.x - p1.x) * (p3.y - p1.y) - (p3.x - p1.x) * (p2.y - p1.y)
    return cross > 0
  }

  updateCircumcircle() {
    const p1 = this.vertices[0]
    const p2 = this.vertices[1]
    const p3 = this.vertices[2]

    const ax = p1.x
    const ay = p1.y
    const bx = p2.x
    const by = p2.y
    const cx = p3.x
    const cy = p3.y

    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))

    if (Math.abs(d) < 0.0001) {
      // Degenerate triangle
      this.circumcenter = { x: 0, y: 0 }
      this.radiusSquared = 0
      return
    }

    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d

    this.circumcenter = { x: ux, y: uy }

    const dx = ax - ux
    const dy = ay - uy
    this.radiusSquared = dx * dx + dy * dy
  }

  isPointInsideCircumcircle(point) {
    if (!this.circumcenter) return false
    const dx = point.x - this.circumcenter.x
    const dy = point.y - this.circumcenter.y
    const distSquared = dx * dx + dy * dy
    return distSquared < this.radiusSquared
  }

  shareEdgeWith(other) {
    // Check if triangles share an edge
    const sharedVertices = this.vertices.filter(v =>
      other.vertices.some(ov => v === ov)
    )
    return sharedVertices.length === 2
  }

  toString() {
    return `Triangle(${this.vertices[0]}, ${this.vertices[1]}, ${this.vertices[2]})`
  }
}
