import * as THREE from 'three'

// Walk Mode minimap. Captures a small top-down snapshot of the area around the entry
// point right as Walk Mode is entered (WorldRenderer.toggleWalkMode, before the Avatar
// mesh is added to the scene), then every Walk Mode frame blits a cheap, rotated crop
// of that bitmap (heading-up, Avatar pinned to centre) into a small on-screen circular
// canvas. Re-captured fresh on every entry — see docs/adr/0017-minimap-snapshot-not-live-camera.md
// for why a small local snapshot beats either a live second camera or one bitmap
// covering the whole world.

const CAPTURE_RADIUS = 10    // world units captured around the entry point (a few blocks
                              // of wandering room) — far smaller than the full world, so
                              // the same bitmap size buys much higher detail per world-unit
const SNAPSHOT_SIZE  = 2048  // px, square bitmap covering [centre ± CAPTURE_RADIUS]²
const VIEW_RADIUS    = 1.20  // world units shown around the Avatar — tight, ~one street over
const PANEL_SIZE     = 300   // px, on-screen circular panel diameter
const AVATAR_BODY_COLOR = '#ffaa44'  // matches WalkMode.js's body mesh colour
const AVATAR_HEAD_COLOR = '#ffcc88'  // matches WalkMode.js's head mesh colour

export default class Minimap {
  constructor() {
    // Offscreen captured bitmap — world-space, north-up, never has the Avatar drawn
    // into it (captured before WalkMode's body/head meshes exist).
    this._snapshotCanvas = document.createElement('canvas')
    this._snapshotCanvas.width  = SNAPSHOT_SIZE
    this._snapshotCanvas.height = SNAPSHOT_SIZE
    this._snapshotCtx = this._snapshotCanvas.getContext('2d')
    this._hasSnapshot = false
    this._center = { x: 0, z: 0 }   // world-space centre the current bitmap was captured around

    // Visible panel — bottom-right, the corner UIManager.setWalkMode(true) frees up by
    // hiding the action panel (see CONTEXT.md's Action Panel UI rule).
    this._el = document.createElement('canvas')
    this._el.width  = PANEL_SIZE
    this._el.height = PANEL_SIZE
    // top/left:auto explicitly override index.html's global `canvas { top:0; left:0 }`
    // rule — without them, CSS's over-constraint resolution keeps that rule's top/left
    // and silently drops bottom/right below, regardless of inline-style precedence.
    this._el.style.cssText = `position:fixed;top:auto;left:auto;bottom:20px;right:20px;width:${PANEL_SIZE}px;height:${PANEL_SIZE}px;border-radius:50%;border:2px solid #555;box-shadow:0 4px 16px rgba(0,0,0,0.6);z-index:50;pointer-events:none;display:none`
    this._ctx = this._el.getContext('2d')
    document.body.appendChild(this._el)

    // Dedicated capture camera, re-aimed at the entry point each capture.
    this._captureCamera = new THREE.OrthographicCamera(
      -CAPTURE_RADIUS, CAPTURE_RADIUS, CAPTURE_RADIUS, -CAPTURE_RADIUS, 0.1, 200
    )
    this._captureCamera.up.set(0, 0, -1)
  }

  // Render the scene from directly above a CAPTURE_RADIUS-wide square centred on
  // (cx, cz) into the main renderer, then copy that frame into the offscreen snapshot
  // bitmap. Caller (WorldRenderer.toggleWalkMode) must call this before constructing
  // WalkMode, so the Avatar mesh isn't in the scene yet and never gets baked into the
  // bitmap, and before WalkMode starts rendering, so the player never sees this frame.
  captureSnapshot(renderer, scene, cx, cz) {
    this._center = { x: cx, z: cz }
    this._captureCamera.position.set(cx, 100, cz)
    this._captureCamera.lookAt(cx, 0, cz)
    renderer.render(scene, this._captureCamera)
    this._snapshotCtx.clearRect(0, 0, SNAPSHOT_SIZE, SNAPSHOT_SIZE)
    this._snapshotCtx.drawImage(renderer.domElement, 0, 0, SNAPSHOT_SIZE, SNAPSHOT_SIZE)
    this._hasSnapshot = true
  }

  show() { if (this._hasSnapshot) this._el.style.display = '' }
  hide() { this._el.style.display = 'none' }

  // px, pz: Avatar world position. yaw: WalkMode's _yaw (radians; fwd = (sin(yaw), cos(yaw))
  // in (x,z), so yaw=0 faces world +Z). Heading-up: the bitmap rotates under a fixed,
  // always-up-pointing Avatar marker rather than rotating the marker itself.
  update(px, pz, yaw) {
    if (!this._hasSnapshot) return
    const ctx = this._ctx
    ctx.save()
    ctx.clearRect(0, 0, PANEL_SIZE, PANEL_SIZE)

    ctx.beginPath()
    ctx.arc(PANEL_SIZE / 2, PANEL_SIZE / 2, PANEL_SIZE / 2, 0, Math.PI * 2)
    ctx.clip()

    ctx.translate(PANEL_SIZE / 2, PANEL_SIZE / 2)
    // -π offset: the capture camera's up=(0,0,-1) makes the raw bitmap's "up" world -Z,
    // but WalkMode's yaw=0 forward is world +Z — opposite directions — so lining up
    // "forward" with screen-up takes yaw rotated by an extra half-turn, not yaw alone.
    ctx.rotate(yaw - Math.PI)
    ctx.translate(-PANEL_SIZE / 2, -PANEL_SIZE / 2)

    // Source rect in snapshot-bitmap pixels, relative to the bitmap's own centre. If
    // the player wanders past CAPTURE_RADIUS from the entry point this rect falls
    // outside the bitmap — the canvas spec clips that automatically (no error, just
    // blank past the edge), which is an accepted trade-off of a local-only snapshot.
    const pxPerWorld = SNAPSHOT_SIZE / (CAPTURE_RADIUS * 2)
    const sx = (px - this._center.x + CAPTURE_RADIUS - VIEW_RADIUS) * pxPerWorld
    const sy = (pz - this._center.z + CAPTURE_RADIUS - VIEW_RADIUS) * pxPerWorld
    const sSize = VIEW_RADIUS * 2 * pxPerWorld
    ctx.drawImage(this._snapshotCanvas, sx, sy, sSize, sSize, 0, 0, PANEL_SIZE, PANEL_SIZE)
    ctx.restore()

    // Avatar marker — fixed at centre, fixed pointing up (the world rotates around it).
    // Sized relative to PANEL_SIZE so it stays proportional if that constant changes.
    const markerR = PANEL_SIZE * 0.025
    ctx.save()
    ctx.translate(PANEL_SIZE / 2, PANEL_SIZE / 2)
    ctx.fillStyle = AVATAR_BODY_COLOR
    ctx.beginPath()
    ctx.arc(0, 0, markerR, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = AVATAR_HEAD_COLOR
    ctx.beginPath()
    ctx.moveTo(0, -markerR * 2.4)
    ctx.lineTo(-markerR, 0)
    ctx.lineTo(markerR, 0)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
}
