import * as THREE from 'three'

// Simple, miter-joint-free polyline renderer for every mode OTHER than Terrain Setup
// (District mode's non-Wall edge highlighting, and any future non-Terrain edge overlay).
// PolylineRenderer.js's thick-strip-with-mitered-junctions approach is Terrain-Setup-only
// now (see plan "typed-giggling-giraffe" Stage D) — its miter/bevel/clamp geometry was
// the direct cause of the black-spike bug class chased for most of this session, both in
// Terrain mode and, worse, in District mode once river faces stopped needing a
// workaround that happened to sidestep it. A plain THREE.Line per edge has no junction
// fill meshes and no miter geometry at all, so that whole bug class is structurally
// impossible here, not just tuned away.
//
// Same small public API PolylineRenderer exposes (render/getEdgeMesh/edgeMeshes/
// junctionMeshes/setEdgeColor/resetEdgeColor/updateBaseColor/dispose) so callers built
// against PolylineRenderer's interface (DistrictRenderer's hover/select/recolor logic)
// swap over unchanged. junctionMeshes is always empty — there ARE no junction fills —
// kept only so callers that iterate it (visibility toggles) don't need a null check.
export default class EdgeLineRenderer {
  constructor(scene, options = {}) {
    this.scene = scene
    this.y = options.y ?? 0.06
    this._edgeMeshes = new Map()      // edgeId -> THREE.Line
    this._edgeBaseColors = new Map()  // edgeId -> hex
    this._emptyJunctionMeshes = new Map()
  }

  render(edges, pointsById, getColor) {
    this.dispose()
    for (const [edgeId, edge] of Object.entries(edges)) {
      const pts = (edge.pointIds || []).map(id => pointsById.get(id)).filter(p => p && isFinite(p.x))
      if (pts.length < 2) continue
      const color = getColor(edge, edgeId)

      // Real per-point height when available (TODO.md "Groundplane Z-height
      // implementation") — District-scale z isn't populated yet (out of this session's
      // scope), so this is currently a no-op everywhere this renderer is used, but reads
      // through the same pointsById.z the Terrain-Setup PolylineRenderer now does.
      const verts = new Float32Array(pts.length * 3)
      pts.forEach((p, i) => { verts[i * 3] = p.x; verts[i * 3 + 1] = (p.z ?? 0) + this.y; verts[i * 3 + 2] = p.y })
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3))
      const material = new THREE.LineBasicMaterial({ color })
      const mesh = new THREE.Line(geometry, material)
      mesh.userData = { edgeId }

      this.scene.add(mesh)
      this._edgeMeshes.set(edgeId, mesh)
      this._edgeBaseColors.set(edgeId, color)
    }
  }

  getEdgeMesh(edgeId) { return this._edgeMeshes.get(edgeId) }
  get edgeMeshes() { return this._edgeMeshes }
  get junctionMeshes() { return this._emptyJunctionMeshes }

  setEdgeColor(edgeId, color) {
    const mesh = this._edgeMeshes.get(edgeId)
    if (mesh) mesh.material.color.setHex(color)
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
    this._edgeMeshes.clear()
    this._edgeBaseColors.clear()
  }
}
