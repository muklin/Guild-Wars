import Point from './Point.js'
import DelaunayTriangulator from './DelaunayTriangulator.js'

export default class CityVoronoiGenerator {
  generate(cityPolygon, districtCount = 6) {
    // Estimate city bounds from polygon
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity

    if (Array.isArray(cityPolygon)) {
      for (const v of cityPolygon) {
        const x = v.x !== undefined ? v.x : v.z
        const y = v.y !== undefined ? v.y : v.z
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    } else {
      // Fallback bounds
      minX = 10
      maxX = 40
      minY = 10
      maxY = 40
    }

    // For now, use grid-based districts which is reliable
    // TODO: implement proper Voronoi-based subdivision once Delaunay is fixed
    return this.generateGridDistricts(minX, maxX, minY, maxY, districtCount)
  }

  generateGridDistricts(minX, maxX, minY, maxY, districtCount) {
    const districts = []
    const cols = Math.ceil(Math.sqrt(districtCount))
    const rows = Math.ceil(districtCount / cols)
    const cellWidth = (maxX - minX) / cols
    const cellHeight = (maxY - minY) / rows

    let districtId = 0
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (districtId >= districtCount) break

        const x = minX + col * cellWidth + cellWidth / 2
        const y = minY + row * cellHeight + cellHeight / 2

        const boundary = [
          { x: minX + col * cellWidth, y: minY + row * cellHeight },
          { x: minX + (col + 1) * cellWidth, y: minY + row * cellHeight },
          { x: minX + (col + 1) * cellWidth, y: minY + (row + 1) * cellHeight },
          { x: minX + col * cellWidth, y: minY + (row + 1) * cellHeight }
        ]

        districts.push({
          id: districtId,
          centerPosition: { x, y },
          boundary,
          controllingGuildId: -1,
          class: 'Neutral',
          factionLabel: `District ${districtId}`
        })

        districtId++
      }
    }

    return { districts }
  }

  sortByAngle(center, points) {
    return points.sort((a, b) => {
      const angleA = Math.atan2(a.y - center.y, a.x - center.x)
      const angleB = Math.atan2(b.y - center.y, b.x - center.x)
      return angleA - angleB
    })
  }

  clipToPolygon(polygon, minX, maxX, minY, maxY) {
    if (polygon.length < 3) return polygon

    let output = [...polygon]

    // Clip against each boundary edge (axis-aligned rectangle)
    output = this.clipAgainstEdge(output, true, minX, minY, maxY) // Left
    if (output.length < 3) return output

    output = this.clipAgainstEdge(output, true, maxX, minY, maxY) // Right
    if (output.length < 3) return output

    output = this.clipAgainstEdge(output, false, minY, minX, maxX) // Bottom
    if (output.length < 3) return output

    output = this.clipAgainstEdge(output, false, maxY, minX, maxX) // Top

    return output
  }

  clipAgainstEdge(polygon, isVertical, edgePos, min, max) {
    const output = []

    for (let i = 0; i < polygon.length; i++) {
      const current = polygon[i]
      const next = polygon[(i + 1) % polygon.length]

      const currentInside = isVertical
        ? (edgePos === min ? current.x >= edgePos - 0.01 : current.x <= edgePos + 0.01)
        : (edgePos === min ? current.y >= edgePos - 0.01 : current.y <= edgePos + 0.01)

      const nextInside = isVertical
        ? (edgePos === min ? next.x >= edgePos - 0.01 : next.x <= edgePos + 0.01)
        : (edgePos === min ? next.y >= edgePos - 0.01 : next.y <= edgePos + 0.01)

      if (nextInside) {
        if (!currentInside) {
          const intersection = this.getIntersection(current, next, isVertical, edgePos)
          if (intersection) output.push(intersection)
        }
        output.push(next)
      } else if (currentInside) {
        const intersection = this.getIntersection(current, next, isVertical, edgePos)
        if (intersection) output.push(intersection)
      }
    }

    return output
  }

  getIntersection(p1, p2, isVertical, edgePos) {
    if (isVertical) {
      const denom = p2.x - p1.x
      if (Math.abs(denom) < 0.0001) return null
      const t = (edgePos - p1.x) / denom
      if (t < -0.0001 || t > 1.0001) return null
      return {
        x: edgePos,
        y: p1.y + t * (p2.y - p1.y)
      }
    } else {
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
}
