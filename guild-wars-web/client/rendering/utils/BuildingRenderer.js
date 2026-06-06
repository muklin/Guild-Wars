import * as THREE from 'three'

// ── Low-level geometry helpers ────────────────────────────────────────────────

function tri(pos, ax, ay, az, bx, by, bz, cx, cy, cz) {
  pos.push(ax, ay, az, bx, by, bz, cx, cy, cz)
}

function quad(pos, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
  tri(pos, ax, ay, az, bx, by, bz, cx, cy, cz)
  tri(pos, ax, ay, az, cx, cy, cz, dx, dy, dz)
}

// Box walls + gable ends, centred on origin: X∈[-hw,hw], Y∈[0,wallH], Z∈[-hd,hd].
// Front face is +Z (faces the street). Gable ends rise to the ridge at x=0.
function buildWalls(pos, hw, hd, wallH, roofH) {
  quad(pos, -hw, 0, hd,   hw, 0, hd,   hw, wallH, hd,  -hw, wallH, hd)   // front (+Z)
  quad(pos,  hw, 0, -hd, -hw, 0, -hd, -hw, wallH, -hd,  hw, wallH, -hd)  // back
  quad(pos, -hw, 0, -hd, -hw, 0,  hd, -hw, wallH,  hd, -hw, wallH, -hd)  // left
  quad(pos,  hw, 0,  hd,  hw, 0, -hd,  hw, wallH, -hd,  hw, wallH,  hd)  // right
  const ry = wallH + roofH
  tri(pos, -hw, wallH, hd,   hw, wallH, hd,  0, ry, hd)   // front gable
  tri(pos,  hw, wallH, -hd, -hw, wallH, -hd, 0, ry, -hd)  // back gable
}

// Gabled roof: two slopes meeting at a ridge running along Z (front-to-back).
function buildRoof(pos, hw, hd, wallH, roofH) {
  const ry = wallH + roofH
  quad(pos, -hw, wallH, -hd, -hw, wallH,  hd,  0, ry,  hd,  0, ry, -hd)  // left slope
  quad(pos,  hw, wallH,  hd,  hw, wallH, -hd,  0, ry, -hd,  0, ry,  hd)  // right slope
}

// ── BuildingRenderer ──────────────────────────────────────────────────────────
// Spawns one street-facing building in the front half of each plot, using the
// plot's recorded streetEdges to find the frontage. All wall/roof geometry is
// merged into two meshes (one draw call each) for performance.

const FLOOR_H = 0.13   // world units per storey

export default class BuildingRenderer {
  constructor() {
    this.meshes = []
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0xd9c7ad, flatShading: true, roughness: 0.85 })
    this.roofMat = new THREE.MeshStandardMaterial({ color: 0x6e3b2a, flatShading: true, roughness: 1.0 })
  }

  clear(scene) {
    for (const m of this.meshes) {
      scene.remove(m)
      m.geometry?.dispose()
    }
    this.meshes = []
  }

  render(scene, plots) {
    this.clear(scene)
    if (!plots?.length) return

    const wallPos = [], roofPos = []
    for (const plot of plots) {
      if (plot.blockType === 'square') continue
      this._spawn(plot, wallPos, roofPos)
    }
    if (wallPos.length) this.meshes.push(this._addMesh(scene, wallPos, this.wallMat))
    if (roofPos.length) this.meshes.push(this._addMesh(scene, roofPos, this.roofMat))
  }

  _addMesh(scene, pos, mat) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, mat)
    mesh.castShadow = true
    scene.add(mesh)
    return mesh
  }

  // Append one building's transformed geometry into the shared wall/roof arrays.
  _spawn(plot, wallPos, roofPos) {
    const poly = plot.blockCorners
    const streetEdges = plot.streetEdges || []
    if (!poly || poly.length < 3 || streetEdges.length === 0) return

    // Primary frontage = longest street-facing edge.
    let a = null, b = null, len = -1
    for (const se of streetEdges) {
      const va = poly[se.index], vb = poly[(se.index + 1) % poly.length]
      if (!va || !vb) continue
      const l = Math.hypot(vb.x - va.x, vb.y - va.y)
      if (l > len) { len = l; a = va; b = vb }
    }
    if (!a || len < 0.06) return

    // Edge direction and inward normal.
    const ex = (b.x - a.x) / len, ey = (b.y - a.y) / len
    let nx = -ey, ny = ex
    let cx = 0, cy = 0
    for (const v of poly) { cx += v.x; cy += v.y }
    cx /= poly.length; cy /= poly.length
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny }   // point into the plot

    // Plot depth perpendicular to the frontage.
    let depth = 0
    for (const v of poly) {
      const d = (v.x - a.x) * nx + (v.y - a.y) * ny
      if (d > depth) depth = d
    }

    const bw = len * 0.72
    const bd = Math.min(depth * 0.5, bw * 1.5) * 0.9   // front ~half, not absurdly deep
    if (bw < 0.06 || bd < 0.05) return

    const setback = Math.min(0.04, depth * 0.12)
    const ccx = mx + nx * (setback + bd / 2)
    const ccy = my + ny * (setback + bd / 2)

    const hw = bw / 2, hd = bd / 2
    const floors = 1 + (plot.id % 3)
    const wallH = floors * FLOOR_H
    const roofH = Math.min(bw, bd) * 0.35

    // Build at origin, then transform: rotate so local +Z faces the street
    // (outward = -N), and translate to the footprint centre.
    const w = [], r = []
    buildWalls(w, hw, hd, wallH, roofH)
    buildRoof(r, hw, hd, wallH, roofH)
    const theta = Math.atan2(-nx, -ny)   // local +Z → outward (worldX=-nx, worldZ=-ny)
    const cosT = Math.cos(theta), sinT = Math.sin(theta)
    const push = (src, dst) => {
      for (let i = 0; i < src.length; i += 3) {
        const lx = src[i], ly = src[i + 1], lz = src[i + 2]
        // rotation about Y: x' = x cosθ + z sinθ ; z' = -x sinθ + z cosθ
        dst.push(ccx + lx * cosT + lz * sinT, ly, ccy - lx * sinT + lz * cosT)
      }
    }
    push(w, wallPos)
    push(r, roofPos)
  }
}
