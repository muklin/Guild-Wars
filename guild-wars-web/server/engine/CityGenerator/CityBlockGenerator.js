import { distToSegSq, pip, segIntersect } from '../voronoi/VoronoiUtils.js'
import { STREET_HALF_WIDTH, getDistrictParams, halfWidthForDistrict } from './StreetVoronoiGenerator.js'
import polygonClipping from 'polygon-clipping'


// Street priority for tie-breaking (paved hierarchy: Stone > Brick > Mud).
export const STREET_TYPE_PRIORITY = { Stone: 2, Brick: 1, Mud: 0 }

// Distance below which two gutter-graph nodes are the same point. Mitre corners from
// adjacent junctions and planarization crossing-nodes routinely land ~0.005–0.01 apart;
// the toFixed(6) node key is far too tight to merge them, so the face tracer walks micro-
// faces between them and produces only wraparound faces (→ void) or duplicate overlapping
// faces (→ double-layer). A third of the road half-width catches those while staying well
// clear of any legitimately-distinct gutter corner.
const GUTTER_MERGE_TOL = STREET_HALF_WIDTH * 0.35   // ≈ 0.0153 world units

// Centroid + bbox area of a face, for the bug-4 reject diagnostics (correlate a dropped
// face's world position with a visible black hole on the map). Cheap; debug-only.
function faceCentroidArea(verts) {
  let cx = 0, cy = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const v of verts) {
    cx += v.x; cy += v.y
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y
  }
  const n = verts.length || 1
  return { x: cx / n, y: cy / n, bbox: (maxX - minX) * (maxY - minY) }
}

// Log the N largest rejected faces in a category with their world centroids — a quick
// pointer to where any "missing block" came from. enclosesNode rejects are normally just
// district-outline loops (correctly dropped); a road-pass reject sitting on a real block is
// the one to investigate.
function logRejects(label, rejects, n = 5) {
  if (!rejects.length) return
  const top = [...rejects].sort((a, b) => b.bbox - a.bbox).slice(0, n)
    .map(r => `(${r.x.toFixed(3)},${r.y.toFixed(3)})`).join(' ')
  console.log(`  [blocks] ${label}: ${rejects.length} rejected — largest at ${top}`)
}

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

// Derive just the road-edge segments from saved junction gutter data, without
// running the full block-tracing pipeline. Used by regeneratePlots() on load.
export function gutterRoadEdges(junctions) {
  return new CityBlockGenerator()._gutterGraphFromJunctions(junctions).roadEdges
}

export default class CityBlockGenerator {
  // Returns { blocks, roadEdges }.
  // blocks: [{id, districtId, vertices, area, streetEdges}]
  // roadEdges: raw gutter road-edge segments, needed by CityPlotGenerator.
  generate(districts, streetGraph) {
    const junctions = streetGraph?.junctions || []

    const { gutterNodes, gutterEdges, roadEdges } = this._gutterGraphFromJunctions(junctions)
    const planar = this._planarizeGutterGraph(gutterNodes, gutterEdges)
    // Snap-merge near-coincident gutter nodes (mitre corners + planarization crossings that
    // land ~0.005–0.01 apart). Without this the tracer produces wraparound-only faces (void)
    // or duplicate overlapping faces (double-layer) — see GUTTER_MERGE_TOL.
    const { nodes: planarNodes, edges: planarEdges } = this._mergeNearbyGutterNodes(planar.nodes, planar.edges, GUTTER_MERGE_TOL)

    // bug-4 diagnostic: a healthy gutter graph is all closed loops, so every node has
    // degree ≥ 2. A degree-0/1 node is a dangling gutter endpoint — the face beside it
    // can't close, so a whole block goes untraced (a void). Log their world positions;
    // they should sit on the edge of any big black region.
    {
      const deg = new Map(planarNodes.map(n => [n.id, 0]))
      for (const e of planarEdges) { deg.set(e.nodeA, (deg.get(e.nodeA) || 0) + 1); deg.set(e.nodeB, (deg.get(e.nodeB) || 0) + 1) }
      const byId = new Map(planarNodes.map(n => [n.id, n]))
      const dangling = [...deg.entries()].filter(([, d]) => d <= 1)
        .map(([id, d]) => { const n = byId.get(id); return n ? `(${n.x.toFixed(3)},${n.y.toFixed(3)})d${d}` : null }).filter(Boolean)
      if (dangling.length) console.log(`  [blocks] ${dangling.length} dangling gutter node(s) (broken loop → untraced void): ${dangling.slice(0, 12).join(' ')}`)
    }

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

    const allFaces = this._traceFaces(planarNodes, planarEdges)
    const roadFacePolys = []
    let rejectedRoad = 0, rejectedArea = 0, rejectedNotch = 0
    // bug-4 diagnostics: collect centroids of every dropped face by cause.
    const dbgRoad1 = [], dbgRoad2 = [], dbgArea = []

    // Pass 1: reject road strips + junction fills (interior point close to centreline).
    const faceCandidates = []
    for (const rawVertices of allFaces) {
      if (rawVertices.length < 3) continue
      if (this._isRoadFace(rawVertices, streetNodes, streetEdges)) {
        roadFacePolys.push(rawVertices)
        rejectedRoad++
        dbgRoad1.push(faceCentroidArea(rawVertices))
      } else {
        faceCandidates.push(rawVertices)
      }
    }

    // Pass 2: reject junction corner triangles that slipped through pass 1.
    // At acute-angle junctions the corner triangle's interior sits ~STREET_HALF_WIDTH
    // from the nearest centreline — just outside the radius test — so pass 1 misses
    // it.  But these triangles are completely surrounded by road surface: every edge is
    // shared (in reverse) with an already-identified road face.  A real block always
    // has at least one edge adjacent to another block, not all road.
    const pk = p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`
    const roadEdgeSet = new Set()
    for (const poly of roadFacePolys) {
      const n = poly.length
      for (let i = 0; i < n; i++) roadEdgeSet.add(`${pk(poly[i])}_${pk(poly[(i + 1) % n])}`)
    }
    const blockFaces = []
    for (const rawVertices of faceCandidates) {
      const n = rawVertices.length
      const surroundedByRoad = rawVertices.every((_, i) =>
        roadEdgeSet.has(`${pk(rawVertices[(i + 1) % n])}_${pk(rawVertices[i])}`)
      )
      if (surroundedByRoad) {
        roadFacePolys.push(rawVertices)
        rejectedRoad++
        dbgRoad2.push(faceCentroidArea(rawVertices))
      } else {
        blockFaces.push(rawVertices)
      }
    }

    for (const rawVertices of blockFaces) {

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
      const vertices = rawVertices
      
      let area = 0
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i], b = vertices[(i + 1) % vertices.length]
        area += a.x * b.y - b.x * a.y
      }
      area = Math.abs(area) / 2
      if (area < 1e-6) { rejectedArea++; dbgArea.push(faceCentroidArea(vertices)); continue }

      const block = {
        id: blockId++,
        districtId,
        blockCorners: vertices,
        area,
        streetEdges: findStreetFacingEdges(vertices, roadEdges),
      }
      // B3: quarantine self-intersecting blocks so the plotter never subdivides garbage geometry.
      if (!this._isSimplePolygon(vertices)) block.blockType = 'single'
      blocks.push(block)
    }

    // Mark squares before merging so _mergeSquareClusters can identify them.
    // markSquareBlocks() in PlotVoronoiGenerator is still called from SetupPhase
    // for any remaining small blocks; it is a no-op on already-marked blocks.
    for (const block of blocks) {
      const params = getDistrictParams(districtById.get(block.districtId))
      if (block.area < params.square_threshhold) block.blockType = 'square'
    }

    this._mergeSquareClusters(blocks, roadFacePolys, roadEdges)

    // Overlapping/duplicate block faces: near-dup gutter nodes (see the topology repair's
    // "near-dup node(s)" count) let _traceFaces walk two overlapping faces over the same
    // ground, which z-fight as a visible "double layer". Flag block pairs whose centres sit
    // within OVERLAP_TOL. Diagnostic only — cheap spatial hash.
    {
      const OVERLAP_TOL = 0.08
      const cen = blocks.map(b => ({ id: b.id, ...faceCentroidArea(b.blockCorners) }))
      const buckets = new Map()
      for (const p of cen) {
        const k = `${Math.floor(p.x / OVERLAP_TOL)},${Math.floor(p.y / OVERLAP_TOL)}`
        if (!buckets.has(k)) buckets.set(k, [])
        buckets.get(k).push(p)
      }
      const pairs = []
      for (const p of cen) {
        const gx = Math.floor(p.x / OVERLAP_TOL), gy = Math.floor(p.y / OVERLAP_TOL)
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const arr = buckets.get(`${gx + dx},${gy + dy}`)
          if (!arr) continue
          for (const q of arr) {
            if (q.id <= p.id) continue
            if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 < OVERLAP_TOL * OVERLAP_TOL) pairs.push(`#${p.id}~#${q.id}@(${p.x.toFixed(3)},${p.y.toFixed(3)})`)
          }
        }
      }
      if (pairs.length) console.log(`  [overlap] ${pairs.length} block pair(s) with near-coincident centres (double-layer/z-fight): ${pairs.slice(0, 12).join(' ')}`)
    }

    console.log(`CityBlockGenerator: ${blocks.length} blocks traced from ${allFaces.length} faces (road=${rejectedRoad}, degenerate-area=${rejectedArea}, over-notched=${rejectedNotch})`)
    // bug-4 diagnostics: where did dropped faces go? Correlate these world centroids with
    // the visible black holes. `enclosesNode` rejects are clockwise faces _traceFaces threw
    // out for wrapping a gutter node (a large/concave block can legitimately do this).
    logRejects('road-pass1 (interior near centreline)', dbgRoad1)
    logRejects('road-pass2 (surrounded by road)', dbgRoad2)
    logRejects('degenerate-area', dbgArea)
    logRejects('enclosesNode (face wraps a gutter node)', this._dbgEnclosedRejects || [])

    return { blocks, roadEdges }
  }


  // Fill sparse-interior-street voids. A district whose interior streets are too sparse
  // leaves large areas covered by neither a block nor a road — the tracer produces nothing
  // there, so it renders as a void. Compute each district's uncovered region,
  // districtPolygon − union(blocks ∪ road faces), via robust polygon difference and add each
  // piece as a block; the normal plot pipeline then subdivides it into building plots. The
  // pieces are, by construction, disjoint from every existing block, so no overlap is
  // introduced. Mutates `blocks`. Returns the number of void-fill blocks added.
  _fillDistrictVoids(blocks, roadFacePolys, districts, roadEdges) {
    if (!districts?.length || !blocks.length) return 0
    const MIN_VOID_AREA = 0.05   // ignore thin boundary slivers
    const MP = (pts) => [[pts.map(p => [p.x, p.y])]]
    const ringArea = (r) => { let a = 0; for (let k = 0; k < r.length; k++) { const p = r[k], q = r[(k + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1] } return Math.abs(a / 2) }

    const cover = []
    for (const b of blocks) if (b.blockCorners?.length >= 3) cover.push(MP(b.blockCorners))
    for (const rf of roadFacePolys) if (rf?.length >= 3) cover.push(MP(rf))
    if (!cover.length) return 0

    let coverage
    try { coverage = polygonClipping.union(...cover) } catch (e) { console.warn('  [void-fill] coverage union failed —', e.message); return 0 }

    let nextId = blocks.reduce((m, b) => Math.max(m, b.id), -1) + 1
    let added = 0, holed = 0
    for (const d of districts) {
      if (!d.polygon || d.polygon.length < 3) continue
      let voids
      try { voids = polygonClipping.difference(MP(d.polygon), coverage) } catch { continue }
      for (const poly of voids) {
        const ext = poly[0]
        if (ringArea(ext) < MIN_VOID_AREA) continue

        // Annular void (wraps an island block/plaza): stitch the hole(s) into one ring with
        // zero-width slits and PAVE it as a square, so it fills cleanly without an annular
        // building. Solid voids become normal blocks and subdivide into plots.
        let ringPts, blockType
        if (poly.length > 1) { ringPts = this._stitchHoles(poly); blockType = 'square'; holed++ }
        else ringPts = poly[0].map(p => [p[0], p[1]])

        const corners = ringPts.map(([x, y]) => ({ x, y }))
        // polygon-clipping closes rings (last vertex == first) — drop the duplicate.
        if (corners.length > 1) { const f = corners[0], l = corners[corners.length - 1]; if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) corners.pop() }
        if (corners.length < 3) continue

        const block = { id: nextId++, districtId: d.id, blockCorners: corners, area: ringArea(ext), streetEdges: findStreetFacingEdges(corners, roadEdges) }
        if (blockType) block.blockType = blockType
        blocks.push(block)
        added++
      }
    }
    if (added) console.log(`  [void-fill] added ${added} block(s) filling sparse-street voids${holed ? ` (${holed} annular → paved squares)` : ''}`)
    return added
  }

  // Merge a polygon-with-holes (polygon-clipping ring list [exterior, hole1, …]) into one
  // simple ring by bridging each hole to the nearest outer vertex with a zero-width slit.
  _stitchHoles(rings) {
    const strip = (r) => { const a = r.map(p => [p[0], p[1]]); if (a.length > 1) { const f = a[0], l = a[a.length - 1]; if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) a.pop() } return a }
    let outer = strip(rings[0])
    for (let h = 1; h < rings.length; h++) {
      const hole = strip(rings[h])
      if (hole.length < 3) continue
      let bi = 0, bj = 0, bd = Infinity
      for (let i = 0; i < outer.length; i++) for (let j = 0; j < hole.length; j++) {
        const dx = outer[i][0] - hole[j][0], dy = outer[i][1] - hole[j][1], d = dx * dx + dy * dy
        if (d < bd) { bd = d; bi = i; bj = j }
      }
      const hseq = []
      for (let k = 0; k <= hole.length; k++) hseq.push(hole[(bj + k) % hole.length])
      outer = [...outer.slice(0, bi + 1), ...hseq, outer[bi], ...outer.slice(bi + 1)]
    }
    return outer
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

  // Resolve all pairwise edge crossings in the gutter graph by splitting each pair of
  // crossing edges at their intersection and inserting a new node. O(n²) — fine at city scale.
  // Crossing edges arise from per-district variable street widths. After planarization
  // _traceFaces produces only simple, non-self-intersecting face polygons.
  _planarizeGutterGraph(nodes, edges) {
    const nodeById = new Map(nodes.map(n => [n.id, n]))

    // Collect split points per edge: [{t along edge, x, y}]
    const splits = edges.map(() => [])

    for (let i = 0; i < edges.length; i++) {
      const ei = edges[i]
      const a1 = nodeById.get(ei.nodeA), a2 = nodeById.get(ei.nodeB)
      if (!a1 || !a2) continue
      for (let j = i + 1; j < edges.length; j++) {
        const ej = edges[j]
        const b1 = nodeById.get(ej.nodeA), b2 = nodeById.get(ej.nodeB)
        if (!b1 || !b2) continue
        const ix = segIntersect(a1, a2, b1, b2)
        if (!ix) continue
        splits[i].push({ t: ix.t, x: ix.x, y: ix.y })
        splits[j].push({ t: ix.s, x: ix.x, y: ix.y })
      }
    }

    if (splits.every(s => s.length === 0)) return { nodes, edges }

    // Build augmented node list; deduplicate by position at 1e-6 tolerance.
    const allNodes = [...nodes]
    const nodeIndex = new Map(nodes.map(n => [`${n.x.toFixed(6)},${n.y.toFixed(6)}`, n.id]))
    const getOrCreateNode = (x, y) => {
      const key = `${x.toFixed(6)},${y.toFixed(6)}`
      if (nodeIndex.has(key)) return nodeIndex.get(key)
      const id = allNodes.length
      allNodes.push({ id, x, y })
      nodeIndex.set(key, id)
      return id
    }

    const seenEdges = new Set()
    const newEdges = []
    const addEdge = (a, b) => {
      if (a === b) return
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      if (!seenEdges.has(key)) { seenEdges.add(key); newEdges.push({ nodeA: a, nodeB: b }) }
    }

    let crossingCount = 0
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i], sp = splits[i]
      if (!sp.length) { addEdge(e.nodeA, e.nodeB); continue }
      sp.sort((a, b) => a.t - b.t)
      crossingCount += sp.length
      let prev = e.nodeA
      for (const s of sp) { const nid = getOrCreateNode(s.x, s.y); addEdge(prev, nid); prev = nid }
      addEdge(prev, e.nodeB)
    }

    console.log(`_planarizeGutterGraph: resolved ${crossingCount} crossings, added ${allNodes.length - nodes.length} nodes`)
    return { nodes: allNodes, edges: newEdges }
  }

  // Snap-merge gutter-graph nodes within `tol` of each other into one node, averaging
  // their positions and remapping edges (dropping self-loops + duplicates). Collapses the
  // near-coincident clusters (mitre corners + planarization crossings) that otherwise make
  // _traceFaces emit wraparound-only or duplicate overlapping faces. Returns {nodes, edges}.
  _mergeNearbyGutterNodes(nodes, edges, tol) {
    if (nodes.length < 2) return { nodes, edges }
    const tolSq = tol * tol

    const parent = new Map(nodes.map(n => [n.id, n.id]))
    const find = (id) => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id) } return id }
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra) }

    const buckets = new Map()
    for (const n of nodes) {
      const k = `${Math.floor(n.x / tol)},${Math.floor(n.y / tol)}`
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k).push(n)
    }
    for (const n of nodes) {
      const gx = Math.floor(n.x / tol), gy = Math.floor(n.y / tol)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const arr = buckets.get(`${gx + dx},${gy + dy}`)
        if (!arr) continue
        for (const m of arr) {
          if (m.id <= n.id) continue
          const ddx = n.x - m.x, ddy = n.y - m.y
          if (ddx * ddx + ddy * ddy < tolSq) union(n.id, m.id)
        }
      }
    }

    const acc = new Map()
    for (const n of nodes) {
      const r = find(n.id)
      if (!acc.has(r)) acc.set(r, { sx: 0, sy: 0, c: 0 })
      const a = acc.get(r); a.sx += n.x; a.sy += n.y; a.c++
    }

    let mergedCount = 0
    const newNodes = []
    for (const n of nodes) {
      if (find(n.id) === n.id) { const a = acc.get(n.id); newNodes.push({ id: n.id, x: a.sx / a.c, y: a.sy / a.c }) }
      else mergedCount++
    }
    if (mergedCount === 0) return { nodes, edges }

    const seen = new Set()
    const newEdges = []
    for (const e of edges) {
      const a = find(e.nodeA), b = find(e.nodeB)
      if (a === b) continue
      const k = a < b ? `${a}_${b}` : `${b}_${a}`
      if (seen.has(k)) continue
      seen.add(k)
      newEdges.push({ nodeA: a, nodeB: b })
    }

    console.log(`_mergeNearbyGutterNodes: merged ${mergedCount} near-coincident gutter node(s) (tol=${tol.toFixed(3)})`)
    return { nodes: newNodes, edges: newEdges }
  }

  // Returns true if polygon has no self-intersecting edges (non-adjacent edge pairs).
  _isSimplePolygon(vertices) {
    const n = vertices.length
    if (n < 3) return false
    for (let i = 0; i < n; i++) {
      const a = vertices[i], b = vertices[(i + 1) % n]
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue  // share endpoint
        const c = vertices[j], d = vertices[(j + 1) % n]
        if (segIntersect(a, b, c, d)) return false
      }
    }
    return true
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
        roadEdges.push({ roadId: conn.roadId, type: conn.type, ax: conn.gutterLeft.x,  ay: conn.gutterLeft.y,  bx: conn2.gutterRight.x, by: conn2.gutterRight.y, isOuter: false })
        roadEdges.push({ roadId: conn.roadId, type: conn.type, ax: conn.gutterRight.x, ay: conn.gutterRight.y, bx: conn2.gutterLeft.x,  by: conn2.gutterLeft.y, isOuter: typeof conn.right !== 'number' })
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
    this._dbgEnclosedRejects = []   // bug-4: clockwise faces dropped for enclosing a node
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

    for (const edge of edges) {
      for (const [u, v] of [[edge.nodeA, edge.nodeB], [edge.nodeB, edge.nodeA]]) {
        if (visited.has(`${u},${v}`)) continue

        const faceVerts = []
        const faceEdges = new Set()  // per-face: detect sub-cycles in getNext
        let cu = u, cv = v

        do {
          const key = `${cu},${cv}`
          if (faceEdges.has(key)) break  // sub-cycle: getNext looped without closing face
          faceEdges.add(key)
          visited.add(key)
          const node = nodeById.get(cu)
          if (node) faceVerts.push({ x: node.x, y: node.y })
          const next = getNext(cu, cv)
          if (next == null) break
          cu = cv; cv = next
        } while (cu !== u || cv !== v)

        if (faceVerts.length < 3) continue

        let area = 0
        for (let i = 0; i < faceVerts.length; i++) {
          const a = faceVerts[i], b = faceVerts[(i + 1) % faceVerts.length]
          area += a.x * b.y - b.x * a.y
        }
        // Keep clockwise (negative-area) faces, but reject any that encloses
        // another gutter node — those are outer/wraparound faces, not minimal
        // blocks. A true block face is empty of interior nodes.
        if (area < 0) {
          if (this._enclosesNode(faceVerts, nodes)) this._dbgEnclosedRejects.push(faceCentroidArea(faceVerts))
          else faces.push(faceVerts)
        }
      }
    }

    return faces
  }

  // Gutter nodes lying strictly inside `poly` (further than a small margin from every
  // edge). Nodes on the face's own boundary sit at distance ~0 and are excluded.
  _enclosedNodes(poly, nodes) {
    // Boundary nodes of this face sit at dist ≈ 0; use a small epsilon that's well
    // above floating-point noise but well below STREET_HALF_WIDTH (~0.044) so that
    // a nearby-but-genuinely-interior node in a narrow block isn't falsely excluded.
    const MARGIN_SQ = 1e-5   // ~0.003 world units
    const out = []
    for (const nd of nodes) {
      if (!pip(nd.x, nd.y, poly)) continue
      let minD2 = Infinity
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length]
        const d2 = distToSegSq(nd.x, nd.y, a.x, a.y, b.x, b.y)
        if (d2 < minD2) minD2 = d2
        if (minD2 <= MARGIN_SQ) break
      }
      if (minD2 > MARGIN_SQ) out.push(nd)
    }
    return out
  }

  // True if any gutter node lies strictly inside `poly`.
  _enclosesNode(poly, nodes) {
    return this._enclosedNodes(poly, nodes).length > 0
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
