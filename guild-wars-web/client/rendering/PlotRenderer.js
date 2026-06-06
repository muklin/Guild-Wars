import * as THREE from 'three'
import { DISTRICT_COLORS } from './DistrictRenderer.js'
import { STREET_COLORS } from './StreetRenderer.js'

// Fill material params. PLOT matches plot fills; STREET matches the street
// surface exactly (see StreetRenderer) so city squares blend into the streets.
const PLOT_FILL_MAT   = { roughness: 0.5, emissiveIntensity: 0.15 }
const STREET_FILL_MAT = { roughness: 0.6, emissiveIntensity: 0.5 }

export default class PlotRenderer {
  constructor(scene, originalMaterials) {
    this.scene = scene
    this.originalMaterials = originalMaterials
    this.showDebug = false
    this.debugObjects = []
    this._blockDebugMeshes = []
    this._blockSeedMeshes = []
    this._plotDebugMeshes = []

    this.blockMeshes = []
    this.plotMeshes = []
    this.gutterMeshes = []
    this._blockById = new Map()
    this._hoveredBlockMesh = null
    this.hoveredBlockId = null
  }

  setDebugVisible(show) {
    this.showDebug = show
    for (const obj of this.debugObjects) obj.visible = show
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

    // District-coloured underlay beneath the plots. Plots are already solid
    // district colour, so this fills the thin slivers left where the no-road-
    // crossing trim removes a plot spike — showing district colour, not the
    // magenta background. Hidden under streets/squares everywhere else.
    for (const block of (districtData?.blocks || [])) {
      const poly = block.blockCorners
      if (!poly?.length || block.blockType === 'square') continue
      const mesh = this._makeFill(poly, getColor(block.districtId), 0.071, PLOT_FILL_MAT)
      if (mesh) { this.scene.add(mesh); this.plotMeshes.push(mesh) }
    }

    for (const plot of plots) {
      // City squares are paved street surface: render with the street colour,
      // street material and street height so the block seam is invisible.
      const isSquare = plot.blockType === 'square'
      const color = isSquare ? this._squareColor(plot, STREET_PRIORITY) : getColor(plot.districtId)
      const mesh = isSquare
        ? this._makeFill(plot.blockCorners, color, 0.075, STREET_FILL_MAT)
        : this._makeFill(plot.blockCorners, color, 0.072, PLOT_FILL_MAT)

      if (mesh) {
        if (this.showDebug) {
          this.originalMaterials.set(mesh, mesh.material)
          mesh.material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.7, 0.6) })
        }
        this.scene.add(mesh)
        this.plotMeshes.push(mesh)
      }
    }

    const lineVerts = []
    for (const plot of plots) {
      if (plot.blockType === 'square') continue
      const poly = plot.blockCorners
      if (!poly?.length) continue
      // Skip street-facing edges: drawing them at this height paints the plot
      // boundary over the road (most visible wrapping a dead-end). Boundaries
      // are drawn only between plots, so they respect the street.
      const streetIdx = new Set((plot.streetEdges || []).map(e => e.index))
      for (let i = 0; i < poly.length; i++) {
        if (streetIdx.has(i)) continue
        const a = poly[i], b = poly[(i + 1) % poly.length]
        lineVerts.push(a.x, 0.077, a.y, b.x, 0.077, b.y)
      }
    }
    if (lineVerts.length > 0) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lineVerts), 3))
      const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0x00cc44 }))
      this.scene.add(lines)
      this.plotMeshes.push(lines)
    }
  }

  clearPlotLayer() {
    for (const m of this.plotMeshes) this.scene.remove(m)
    this.plotMeshes = []
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
      mesh.visible = this.showDebug
      this.scene.add(mesh)
      this.debugObjects.push(mesh)
      this._blockDebugMeshes.push(mesh)

      for (const s of (b.seeds || [])) {
        const sm = new THREE.Mesh(seedGeo, seedMat)
        sm.position.set(s.x, 0.092, s.y)
        sm.visible = this.showDebug
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
