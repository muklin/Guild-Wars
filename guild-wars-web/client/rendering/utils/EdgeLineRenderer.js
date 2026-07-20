import * as THREE from 'three'

// Thin ribbon-mesh polyline renderer, used everywhere an edge/boundary needs a stroke —
// District mode's non-Wall edge highlighting, and (since plan "typed-gliding-leaf" Stage
// D) Terrain Setup's own unassigned-edge hover/select overlay too, replacing the retired
// PolylineRenderer.js entirely. Each SEGMENT is its own independent flat quad (real
// world-space thickness, unlike a THREE.Line — see below) with NO mitre/bevel/junction
// geometry joining them: adjacent segments simply overlap a little at each shared
// corner, which is imperceptible at this thickness. PolylineRenderer's thick-strip-
// WITH-mitred-junctions approach's miter/bevel/clamp geometry was the direct cause of
// the black-spike bug class chased for most of a prior session; per-segment quads with
// no attempt at a mitred join make that whole bug class structurally impossible here,
// not just tuned away.
//
// Rebuilt as a real Mesh (2026-07-14, user-confirmed "are they 2d lines?" / "make these
// lines thicker") — a plain THREE.Line's `linewidth` is silently ignored on almost every
// platform (ANGLE/D3D, most desktop GL contexts only support 1px lines), so it could
// never actually be made thicker. polygonOffset (not depthTest:false — see render()'s
// own doc comment, fixed 2026-07-19: edges used to draw as x-ray, visible straight
// through any hill/mountain in front) resolves z-fighting with the ground fill directly
// beneath it while still respecting real occlusion from anything genuinely in front.
//
// Same small public API PolylineRenderer/the old THREE.Line version exposed
// (render/getEdgeMesh/edgeMeshes/junctionMeshes/setEdgeColor/resetEdgeColor/
// updateBaseColor/dispose/setFlattened) so callers built against that interface
// (DistrictRenderer's hover/select/recolor logic, TerrainRenderer's top-down flatten)
// swap over unchanged. junctionMeshes is always empty — there ARE no junction fills —
// kept only so callers that iterate it (visibility toggles) don't need a null check.
export default class EdgeLineRenderer {
  constructor(scene, options = {}) {
    this.scene = scene
    this.y = options.y ?? 0.06
    this.thickness = options.thickness ?? 0.12
    this._edgeMeshes = new Map()      // edgeId -> THREE.Mesh (ribbon)
    this._edgeBaseColors = new Map()  // edgeId -> hex
    this._emptyJunctionMeshes = new Map()
    this._flattened = false
  }

  render(edges, pointsById, getColor) {
    this.dispose()
    const halfWidth = this.thickness / 2
    for (const [edgeId, edge] of Object.entries(edges)) {
      const pts = (edge.pointIds || []).map(id => pointsById.get(id)).filter(p => p && isFinite(p.x))
      if (pts.length < 2) continue
      const color = getColor(edge, edgeId)

      // Real per-point height (TODO.md "Groundplane Z-height implementation") — reads
      // through the same pointsById.z the Terrain-Setup fill meshes do. realY is stashed
      // per vertex (same pattern as TerrainRenderer.buildRegionMesh) so setFlattened can
      // swap between real relief and flat Y for top-down mode without a rebuild.
      const verts = []
      const realY = []
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1]
        const dx = b.x - a.x, dy = b.y - a.y
        const len = Math.hypot(dx, dy)
        if (len === 0) continue
        const px = (-dy / len) * halfWidth, py = (dx / len) * halfWidth
        const ay = (a.z ?? 0) + this.y, by = (b.z ?? 0) + this.y
        verts.push(
          a.x - px, ay, a.y - py,
          a.x + px, ay, a.y + py,
          b.x + px, by, b.y + py,
          b.x - px, by, b.y - py,
        )
        realY.push(ay, ay, by, by)
      }
      if (verts.length === 0) continue

      const idx = []
      for (let base = 0; base < verts.length / 3; base += 4) {
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      }

      const geometry = new THREE.BufferGeometry()
      const posArray = new Float32Array(verts)
      geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3))
      geometry.setIndex(idx)
      geometry.userData.realY = realY
      if (this._flattened) {
        // Exactly 0, NOT this.y (user-confirmed 2026-07-14, "still not visible top
        // down"): top-down mode's floor-scroll clip plane sits just above GROUND_Y by
        // default (~0.045 world units at the default scroll level, and shrinks further
        // if the user scrolls down) — this.y (0.06) already exceeds that by default, so
        // the ribbon was silently clipped even though the flatten logic itself was
        // correct. The terrain FILL flattens to exactly 0 and is never clipped (the
        // clip plane's own formula guarantees clipY > 0 for any scroll level), so
        // matching that exactly is the only offset that's safe at every scroll level —
        // see the material's polygonOffset below for what now keeps it drawing over the
        // fill despite sharing the same Y.
        for (let i = 0; i < realY.length; i++) posArray[i * 3 + 1] = 0
      }
      // depthTest was previously off entirely (x-ray — user-confirmed 2026-07-19, "don't
      // draw terrain edges as x-ray, always visible": a hill/mountain in front of a far
      // edge should occlude it like anything else). polygonOffset replaces it for the ONE
      // thing depthTest:false was actually needed for — this ribbon sits at the exact
      // same Y as the terrain fill directly beneath it in flattened/top-down mode (see
      // setFlattened's doc comment: forced to exactly 0, not this.y, to dodge the
      // floor-scroll clip plane), which is a real coplanar z-fight risk with depth
      // testing now on. Nudges only THIS mesh's effective depth slightly nearer the
      // camera so it still wins against its own directly-underlying fill, while any
      // genuinely-in-front geometry (at a real, different depth) still occludes it
      // normally.
      const material = new THREE.MeshBasicMaterial({
        color, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.renderOrder = 999
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

  // Top-down mode (user-confirmed 2026-07-14, "hovered and selected edges are not
  // visible in top down mode"): every fill mesh flattens to Y=0 there and this renderer
  // needs to match, or its ribbon keeps its real (non-zero) Y while the flat-world
  // floor-scroll clip plane (calibrated for Y=0) clips it out of view entirely.
  // Persists across the next render() call too (stashed on `this`, applied at creation
  // time), since render() rebuilds every mesh from scratch on each terrain data sync —
  // see TerrainRenderer.renderEdges for the matching fix on FIRST construction (this
  // may be called before any instance exists yet, silently no-op'ing via optional
  // chaining on the caller's side).
  setFlattened(flat) {
    this._flattened = flat
    for (const mesh of this._edgeMeshes.values()) {
      const geo = mesh.geometry
      const realY = geo?.userData?.realY
      if (!realY) continue
      const pos = geo.attributes.position
      // Exactly 0 when flat, not this.y — see the matching comment in render() for why.
      for (let i = 0; i < realY.length; i++) pos.array[i * 3 + 1] = flat ? 0 : realY[i]
      pos.needsUpdate = true
    }
  }
}
