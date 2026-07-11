import * as THREE from 'three'
import CompassRing from '../ui/CompassRing.js'

// Walk Mode minimap. Captures a small top-down snapshot of the area around the entry
// point right as Walk Mode is entered (WorldRenderer.toggleWalkMode, before the Avatar
// mesh is added to the scene), then every Walk Mode frame blits a cheap, rotated crop
// of that bitmap (heading-up, Avatar pinned to centre) into a small on-screen circular
// canvas. Re-captured fresh on every entry — see docs/adr/0017-minimap-snapshot-not-live-camera.md
// for why a small local snapshot beats either a live second camera or one bitmap
// covering the whole world.
//
// The N/S/E/W ring overlaid on top is the same CompassRing used by the Top-down/Iso HUD
// compass and ForeignPowerDialog's direction picker (bgFill:'none' so the map bitmap
// shows through, contrastBand:true for a dark band OUTSIDE the map circle so the ticks/
// labels stay legible over any map content) — one shared compass look everywhere.

const CAPTURE_RADIUS = 10    // world units captured around the entry point (a few blocks
                              // of wandering room) — far smaller than the full world, so
                              // the same bitmap size buys much higher detail per world-unit
const SNAPSHOT_SIZE  = 2048  // px, square bitmap covering [centre ± CAPTURE_RADIUS]²
const VIEW_RADIUS    = 1.20  // world units shown around the Avatar — tight, ~one street over
const PANEL_SIZE     = 260   // px, on-screen circular MAP diameter
const RING_MARGIN    = 16    // px, ring radius beyond the map circle — just enough for
                              // the contrast band and tick labels to sit outside the map,
                              // kept tight so the ring hugs the map circle closely
const RING_SIZE      = PANEL_SIZE + RING_MARGIN * 2
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

    // Container — bottom-right, the corner UIManager.setWalkMode(true) frees up by
    // hiding every other UI surface (see CONTEXT.md's Action Panel UI rule). Sized to
    // RING_SIZE (map circle + outer ring margin); holds the map canvas and the compass
    // ring overlay, both centred within it.
    this._container = document.createElement('div')
    this._container.style.cssText = `position:fixed;top:auto;left:auto;bottom:${20 - RING_MARGIN}px;right:${20 - RING_MARGIN}px;width:${RING_SIZE}px;height:${RING_SIZE}px;z-index:50;pointer-events:none;display:none;filter:drop-shadow(0 4px 16px rgba(0,0,0,0.6))`
    document.body.appendChild(this._container)

    this._el = document.createElement('canvas')
    this._el.width  = PANEL_SIZE
    this._el.height = PANEL_SIZE
    this._el.style.cssText = `position:absolute;top:${RING_MARGIN}px;left:${RING_MARGIN}px;width:${PANEL_SIZE}px;height:${PANEL_SIZE}px;border-radius:50%;overflow:hidden`
    this._ctx = this._el.getContext('2d')
    this._container.appendChild(this._el)

    // Compass ring overlay — transparent centre so the map canvas shows through there;
    // the contrast band fills the RING_MARGIN annulus outside the map circle exactly
    // (contrastBandWidth: RING_MARGIN — its inner edge butts up against the map circle
    // with no gap). Tick lines run the full radius, INCLUDING over the map itself (the
    // default lineInnerRadius:0) — layered here, between the map and the Avatar marker
    // below, exactly the stacking order requested: map < compass lines < Avatar.
    this._ring = new CompassRing({
      size: RING_SIZE, radius: RING_SIZE / 2, bgFill: 'none',
      contrastBand: true, contrastBandWidth: RING_MARGIN,
    })
    this._ring.svgWrapper.style.cssText += ';position:absolute;top:0;left:0'
    this._container.appendChild(this._ring.svgWrapper)

    // Avatar marker layer — its own canvas, stacked ABOVE the compass ring (appended
    // last), so it's never obscured by the tick lines crossing the map beneath it. Fixed
    // at centre, fixed pointing up (the world rotates around it, not the marker) — a
    // static image, drawn once here rather than every update() frame.
    const markerEl = document.createElement('canvas')
    markerEl.width  = PANEL_SIZE
    markerEl.height = PANEL_SIZE
    markerEl.style.cssText = `position:absolute;top:${RING_MARGIN}px;left:${RING_MARGIN}px;width:${PANEL_SIZE}px;height:${PANEL_SIZE}px`
    const mctx = markerEl.getContext('2d')
    const markerR = PANEL_SIZE * 0.025
    mctx.translate(PANEL_SIZE / 2, PANEL_SIZE / 2)
    mctx.fillStyle = AVATAR_BODY_COLOR
    mctx.beginPath()
    mctx.arc(0, 0, markerR, 0, Math.PI * 2)
    mctx.fill()
    mctx.fillStyle = AVATAR_HEAD_COLOR
    mctx.beginPath()
    mctx.moveTo(0, -markerR * 2.4)
    mctx.lineTo(-markerR, 0)
    mctx.lineTo(markerR, 0)
    mctx.closePath()
    mctx.fill()
    this._container.appendChild(markerEl)

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

  show() { if (this._hasSnapshot) this._container.style.display = '' }
  hide() { this._container.style.display = 'none' }

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

    // Avatar marker is a separate static layer (see constructor) stacked above the
    // compass ring — nothing to redraw here every frame.

    // Compass ring overlay — see CompassRing.update's own doc comment for the
    // azimuth-based formula it implements (ringRot = 90 - azimuthDeg, ticks placed at
    // rad = i*45-90 before that rotation). Heading-up here uses WalkMode's yaw on a
    // DIFFERENT convention (canvas angle for bearing theta is yaw + PI/2 + theta — see
    // the ctx.rotate(yaw - PI) comment above for where that PI/2 offset comes from).
    // Solving CompassRing's own formula for the azimuth that reproduces this same
    // rotation gives azimuthEquivalent = -(PI/2 + yaw) — verified against yaw=0 (facing
    // world +Z/"south"): North should appear at the BOTTOM (directly behind), and this
    // value does place it there.
    // topDown=true always: CompassRing's squish=0.5 is meant for the tilted ISO camera
    // HUD compass — this minimap is captured from a straight-down ortho camera (see
    // captureSnapshot), so the ring must stay a plain undistorted circle (squish=1),
    // never flattened into an ellipse (confirmed live).
    this._ring.update(-(Math.PI / 2 + yaw), true)
  }
}
