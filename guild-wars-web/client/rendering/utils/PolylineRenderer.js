import * as THREE from 'three'
import { computeJunctionData, computeEdgeCorners } from '../../../shared/polylineGeometry.js'

// Renders a set of thick polyline edges with miter-jointed strips and filled junction caps.
//
// Usage:
//   const renderer = new PolylineRenderer(scene, { thickness: 0.5, stripY: 0.06 })
//   renderer.render(edges, pointsById, (edge, edgeId) => hexColor)
//   renderer.setEdgeColor(edgeId, 0xffffff)   // e.g. selection highlight
//   renderer.resetEdgeColor(edgeId)            // back to base
//   renderer.updateBaseColor(edgeId, color)    // persist new assigned color
//   renderer.dispose()
//
// edges format: { [edgeId]: { pointIds: [id, ...], ... } }
// pointsById: Map<id, {x, y}>

export default class PolylineRenderer {
  constructor(scene, options = {}) {
    this.scene = scene
    this.thickness = options.thickness ?? 0.5
    this.stripY    = options.stripY    ?? 0.06
    this.fillY     = options.fillY     ?? (options.stripY ?? 0.06) + 0.005
    // World-distance ceiling for the miter intersection from a junction point. Beyond
    // this, the corner is beveled (two boundary points) instead of mitered to a single
    // far-flung spike vertex. As the angle between two edges at a junction narrows, the
    // miter point's distance from the joint grows as r/sin(angle/2) — unbounded as the
    // angle approaches 0 — so leaving this at Infinity (the old default) let ANY
    // sufficiently narrow junction spike arbitrarily far, for every edge type alike
    // (river, cliff, wall...); confirmed as the actual cause of black spikes reported
    // both in Terrain mode and, worse, in District mode, once river endpoints stopped
    // getting their own workaround that happened to sidestep this for wide-gap cases.
    // Was 4× thickness (SVG/Canvas's stroke-miterlimit convention) — still visibly
    // spiky live at that bound: the interior-vertex case (_buildEdgeMesh) only CLAMPS
    // the miter point's distance, it doesn't bevel into two flat points the way the
    // junction case (_computeJunctionData) does, so a clamped-but-still-pointed corner
    // at 4× thickness (2.0 world units at this renderer's 0.5 thickness) reads as a
    // real spike, not a subtle imperfection. 1.5× keeps the same proportional-to-
    // thickness behavior but bounds any residual spike small enough to be visually
    // negligible instead of just "shorter".
    this.miterLimitDist = options.miterLimitDist ?? this.thickness * 1.5
    // A colour that dominates junction fills when any adjacent edge has it (e.g.
    // a River, so its ends/junctions stay blue rather than the majority colour).
    this.priorityColor = options.priorityColor ?? null

    this._edgeMeshes     = new Map()  // edgeId → mesh
    this._junctionMeshes = new Map()  // ptId → mesh
    this._junctionEdgeIds = new Map() // ptId → Set<edgeId>
    this._edgeEndpoints  = new Map()  // edgeId → [ptId, ptId]
    this._edgeBaseColors = new Map()  // edgeId → hex
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  // Top-down mode reinstates the floor-scroll clip plane (user-confirmed 2026-07-13),
  // which only behaves correctly against a flat world — see TerrainRenderer's/
  // GroundRenderer's matching methods. Flat target is each mesh's own epsilon
  // (stripY/fillY), not 0 — see the build-site comments for why.
  setFlattened(flat) {
    const apply = (mesh) => {
      const geo = mesh?.geometry
      const realY = geo?.userData?.realY
      if (!realY) return
      const pos = geo.attributes.position
      const flatY = geo.userData.flatY ?? 0
      for (let i = 0; i < realY.length; i++) pos.array[i * 3 + 1] = flat ? flatY : realY[i]
      pos.needsUpdate = true
      geo.computeVertexNormals()
    }
    this._edgeMeshes.forEach(apply)
    this._junctionMeshes.forEach(apply)
  }

  render(edges, pointsById, getColor) {
    this.dispose()
    const r = this.thickness / 2

    const junctionFills = new Map()  // ptId → { boundaryPts, edgeIds }
    const overrides = computeJunctionData(edges, pointsById, r, this.miterLimitDist, junctionFills)

    for (const [edgeId, edge] of Object.entries(edges)) {
      const color = getColor(edge, edgeId)
      const mesh = this._buildEdgeMesh(edge, edgeId, overrides, pointsById, r, color)
      if (!mesh) continue
      this.scene.add(mesh)
      this._edgeMeshes.set(edgeId, mesh)
      this._edgeBaseColors.set(edgeId, color)
      const pts = edge.pointIds
      if (pts?.length >= 2) this._edgeEndpoints.set(edgeId, [pts[0], pts[pts.length - 1]])
    }

    // Adjacency for all endpoints (needed for junction color refresh)
    for (const [edgeId, edge] of Object.entries(edges)) {
      const pts = edge.pointIds
      if (!pts || pts.length < 2) continue
      for (const ptId of [pts[0], pts[pts.length - 1]]) {
        if (!this._junctionEdgeIds.has(ptId)) this._junctionEdgeIds.set(ptId, new Set())
        this._junctionEdgeIds.get(ptId).add(edgeId)
      }
    }

    // Junction fill meshes (3+ way). Fan-triangulated from the junction
    // center (`center`) — the cap is always star-shaped around the center,
    // even when beveled corners make the boundary polygon non-convex.
    for (const [ptId, { boundaryPts, edgeIds, center }] of junctionFills) {
      if (boundaryPts.length < 3 || !center) continue
      // Real height at the junction point itself (TODO.md "Groundplane Z-height
      // implementation") — every boundaryPt is a small local offset off the same
      // vertex, so one z for the whole fan is an acceptable approximation, same as the
      // strip quads' per-corner (not per-offset-point) resolution above. `this.fillY`
      // stays the small constant lift ABOVE stripY (its original purpose — sit visibly
      // over the strip mesh), not the absolute height itself.
      const fillY = (pointsById.get(ptId)?.z ?? 0) + this.fillY
      const n = boundaryPts.length
      const verts = new Float32Array((n + 1) * 3)
      verts[0] = center.x; verts[1] = fillY; verts[2] = center.y
      for (let i = 0; i < n; i++) {
        verts[(i + 1) * 3]     = boundaryPts[i].x
        verts[(i + 1) * 3 + 1] = fillY
        verts[(i + 1) * 3 + 2] = boundaryPts[i].y
      }
      const tris = []
      for (let i = 0; i < n; i++) tris.push(0, ((i + 1) % n) + 1, i + 1)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1))
      geo.computeVertexNormals()
      geo.userData.realY = Array.from({ length: n + 1 }, () => fillY)   // uniform fan — see setFlattened
      geo.userData.flatY = this.fillY
      const color = this._junctionColor(edgeIds)
      // DoubleSide: the fan's boundaryPts aren't guaranteed convex (beveled/clamped
      // corners at sharp junctions can still locally reverse the polygon's winding for
      // one or two triangles) — a backface-culled triangle there doesn't just look wrong,
      // it shows the scene's clear colour straight through, which is what a "hole that
      // changes colour between ISO/Debug camera modes" actually is (no geometry drawn,
      // not literally missing terrain). See TerrainRenderer.buildRegionMesh's identical
      // fix/comment for the same failure mode on terrain-plot fills.
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, emissive: color, emissiveIntensity: 0.5, side: THREE.DoubleSide })
      const mesh = new THREE.Mesh(geo, mat)
      this.scene.add(mesh)
      this._junctionMeshes.set(ptId, mesh)
    }
  }

  getEdgeMesh(edgeId) { return this._edgeMeshes.get(edgeId) }
  get edgeMeshes()     { return this._edgeMeshes }
  get junctionMeshes() { return this._junctionMeshes }

  setEdgeColor(edgeId, color) {
    const mesh = this._edgeMeshes.get(edgeId)
    if (mesh) { mesh.material.color.setHex(color); mesh.material.emissive?.setHex(color) }
    this._refreshJunctionsForEdge(edgeId)
  }

  resetEdgeColor(edgeId) {
    this.setEdgeColor(edgeId, this._edgeBaseColors.get(edgeId) ?? 0)
  }

  updateBaseColor(edgeId, color) {
    this._edgeBaseColors.set(edgeId, color)
    this.setEdgeColor(edgeId, color)
  }

  dispose() {
    this._edgeMeshes.forEach(m => this.scene.remove(m))
    this._junctionMeshes.forEach(m => this.scene.remove(m))
    this._edgeMeshes.clear()
    this._junctionMeshes.clear()
    this._junctionEdgeIds.clear()
    this._edgeEndpoints.clear()
    this._edgeBaseColors.clear()
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _refreshJunctionsForEdge(edgeId) {
    const pts = this._edgeEndpoints.get(edgeId)
    if (pts) for (const ptId of pts) this._refreshJunctionColor(ptId)
  }

  _refreshJunctionColor(ptId) {
    const mesh = this._junctionMeshes.get(ptId)
    if (!mesh) return
    const color = this._junctionColor(this._junctionEdgeIds.get(ptId) ?? new Set())
    mesh.material.color.setHex(color)
    mesh.material.emissive?.setHex(color)
  }

  _junctionColor(edgeIds) {
    const counts = new Map()
    let hasPriority = false
    for (const edgeId of edgeIds) {
      const mesh = this._edgeMeshes.get(edgeId)
      if (!mesh) continue
      const c = mesh.material.color.getHex()
      if (c === 0xffffff) return 0xffffff  // any selected edge → white
      if (this.priorityColor != null && c === this.priorityColor) hasPriority = true
      counts.set(c, (counts.get(c) || 0) + 1)
    }
    if (hasPriority) return this.priorityColor  // e.g. River dominates the junction
    if (!counts.size) return 0x888888
    let best = null, bestCount = 0
    for (const [c, n] of counts) if (n > bestCount) { best = c; bestCount = n }
    return best ?? 0x888888
  }

  _buildEdgeMesh(edge, edgeId, overrides, pointsById, r, color) {
    // Corner computation (junction overrides + interior miter/clamp) now lives in
    // shared/polylineGeometry.js — see its doc comment for why (same math is used
    // server-side for river/cliff pullback, so the two never disagree by construction).
    const corners = computeEdgeCorners(edge, edgeId, overrides, pointsById, r, this.miterLimitDist)
    if (!corners) return null
    const n = corners.length
    // Per-corner height (TODO.md "Groundplane Z-height implementation", plan "rustling-
    // churning-finch"): the terrain the edge bounds, not a flat stripY everywhere —
    // corners[i] is built 1:1 from edge.pointIds[i] (see computeEdgeCorners), so the
    // same index resolves the real point's z. stripY stays a small constant lift above
    // that real height (its original purpose: sit visibly above the ground fill,
    // avoiding z-fighting), not the height itself. Falls back to flat stripY when a
    // point has no z (pointsById unavailable/older save).
    const ptIds = edge.pointIds || []
    const zByIndex = ptIds.map(id => (pointsById.get(id)?.z ?? 0) + this.stripY)
    // Safety clamp (user-confirmed 2026-07-14, "poly line should not do this" — a
    // screenshot showing a single stroke ramping from ground level up into the sky):
    // a wayward point's z can end up wildly wrong upstream (a stale/miscomputed value
    // reaching a real registry point some edge chain still references) — no legitimate
    // terrain height difference in this game is anywhere near this large, so rather
    // than chase every possible upstream cause, cap how far one consecutive pair of
    // polyline vertices is ever allowed to step in Y. Walked left-to-right so a single
    // outlier gets pulled toward its neighbour instead of distorting the whole strip.
    const MAX_Y_STEP = 3
    for (let i = 1; i < zByIndex.length; i++) {
      const delta = zByIndex[i] - zByIndex[i - 1]
      if (delta > MAX_Y_STEP) zByIndex[i] = zByIndex[i - 1] + MAX_Y_STEP
      else if (delta < -MAX_Y_STEP) zByIndex[i] = zByIndex[i - 1] - MAX_Y_STEP
    }
    const Y = this.stripY   // fallback when an index is out of range (shouldn't happen)

    const allVerts = [], allIdx = []
    for (let i = 0; i < n - 1; i++) {
      const c1 = corners[i], c2 = corners[i + 1]
      if (!c1 || !c2) continue
      const y1 = zByIndex[i] ?? Y, y2 = zByIndex[i + 1] ?? Y
      const base = allVerts.length / 3
      // At a beveled interior vertex, the segment's own quad must reach its own local
      // offset endpoint (q2 for the segment starting here, q1 for the segment ending
      // here) rather than the shared clamped corner — the join triangles below fill the
      // remainder, closing what would otherwise be a notch (see the doc comment on
      // leftBevel/rightBevel in shared/polylineGeometry.js).
      const c1Right = c1.rightBevel ? c1.rightBevel.q2 : c1.right
      const c1Left  = c1.leftBevel  ? c1.leftBevel.q2  : c1.left
      const c2Left  = c2.leftBevel  ? c2.leftBevel.q1  : c2.left
      const c2Right = c2.rightBevel ? c2.rightBevel.q1 : c2.right
      allVerts.push(c1Right.x, y1, c1Right.y, c1Left.x, y1, c1Left.y,
                    c2Left.x,  y2, c2Left.y,  c2Right.x, y2, c2Right.y)
      allIdx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    // Bevel join triangles at sharp interior bends — fan from the centreline vertex to
    // its two segments' own local offset points, filling exactly the wedge the
    // shortened quads above leave uncovered.
    for (let i = 1; i < n - 1; i++) {
      const c = corners[i]
      if (!c) continue
      const y = zByIndex[i] ?? Y
      for (const bevel of [c.leftBevel, c.rightBevel]) {
        if (!bevel) continue
        const base = allVerts.length / 3
        allVerts.push(bevel.pt.x, y, bevel.pt.y, bevel.q1.x, y, bevel.q1.y, bevel.q2.x, y, bevel.q2.y)
        allIdx.push(base, base + 1, base + 2)
      }
    }
    if (allVerts.length === 0) return null

    let geometry
    try {
      geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVerts), 3))
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(allIdx), 1))
      geometry.computeVertexNormals()
      // Real per-vertex height, kept for top-down flatten/unflatten (see
      // setFlattened) — the flat target is the constant stripY epsilon (every vertex
      // shares it), not 0: that epsilon's whole job is sitting visibly above the
      // ground fill, which top-down flattens to 0 too (TerrainRenderer/GroundRenderer).
      geometry.userData.realY = allVerts.filter((_, i) => i % 3 === 1)
      geometry.userData.flatY = this.stripY
    } catch (e) {
      console.error(`PolylineRenderer: geometry error for edge ${edgeId}:`, e)
      return null
    }

    // DoubleSide: a quad whose corner points got clamped/beveled at a sharp bend can
    // still end up wound backward locally — see the matching comment on the junction
    // fill material above for why that must not backface-cull to nothing.
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, emissive: color, emissiveIntensity: 0.5, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geometry, mat)
    mesh.userData = { edgeId }
    return mesh
  }
}
