import { distToSegSq, ptOnSeg, pip } from '../voronoi/VoronoiUtils.js'
import { STREET_HALF_WIDTH } from './StreetVoronoiGenerator.js'


// Street priority for tie-breaking (paved hierarchy: Stone > Brick > Mud).
export const STREET_TYPE_PRIORITY = { Stone: 2, Brick: 1, Mud: 0 }

// The street type bordering the majority of a block's street-facing edges.
// Ties break toward the higher-priority (more paved) type. Returns null if none.
export function majorityStreetType(streetEdges) {
  if (!streetEdges?.length) return null
  const counts = new Map()
  for (const e of streetEdges) counts.set(e.type, (counts.get(e.type) || 0) + 1)
  let best = null, bestN = -1
  for (const [type, n] of counts) {
    if (n > bestN || (n === bestN && (STREET_TYPE_PRIORITY[type] ?? -1) > (STREET_TYPE_PRIORITY[best] ?? -1))) {
      best = type; bestN = n
    }
  }
  return best
}

// For each edge of `vertices`, flag it as street-facing if it lies along a gutter.
// Tests the edge MIDPOINT against each gutter segment (not both endpoints), so an
// edge that spans a gutter node — common where gutters split at junctions or
// dead-end caps — is still caught. Returns [{index, roadId, type}] per such edge.
export function findStreetFacingEdges(vertices, roadEdges) {
  const result = []
  const n = vertices.length
  const tolSq = (STREET_HALF_WIDTH * 0.6) ** 2
  for (let i = 0; i < n; i++) {
    const va = vertices[i], vb = vertices[(i + 1) % n]
    const mx = (va.x + vb.x) / 2, my = (va.y + vb.y) / 2
    for (const re of roadEdges) {
      if (distToSegSq(mx,    my,    re.ax, re.ay, re.bx, re.by) < tolSq ||
          distToSegSq(va.x,  va.y,  re.ax, re.ay, re.bx, re.by) < tolSq ||
          distToSegSq(vb.x,  vb.y,  re.ax, re.ay, re.bx, re.by) < tolSq) {
        result.push({ index: i, roadId: re.roadId, type: re.type })
        break
      }
    }
  }
  return result
}

export default class CityBlockGenerator {
  // Returns { blocks, roadEdges }.
  // blocks: [{id, districtId, vertices, area, streetEdges}]
  // roadEdges: raw gutter road-edge segments, needed by CityPlotGenerator.
  generate(districts, streetGraph) {
    const junctions = streetGraph?.junctions || []

    const { gutterNodes, gutterEdges, roadEdges } = this._gutterGraphFromJunctions(junctions)

    const streetNodes = junctions.map(j => ({ id: j.id, x: j.x, y: j.y }))
    const streetEdges = []
    const seenRoads = new Set()
    for (const j of junctions) {
      for (const conn of j.connections) {
        if (conn.toId <= j.id) continue
        if (String(conn.roadId).startsWith('trade')) continue   // trade roads aren't block-bounding
        const key = `${j.id}_${conn.toId}`
        if (!seenRoads.has(key)) { seenRoads.add(key); streetEdges.push({ nodeA: j.id, nodeB: conn.toId }) }
      }
    }

    const blocks = []
    let blockId = 0

    const faces = this._traceFaces(gutterNodes, gutterEdges)

    for (const vertices of faces) {
      if (vertices.length < 3) continue
      if (this._isRoadFace(vertices, streetNodes, streetEdges)) continue

      let area = 0
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i], b = vertices[(i + 1) % vertices.length]
        area += a.x * b.y - b.x * a.y
      }
      area = Math.abs(area) / 2
      if (area < 1e-6) continue

      const districtId = this._findDistrict(vertices, districts)
      blocks.push({
        id: blockId++,
        districtId,
        blockCorners: vertices,
        area,
        streetEdges: findStreetFacingEdges(vertices, roadEdges),
      })
    }

    console.log(`CityBlockGenerator: ${blocks.length} blocks traced`)
    return { blocks, roadEdges }
  }

  // Returns true if the face is road surface (junction fill or road strip).
  _isRoadFace(vertices, streetNodes, streetEdges) {
    // Use a guaranteed-interior point, not the centroid: a block that notches
    // around a dead-end stub has its centroid land on the stub centerline, which
    // would misclassify the block as road surface. The interior point sits in the
    // block body (a road strip's interior point still lands near its centerline).
    const { x: cx, y: cy } = this._interiorPoint(vertices)
    const rSq = (STREET_HALF_WIDTH * 0.9) ** 2
    const nodeById = new Map(streetNodes.map(n => [n.id, n]))
    for (const n of streetNodes) {
      const dx = cx - n.x, dy = cy - n.y
      if (dx * dx + dy * dy < rSq) return true
    }
    for (const e of streetEdges) {
      const a = nodeById.get(e.nodeA), b = nodeById.get(e.nodeB)
      if (!a || !b) continue
      if (distToSegSq(cx, cy, a.x, a.y, b.x, b.y) < rSq) return true
    }
    return false
  }

  // A point guaranteed to lie strictly inside the simple polygon: midpoint of the
  // widest interior span where a horizontal line at the centroid's y crosses the
  // polygon. Falls back to the centroid for degenerate cases.
  _interiorPoint(vertices) {
    const cy = vertices.reduce((s, v) => s + v.y, 0) / vertices.length
    const xs = []
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i], b = vertices[(i + 1) % vertices.length]
      if ((a.y > cy) !== (b.y > cy)) {
        xs.push(a.x + (cy - a.y) / (b.y - a.y) * (b.x - a.x))
      }
    }
    xs.sort((p, q) => p - q)
    let bestMid = null, bestW = -1
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i]
      if (w > bestW) { bestW = w; bestMid = (xs[i] + xs[i + 1]) / 2 }
    }
    if (bestMid === null) {
      const cx = vertices.reduce((s, v) => s + v.x, 0) / vertices.length
      return { x: cx, y: cy }
    }
    return { x: bestMid, y: cy }
  }

  // Reconstruct a planar gutter graph (nodes + edges) from the junction structure
  // so _traceFaces can find block faces.
  _gutterGraphFromJunctions(junctions) {
    const nodes = []
    const nodeIndex = new Map()

    function getNode(p) {
      const key = `${p.x.toFixed(6)},${p.y.toFixed(6)}`
      if (!nodeIndex.has(key)) {
        const node = { id: nodes.length, x: p.x, y: p.y }
        nodeIndex.set(key, node)
        nodes.push(node)
      }
      return nodeIndex.get(key)
    }

    for (const j of junctions) {
      for (const conn of j.connections) {
        getNode(conn.gutterLeft)
        getNode(conn.gutterRight)
      }
    }

    const seenEdges = new Set()
    const edges = []
    const roadEdges = []
    const junctionById = new Map(junctions.map(j => [j.id, j]))

    function addEdge(a, b) {
      if (a.id === b.id) return
      const key = a.id < b.id ? `${a.id}_${b.id}` : `${b.id}_${a.id}`
      if (!seenEdges.has(key)) { seenEdges.add(key); edges.push({ nodeA: a.id, nodeB: b.id }) }
    }

    for (const j of junctions) {
      // Trade roads must not contribute gutters — no blocks/plots from them.
      const conns = j.connections.filter(c => !String(c.roadId).startsWith('trade'))
      const n = conns.length
      if (n === 0) continue

      for (const conn of conns) {
        if (conn.toId <= j.id) continue
        const j2 = junctionById.get(conn.toId)
        if (!j2) continue
        const conn2 = j2.connections.find(c => c.toId === j.id)
        if (!conn2) continue
        addEdge(getNode(conn.gutterLeft),  getNode(conn2.gutterRight))
        addEdge(getNode(conn.gutterRight), getNode(conn2.gutterLeft))
        roadEdges.push({ roadId: conn.roadId, type: conn.type, ax: conn.gutterLeft.x,  ay: conn.gutterLeft.y,  bx: conn2.gutterRight.x, by: conn2.gutterRight.y })
        roadEdges.push({ roadId: conn.roadId, type: conn.type, ax: conn.gutterRight.x, ay: conn.gutterRight.y, bx: conn2.gutterLeft.x,  by: conn2.gutterLeft.y })
      }

      if (n === 1) {
        // Dead-end cap. Also a gutter — record it so plots front it, not cross it.
        const gl = conns[0].gutterLeft, gr = conns[0].gutterRight
        addEdge(getNode(gr), getNode(gl))
        roadEdges.push({ roadId: `${conns[0].roadId}-cap`, type: conns[0].type, ax: gr.x, ay: gr.y, bx: gl.x, by: gl.y })
      } else {
        // Junction fan mitres — also gutters bounding the blocks.
        for (let i = 0; i < n; i++) {
          const a = conns[i].gutterLeft, b = conns[(i + 1) % n].gutterRight
          addEdge(getNode(a), getNode(b))
          roadEdges.push({ roadId: `${conns[i].roadId}-fan`, type: conns[i].type, ax: a.x, ay: a.y, bx: b.x, by: b.y })
        }
      }
    }

    return { gutterNodes: nodes, gutterEdges: edges, roadEdges }
  }

  // Trace all interior faces of the planar gutter graph.
  // Interior faces have clockwise winding (negative signed area).
  _traceFaces(nodes, edges) {
    if (!nodes.length || !edges.length) return []

    const nodeById = new Map(nodes.map(n => [n.id, n]))

    const adjSets = new Map(nodes.map(n => [n.id, new Set()]))
    for (const edge of edges) {
      adjSets.get(edge.nodeA)?.add(edge.nodeB)
      adjSets.get(edge.nodeB)?.add(edge.nodeA)
    }
    const adj = new Map([...adjSets.entries()].map(([id, s]) => [id, [...s]]))

    for (const [nodeId, neighbors] of adj) {
      const node = nodeById.get(nodeId)
      if (!node) continue
      neighbors.sort((a, b) => {
        const na = nodeById.get(a), nb = nodeById.get(b)
        if (!na || !nb) return 0
        const angA = Math.atan2(na.y - node.y, na.x - node.x)
        const angB = Math.atan2(nb.y - node.y, nb.x - node.x)
        const diff = angA - angB
        if (Math.abs(diff) > 1e-9) return diff
        const dA = (na.x - node.x) ** 2 + (na.y - node.y) ** 2
        const dB = (nb.x - node.x) ** 2 + (nb.y - node.y) ** 2
        return dA !== dB ? dA - dB : a - b
      })
    }

    // Most-clockwise turn traversal to trace right-hand faces.
    const getNext = (from, to) => {
      const fromNode = nodeById.get(from), toNode = nodeById.get(to)
      if (!fromNode || !toNode) return null
      const reverseAngle = Math.atan2(fromNode.y - toNode.y, fromNode.x - toNode.x)
      const neighbors = adj.get(to) || []
      let best = null, bestDiff = Infinity
      for (const nb of neighbors) {
        const nbNode = nodeById.get(nb)
        if (!nbNode) continue
        const outAngle = Math.atan2(nbNode.y - toNode.y, nbNode.x - toNode.x)
        let diff = (outAngle - reverseAngle + 2 * Math.PI) % (2 * Math.PI)
        if (diff < 1e-10) diff = 2 * Math.PI
        const isBetter = diff < bestDiff ||
          (diff === bestDiff && best === null) ||
          (diff === bestDiff && best === from && nb !== from) ||
          (diff === bestDiff && nb !== from && best !== from && nb < best)
        if (isBetter) { bestDiff = diff; best = nb }
      }
      return best
    }

    const visited = new Set()
    const faces   = []
    const maxSteps = Math.min(200, nodes.length + 2)

    for (const edge of edges) {
      for (const [u, v] of [[edge.nodeA, edge.nodeB], [edge.nodeB, edge.nodeA]]) {
        if (visited.has(`${u},${v}`)) continue

        const faceVerts = []
        let cu = u, cv = v, steps = 0

        do {
          visited.add(`${cu},${cv}`)
          const node = nodeById.get(cu)
          if (node) faceVerts.push({ x: node.x, y: node.y })
          const next = getNext(cu, cv)
          if (next == null) break
          cu = cv; cv = next
        } while ((cu !== u || cv !== v) && ++steps < maxSteps)

        if (faceVerts.length < 3) continue

        let area = 0
        for (let i = 0; i < faceVerts.length; i++) {
          const a = faceVerts[i], b = faceVerts[(i + 1) % faceVerts.length]
          area += a.x * b.y - b.x * a.y
        }
        // Keep clockwise (negative-area) faces, but reject any that encloses
        // another gutter node — those are outer/wraparound faces, not minimal
        // blocks. A true block face is empty of interior nodes.
        if (area < 0 && !this._enclosesNode(faceVerts, nodes)) faces.push(faceVerts)
      }
    }

    return faces
  }

  // True if any gutter node lies strictly inside `poly` (further than a small
  // margin from every edge). Nodes on the face's own boundary sit at distance ~0
  // and are naturally excluded by the margin.
  _enclosesNode(poly, nodes) {
    const MARGIN_SQ = 0.01 // 0.1 units
    for (const nd of nodes) {
      if (!pip(nd.x, nd.y, poly)) continue
      let minD2 = Infinity
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length]
        const d2 = distToSegSq(nd.x, nd.y, a.x, a.y, b.x, b.y)
        if (d2 < minD2) minD2 = d2
        if (minD2 <= MARGIN_SQ) break
      }
      if (minD2 > MARGIN_SQ) return true
    }
    return false
  }

  _findDistrict(vertices, districts) {
    const cx = vertices.reduce((s, v) => s + v.x, 0) / vertices.length
    const cy = vertices.reduce((s, v) => s + v.y, 0) / vertices.length
    for (const d of districts) {
      if (pip(cx, cy, d.polygon)) return d.id
    }
    return null
  }
}
