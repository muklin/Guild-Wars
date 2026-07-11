import * as THREE from 'three'

// Floor-scroll: PageUp/PageDown step a world-space clip plane up/down in half-floor-
// height units — the same granularity Building Spec floor lists use (see
// ParametricBuilding.js/BuildingRenderer.js's per-wing `floors` entries). The clip
// plane is the ONLY mechanism that hides/reveals geometry — including the roof, which
// is just more geometry at a higher Y, not a separately-toggled layer — so scrolling
// up through a building reveals each floor and then the roof continuously, in line
// with their actual z-heights, instead of the roof popping in as a separate step.
// Works in BOTH top-down and the normal isometric view (each has its own default).
export const FLOOR_SCROLL_MAX = 24
// Default level on entering top-down: just above the Foundation height (0.5
// floor-heights = 1 half-unit), so a raised ground floor's foundation is visible
// without immediately exposing the floors above it.
export const FLOOR_SCROLL_DEFAULT_TOPDOWN = 1
// Default level for the iso view (including on load): "max z-height of any object +
// 0.5" — i.e. above everything, so nothing is culled until the player pages down.
// FLOOR_SCROLL_MAX is comfortably above any building's roofline, so it doubles as that
// sentinel rather than computing a literal scene-wide max each time.
export const FLOOR_SCROLL_DEFAULT_ISO = FLOOR_SCROLL_MAX
// Top-down mode allows much deeper zoom than the normal 3D view — enough for a single
// building's footprint (~0.2-0.4 world units across, at MODEL_SCALE/2.3) to fill the
// frustum (frustumHeight 80 / zoom ≈ visible world height).
const TOP_DOWN_MAX_ZOOM = 250.0
const NORMAL_MAX_ZOOM = 150.0

// View mode + camera location, persisted across a page reload — see _saveState/
// restoreSavedState below.
const CAMERA_STATE_KEY = 'gw.cameraState'

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

    // Zoom — start framing the full map; allow deep zoom-in (close enough to read
    // individual buildings clearly in the angled iso view, short of top-down's even
    // deeper TOP_DOWN_MAX_ZOOM).
    this.minZoom = 1.0   // low enough to see the full map; enforced dynamically via world bounds
    this.maxZoom = NORMAL_MAX_ZOOM
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

    // Floor-scroll level (half-floor-height units; see FLOOR_SCROLL_MAX/
    // FLOOR_SCROLL_DEFAULT_* above) — active in both iso and top-down (onKeyDown).
    this.floorScrollUnits = FLOOR_SCROLL_DEFAULT_ISO

    this.setupEventListeners()
    this.updateCameraPosition()

    // Remember view mode + camera location across a page reload — saved once right
    // before the page actually unloads (not on every camera move, which would mean a
    // localStorage write every frame while panning/zooming). Walk mode is deliberately
    // NOT part of this: it's a WorldRenderer/App-level overlay with its own spawn-
    // validity concerns on reload, not a CameraController field, so restoring this state
    // naturally leaves it walk-mode-agnostic (always comes back in iso/top-down).
    window.addEventListener('beforeunload', () => this._saveState())
  }

  _saveState() {
    try {
      localStorage.setItem(CAMERA_STATE_KEY, JSON.stringify({
        x: this.targetPosition.x, z: this.targetPosition.z,
        distance: this.distance, azimuth: this.azimuth, elevation: this.elevation,
        zoom: this.camera.zoom, maxZoom: this.maxZoom,
        topDown: !!this._topDown, floorScrollUnits: this.floorScrollUnits,
      }))
    } catch { /* ignore (private mode / no storage) */ }
  }

  // Restores a previously-saved view mode + camera location, if one exists. Returns
  // true if it did (callers use this to skip their own default "centre on city" framing
  // only when there's nothing to restore). Sets fields directly (not via toggleTopDown())
  // since the saved elevation/maxZoom already reflect whichever mode was active.
  restoreSavedState() {
    let saved
    try { saved = JSON.parse(localStorage.getItem(CAMERA_STATE_KEY)) } catch { saved = null }
    if (!saved) return false
    this.targetPosition.set(saved.x ?? this.targetPosition.x, 0, saved.z ?? this.targetPosition.z)
    if (typeof saved.distance === 'number') this.distance = saved.distance
    if (typeof saved.azimuth === 'number') this.azimuth = saved.azimuth
    if (typeof saved.elevation === 'number') this.elevation = saved.elevation
    if (typeof saved.maxZoom === 'number') this.maxZoom = saved.maxZoom
    if (typeof saved.zoom === 'number') this.camera.zoom = Math.min(saved.zoom, this.maxZoom)
    if (typeof saved.floorScrollUnits === 'number') this.floorScrollUnits = saved.floorScrollUnits
    this._topDown = !!saved.topDown
    this.camera.updateProjectionMatrix()
    this.updateCameraPosition()
    this._onDirty()
    return true
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
    } else if (e.code === 'PageUp') {
      this.floorScrollUnits = Math.min(FLOOR_SCROLL_MAX, this.floorScrollUnits + 1)
      this._onDirty()
      e.preventDefault()
    } else if (e.code === 'PageDown') {
      this.floorScrollUnits = Math.max(0, this.floorScrollUnits - 1)
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

  // Ground-plane hit points for a screen row (fixed screenY, both left/right edges),
  // clamped inward if the raw row misses the ground plane entirely. That miss happens
  // once the frustum's world-space half-height at the current zoom exceeds the camera's
  // height above ground (see raycastToGroundPlane) — i.e. zoomed out far enough that the
  // screen's near edge looks past the ground's "horizon" into empty space, not more
  // ground. Only the vertical screen axis can do this: the camera never rolls, so its
  // right vector is always horizontal and ndcX never affects whether a ray reaches y=0.
  // Without this clamp, getVisibleGroundBounds silently dropped that whole row, and the
  // bound came from only the OTHER (surviving) row's two corners — which share one of
  // the two screen-axis offsets and so collapse to a near-zero-width box on that axis,
  // making enforceWorldBounds clamp panning far more tightly than intended right at the
  // zoom levels where the whole map is meant to be visible and pannable.
  _edgeGroundPoints(rect, screenY, ndcYRaw) {
    const l = this.raycastToGroundPlane(rect.left, screenY)
    const r = this.raycastToGroundPlane(rect.right, screenY)
    if (l && r) return [l, r]

    const up = new THREE.Vector3(), right = new THREE.Vector3(), backward = new THREE.Vector3()
    this.camera.matrixWorld.extractBasis(right, up, backward)
    const rayDirY = -backward.y
    if (Math.abs(rayDirY) < 0.0001 || Math.abs(up.y) < 1e-9) return null

    const halfH = (this.camera.top - this.camera.bottom) / (2 * this.camera.zoom)
    // ndcY where the ray origin's y-offset alone reaches 0 — the closest this row can
    // get to screenY while still hitting the ground (t=0 boundary). Nudged 0.1% back
    // toward centre so floating-point noise doesn't land just past it into t<0.
    const ndcYCrit = (-this.camera.position.y / (halfH * up.y)) * 0.999
    const ndcYClamped = ndcYRaw > 0 ? Math.min(ndcYRaw, ndcYCrit) : Math.max(ndcYRaw, ndcYCrit)
    const clampedScreenY = rect.top + rect.height * (1 - ndcYClamped) / 2
    const l2 = this.raycastToGroundPlane(rect.left, clampedScreenY)
    const r2 = this.raycastToGroundPlane(rect.right, clampedScreenY)
    return (l2 && r2) ? [l2, r2] : null
  }

  getVisibleGroundBounds() {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const topPts    = this._edgeGroundPoints(rect, rect.top, 1)
    const bottomPts = this._edgeGroundPoints(rect, rect.bottom, -1)
    const pts = [...(topPts || []), ...(bottomPts || [])]

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

  // Straight-down view for the top-down map mode: lock elevation near 90° (a hair short of
  // it to avoid lookAt's up/forward gimbal-lock at true vertical), remembering whatever
  // elevation was active so toggling back off restores it. Azimuth/pan stay live. Zoom
  // range is widened while active (down to roughly one building filling the screen),
  // restoring the normal-view max on exit and clamping the current zoom back into it.
  toggleTopDown() {
    this._topDown = !this._topDown
    // Each mode has its own default floor-scroll level (reset every time you switch).
    this.floorScrollUnits = this._topDown ? FLOOR_SCROLL_DEFAULT_TOPDOWN : FLOOR_SCROLL_DEFAULT_ISO
    if (this._topDown) {
      this._preTopDownElevation = this.elevation
      this.elevation = Math.PI / 2 - 0.001
      this._preTopDownMaxZoom = this.maxZoom
      this.maxZoom = TOP_DOWN_MAX_ZOOM
    } else {
      this.elevation = this._preTopDownElevation ?? Math.PI / 6
      this.maxZoom = this._preTopDownMaxZoom ?? this.maxZoom
      this.camera.zoom = Math.min(this.camera.zoom, this.maxZoom)
      this.camera.updateProjectionMatrix()
    }
    this.updateCameraPosition()
    this._onDirty()
    return this._topDown
  }

  // Reset to the default new-game view: iso mode, North at the top of the screen,
  // city centred, whole map visible. "North at the top" means the world direction the
  // screen's top edge shows must be world -Z (see SetupPhase.touchesNorthBoundary's
  // "North = low Z" convention) — with updateCameraPosition's
  // camera = target + hDist*(cos(az),0,sin(az)), the screen-up world direction works out
  // to (-cos(az),-sin(az)); solving that against (0,-1) (world -Z) gives az = PI/2,
  // not the PI/4 diagonal this used before (confirmed live: PI/4 puts North at screen-
  // right, not top).
  centerOnMap() {
    this.targetPosition.set(this.homeX, 0, this.homeZ)
    this.azimuth = Math.PI / 2
    this.elevation = Math.PI / 6
    this.camera.zoom = 3.0
    this.camera.updateProjectionMatrix()
    // Reset every other view setting too, in case this is called with stale state from
    // a prior game (Top-down's maxZoom override, floor-scroll level).
    this._topDown = false
    this.maxZoom = NORMAL_MAX_ZOOM
    this.floorScrollUnits = FLOOR_SCROLL_DEFAULT_ISO
    this.updateCameraPosition()
    this._onDirty()
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
