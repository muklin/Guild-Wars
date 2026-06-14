import * as THREE from 'three'
import { DISTRICT_COLORS } from './DistrictRenderer.js'
import { STREET_COLORS } from './StreetRenderer.js'
import BuildingRenderer from './utils/BuildingRenderer.js'
import { posHash } from './utils/renderUtils.js'

// Fill material params. PLOT matches plot fills; STREET matches the street
// surface exactly (see StreetRenderer) so city squares blend into the streets.
const PLOT_FILL_MAT   = { roughness: 0.5, emissiveIntensity: 0.15 }
const STREET_FILL_MAT = { roughness: 0.6, emissiveIntensity: 0.5 }

// Fences: a share of plots are "fenced" — a low, light-brown wall along every
// boundary edge that does NOT face a street.
const FENCE_FRACTION = 0.5      // share of (non-square) plots that are fenced
const FENCE_HEIGHT   = 0.03     // wall height in world units (low)
const FENCE_BASE_Y   = 0.0755   // just above the plot fill (0.075)
const FENCE_COLOR    = 0xc2a878 // light brown

// Once District Setup is finished, plot bases are recoloured a uniform grassy brown
// (instead of per-district colours) for the "built city" look — a touch greener.
const GRASSY_BROWN   = 0x838f55

export default class PlotRenderer {
  constructor(scene, originalMaterials) {
    this.scene = scene
    this.originalMaterials = originalMaterials
    this.showDebug = false
    this.debugObjects = []
    this._blockDebugMeshes = []
    this._blockSeedMeshes = []
    this._plotDebugMeshes = []

    // Per-layer visibility flags (independent; all visible by default when debug is on)
    this._blockCentersVisible = true
    this._blockSeedsVisible   = true
    this._plotCentersVisible  = true

    this.buildingRenderer = new BuildingRenderer()

    this.blockMeshes = []
    this.plotMeshes = []
    this.gutterMeshes = []
    this._blockById = new Map()
    this._hoveredBlockMesh = null
    this.hoveredBlockId = null

    this.finishedGround = false   // true after District Setup → plot bases go grassy brown
    this._plotFills = []          // { mesh, districtId, districtColor, seed } for recolour/highlight
    this._squareFills = []        // { mesh, districtId } — paved squares, lightened on faction hover
    this._plotHighlight = []      // materials lightened on faction hover (plots + squares)
  }

  setDebugVisible(show) {
    this.showDebug = show
    for (const m of this._blockDebugMeshes) m.visible = show && this._blockCentersVisible
    for (const m of this._blockSeedMeshes)  m.visible = show && this._blockSeedsVisible
    for (const m of this._plotDebugMeshes)  m.visible = show && this._plotCentersVisible
  }

  setBlockCentersVisible(on) {
    this._blockCentersVisible = on
    for (const m of this._blockDebugMeshes) m.visible = this.showDebug && on
  }

  setBlockSeedsVisible(on) {
    this._blockSeedsVisible = on
    for (const m of this._blockSeedMeshes) m.visible = this.showDebug && on
  }

  setPlotCentersVisible(on) {
    this._plotCentersVisible = on
    for (const m of this._plotDebugMeshes) m.visible = this.showDebug && on
  }

  clearDebugObjects() {
    this._clearDebugGroup(this._blockDebugMeshes)
    this._clearDebugGroup(this._blockSeedMeshes)
    this._clearDebugGroup(this._plotDebugMeshes)
    for (const obj of this.debugObjects) this.scene.remove(obj)
    this.debugObjects = []
  }

  _clearDebugGroup(arr) {
    for (const obj of arr) this.scene.remove(obj)
    const toRemove = new Set(arr)
    this.debugObjects = this.debugObjects.filter(o => !toRemove.has(o))
    arr.length = 0
  }

  clearHover() {
    this.clearBlockHover()
  }

  // ── Blocks ──────────────────────────────────────────────────────────────────

  renderBlocks(blocks) {
    this.clearBlockLayer()
    this._blockById = new Map((blocks || []).map(b => [b.id, b.blockCorners]))

    if (!blocks?.length) return

    const blockLineVerts = []
    for (const block of blocks) {
      const poly = block.blockCorners
      if (!poly?.length) continue
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length]
        blockLineVerts.push(a.x, 0.08, a.y, b.x, 0.08, b.y)
      }
    }
    if (blockLineVerts.length === 0) return
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(blockLineVerts), 3))
    const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xff8800 }))
    this.scene.add(lines)
    this.blockMeshes.push(lines)
  }

  clearBlockLayer() {
    for (const m of this.blockMeshes) this.scene.remove(m)
    this.blockMeshes = []
  }

  setBlockHover(blockId) {
    if (this.hoveredBlockId === blockId) return
    this.clearBlockHover()
    const poly = this._blockById.get(blockId)
    if (!poly?.length) return
    const verts = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      verts.push(a.x, 0.085, a.y, b.x, 0.085, b.y)
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    const mesh = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xffff00 }))
    this.scene.add(mesh)
    this._hoveredBlockMesh = mesh
    this.hoveredBlockId = blockId
  }

  clearBlockHover() {
    if (this._hoveredBlockMesh) {
      this.scene.remove(this._hoveredBlockMesh)
      this._hoveredBlockMesh.geometry?.dispose()
      this._hoveredBlockMesh.material?.dispose()
      this._hoveredBlockMesh = null
    }
    this.hoveredBlockId = null
  }

  // ── Plots ───────────────────────────────────────────────────────────────────

  renderPlots(plots, districtData) {
    this.clearPlotLayer()
    if (!plots?.length) return

    const districtById = new Map((districtData?.districts || []).map(d => [d.id, d]))
    const STREET_PRIORITY = { Stone: 2, Brick: 1, Mud: 0 }

    const getColor = (districtId) => {
      const d = districtById.get(districtId)
      if (!d?.assignedType) return DISTRICT_COLORS.Neutral
      const key = d.assignedType === 'Residential' && d.residentialClass ? d.residentialClass
        : d.assignedType === 'Leadership' && d.LeadershipClass ? d.LeadershipClass
        : d.assignedType
      return DISTRICT_COLORS.get(key) || DISTRICT_COLORS.Neutral
    }

    // Base colour of a non-square plot/underlay: per-district during setup, uniform
    // grassy brown once finished. The per-district colour is remembered for hover.
    const plotBase = (districtId) => this.finishedGround ? GRASSY_BROWN : getColor(districtId)

    // District-coloured underlay beneath the plots. Plots are already solid
    // district colour, so this fills the thin slivers left where the no-road-
    // crossing trim removes a plot spike — showing district colour, not the
    // magenta background. Hidden under streets/squares everywhere else.
    for (const block of (districtData?.blocks || [])) {
      const poly = block.blockCorners
      if (!poly?.length || block.blockType === 'square') continue
      const seed = this._polySeed(poly)
      const mesh = this._makeFill(poly, this._jitterColor(plotBase(block.districtId), seed), 0.071, PLOT_FILL_MAT)
      if (mesh) {
        mesh.userData = { districtId: block.districtId }
        this._plotFills.push({ mesh, districtId: block.districtId, districtColor: getColor(block.districtId), seed })
        this.scene.add(mesh); this.plotMeshes.push(mesh)
      }
    }

    for (const plot of plots) {
      // City squares are paved street surface: render with the street colour,
      // street material and street height so the block seam is invisible.
      const isSquare = plot.blockType === 'square'
      const seed = this._polySeed(plot.blockCorners)
      // Non-square plots get a seeded ±5% colour jitter for ground variation.
      const color = isSquare ? this._squareColor(plot, STREET_PRIORITY) : this._jitterColor(plotBase(plot.districtId), seed)
      const mesh = isSquare
        ? this._makeFill(plot.blockCorners, color, 0.075, STREET_FILL_MAT)
        : this._makeFill(plot.blockCorners, color, 0.073, PLOT_FILL_MAT)

      if (mesh && !isSquare) {
        mesh.userData = { districtId: plot.districtId }
        this._plotFills.push({ mesh, districtId: plot.districtId, districtColor: getColor(plot.districtId), seed })
      } else if (mesh && isSquare) {
        this._squareFills.push({ mesh, districtId: plot.districtId })
      }

      if (mesh) {
        if (this.showDebug) {
          this.originalMaterials.set(mesh, mesh.material)
          mesh.material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.7, 0.6) })
        }
        this.scene.add(mesh)
        this.plotMeshes.push(mesh)
      }
    }

    // Fences: each plot is deterministically fenced or not. A fenced plot gets a low
    // light-brown wall along every boundary edge that does NOT face a street (street-
    // facing sides stay open). All walls merge into one mesh.
    const top = FENCE_BASE_Y + FENCE_HEIGHT
    const fenceVerts = []
    for (const plot of plots) {
      if (plot.blockType === 'square') continue
      const poly = plot.blockCorners
      if (!poly?.length) continue
      // Fenced decision seeded by plot position (not the unstable plot id) so it stays
      // put when neighbouring districts change.
      let fcx = 0, fcy = 0
      for (const v of poly) { fcx += v.x; fcy += v.y }
      if (this._rand(posHash(fcx / poly.length, fcy / poly.length)) >= FENCE_FRACTION) continue
      const streetIdx = new Set((plot.streetEdges || []).map(e => e.index))
      for (let i = 0; i < poly.length; i++) {
        if (streetIdx.has(i)) continue   // no fence on street-facing sides
        const a = poly[i], b = poly[(i + 1) % poly.length]
        // Vertical wall quad (two triangles) along the edge.
        fenceVerts.push(
          a.x, FENCE_BASE_Y, a.y,  b.x, FENCE_BASE_Y, b.y,  b.x, top, b.y,
          a.x, FENCE_BASE_Y, a.y,  b.x, top, b.y,           a.x, top, a.y,
        )
      }
    }
    if (fenceVerts.length > 0) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fenceVerts), 3))
      geom.computeVertexNormals()
      const mat = new THREE.MeshStandardMaterial({ color: FENCE_COLOR, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, emissive: FENCE_COLOR, emissiveIntensity: 0.12 })
      const mesh = new THREE.Mesh(geom, mat)
      this.scene.add(mesh)
      this.plotMeshes.push(mesh)
    }

    // Street-facing buildings, one per plot in its front half.
    this.buildingRenderer.render(this.scene, plots, districtData)
  }

  clearPlotLayer() {
    for (const m of this.plotMeshes) this.scene.remove(m)
    this.plotMeshes = []
    this._plotFills = []
    this._squareFills = []
    this._plotHighlight = []
    this.buildingRenderer.clear(this.scene)
  }

  // ── Finished-ground recolour + faction-hover highlight ───────────────────────

  // Switch plot bases between per-district colours (during setup) and a uniform
  // grassy brown (once District Setup is complete). Recolours existing fills now.
  setFinishedGround(finished) {
    this.finishedGround = !!finished
    this.clearDistrictPlotHighlight()
    for (const f of this._plotFills) {
      const c = this._jitterColor(this.finishedGround ? GRASSY_BROWN : f.districtColor, f.seed ?? 0)
      f.mesh.material.color.setHex(c)
      f.mesh.material.emissive?.setHex(c)
    }
  }

  // Lighten one district's plot bases AND its paved squares (the visible "ground
  // plane") on faction hover. Reverted by clearDistrictPlotHighlight().
  highlightDistrictPlots(districtId) {
    this.clearDistrictPlotHighlight()
    if (districtId === undefined || districtId === null) return
    const white = new THREE.Color(0xffffff)
    const lighten = (mesh) => {
      const mat = mesh.material
      this._plotHighlight.push({ mat, color: mat.color.getHex(), emissive: mat.emissive?.getHex() })
      mat.color.lerp(white, 0.45)
      mat.emissive?.lerp(white, 0.45)
    }
    for (const f of this._plotFills)   if (f.districtId === districtId) lighten(f.mesh)
    for (const s of this._squareFills) if (s.districtId === districtId) lighten(s.mesh)
  }

  clearDistrictPlotHighlight() {
    for (const h of this._plotHighlight) {
      h.mat.color.setHex(h.color)
      if (h.emissive !== undefined && h.mat.emissive) h.mat.emissive.setHex(h.emissive)
    }
    this._plotHighlight = []
  }

  // ── Debug ───────────────────────────────────────────────────────────────────

  drawBlockCenters(blocks) {
    this._clearDebugGroup(this._blockDebugMeshes)
    this._clearDebugGroup(this._blockSeedMeshes)

    const blockGeo = new THREE.SphereGeometry(0.0375, 6, 6)
    const blockMat = new THREE.MeshBasicMaterial({ color: 0xff0000 })
    const seedGeo  = new THREE.SphereGeometry(0.018, 5, 5)
    const seedMat  = new THREE.MeshBasicMaterial({ color: 0x00ffff })

    for (const b of (blocks || [])) {
      const poly = b.blockCorners
      if (!poly?.length) continue
      const c = { x: poly.reduce((s, v) => s + v.x, 0) / poly.length, y: poly.reduce((s, v) => s + v.y, 0) / poly.length }
      const mesh = new THREE.Mesh(blockGeo, blockMat)
      mesh.position.set(c.x, 0.09, c.y)
      mesh.userData = { kind: 'block', id: b.id, blockType: b.blockType, districtId: b.districtId }
      mesh.visible = this.showDebug && this._blockCentersVisible
      this.scene.add(mesh)
      this.debugObjects.push(mesh)
      this._blockDebugMeshes.push(mesh)

      for (const s of (b.seeds || [])) {
        const sm = new THREE.Mesh(seedGeo, seedMat)
        sm.position.set(s.x, 0.092, s.y)
        sm.visible = this.showDebug && this._blockCentersVisible
        this.scene.add(sm)
        this.debugObjects.push(sm)
        this._blockSeedMeshes.push(sm)
      }
    }
  }

  getBlockCenterAtWorldPos(worldX, worldY, threshold = 0.2) {
    const rSq = threshold * threshold
    for (const mesh of this._blockDebugMeshes) {
      if (!mesh.visible) continue
      const dx = worldX - mesh.position.x, dy = worldY - mesh.position.z
      if (dx * dx + dy * dy < rSq) return mesh.userData
    }
    return null
  }

  drawPlotCenters(plots) {
    this._clearDebugGroup(this._plotDebugMeshes)
    const geo = new THREE.SphereGeometry(0.022, 6, 6)
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ff88 })
    for (const p of (plots || [])) {
      const poly = p.blockCorners
      if (!poly?.length) continue
      const cx = poly.reduce((s, v) => s + v.x, 0) / poly.length
      const cy = poly.reduce((s, v) => s + v.y, 0) / poly.length
      const m = new THREE.Mesh(geo, mat)
      m.position.set(cx, 0.091, cy)
      m.visible = this.showDebug && this._plotCentersVisible
      m.userData = { kind: 'plot', id: p.id, blockId: p.blockId, districtId: p.districtId, blockType: p.blockType ?? 'normal', streetEdges: p.streetEdges?.length ?? 0 }
      this.scene.add(m)
      this.debugObjects.push(m)
      this._plotDebugMeshes.push(m)
    }
  }

  getPlotCenterAtWorldPos(worldX, worldY, threshold = 0.2) {
    const rSq = threshold * threshold
    for (const mesh of this._plotDebugMeshes) {
      if (!mesh.visible) continue
      const dx = worldX - mesh.position.x, dy = worldY - mesh.position.z
      if (dx * dx + dy * dy < rSq) return mesh.userData
    }
    return null
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  // Deterministic [0,1) RNG from a seed (stable across rebuilds) — used to pick
  // which plots are fenced.
  _rand(seed) {
    let s = (seed * 2654435761) >>> 0
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 0x100000000
  }

  // Stable per-polygon seed from its centroid (independent of unstable plot ids).
  _polySeed(poly) {
    if (!poly?.length) return 0
    let cx = 0, cy = 0
    for (const v of poly) { cx += v.x; cy += v.y }
    return posHash(cx / poly.length, cy / poly.length)
  }

  // Apply a seeded ±5% per-channel jitter to a colour, for ground variation.
  _jitterColor(hex, seed) {
    const ch = (shift, i) => {
      const v = (hex >> shift) & 255
      const f = 0.95 + this._rand(seed * 31 + i) * 0.10   // [0.95, 1.05]
      return Math.max(0, Math.min(255, Math.round(v * f)))
    }
    return (ch(16, 1) << 16) | (ch(8, 2) << 8) | ch(0, 3)
  }

  // Colour for a city-square plot: the street colour of the majority of its
  // surrounding street edges. Ties broken by street priority (Stone > Brick > Mud).
  _squareColor(plot, priority) {
    const edges = plot.streetEdges || []
    if (!edges.length) return STREET_COLORS.unassigned
    const counts = new Map()
    for (const e of edges) counts.set(e.type, (counts.get(e.type) || 0) + 1)
    let best = null, bestN = -1
    for (const [type, n] of counts) {
      if (n > bestN || (n === bestN && (priority[type] ?? -1) > (priority[best] ?? -1))) {
        best = type; bestN = n
      }
    }
    return STREET_COLORS.get(best) ?? STREET_COLORS.unassigned
  }

  _makeFill(poly, colorHex, Y, matOpts = PLOT_FILL_MAT) {
    if (!poly || poly.length < 3) return null
    const contour = poly.map(v => new THREE.Vector2(v.x, v.y))
    let triangles
    try {
      triangles = THREE.ShapeUtils.triangulateShape(contour, [])
    } catch {
      return null
    }
    if (!triangles?.length) return null
    const verts = []
    for (const v of poly) verts.push(v.x, Y, v.y)
    const indices = []
    for (const [a, b, c] of triangles) indices.push(a, b, c)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1))
    geometry.computeVertexNormals()
    const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: matOpts.roughness, metalness: 0, emissive: colorHex, emissiveIntensity: matOpts.emissiveIntensity, side: THREE.DoubleSide })
    return new THREE.Mesh(geometry, mat)
  }
}
