import * as THREE from 'three'

export default class CameraController {
  constructor(camera, renderer, onDirty) {
    this.camera = camera
    this.renderer = renderer
    this._onDirty = onDirty ?? (() => {})
    this.worldSize = 50

    // Orbital parameters (spherical coordinates)
    this.targetPosition = new THREE.Vector3(25, 0, 25)
    this.distance = 45
    this.azimuth = 0
    this.elevation = Math.PI / 6 // 30 degrees

    // Zoom — start framing the full map; allow deep zoom-in
    this.minZoom = 4.5   // enforced dynamically via world bounds
    this.maxZoom = 40.0
    this.camera.zoom = 4.5
    this.camera.updateProjectionMatrix()

    // Panning state
    this.isPanning = false
    this.gazeLockWorldPoint = null

    // Home position (updated when city/HQ is known)
    this.homeX = 25
    this.homeZ = 25

    // Keyboard state
    this.keys = {}
    this._enabled = true

    this.setupEventListeners()
    this.updateCameraPosition()
  }

  setupEventListeners() {
    document.addEventListener('keydown', (e) => this.onKeyDown(e))
    document.addEventListener('keyup',   (e) => this.onKeyUp(e))
    document.addEventListener('wheel',   (e) => this.onMouseWheel(e), { passive: false })
    document.addEventListener('mousedown', (e) => this.onMouseDown(e))
    document.addEventListener('mousemove', (e) => this.onMouseMove(e))
    document.addEventListener('mouseup',   (e) => this.onMouseUp(e))
  }

  _isTyping() {
    const el = document.activeElement
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
  }

  setEnabled(on) {
    this._enabled = on
    if (!on) this.keys = {}   // clear held keys so nothing moves when re-enabled
  }

  setHomePosition(x, z) {
    this.homeX = x
    this.homeZ = z
  }

  _snapTargetToScreenCenter() {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const pt = this.raycastToGroundPlane(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (pt) this.targetPosition.set(pt.x, 0, pt.z)
  }

  onKeyDown(e) {
    if (!this._enabled || this._isTyping()) return
    if (e.code === 'KeyD' && e.shiftKey) return

    if (e.code === 'KeyQ') {
      if (!this.keys['keyq']) this._snapTargetToScreenCenter()  // lock pivot on first press only
      this.keys['keyq'] = true
      e.preventDefault()
    } else if (e.code === 'KeyE') {
      if (!this.keys['keye']) this._snapTargetToScreenCenter()  // lock pivot on first press only
      this.keys['keye'] = true
      e.preventDefault()
    } else if (e.key.toLowerCase() === 'f') {
      this.frameAllContent()
      e.preventDefault()
    } else if (e.key === ']') {
      this.camera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.camera.zoom * 1.15))
      this.camera.updateProjectionMatrix()
      this.enforceWorldBounds()
      this._onDirty()
      e.preventDefault()
    } else if (e.key === '[') {
      this.camera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.camera.zoom / 1.15))
      this.camera.updateProjectionMatrix()
      this.enforceWorldBounds()
      this._onDirty()
      e.preventDefault()
    } else {
      this.keys[e.code.toLowerCase()] = true
      if (e.code.startsWith('Arrow')) e.preventDefault()
    }
  }

  onKeyUp(e) {
    if (!this._enabled || this._isTyping()) return
    if (e.code === 'KeyD' && e.shiftKey) return
    this.keys[e.code.toLowerCase()] = false
  }

  onMouseWheel(e) {
    if (!this._enabled) return
    e.preventDefault()
    const zoomFactor = 1.15
    const direction = e.deltaY < 0 ? zoomFactor : 1 / zoomFactor
    this.camera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.camera.zoom * direction))
    this.camera.updateProjectionMatrix()
    this.enforceWorldBounds()
    this._onDirty()
  }

  onMouseDown(e) {
    if (!this._enabled) return
    if (e.button === 1 || e.button === 2) {
      this.isPanning = true
      this.gazeLockWorldPoint = this.raycastToGroundPlane(e.clientX, e.clientY)
      e.preventDefault()
    }
  }

  onMouseMove(e) {
    if (!this.isPanning || !this.gazeLockWorldPoint) return

    // Move target so the locked world point stays under the cursor.
    const current = this.raycastToGroundPlane(e.clientX, e.clientY)
    if (current) {
      this.targetPosition.add(
        new THREE.Vector3().subVectors(this.gazeLockWorldPoint, current)
      )
      this.updateCameraPosition()
      this.enforceWorldBounds()
    }
  }

  onMouseUp(e) {
    if (e.button === 1 || e.button === 2) {
      this.isPanning = false
      this.gazeLockWorldPoint = null
    }
  }

  // Correct orthographic raycasting — matches InputHandler.screenToWorld exactly.
  // Returns a THREE.Vector3 on the y=0 terrain plane, or null if no intersection.
  raycastToGroundPlane(screenX, screenY) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndcX = ((screenX - rect.left) / rect.width)  * 2 - 1
    const ndcY = -(((screenY - rect.top)  / rect.height)) * 2 + 1

    const right    = new THREE.Vector3()
    const up       = new THREE.Vector3()
    const backward = new THREE.Vector3()
    this.camera.matrixWorld.extractBasis(right, up, backward)

    const halfW = (this.camera.right  - this.camera.left)   / (2 * this.camera.zoom)
    const halfH = (this.camera.top    - this.camera.bottom)  / (2 * this.camera.zoom)

    const rayOrigin = this.camera.position.clone()
      .addScaledVector(right, ndcX * halfW)
      .addScaledVector(up,    ndcY * halfH)
    const rayDir = backward.clone().negate()

    if (Math.abs(rayDir.y) < 0.0001) return null
    const t = -rayOrigin.y / rayDir.y
    if (t < 0) return null

    return rayOrigin.addScaledVector(rayDir, t) // y ≈ 0
  }

  getVisibleGroundBounds() {
    const rect = this.renderer.domElement.getBoundingClientRect()

    const pts = [
      [rect.left,  rect.top],
      [rect.right, rect.top],
      [rect.left,  rect.bottom],
      [rect.right, rect.bottom]
    ].map(([sx, sy]) => {
      const pt = this.raycastToGroundPlane(sx, sy)
      return pt ? { x: pt.x, z: pt.z } : null
    }).filter(Boolean)

    if (pts.length === 0) return null
    return {
      minX: Math.min(...pts.map(p => p.x)),
      maxX: Math.max(...pts.map(p => p.x)),
      minZ: Math.min(...pts.map(p => p.z)),
      maxZ: Math.max(...pts.map(p => p.z))
    }
  }

  enforceWorldBounds() {
    const b = this.getVisibleGroundBounds()
    if (!b) return
    const w = this.worldSize
    // Allow panning past each map edge by up to half the visible extent, so an
    // edge or boundary terrain can be dragged out from under the fixed side/top
    // panels into the interactable centre of the screen (and so the map edge
    // itself is reachable). Scales with zoom, so it's just enough at any level.
    const mx = (b.maxX - b.minX) * 0.5
    const mz = (b.maxZ - b.minZ) * 0.5
    let dx = 0, dz = 0
    if      (b.minX < -mx)    dx = -mx - b.minX
    else if (b.maxX > w + mx) dx = w + mx - b.maxX
    if      (b.minZ < -mz)    dz = -mz - b.minZ
    else if (b.maxZ > w + mz) dz = w + mz - b.maxZ
    if (dx !== 0 || dz !== 0) {
      this.targetPosition.x += dx
      this.targetPosition.z += dz
      this.updateCameraPosition()
    }
  }

  updateCameraPosition() {
    const hDist = this.distance * Math.cos(this.elevation)
    const vDist = this.distance * Math.sin(this.elevation)
    this.camera.position.set(
      this.targetPosition.x + hDist * Math.cos(this.azimuth),
      this.targetPosition.y + vDist,
      this.targetPosition.z + hDist * Math.sin(this.azimuth)
    )
    this.camera.lookAt(this.targetPosition)
  }

  // Focus camera on a specific world XZ position (e.g., city seed point).
  focusOn(x, z) {
    this.targetPosition.set(x, 0, z)
    this.updateCameraPosition()
    this.enforceWorldBounds()
  }

  frameAllContent() {
    this.targetPosition.set(25, 0, 25)
    this.camera.zoom = 3.0
    this.camera.updateProjectionMatrix()
    this.updateCameraPosition()
  }

  centerOnMap() {
    this.targetPosition.set(this.homeX, 0, this.homeZ)
    this.azimuth = Math.PI / 4
    this.elevation = Math.PI / 6
    this.camera.zoom = 3.0
    this.camera.updateProjectionMatrix()
    this.updateCameraPosition()
  }

  update() {
    if (!this._enabled || this._isTyping()) return

    const now = performance.now()
    const delta = this._lastUpdateTime != null ? Math.min((now - this._lastUpdateTime) / 1000, 0.1) : 0
    this._lastUpdateTime = now

    const rotateSpeed = Math.PI * 0.9  // ~162°/sec — comfortable free rotation
    let rotated = false
    if (this.keys['keyq']) { this.azimuth -= rotateSpeed * delta; rotated = true }
    if (this.keys['keye']) { this.azimuth += rotateSpeed * delta; rotated = true }
    if (rotated) {
      this.updateCameraPosition()
      this.enforceWorldBounds()
    }

    const moveSpeed = 2.0 / this.camera.zoom   // slower when zoomed in, faster when zoomed out
    let moved = false

    const ca = Math.cos(this.azimuth)
    const sa = Math.sin(this.azimuth)
    if (this.keys['keyw'] || this.keys['arrowup'])    { this.targetPosition.addScaledVector(new THREE.Vector3(-ca, 0, -sa), moveSpeed); moved = true }
    if (this.keys['keys'] || this.keys['arrowdown'])  { this.targetPosition.addScaledVector(new THREE.Vector3( ca, 0,  sa), moveSpeed); moved = true }
    if (this.keys['keya'] || this.keys['arrowleft'])  { this.targetPosition.addScaledVector(new THREE.Vector3(-sa, 0,  ca), moveSpeed); moved = true }
    if (this.keys['keyd'] || this.keys['arrowright']) { this.targetPosition.addScaledVector(new THREE.Vector3( sa, 0, -ca), moveSpeed); moved = true }

    if (moved) {
      this.updateCameraPosition()
      this.enforceWorldBounds()
    }
  }
}
