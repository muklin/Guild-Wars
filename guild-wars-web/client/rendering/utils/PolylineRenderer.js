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
      const n = boundaryPts.length
      const verts = new Float32Array((n + 1) * 3)
      verts[0] = center.x; verts[1] = this.fillY; verts[2] = center.y
      for (let i = 0; i < n; i++) {
        verts[(i + 1) * 3]     = boundaryPts[i].x
        verts[(i + 1) * 3 + 1] = this.fillY
        verts[(i + 1) * 3 + 2] = boundaryPts[i].y
      }
      const tris = []
      for (let i = 0; i < n; i++) tris.push(0, ((i + 1) % n) + 1, i + 1)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1))
      geo.computeVertexNormals()
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
    const Y = this.stripY

    const allVerts = [], allIdx = []
    for (let i = 0; i < n - 1; i++) {
      const c1 = corners[i], c2 = corners[i + 1]
      if (!c1 || !c2) continue
      const base = allVerts.length / 3
      allVerts.push(c1.right.x, Y, c1.right.y, c1.left.x, Y, c1.left.y,
                    c2.left.x,  Y, c2.left.y,  c2.right.x, Y, c2.right.y)
      allIdx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    if (allVerts.length === 0) return null

    let geometry
    try {
      geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVerts), 3))
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(allIdx), 1))
      geometry.computeVertexNormals()
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
