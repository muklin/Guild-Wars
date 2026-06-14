import * as THREE from 'three'

export const STREET_COLORS = {
  Mud:       0x6B4C2A,   // brown dirt road
  Brick:     0x6B291C,   // warm clay-terracotta
  Stone:     0x888fa0,   // blue-gray flagstone
  unassigned: 0xb8a680,
  get(type) {
    return this[type] ?? null
  }
}

const WIDTH_FACTOR = { Stone: 2.0, Mud: 0.8, Brick: 1.0, MainRoad: 2.0 }

function scaledGutter(ptL, ptR, f) {
  const cx = (ptL.x + ptR.x) / 2, cy = (ptL.y + ptR.y) / 2
  const hx = (ptR.x - ptL.x) / 2, hy = (ptR.y - ptL.y) / 2
  return { left: { x: cx - hx * f, y: cy - hy * f }, right: { x: cx + hx * f, y: cy + hy * f } }
}

export default class StreetRenderer {
  constructor(scene) {
    this.scene = scene
    this.showDebug = false
    this.debugObjects = []
    this._streetSeedMeshes = []

    this._streetSeedsVisible = true

    this._streetGraph = null
    this.streetMeshes = []
    this.gutterMeshes = []
    this._districtHighlight = []   // streets lightened on faction hover

    this.hoveredStreetEdgeKey = null
    this._streetHoverMesh = null
    this.hoveredJunctionId = null
    this._junctionHoverMesh = null

    this._boundaryHighlight = []  // { mat, color, emissive, ei } — saved states for recolor restore
  }

  setDebugVisible(show) {
    this.showDebug = show
    for (const m of this._streetSeedMeshes) m.visible = show && this._streetSeedsVisible
  }

  setStreetSeedsVisible(on) {
    this._streetSeedsVisible = on
    for (const m of this._streetSeedMeshes) m.visible = this.showDebug && on
  }

  clearDebugObjects() {
    this._clearDebugGroup(this._streetSeedMeshes)
    for (const obj of this.debugObjects) this.scene.remove(obj)
    this.debugObjects = []
  }

  _clearDebugGroup(arr) {
    for (const obj of arr) this.scene.remove(obj)
    const toRemove = new Set(arr)
    this.debugObjects = this.debugObjects.filter(o => !toRemove.has(o))
    arr.length = 0
  }

  // Recolor all existing street meshes whose roadId belongs to a boundary chain.
  // Uses the same save/restore pattern as highlightDistrictStreets.
  setBoundaryChainHighlight(edgeId, color = 0xffff66) {
    this.clearBoundaryChainHighlight()
    const prefix = `street-boundary-${edgeId}-`
    for (const mesh of this.streetMeshes) {
      if (!mesh.userData.roadId?.startsWith(prefix)) continue
      const mat = mesh.material
      this._boundaryHighlight.push({ mat, color: mat.color.getHex(), emissive: mat.emissive?.getHex(), ei: mat.emissiveIntensity })
      mat.color.setHex(color)
      if (mat.emissive) mat.emissive.setHex(color)
      mat.emissiveIntensity = 0.9
    }
  }

  clearBoundaryChainHighlight() {
    for (const h of this._boundaryHighlight) {
      h.mat.color.setHex(h.color)
      if (h.emissive !== undefined && h.mat.emissive) h.mat.emissive.setHex(h.emissive)
      h.mat.emissiveIntensity = h.ei
    }
    this._boundaryHighlight = []
  }

  clearHover() {
    if (this.hoveredStreetEdgeKey !== null) {
      if (this._streetHoverMesh) {
        this.scene.remove(this._streetHoverMesh)
        this._streetHoverMesh.geometry?.dispose?.()
        this._streetHoverMesh.material?.dispose?.()
        this._streetHoverMesh = null
      }
      this.hoveredStreetEdgeKey = null
    }
    if (this.hoveredJunctionId !== null) {
      if (this._junctionHoverMesh) {
        this.scene.remove(this._junctionHoverMesh)
        this._junctionHoverMesh.geometry?.dispose?.()
        this._junctionHoverMesh.material?.dispose?.()
        this._junctionHoverMesh = null
      }
      this.hoveredJunctionId = null
    }
    this.clearBoundaryChainHighlight()
  }

  setStreetGraph(streetGraph) {
    this._streetGraph = streetGraph
  }

  // ── Street rendering ────────────────────────────────────────────────────────

  renderStreetGraph(streetGraph) {
    this.clearStreetLayer()
    const junctions = streetGraph?.junctions
    if (!junctions?.length) return

    const junctionById = new Map(junctions.map(j => [j.id, j]))
    const fallback = STREET_COLORS.Mud
    const Y = 0.075, fillY = 0.0752

    for (const j of junctions) {
      for (const conn of j.connections) {
        if (conn.toId <= j.id) continue
        // Canal (and future Docks) boundaries are physical waterways rendered by
        // DistrictRenderer, not walkable streets — skip here so they don't show
        // as brown Mud roads underneath the water mesh.
        if (conn.type === 'Canal' || conn.type === 'Docks') continue
        const j2 = junctionById.get(conn.toId)
        if (!j2) continue
        const conn2 = j2.connections.find(c => c.toId === j.id)
        if (!conn2) continue

        const type = conn.type
        const color = STREET_COLORS.get(type) || fallback
        const { gutterLeft: aL, gutterRight: aR } = conn
        const { gutterLeft: bL, gutterRight: bR } = conn2
        const verts = new Float32Array([
          aR.x, Y, aR.y,
          aL.x, Y, aL.y,
          bR.x, Y, bR.y,
          bL.x, Y, bL.y,
        ])
        const geom = new THREE.BufferGeometry()
        geom.setAttribute('position', new THREE.BufferAttribute(verts, 3))
        geom.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1))
        geom.computeVertexNormals()
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, emissive: color, emissiveIntensity: 0.5 })
        const mesh = new THREE.Mesh(geom, mat)
        mesh.userData = { roadId: conn.roadId, districtId: conn.districtId }
        this.scene.add(mesh)
        this.streetMeshes.push(mesh)
      }
    }

    for (const j of junctions) {
      if (j.connections.length < 2) continue
      if (j.type === 'Canal' || j.type === 'Docks') continue

      const pts = []
      for (const conn of j.connections) {
        if (conn.type === 'Canal' || conn.type === 'Docks') continue
        pts.push(conn.gutterLeft, conn.gutterRight)
      }
      pts.sort((a, b) => Math.atan2(a.y - j.y, a.x - j.x) - Math.atan2(b.y - j.y, b.x - j.x))

      const uniq = [pts[0]]
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i], q = uniq[uniq.length - 1]
        if (Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) uniq.push(p)
      }
      const last = uniq[uniq.length - 1], first = uniq[0]
      if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-6) uniq.pop()
      if (uniq.length < 3) continue

      const n = uniq.length
      const verts = new Float32Array((n + 1) * 3)
      verts[0] = j.x; verts[1] = fillY; verts[2] = j.y
      for (let i = 0; i < n; i++) {
        verts[(i + 1) * 3]     = uniq[i].x
        verts[(i + 1) * 3 + 1] = fillY
        verts[(i + 1) * 3 + 2] = uniq[i].y
      }
      const tris = []
      for (let i = 0; i < n; i++) tris.push(0, ((i + 1) % n) + 1, i + 1)

      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.BufferAttribute(verts, 3))
      geom.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1))
      geom.computeVertexNormals()
      const color = STREET_COLORS.get(j.type) || fallback
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, emissive: color, emissiveIntensity: 0.5 })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.userData = { districtId: j.districtId }
      this.scene.add(mesh)
      this.streetMeshes.push(mesh)
    }
  }

  // Lighten the streets (and junction caps) of one district — used to highlight a
  // faction's district on hover. Restores on clearDistrictHighlight().
  highlightDistrictStreets(districtId) {
    this.clearDistrictHighlight()
    if (districtId === undefined || districtId === null) return
    const white = new THREE.Color(0xffffff)
    for (const m of this.streetMeshes) {
      if (m.userData?.districtId !== districtId) continue
      const mat = m.material
      this._districtHighlight.push({ mat, color: mat.color.getHex(), emissive: mat.emissive?.getHex(), ei: mat.emissiveIntensity })
      mat.color.lerp(white, 0.5)
      mat.emissive?.lerp(white, 0.5)
      mat.emissiveIntensity = 0.85
    }
  }

  clearDistrictHighlight() {
    for (const h of this._districtHighlight) {
      h.mat.color.setHex(h.color)
      if (h.emissive !== undefined && h.mat.emissive) h.mat.emissive.setHex(h.emissive)
      h.mat.emissiveIntensity = h.ei
    }
    this._districtHighlight = []
  }

  clearStreetLayer() {
    this.clearBoundaryChainHighlight()
    for (const m of this.streetMeshes) this.scene.remove(m)
    this.streetMeshes = []
  }

  renderGutters(streetGraph) {
    this.clearGutterLayer()
    const junctions = streetGraph?.junctions
    if (!junctions?.length) return

    const Y = 0.077
    const verts = []
    const junctionById = new Map(junctions.map(j => [j.id, j]))

    const addSeg = (a, b) => { verts.push(a.x, Y, a.y, b.x, Y, b.y) }

    for (const j of junctions) {
      for (const conn of j.connections) {
        if (conn.toId <= j.id) continue
        const j2 = junctionById.get(conn.toId)
        if (!j2) continue
        const conn2 = j2.connections.find(c => c.toId === j.id)
        if (!conn2) continue
        addSeg(conn.gutterLeft,  conn2.gutterRight)
        addSeg(conn.gutterRight, conn2.gutterLeft)
      }
    }

    for (const j of junctions) {
      const conns = j.connections
      const n = conns.length
      if (n === 1) {
        addSeg(conns[0].gutterRight, conns[0].gutterLeft)
        continue
      }
      for (let i = 0; i < n; i++) {
        const a = conns[i].gutterLeft
        const b = conns[(i + 1) % n].gutterRight
        if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-6) addSeg(a, b)
      }
    }

    if (verts.length === 0) return
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0x00ffff }))
    this.scene.add(lines)
    this.gutterMeshes.push(lines)
  }

  clearGutterLayer() {
    for (const m of this.gutterMeshes) this.scene.remove(m)
    this.gutterMeshes = []
  }

  // ── Hover ───────────────────────────────────────────────────────────────────

  setStreetEdgeHover(edge) {
    if (!edge) return
    const key = edge.id ?? `${edge.nodeA}_${edge.nodeB}`
    if (this.hoveredStreetEdgeKey === key) return
    this.clearHover()
    const junctions = this._streetGraph?.junctions
    if (!junctions?.length) return
    const byId = new Map(junctions.map(j => [j.id, j]))
    const a = byId.get(edge.nodeA), b = byId.get(edge.nodeB)
    if (!a || !b) return
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len === 0) return
    const thickness = 0.0875 * 1.2
    const r = thickness / 2
    const px = (-dy / len) * r, py = (dx / len) * r
    const Y = 0.078
    const verts = new Float32Array([
      a.x - px, Y, a.y - py,
      a.x + px, Y, a.y + py,
      b.x + px, Y, b.y + py,
      b.x - px, Y, b.y - py,
    ])
    const idx = new Uint16Array([0, 1, 2, 0, 2, 3])
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geom.setIndex(new THREE.BufferAttribute(idx, 1))
    geom.computeVertexNormals()
    const mat = new THREE.MeshBasicMaterial({ color: 0xffff66, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geom, mat)
    this.scene.add(mesh)
    this._streetHoverMesh = mesh
    this.hoveredStreetEdgeKey = key
  }

  setJunctionHover(junctionId) {
    if (this.hoveredJunctionId === junctionId) return
    this.clearHover()
    const junction = this._streetGraph?.junctions?.find(j => j.id === junctionId)
    if (!junction) return
    const r = 0.0875
    const geo = new THREE.CylinderGeometry(r, r, 0.002, 16)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(junction.x, 0.085, junction.y)
    this.scene.add(mesh)
    this._junctionHoverMesh = mesh
    this.hoveredJunctionId = junctionId
  }

  // ── Hit testing ─────────────────────────────────────────────────────────────

  getStreetEdgeAtWorldPos(worldX, worldY, threshold = 0.0875) {
    const junctions = this._streetGraph?.junctions
    if (!junctions?.length) return null
    const byId = new Map(junctions.map(j => [j.id, j]))
    const thrSq = threshold * threshold
    let bestEdge = null, bestDistSq = Infinity, bestT = 0
    for (const j of junctions) {
      for (const conn of j.connections) {
        if (conn.toId <= j.id) continue
        const b = byId.get(conn.toId)
        if (!b) continue
        const dx = b.x - j.x, dy = b.y - j.y
        const lenSq = dx * dx + dy * dy
        if (lenSq < 1e-12) continue
        let t = ((worldX - j.x) * dx + (worldY - j.y) * dy) / lenSq
        t = Math.max(0, Math.min(1, t))
        const px = j.x + t * dx, py = j.y + t * dy
        const distSq = (worldX - px) ** 2 + (worldY - py) ** 2
        if (distSq < thrSq && distSq < bestDistSq) {
          bestDistSq = distSq
          bestEdge = { nodeA: j.id, nodeB: conn.toId, id: conn.roadId, type: conn.type, districtId: conn.districtId }
          bestT = t
        }
      }
    }
    if (!bestEdge) return null
    const a = byId.get(bestEdge.nodeA), b = byId.get(bestEdge.nodeB)
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    return {
      kind: 'streetEdge',
      id: bestEdge.id ?? null,
      type: bestEdge.type ?? null,
      districtId: bestEdge.districtId ?? null,
      nodeA: bestEdge.nodeA,
      nodeB: bestEdge.nodeB,
      length,
      tipDist: Math.sqrt(bestDistSq),
      t: bestT,
    }
  }

  getJunctionAtWorldPos(worldX, worldY, threshold = 0.175) {
    const junctions = this._streetGraph?.junctions
    if (!junctions?.length) return null
    const thrSq = threshold * threshold
    let best = null, bestDistSq = Infinity
    for (const j of junctions) {
      const dx = worldX - j.x, dy = worldY - j.y
      const distSq = dx * dx + dy * dy
      if (distSq < thrSq && distSq < bestDistSq) { bestDistSq = distSq; best = j }
    }
    return best
  }

  // ── Debug ───────────────────────────────────────────────────────────────────

  getStreetSeedAtWorldPos(worldX, worldY, threshold = 0.1) {
    const rSq = threshold * threshold
    for (const m of this._streetSeedMeshes) {
      if (!m.visible) continue
      const dx = worldX - m.position.x, dy = worldY - m.position.z
      if (dx * dx + dy * dy < rSq) return m.userData
    }
    return null
  }

  drawStreetSeeds(streetGraph) {
    this._clearDebugGroup(this._streetSeedMeshes)
    const junctions = streetGraph?.junctions
    if (!junctions?.length) return
    const geo = new THREE.SphereGeometry(0.018, 6, 6)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffff00 })
    for (const j of junctions) {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(j.x, 0.093, j.y)
      m.visible = this.showDebug && this._streetSeedsVisible
      m.userData = { kind: 'streetSeed', id: j.id, type: j.type, districtId: j.districtId, connections: j.connections?.length ?? 0, x: j.x, y: j.y }
      this.scene.add(m)
      this.debugObjects.push(m)
      this._streetSeedMeshes.push(m)
    }
  }
}
