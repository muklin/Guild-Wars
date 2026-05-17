function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a <= -Math.PI) a += 2 * Math.PI
  return a
}

// Planar graph face tracing. Returns all interior faces (street blocks) as
// vertex arrays. Interior = positive signed area in y-down screen coordinates.
export function extractBlocks(streetGraph) {
  const { nodes, edges } = streetGraph
  const nodeById = new Map(nodes.map(n => [n.id, n]))

  // Build adjacency: nodeId → [{neighborId, angle}]
  const adj = new Map()
  for (const node of nodes) adj.set(node.id, [])

  for (const edge of edges) {
    const nA = nodeById.get(edge.nodeA), nB = nodeById.get(edge.nodeB)
    if (!nA || !nB || edge.nodeA === edge.nodeB) continue
    const angle = Math.atan2(nB.y - nA.y, nB.x - nA.x)
    adj.get(edge.nodeA).push({ neighborId: edge.nodeB, angle: normalizeAngle(angle) })
    adj.get(edge.nodeB).push({ neighborId: edge.nodeA, angle: normalizeAngle(angle + Math.PI) })
  }

  // Deduplicate parallel edges, then sort each list by angle (CCW order in math convention)
  for (const [nodeId, list] of adj) {
    const seen = new Set()
    const deduped = []
    for (const nb of list) {
      if (!seen.has(nb.neighborId)) { seen.add(nb.neighborId); deduped.push(nb) }
    }
    deduped.sort((a, b) => a.angle - b.angle)
    adj.set(nodeId, deduped)
  }

  // For directed half-edge u→v, return w where v→w is the next dart tracing the same face.
  // "Previous in angle-sorted list at v" rotates clockwise (math convention) from the reverse dart.
  function next(u, v) {
    const list = adj.get(v)
    if (!list?.length) return null
    const idx = list.findIndex(nb => nb.neighborId === u)
    if (idx === -1) return null
    return list[(idx - 1 + list.length) % list.length].neighborId
  }

  const visited = new Set()
  const blocks = []

  for (const node of nodes) {
    for (const nb of (adj.get(node.id) || [])) {
      const startKey = `${node.id}→${nb.neighborId}`
      if (visited.has(startKey)) continue

      const faceNodes = []
      let u = node.id, v = nb.neighborId
      let iters = 0

      while (true) {
        const key = `${u}→${v}`
        if (visited.has(key) || ++iters > nodes.length + 5) break
        visited.add(key)
        faceNodes.push(nodeById.get(u))
        const w = next(u, v)
        if (w === null) break
        u = v; v = w
      }

      if (faceNodes.length < 3) continue

      // Shoelace signed area. In y-down coords interior (enclosed) faces are positive.
      let area = 0
      for (let i = 0; i < faceNodes.length; i++) {
        const a = faceNodes[i], b = faceNodes[(i + 1) % faceNodes.length]
        area += a.x * b.y - b.x * a.y
      }
      area /= 2

      if (area > 0.001) {
        blocks.push({ vertices: faceNodes.map(n => ({ x: n.x, y: n.y })), area })
      }
    }
  }

  console.log(`Block extractor: ${blocks.length} blocks`)
  return blocks
}
