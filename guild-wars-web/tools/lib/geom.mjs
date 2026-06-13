import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Remap a geometry's [0,1] UVs into an atlas region (glTF top-left origin).
export function remapUV(geo, region) {
  const uv = geo.attributes.uv
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i)
    uv.setXY(i, region.u0 + u * (region.u1 - region.u0), region.v0 + v * (region.v1 - region.v0))
  }
  uv.needsUpdate = true
  return geo
}

// A box of size w×h×d centred at (cx,cy,cz), all faces mapped to one atlas region.
export function box(w, h, d, region, cx = 0, cy = 0, cz = 0) {
  const g = new THREE.BoxGeometry(w, h, d)
  remapUV(g, region)
  g.translate(cx, cy, cz)
  return g
}

// Merge many region-mapped geometries into one (they all share the atlas material).
export function merge(geos) {
  const g = mergeGeometries(geos.filter(Boolean), false)
  g.computeVertexNormals()
  return g
}

// A right triangular prism running along X (length L), used for gable roofs and
// gable-end fills. Cross-section in the Y–Z plane: base width `wd` (along Z, centred),
// apex height `ht` at z=0. Sides mapped to `region`. Returned centred on X.
export function gablePrism(L, wd, ht, region) {
  const hl = L / 2, hw = wd / 2
  // 6 verts: ends (x=-hl, x=+hl) × {leftBase, rightBase, apex}
  const P = [
    [-hl, 0, -hw], [-hl, 0, hw], [-hl, ht, 0],   // left end (0,1,2)
    [hl, 0, -hw], [hl, 0, hw], [hl, ht, 0],       // right end (3,4,5)
  ]
  const pos = [], uv = []
  const tri = (a, b, c, uvs) => {
    for (const i of [a, b, c]) pos.push(...P[i])
    for (const t of uvs) uv.push(...t)
  }
  // two ends (triangles)
  tri(0, 2, 1, [[0, 0], [0.5, 1], [1, 0]])
  tri(3, 4, 5, [[0, 0], [1, 0], [0.5, 1]])
  // two slopes (quads → 2 tris each)
  tri(1, 4, 0, [[0, 0], [1, 0], [0, 1]]); tri(4, 3, 0, [[1, 0], [1, 1], [0, 1]]) // back slope (+Z)
  tri(0, 3, 2, [[0, 0], [1, 0], [0, 1]]); tri(3, 5, 2, [[1, 0], [1, 1], [0, 1]]) // front slope (-Z) ... apex
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  remapUV(g, region)
  g.computeVertexNormals()
  return g
}
