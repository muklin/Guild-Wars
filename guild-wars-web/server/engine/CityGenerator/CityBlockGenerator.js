import { distToSegSq, ptOnSeg, pip } from '../voronoi/VoronoiUtils.js'
import { STREET_HALF_WIDTH, getDistrictParams, halfWidthForDistrict } from './StreetVoronoiGenerator.js'


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
    // Use midpoint only — NOT individual endpoints. A "transition" edge that
    // runs perpendicular from a gutter vertex into the plot interior has one
    // endpoint exactly on the gutter (dist = 0), which would falsely flag it
    // as street-facing and exclude it from fences. The midpoint of such an
    // edge is halfway into the interior, well outside the tolerance.
    const mx = (va.x + vb.x) / 2, my = (va.y + vb.y) / 2
    for (const re of roadEdges) {
      if (distToSegSq(mx, my, re.ax, re.ay, re.bx, re.by) < tolSq) {
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
    const districtById = new Map(districts.map(d => [d.id, d]))

    const allFaces = this._traceFaces(gutterNodes, gutterEdges)
    const roadFacePolys = []

    for (const rawVertices of allFaces) {
      if (rawVertices.length < 3) continue
      if (this._isRoadFace(rawVertices, streetNodes, streetEdges)) {
        roadFacePolys.push(rawVertices)
        continue
      }

      // High-valence junctions (4+ roads meeting at a sharp angle) sometimes bevel a
      // miter instead of spiking it (StreetVoronoiGenerator.buildJunctions, MITER_LIMIT)
      // — correct for the street/gutter mesh itself, but it leaves a small reflex
      // (concave) vertex right at the junction that _traceFaces then bakes into the
      // BLOCK polygon, propagating into every plot/wing built from it as a notch. Strip
      // those out here — junction-scale relative to the LOCAL street width (districts
      // can now have very different street_width values — see halfWidthForDistrict —
      // so a fixed STREET_HALF_WIDTH-based threshold missed notches at a wide-street
      // district's junctions entirely, letting the road visibly bend into the block/
      // plot there) — so a genuine large-scale concave block shape (e.g. an L-shaped
      // block from the street layout itself) is left untouched. This only affects
      // blockCorners, not the underlying junction/gutter data, so street/gutter
      // rendering is unaffected. District is found from the RAW vertices first since
      // the notch limit needs to know which district this block belongs to.
      const districtId = this._findDistrict(rawVertices, districts)
      const notchLimit = Math.max(halfWidthForDistrict(districtById.get(districtId)), STREET_HALF_WIDTH) * 2.5
      const vertices = this._simplifyReflexNotches(rawVertices, notchLimit)
      if (vertices.length < 3) continue

      let area = 0
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i], b = vertices[(i + 1) % vertices.length]
        area += a.x * b.y - b.x * a.y
      }
      area = Math.abs(area) / 2
      if (area < 1e-6) continue

      blocks.push({
        id: blockId++,
        districtId,
        blockCorners: vertices,
        area,
        streetEdges: findStreetFacingEdges(vertices, roadEdges),
      })
    }

    // Mark squares before merging so _mergeSquareClusters can identify them.
    // markSquareBlocks() in PlotVoronoiGenerator is still called from SetupPhase
    // for any remaining small blocks; it is a no-op on already-marked blocks.
    for (const block of blocks) {
      const params = getDistrictParams(districtById.get(block.districtId))
      if (block.area < params.square_threshhold) block.blockType = 'square'
    }

    this._mergeSquareClusters(blocks, roadFacePolys, roadEdges)

    console.log(`CityBlockGenerator: ${blocks.length} blocks traced`)
    return { blocks, roadEdges }
  }

  // Removes shallow reflex (concave) vertices from a traced block polygon — see the
  // call site comment in generate() for why these appear. A vertex is dropped (bridging
  // directly between its neighbours) only if it's BOTH reflex AND shallow (its
  // perpendicular distance from the chord between its neighbours is small relative to
  // `notchLimit`, the calling district's own actual street half-width — districts can
  // have very different street_width values now, so this is NOT just STREET_HALF_WIDTH
  // anymore) — a genuine large-scale concave block shape stays untouched. Iterative:
  // removing one vertex changes the local geometry around its former neighbours, so
  // each pass re-scans from scratch until nothing more qualifies.
  _simplifyReflexNotches(vertices, notchLimit = STREET_HALF_WIDTH * 2.5) {
    const NOTCH_DEPTH_LIMIT = notchLimit
    let verts = vertices
    let changed = true
    let guard = 0
    while (changed && verts.length > 3 && guard++ < 20) {
      changed = false
      const n = verts.length
      for (let i = 0; i < n; i++) {
        const A = verts[(i - 1 + n) % n], B = verts[i], C = verts[(i + 1) % n]
        // Z-component of (B-A)×(C-B): positive = left turn = reflex, for the CW
        // (negative-area) winding _traceFaces produces.
        const cross = (B.x - A.x) * (C.y - B.y) - (B.y - A.y) * (C.x - B.x)
        if (cross <= 0) continue
        const acx = C.x - A.x, acy = C.y - A.y
        const acLen = Math.hypot(acx, acy) || 1
        const dist = Math.abs((B.x - A.x) * acy - (B.y - A.y) * acx) / acLen
        if (dist < NOTCH_DEPTH_LIMIT) {
          verts = verts.slice(0, i).concat(verts.slice(i + 1))
          changed = true
          break
        }
      }
    }
    return verts
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

  // Coalesce adjacent square blocks by removing the streets between them and
  // filling the combined area with a single "square" polygon.
  //
  // Algorithm:
  //   1. Build a directed half-edge → blockId map from every block's boundary.
  //   2. For each road-surface face, look up the two blocks adjacent to it (via
  //      the reverse of each of its directed half-edges). If both are squares,
  //      the road face is a "square–square street" to be absorbed.
  //   3. BFS over the square–square adjacency graph to find connected clusters.
  //   4. Union every cluster's block polygons + connecting road-face polygons
  //      via directed-edge cancellation (shared interior edges cancel; the
  //      remaining outer edges form the merged boundary).
  //   5. Replace original cluster blocks with the merged square; drop clusters
  //      whose merged boundary has no street-facing edge (rule 2: no street access).
  //
  // Mutates `blocks` in place.
  _mergeSquareClusters(blocks, roadFacePolys, roadEdges) {
    const squareSet = new Set(blocks.filter(b => b.blockType === 'square').map(b => b.id))
    if (squareSet.size < 2 || !roadFacePolys.length) return

    const blockById = new Map(blocks.map(b => [b.id, b]))

    // Directed half-edge key: "x1,y1_x2,y2" using 6dp to match gutter-node positions.
    const pk  = (p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`
    const hek = (a, b) => `${pk(a)}_${pk(b)}`

    // Map every directed block-boundary edge to the block that owns it.
    const halfEdgeToBlock = new Map()
    for (const block of blocks) {
      const c = block.blockCorners, n = c.length
      for (let i = 0; i < n; i++)
        halfEdgeToBlock.set(hek(c[i], c[(i + 1) % n]), block.id)
    }

    // For each road face, find adjacent blocks via the reverse of its directed edges.
    // Only proceed when exactly two distinct square blocks adjoin the face.
    const squareAdj    = new Map()  // blockId → Set<blockId>
    const streetByPair = new Map()  // "minId_maxId" → [roadFacePoly, ...]

    for (const rfPoly of roadFacePolys) {
      const n = rfPoly.length
      const adjIds = new Set()
      for (let i = 0; i < n; i++) {
        const bid = halfEdgeToBlock.get(hek(rfPoly[(i + 1) % n], rfPoly[i]))
        if (bid != null) adjIds.add(bid)
      }
      if (adjIds.size !== 2) continue
      const [idA, idB] = [...adjIds]
      if (!squareSet.has(idA) || !squareSet.has(idB)) continue

      if (!squareAdj.has(idA)) squareAdj.set(idA, new Set())
      if (!squareAdj.has(idB)) squareAdj.set(idB, new Set())
      squareAdj.get(idA).add(idB)
      squareAdj.get(idB).add(idA)

      const pairKey = idA < idB ? `${idA}_${idB}` : `${idB}_${idA}`
      if (!streetByPair.has(pairKey)) streetByPair.set(pairKey, [])
      streetByPair.get(pairKey).push(rfPoly)
    }

    if (!squareAdj.size) return

    // BFS: find connected clusters of mutually adjacent squares.
    const visited  = new Set()
    const clusters = []
    for (const bid of squareSet) {
      if (visited.has(bid) || !squareAdj.has(bid)) continue
      const cluster = [], queue = [bid]
      visited.add(bid)
      while (queue.length) {
        const cur = queue.shift()
        cluster.push(cur)
        for (const nb of squareAdj.get(cur))
          if (!visited.has(nb)) { visited.add(nb); queue.push(nb) }
      }
      if (cluster.length >= 2) clusters.push(cluster)
    }
    if (!clusters.length) return

    // Union polygons and replace original blocks.
    let nextId  = blocks.reduce((m, b) => Math.max(m, b.id), -1) + 1
    const toRemove = new Set()
    const toAdd    = []

    for (const cluster of clusters) {
      const polys = cluster.map(id => blockById.get(id).blockCorners)
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          const pk2 = cluster[i] < cluster[j]
            ? `${cluster[i]}_${cluster[j]}` : `${cluster[j]}_${cluster[i]}`
          polys.push(...(streetByPair.get(pk2) || []))
        }
      }

      const merged = this._unionPolygons(polys)
      if (!merged) continue

      cluster.forEach(id => toRemove.add(id))

      const se = findStreetFacingEdges(merged, roadEdges)
      if (!se.length) continue   // rule 2: merged area has no street — drop it

      toAdd.push({
        id: nextId++,
        districtId: blockById.get(cluster[0]).districtId,
        blockCorners: merged,
        area: Math.abs(this._signedArea(merged)),
        blockType: 'square',
        streetEdges: se,
      })
    }

    for (let i = blocks.length - 1; i >= 0; i--)
      if (toRemove.has(blocks[i].id)) blocks.splice(i, 1)
    blocks.push(...toAdd)

    const skipped = clusters.length - toAdd.length
    console.log(
      `mergeSquareClusters: ${toAdd.length} merged squares from ${clusters.length} clusters` +
      ` (${toRemove.size} originals absorbed${skipped ? `, ${skipped} dropped — no street access` : ''})`
    )
  }

  // Union an array of polygons using directed-edge cancellation.
  // All inputs are normalised to CCW before processing.
  // Returns the largest closed boundary polygon, or null on failure.
  _unionPolygons(polys) {
    if (!polys?.length) return null
    const EPS2 = 1e-8

    const canon = []
    const keyOf = (p) => {
      for (let i = 0; i < canon.length; i++) {
        const dx = canon[i].x - p.x, dy = canon[i].y - p.y
        if (dx * dx + dy * dy < EPS2) return i
      }
      canon.push({ x: p.x, y: p.y })
      return canon.length - 1
    }

    const sa = (poly) => {
      let a = 0
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length]
        a += p.x * q.y - q.x * p.y
      }
      return a / 2
    }

    // Normalise each polygon to CCW (positive area) then cancel shared reverse edges.
    const counts = new Map()
    for (const poly of polys) {
      if (!poly?.length) continue
      let pts = [...poly]
      if (sa(pts) < 0) pts.reverse()
      const idx = pts.map(keyOf)
      for (let i = 0; i < idx.length; i++) {
        const a = idx[i], b = idx[(i + 1) % idx.length]
        if (a === b) continue
        const fwd = `${a}_${b}`, rev = `${b}_${a}`
        if (counts.has(rev)) {
          const n = counts.get(rev) - 1
          if (n <= 0) counts.delete(rev); else counts.set(rev, n)
        } else {
          counts.set(fwd, (counts.get(fwd) || 0) + 1)
        }
      }
    }
    if (!counts.size) return null

    // Build outgoing edge table then chain into the largest closed loop.
    const out = new Map()
    for (const e of counts.keys()) {
      const u = e.indexOf('_'), i = +e.slice(0, u), j = +e.slice(u + 1)
      if (!out.has(i)) out.set(i, [])
      out.get(i).push(j)
    }

    const used = new Set()
    let best = null
    for (const startEdge of counts.keys()) {
      if (used.has(startEdge)) continue
      const s0 = +startEdge.slice(0, startEdge.indexOf('_'))
      const loop = []; let cur = s0, guard = 0, closed = false
      while (guard++ <= counts.size + 1) {
        loop.push(cur)
        const nbrs = out.get(cur)
        if (!nbrs?.length) break
        let nxt = null
        for (const c of nbrs) {
          const k = `${cur}_${c}`
          if (!used.has(k)) { nxt = c; used.add(k); break }
        }
        if (nxt == null) break
        if (nxt === s0) { closed = true; break }
        cur = nxt
      }
      if (closed && loop.length >= 3) {
        const poly = loop.map(i => ({ x: canon[i].x, y: canon[i].y }))
        const a = Math.abs(sa(poly))
        if (!best || a > best.a) best = { poly, a }
      }
    }
    return best?.poly ?? null
  }

  _signedArea(poly) {
    let a = 0
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length]
      a += p.x * q.y - q.x * p.y
    }
    return a / 2
  }
}
