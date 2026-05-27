import * as THREE from 'three'

// ── Low-level geometry helpers ────────────────────────────────────────────────

function tri(pos, uvs, ax, ay, az, bx, by, bz, cx, cy, cz, uA, vA, uB, vB, uC, vC) {
  pos.push(ax, ay, az, bx, by, bz, cx, cy, cz)
  uvs.push(uA, vA, uB, vB, uC, vC)
}

function quad(pos, uvs, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
  tri(pos, uvs, ax, ay, az, bx, by, bz, cx, cy, cz,  0, 0, 1, 0, 1, 1)
  tri(pos, uvs, ax, ay, az, cx, cy, cz, dx, dy, dz,  0, 0, 1, 1, 0, 1)
}

function makeGeo(pos, uvs) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(uvs), 2))
  geo.computeVertexNormals()
  return geo
}

// ── Geometry builders ─────────────────────────────────────────────────────────

function buildWalls(hw, hd, wallH, hasGables, roofH) {
  const pos = [], uvs = []
  quad(pos, uvs, -hw, 0, hd,   hw, 0, hd,   hw, wallH, hd,  -hw, wallH, hd)   // front
  quad(pos, uvs,  hw, 0, -hd, -hw, 0, -hd, -hw, wallH, -hd,  hw, wallH, -hd)  // back
  quad(pos, uvs, -hw, 0, -hd, -hw, 0,  hd, -hw, wallH,  hd, -hw, wallH, -hd)  // left
  quad(pos, uvs,  hw, 0,  hd,  hw, 0, -hd,  hw, wallH, -hd,  hw, wallH,  hd)  // right
  if (hasGables) {
    const ry = wallH + roofH
    tri(pos, uvs, -hw, wallH, hd,   hw, wallH, hd,  0, ry, hd,   0, 0, 1, 0, 0.5, 1)
    tri(pos, uvs,  hw, wallH, -hd, -hw, wallH, -hd, 0, ry, -hd,  0, 0, 1, 0, 0.5, 1)
  }
  return makeGeo(pos, uvs)
}

function buildGabledRoof(hw, hd, wallH, roofH) {
  const pos = [], uvs = [], ry = wallH + roofH
  quad(pos, uvs, -hw, wallH, -hd, -hw, wallH,  hd,  0, ry,  hd,  0, ry, -hd)  // left slope
  quad(pos, uvs,  hw, wallH,  hd,  hw, wallH, -hd,  0, ry, -hd,  0, ry,  hd)  // right slope
  return makeGeo(pos, uvs)
}

function buildHippedRoof(hw, hd, wallH, roofH) {
  const pos = [], uvs = [], ry = wallH + roofH
  const rl = hd * 0.5  // ridge half-length
  quad(pos, uvs, -hw, wallH, -hd, -hw, wallH,  hd,  0, ry,  rl,  0, ry, -rl)
  quad(pos, uvs,  hw, wallH,  hd,  hw, wallH, -hd,  0, ry, -rl,  0, ry,  rl)
  tri(pos, uvs, -hw, wallH,  hd,  hw, wallH,  hd,  0, ry,  rl,  0, 0, 1, 0, 0.5, 1)
  tri(pos, uvs,  hw, wallH, -hd, -hw, wallH, -hd,  0, ry, -rl,  0, 0, 1, 0, 0.5, 1)
  return makeGeo(pos, uvs)
}

function buildBarnRoof(hw, hd, wallH, roofH) {
  // Gambrel: two slopes per side — lower steep, upper shallow
  const pos = [], uvs = []
  const ry   = wallH + roofH
  const midH = wallH + roofH * 0.45
  const midW = hw * 0.38
  quad(pos, uvs, -hw, wallH, -hd, -hw, wallH,  hd, -midW, midH,  hd, -midW, midH, -hd)
  quad(pos, uvs, -midW, midH, -hd, -midW, midH,  hd,  0, ry,  hd,  0, ry, -hd)
  quad(pos, uvs,  hw, wallH,  hd,  hw, wallH, -hd,  midW, midH, -hd,  midW, midH,  hd)
  quad(pos, uvs,  midW, midH,  hd,  midW, midH, -hd,  0, ry, -hd,  0, ry,  hd)
  tri(pos, uvs, -hw, wallH,  hd,  hw, wallH,  hd,  0, ry,  hd,  0, 0, 1, 0, 0.5, 1)
  tri(pos, uvs,  hw, wallH, -hd, -hw, wallH, -hd,  0, ry, -hd,  0, 0, 1, 0, 0.5, 1)
  return makeGeo(pos, uvs)
}

function buildFlatRoof(hw, hd, wallH) {
  const pos = [], uvs = []
  quad(pos, uvs, -hw, wallH, -hd, hw, wallH, -hd, hw, wallH, hd, -hw, wallH, hd)
  return makeGeo(pos, uvs)
}

function buildChimney(hw, hd, wallH, roofH) {
  const cw = Math.min(hw * 0.18, 0.18), cd = Math.min(hd * 0.18, 0.18)
  const ch = roofH * 0.9
  const ox = -hw * 0.25, oy = wallH + roofH * 0.45, oz = 0
  const pos = [], uvs = []
  quad(pos, uvs, ox-cw, oy, oz+cd,  ox+cw, oy, oz+cd,  ox+cw, oy+ch, oz+cd,  ox-cw, oy+ch, oz+cd)
  quad(pos, uvs, ox+cw, oy, oz-cd,  ox-cw, oy, oz-cd,  ox-cw, oy+ch, oz-cd,  ox+cw, oy+ch, oz-cd)
  quad(pos, uvs, ox-cw, oy, oz-cd,  ox-cw, oy, oz+cd,  ox-cw, oy+ch, oz+cd,  ox-cw, oy+ch, oz-cd)
  quad(pos, uvs, ox+cw, oy, oz+cd,  ox+cw, oy, oz-cd,  ox+cw, oy+ch, oz-cd,  ox+cw, oy+ch, oz+cd)
  quad(pos, uvs, ox-cw, oy+ch, oz-cd,  ox+cw, oy+ch, oz-cd,  ox+cw, oy+ch, oz+cd,  ox-cw, oy+ch, oz+cd)
  return makeGeo(pos, uvs)
}

// ── BuildingRenderer ──────────────────────────────────────────────────────────

export default class BuildingRenderer {
  constructor() {
    this.meshes    = []
    this.textures  = new Map()   // textureId → DataTexture
    this.wallMats  = new Map()   // textureId → MeshStandardMaterial
  }

  render(scene, buildings, buildingTemplates, textureTemplates) {
    this.clear(scene)
    if (!buildings?.length || !buildingTemplates?.length) return

    this._initTextures(textureTemplates)

    const byId = new Map(buildingTemplates.map(t => [t.id, t]))

    for (const plot of buildings) {
      if (!plot.vertices?.length) continue
      const template = byId.get(plot.templateId)
      if (!template) continue
      const group = this._spawn(plot, template)
      if (group) { scene.add(group); this.meshes.push(group) }
    }
  }

  clear(scene) {
    for (const m of this.meshes) scene.remove(m)
    this.meshes = []
  }

  _initTextures(textureTemplates) {
    if (!textureTemplates?.length) return
    for (const tt of textureTemplates) {
      if (this.textures.has(tt.id)) continue
      const bytes = Uint8Array.from(atob(tt.data), c => c.charCodeAt(0))
      const tex = new THREE.DataTexture(bytes, tt.size, tt.size, THREE.RGBAFormat)
      tex.magFilter = THREE.NearestFilter
      tex.minFilter = THREE.NearestFilter
      tex.flipY     = true
      tex.needsUpdate = true
      this.textures.set(tt.id, tex)
      this.wallMats.set(tt.id, new THREE.MeshStandardMaterial({
        map: tex, flatShading: true, roughness: 0.85,
      }))
    }
  }

  _spawn(plot, template) {
    // AABB of plot polygon
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const v of plot.vertices) {
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x
      if (v.y < minZ) minZ = v.y; if (v.y > maxZ) maxZ = v.y
    }
    const pw = maxX - minX, pd = maxZ - minZ
    if (pw < 0.15 || pd < 0.15) return null

    // Fit building rectangle inside plot respecting widthDepthRatio
    const coverage = 0.72
    const ratio    = template.widthDepthRatio
    let bw = pw * coverage, bd = bw / ratio
    if (bd > pd * coverage) { bd = pd * coverage; bw = bd * ratio }
    if (bw < 0.1 || bd < 0.1) return null

    const hw = bw / 2, hd = bd / 2
    const floorH = 1.2
    const wallH  = template.floors * floorH
    const roofH  = Math.min(bw, bd) / 2 * template.roofPitch

    const wallMat = this.wallMats.get(plot.textureId) ??
      new THREE.MeshStandardMaterial({ color: 0xccbbaa, flatShading: true, roughness: 0.85 })
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3e2b1e, flatShading: true, roughness: 1.0 })
    const chiMat  = new THREE.MeshStandardMaterial({ color: 0x7a5540, flatShading: true, roughness: 1.0 })

    const group = new THREE.Group()
    group.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2)

    const roofType  = template.roofType
    const hasGables = roofType === 'gabled' || roofType === 'barn'

    // Walls + gable ends
    group.add(new THREE.Mesh(buildWalls(hw, hd, wallH, hasGables, roofH), wallMat))

    // Roof
    let roofGeo = null
    if      (roofType === 'flat')   roofGeo = buildFlatRoof(hw, hd, wallH)
    else if (roofType === 'hipped') roofGeo = buildHippedRoof(hw, hd, wallH, roofH)
    else if (roofType === 'barn')   roofGeo = buildBarnRoof(hw, hd, wallH, roofH)
    else                            roofGeo = buildGabledRoof(hw, hd, wallH, roofH)  // gabled + fallback
    group.add(new THREE.Mesh(roofGeo, roofMat))

    // Chimney
    if (template.hasChimney && roofType !== 'flat') {
      group.add(new THREE.Mesh(buildChimney(hw, hd, wallH, roofH), chiMat))
    }

    return group
  }
}
