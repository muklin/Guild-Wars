import * as THREE from 'three'
import { pointInPolygon } from './utils/renderUtils.js'

const GROUND_Y     = 0.075
const PARA_SCALE   = 0.13 / 2.3         // matches BuildingRenderer
const CHAR_HEIGHT  = 1 * PARA_SCALE  // ≈ 0.063 world units (80% of one floor)
const CHAR_RADIUS  = 0.18 * PARA_SCALE  // ≈ 0.014 world units
const BODY_HEIGHT  = CHAR_HEIGHT * 0.60 // shorter cylinder; head sits on top
const HEAD_RADIUS  = CHAR_HEIGHT * 0.22 // dodecahedron head
const PIVOT_Y      = GROUND_Y + BODY_HEIGHT + HEAD_RADIUS  // camera orbit pivot = head centre
const MOVE_SPEED   = 0.17               // world units / second
const SPRINT_MULT  = 3.5                // speed multiplier when sprint toggled
const MOUSE_SENS   = 0.0005             // radians / pixel
const PITCH_MIN    = -20 * Math.PI / 180  // 20° below horizontal
const PITCH_MAX    =  Math.PI / 2 - 0.01  // just under straight up
const FENCE_CLEARANCE = 0.012             // world units, on top of CHAR_RADIUS

// Shortest distance from (x,y) to segment a→b.
function distToSegment(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2))
  return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t))
}

export default class WalkMode {
  constructor(scene, renderer, streetGraph, targetPos, initialYaw, onExit, buildingRenderer, fenceSegments) {
    this._scene  = scene
    this._onExit = onExit

    // Perspective camera
    const aspect = window.innerWidth / window.innerHeight
    this._camera = new THREE.PerspectiveCamera(60, aspect, 0.001, 50)

    // Body — shortened octagonal cylinder
    const bodyGeo = new THREE.CylinderGeometry(CHAR_RADIUS, CHAR_RADIUS, BODY_HEIGHT, 8)
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffaa44 })
    this._char = new THREE.Mesh(bodyGeo, bodyMat)
    this._char.castShadow = false
    scene.add(this._char)

    // Head — dodecahedron, rotates with camera yaw
    const headGeo = new THREE.DodecahedronGeometry(HEAD_RADIUS)
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffcc88 })
    this._head = new THREE.Mesh(headGeo, headMat)
    this._head.castShadow = false
    scene.add(this._head)

    // Building footprint polygons for collision — the ACTUAL built wing footprints (world
    // space), not the full plot boundary, so the character can cross plot/yard space freely
    // and only collides with real building walls.
    this._collisionPolys = []
    for (const { entry } of (buildingRenderer?._lastPolyWingEntries ?? [])) {
      const wings = entry.spec?.footprint?.wings ?? []
      const c = Math.cos(entry.rotY ?? 0), sn = Math.sin(entry.rotY ?? 0)
      for (const w of wings) {
        if (!w.vertices?.length) continue
        this._collisionPolys.push(w.vertices.map(([vx, vz]) => {
          const px = vx * PARA_SCALE, pz = vz * PARA_SCALE
          return { x: entry.x + px * c + pz * sn, y: entry.z - px * sn + pz * c }
        }))
      }
    }

    // Fence segments (world-space) for collision — treated as thin solid walls, blocked
    // whenever the candidate position comes within FENCE_CLEARANCE of one.
    this._fenceSegments = fenceSegments ?? []

    // Spawn at the junction nearest to the current camera target
    const spawn = this._findSpawn(streetGraph, targetPos)
    this._px = spawn.x
    this._pz = spawn.z

    // Camera angles and zoom
    this._yaw     = initialYaw ?? 0
    this._pitch   = -0.10  // slight downward look on entry (within 20° floor)
    this._camDist = 0.08   // world units from head (orbit radius)

    this._placeCharacter()

    // HUD overlay
    this._hud = document.createElement('div')
    this._hud.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:50;color:#fff;font:13px/1.4 monospace;text-shadow:1px 1px 3px #000;pointer-events:none;text-align:center'
    this._hud.textContent = 'WALK MODE  —  WASD: move  |  CapsLock: sprint toggle  |  Mouse: look  |  Shift+W: exit'
    document.body.appendChild(this._hud)

    // Input state
    this._keys = {}
    this._sprinting = false
    this._onKeyDown = (e) => {
      if (e.code === 'CapsLock') { this._sprinting = !this._sprinting; e.preventDefault(); return }
      this._keys[e.code] = true
    }
    this._onKeyUp   = (e) => { this._keys[e.code] = false }
    this._onMouseMove = (e) => {
      if (document.pointerLockElement !== renderer.domElement) return
      this._yaw   -= e.movementX * MOUSE_SENS
      this._pitch += e.movementY * MOUSE_SENS
      this._pitch  = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this._pitch))
    }
    // Esc releases pointer lock → auto-exit walk mode
    this._onPLChange = () => {
      if (document.pointerLockElement !== renderer.domElement) this._onExit?.()
    }
    this._onWheel = (e) => {
      e.preventDefault()
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12
      this._camDist = Math.max(0.04, Math.min(0.22, this._camDist * factor))
    }

    document.addEventListener('keydown', this._onKeyDown)
    document.addEventListener('keyup',   this._onKeyUp)
    document.addEventListener('mousemove', this._onMouseMove)
    document.addEventListener('pointerlockchange', this._onPLChange)
    document.addEventListener('wheel', this._onWheel, { passive: false })

    renderer.domElement.requestPointerLock()
    this._updateCamera()
  }

  // Find the street junction closest to `targetPos` ({x, z} world coords).
  _findSpawn(streetGraph, targetPos) {
    const junctions = streetGraph?.junctions
    const tx = targetPos?.x ?? 25, tz = targetPos?.z ?? 25
    if (!junctions?.length) return { x: tx, z: tz }

    let best = junctions[0], bestD = Infinity
    for (const j of junctions) {
      const d = (j.x - tx) ** 2 + (j.y - tz) ** 2
      if (d < bestD) { bestD = d; best = j }
    }
    return { x: best.x, z: best.y }
  }

  _placeCharacter() {
    this._char.position.set(this._px, GROUND_Y + BODY_HEIGHT / 2, this._pz)
    this._head.position.set(this._px, PIVOT_Y, this._pz)
    this._head.rotation.y = this._yaw
  }

  get camera() { return this._camera }
  get characterPosition() { return { x: this._px, z: this._pz } }

  update(delta) {
    const sprint = this._sprinting
    const speed  = MOVE_SPEED * (sprint ? SPRINT_MULT : 1) * delta
    const fwdX   =  Math.sin(this._yaw)
    const fwdZ   =  Math.cos(this._yaw)
    const rightX =  Math.cos(this._yaw)
    const rightZ = -Math.sin(this._yaw)

    let dx = 0, dz = 0
    if (this._keys['KeyW']) { dx += fwdX; dz += fwdZ }
    if (this._keys['KeyS']) { dx -= fwdX; dz -= fwdZ }
    if (this._keys['KeyA']) { dx += rightX; dz += rightZ }
    if (this._keys['KeyD']) { dx -= rightX; dz -= rightZ }

    if (dx !== 0 || dz !== 0) {
      const len = Math.hypot(dx, dz)
      const nx = this._px + (dx / len) * speed
      const nz = this._pz + (dz / len) * speed

      let blocked = false
      for (const poly of this._collisionPolys) {
        if (pointInPolygon(nx, nz, poly)) { blocked = true; break }
      }
      if (!blocked) {
        for (const { a, b } of this._fenceSegments) {
          if (distToSegment(nx, nz, a, b) < CHAR_RADIUS + FENCE_CLEARANCE) { blocked = true; break }
        }
      }
      if (!blocked) {
        this._px = nx
        this._pz = nz
      }
    }

    this._placeCharacter()
    this._updateCamera()
  }

  _updateCamera() {
    // Camera orbits around the head centre. Pitch=+π/2 puts the camera directly
    // above the head looking straight down; pitch=0 is level behind the character.
    const camX = this._px - Math.sin(this._yaw) * Math.cos(this._pitch) * this._camDist
    const camY = Math.max(GROUND_Y + 0.005, PIVOT_Y + Math.sin(this._pitch) * this._camDist)
    const camZ = this._pz - Math.cos(this._yaw) * Math.cos(this._pitch) * this._camDist
    this._camera.position.set(camX, camY, camZ)

    // Up vector tracks the orbit frame so there is no gimbal flip at vertical extremes.
    // At pitch=0 this is world-up (0,1,0); at pitch=π/2 it is the character's forward.
    this._camera.up.set(
      Math.sin(this._yaw) * Math.sin(this._pitch),
      Math.cos(this._pitch),
      Math.cos(this._yaw) * Math.sin(this._pitch)
    )

    this._camera.lookAt(this._px, PIVOT_Y, this._pz)
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeyDown)
    document.removeEventListener('keyup',   this._onKeyUp)
    document.removeEventListener('mousemove', this._onMouseMove)
    document.removeEventListener('pointerlockchange', this._onPLChange)
    document.removeEventListener('wheel', this._onWheel)
    if (document.pointerLockElement) document.exitPointerLock()
    this._scene.remove(this._char)
    this._char.geometry.dispose()
    this._char.material.dispose()
    this._scene.remove(this._head)
    this._head.geometry.dispose()
    this._head.material.dispose()
    this._hud.remove()
  }
}
