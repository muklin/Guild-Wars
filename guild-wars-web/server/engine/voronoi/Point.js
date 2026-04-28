export default class Point {
  constructor(x, y) {
    this.x = x
    this.y = y
    this.adjacentTriangles = new Set()
  }

  equals(other) {
    return this.x === other.x && this.y === other.y
  }

  toString() {
    return `Point(${this.x}, ${this.y})`
  }
}
