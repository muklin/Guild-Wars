export default class Edge {
  constructor(point1, point2) {
    this.point1 = point1
    this.point2 = point2
    this.centre1 = null
  }

  equals(other) {
    if (!other) return false
    const samePoints = this.point1 === other.point1 && this.point2 === other.point2
    const samePointsReversed = this.point1 === other.point2 && this.point2 === other.point1
    return samePoints || samePointsReversed
  }

  getCanonicalKey() {
    // Create a stable key for this edge (order-independent)
    const id1 = this.point1._id
    const id2 = this.point2._id
    return id1 < id2 ? `${id1}_${id2}` : `${id2}_${id1}`
  }

  toString() {
    return `Edge(${this.point1}, ${this.point2})`
  }
}
