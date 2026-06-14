import * as THREE from 'three'
import CameraController from '../input/CameraController.js'
import WalkMode from '../rendering/WalkMode.js'
import BuildingRenderer from '../rendering/utils/BuildingRenderer.js'

// Load stub data ──────────────────────────────────────────────────────────────
const data = await fetch('/client/preview/testBlocks.json').then(r => r.json())
const { districts, streetGraph } = data.cityDistrictData
let { blocks, plots, landmarkBuildings } = data.cityDistrictData

// Scene + renderer ─────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x3d5c34)

// Orthographic camera — same frustum setup as WorldRenderer (80-unit frustum)
const FRUSTUM_H = 80
function makeFrustum() {
  const a = window.innerWidth / window.innerHeight
  return { l: -(FRUSTUM_H * a) / 2, r: (FRUSTUM_H * a) / 2, t: FRUSTUM_H / 2, b: -FRUSTUM_H / 2 }
}
const f0 = makeFrustum()
const camera = new THREE.OrthographicCamera(f0.l, f0.r, f0.t, f0.b, 0.1, 1000)
camera.position.set(25, 60, 25)
camera.lookAt(25, 0, 25)

// CameraController — identical wiring to WorldRenderer
let needsRender = true
const cameraController = new CameraController(camera, renderer, () => { needsRender = true })
cameraController.worldSize = 50
cameraController.minZoom   = 6
cameraController.maxZoom   = 80
const CX = 24.8, CZ = 34.3
cameraController.focusOn(CX, CZ)
camera.zoom = 14
camera.updateProjectionMatrix()

// Lighting (matches WorldRenderer)
scene.add(new THREE.AmbientLight(0xffffff, 0.6))
const sun = new THREE.DirectionalLight(0xffffff, 0.8)
sun.position.set(50, 100, 50)
scene.add(sun)

// Ground plane ─────────────────────────────────────────────────────────────────
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(10, 10),
  new THREE.MeshStandardMaterial({ color: 0x5a7048, roughness: 0.9 }),
)
ground.rotation.x = -Math.PI / 2
ground.position.set(CX, 0, CZ)
scene.add(ground)

// Geometry helpers ─────────────────────────────────────────────────────────────
function polygonMesh(corners, color, y) {
  if (!corners || corners.length < 3) return null
  const shape = new THREE.Shape(corners.map(c => new THREE.Vector2(c.x, c.y)))
  const geo   = new THREE.ShapeGeometry(shape)
  const mat   = new THREE.MeshStandardMaterial({
    color, roughness: 0.75, side: THREE.DoubleSide,
    emissive: new THREE.Color(color), emissiveIntensity: 0.08,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = y
  return mesh
}

function polygonLine(corners, color, y) {
  if (!corners || corners.length < 2) return null
  const pts = [...corners, corners[0]].map(c => new THREE.Vector3(c.x, y, c.y))
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color }),
  )
}

// Roads (static — street graph never changes) ──────────────────────────────────
const ROAD_HW  = 0.04375
const ROAD_Y   = 0.077
const ROAD_MAT = new THREE.MeshStandardMaterial({ color: 0xb89060, roughness: 0.75 })
const junctionById = new Map(streetGraph.junctions.map(j => [j.id, j]))
const seenConns = new Set()
for (const j of streetGraph.junctions) {
  for (const conn of (j.connections || [])) {
    const key = j.id < conn.toId ? `${j.id}|${conn.toId}` : `${conn.toId}|${j.id}`
    if (seenConns.has(key)) continue
    seenConns.add(key)
    const j2 = junctionById.get(conn.toId)
    if (!j2) continue
    const dx = j2.x - j.x, dz = j2.y - j.y
    const len = Math.hypot(dx, dz)
    if (len < 1e-6) continue
    const ux = dx / len, uz = dz / len, px = -uz, pz = ux
    const v = new Float32Array([
      j.x  + px*ROAD_HW, ROAD_Y, j.y  + pz*ROAD_HW,
      j.x  - px*ROAD_HW, ROAD_Y, j.y  - pz*ROAD_HW,
      j2.x + px*ROAD_HW, ROAD_Y, j2.y + pz*ROAD_HW,
      j2.x - px*ROAD_HW, ROAD_Y, j2.y - pz*ROAD_HW,
    ])
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(v, 3))
    geo.setIndex([0, 1, 2, 1, 3, 2])
    geo.computeVertexNormals()
    scene.add(new THREE.Mesh(geo, ROAD_MAT))
  }
}

// Content group — blocks + plots (rebuilt on regeneration) ─────────────────────
const contentGroup = new THREE.Group()
scene.add(contentGroup)

const BLOCK_COLOR = { 10: 0x9c8860, 13: 0xa09065, 14: 0x8fa060 }

function rebuildContent(newBlocks, newPlots) {
  contentGroup.clear()
  for (const block of newBlocks) {
    const fill = polygonMesh(block.blockCorners, BLOCK_COLOR[block.id] ?? 0x9c8860, 0.07)
    if (fill) contentGroup.add(fill)
    const line = polygonLine(block.blockCorners, 0x3a2810, 0.0701)
    if (line) contentGroup.add(line)
  }
  for (const plot of newPlots) {
    if (plot.blockType === 'square') continue
    const fill = polygonMesh(plot.blockCorners, 0x8b7855, 0.075)
    if (fill) contentGroup.add(fill)
    const line = polygonLine(plot.blockCorners, 0xccaa77, 0.0751)
    if (line) contentGroup.add(line)
  }
}

rebuildContent(blocks, plots)

// Buildings ────────────────────────────────────────────────────────────────────
const buildingRenderer = new BuildingRenderer()
buildingRenderer.setDirtyCallback(() => { needsRender = true })
buildingRenderer.randomizeSeed()
buildingRenderer.render(scene, plots, { districts, landmarkBuildings })

// Regenerate — calls server to re-run _generateBuildings(), then rebuilds scene
window._regenBuildings = async () => {
  const btn = document.getElementById('regen-btn')
  btn.textContent = 'Regenerating…'
  btn.disabled = true
  try {
    const fresh = await fetch('/api/dev/regen-preview', { method: 'POST' }).then(r => r.json())
    if (!fresh.ok) throw new Error(fresh.error)
    blocks = fresh.blocks
    plots  = fresh.plots
    landmarkBuildings = fresh.landmarkBuildings
    rebuildContent(blocks, plots)
    buildingRenderer.randomizeSeed()
    buildingRenderer.render(scene, plots, { districts, landmarkBuildings })
    needsRender = true
  } catch (e) {
    console.error('Regenerate failed:', e)
    alert(`Regenerate failed: ${e.message}`)
  } finally {
    btn.textContent = 'Regenerate Buildings'
    btn.disabled = false
  }
}

// Walk mode ────────────────────────────────────────────────────────────────────
let walkMode = null

function enterWalk() {
  if (walkMode) return
  const targetPos = { x: cameraController.targetPosition.x, z: cameraController.targetPosition.z }
  walkMode = new WalkMode(scene, renderer, streetGraph, plots, targetPos, cameraController.azimuth, exitWalk)
  cameraController.setEnabled(false)
  document.getElementById('hud').textContent = 'WALK MODE — WASD: move · Mouse: look · CapsLock: sprint · Shift+W: exit'
}

function exitWalk() {
  walkMode?.destroy()
  walkMode = null
  cameraController.setEnabled(true)
  updateHud()
  needsRender = true
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyW' && e.shiftKey) {
    if (walkMode) exitWalk(); else enterWalk()
    e.preventDefault()
  }
})

// HUD ──────────────────────────────────────────────────────────────────────────
function updateHud() {
  document.getElementById('hud').textContent =
    'Blocks 10 (concave/townhouse) · 13 (freestanding) · 14 (square) — ' +
    'WASD: pan · Q/E: rotate · scroll: zoom · Shift+W: walk mode'
}
updateHud()

// Resize ───────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const f = makeFrustum()
  Object.assign(camera, { left: f.l, right: f.r, top: f.t, bottom: f.b })
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  needsRender = true
})

// Render loop ──────────────────────────────────────────────────────────────────
const clock = new THREE.Clock()
let lastCamPos = null
let frameCount = 0
;(function animate() {
  requestAnimationFrame(animate)
  const delta = clock.getDelta()
  frameCount++

  if (walkMode) {
    walkMode.update(delta)
    renderer.render(scene, walkMode.camera)
    return
  }

  cameraController.update()
  const p = camera.position
  const camMoved = !lastCamPos || lastCamPos.x !== p.x || lastCamPos.y !== p.y || lastCamPos.z !== p.z
  const periodicRefresh = frameCount % 60 === 0
  if (camMoved || needsRender || periodicRefresh) {
    lastCamPos = { x: p.x, y: p.y, z: p.z }
    needsRender = false
    renderer.render(scene, camera)
  }
})()
