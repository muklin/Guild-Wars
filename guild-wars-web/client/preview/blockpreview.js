import * as THREE from 'three'
import CameraController from '../input/CameraController.js'
import WalkMode from '../rendering/WalkMode.js'
import BuildingRenderer, { PARA_SCALE } from '../rendering/utils/BuildingRenderer.js'

// Load stub data ──────────────────────────────────────────────────────────────
const data = await fetch('/client/preview/testBlocks.json').then(r => r.json())
const { districts, streetGraph } = data.cityDistrictData
let { blocks, plots, landmarkBuildings } = data.cityDistrictData

// Mark preview blocks as townhouse so they route through the Phase 6 path
// (_spawnTownhouse + party-wall suppression). The server's markTownhouseBlocks()
// does this during full city generation; here we force it on the fixed stub blocks
// so the harness reliably shows townhouse output. Blocks 10 & 13 become townhouse
// terraces; each plot independently rolls a 5% chance of being freestanding (a GLB
// model whose townhouse neighbours then expose their side walls). 14 stays square.
const TOWNHOUSE_BLOCKS = new Set([10, 13])
const FREESTANDING_PROB = 0.05
function markTownhouses(seed) {
  for (const block of blocks) {
    if (!TOWNHOUSE_BLOCKS.has(block.id)) continue
    block.blockType = 'townhouse'
    for (const p of plots) {
      if (p.blockId !== block.id || p.blockType === 'square') continue
      p.blockType = 'townhouse'
      // Re-rolled each regenerate via the seed, so the freestanding slot moves around.
      p.freestanding = buildingRenderer._rand(p.id * 13337 + 99 + seed) < FREESTANDING_PROB
    }
  }
}

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
// Walls render normally, with cross-building party-wall suppression (shared walls removed
// up to the shorter neighbour's height). The debug overlay (dashed colour-per-wing + white
// merged footprint) is still drawn on top so the walls can be reconciled against the lines.
const buildingRenderer = new BuildingRenderer()
buildingRenderer.setDirtyCallback(() => { needsRender = true })

// Debug overlay group — wing + footprint lines, redrawn each regenerate.
const debugGroup = new THREE.Group()
scene.add(debugGroup)

const WING_COLORS = [0x3399ff, 0x33dd55, 0xdd33dd, 0xffaa22, 0x22dddd, 0xff5555]  // wing 0,1,2,…
const WING_Y = 0.082        // dashed wings, just above plot fill
const FOOTPRINT_Y = 0.080   // solid white footprint, beneath the dashed wings

// Convert a wing vertex (model space) to world space using the entry's transform.
function wingToWorld([vx, vz], entry, y) {
  const s = PARA_SCALE, c = Math.cos(entry.rotY ?? 0), sn = Math.sin(entry.rotY ?? 0)
  const px = vx * s, pz = vz * s
  return new THREE.Vector3(entry.x + px * c + pz * sn, y, entry.z - px * sn + pz * c)
}

function closedLine(points, material) {
  const geo = new THREE.BufferGeometry().setFromPoints([...points, points[0]])
  const line = new THREE.Line(geo, material)
  line.computeLineDistances()   // required for dashed materials
  return line
}

// — Polygon-union helpers (model space) for the merged building footprint —————————
// Param t along segment p→q where it crosses segment a→b; null if no proper crossing.
function segCrossT(p, q, a, b) {
  const r = [q[0] - p[0], q[1] - p[1]], s = [b[0] - a[0], b[1] - a[1]]
  const d = r[0] * s[1] - r[1] * s[0]
  if (Math.abs(d) < 1e-12) return null            // parallel/collinear
  const t = ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / d
  const u = ((a[0] - p[0]) * r[1] - (a[1] - p[1]) * r[0]) / d
  return (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) ? t : null
}
function pointInPoly(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
    if (((yi > pt[1]) !== (yj > pt[1])) &&
        (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}
// Boundary of the union of `polys`: each edge split at crossings with other polys,
// keeping sub-segments whose midpoint lies inside no OTHER poly. Returns [[p0,p1],…].
function unionBoundarySegments(polys) {
  const segs = []
  for (let pi = 0; pi < polys.length; pi++) {
    const poly = polys[pi]
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      const ts = [0, 1]
      for (let pj = 0; pj < polys.length; pj++) {
        if (pj === pi) continue
        const other = polys[pj]
        for (let k = 0; k < other.length; k++) {
          const t = segCrossT(a, b, other[k], other[(k + 1) % other.length])
          if (t != null) ts.push(t)
        }
      }
      ts.sort((x, y) => x - y)
      for (let s = 0; s < ts.length - 1; s++) {
        const t0 = ts[s], t1 = ts[s + 1]
        if (t1 - t0 < 1e-7) continue
        const mt = (t0 + t1) / 2
        const mid = [a[0] + (b[0] - a[0]) * mt, a[1] + (b[1] - a[1]) * mt]
        const interior = polys.some((o, oi) => oi !== pi && pointInPoly(mid, o))
        if (!interior) segs.push([[a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0],
                                  [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]])
      }
    }
  }
  return segs
}

function drawDebugWings() {
  debugGroup.clear()
  const white = new THREE.LineBasicMaterial({ color: 0xffffff })
  for (const entry of (buildingRenderer._lastParaEntries || [])) {
    const wings = entry.spec?.footprint?.wings
    if (!wings) continue
    const polys = wings.map(w => w.vertices).filter(v => v && v.length >= 3)
    if (!polys.length) continue

    // Solid white = merged building footprint (union boundary of all this building's wings).
    for (const [p0, p1] of unionBoundarySegments(polys)) {
      const geo = new THREE.BufferGeometry().setFromPoints([wingToWorld(p0, entry, FOOTPRINT_Y), wingToWorld(p1, entry, FOOTPRINT_Y)])
      debugGroup.add(new THREE.Line(geo, white))
    }

    // Dashed, colour-per-wing — inset 1% toward the wing centroid so it nests just
    // inside the white footprint and the colour stays visible.
    for (let wi = 0; wi < polys.length; wi++) {
      const verts = polys[wi]
      let cx = 0, cz = 0
      for (const [x, z] of verts) { cx += x; cz += z }
      cx /= verts.length; cz /= verts.length
      const inset = verts.map(([x, z]) => [x + (cx - x) * 0.01, z + (cz - z) * 0.01])
      const colored = inset.map(v => wingToWorld(v, entry, WING_Y))
      const mat = new THREE.LineDashedMaterial({
        color: WING_COLORS[wi % WING_COLORS.length], dashSize: 0.012, gapSize: 0.008,
      })
      debugGroup.add(closedLine(colored, mat))
    }
  }
  needsRender = true
}

function renderBuildings() {
  buildingRenderer.randomizeSeed()
  markTownhouses(buildingRenderer._seedOffset)
  buildingRenderer.render(scene, plots, { districts, landmarkBuildings })
  drawDebugWings()
}

renderBuildings()

// Regenerate — re-roll wing/footprint geometry on the SAME blocks/plots (no server rebuild).
window._regenBuildings = renderBuildings

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

// Top-down (plan) view toggle — press T. Near-90° elevation avoids a degenerate
// straight-down lookAt while reading as a true plan view for reconciling the lines.
let topDown = false
function setTopDown(on) {
  topDown = on
  cameraController.elevation = on ? Math.PI / 2 - 0.0001 : Math.PI / 6
  cameraController.azimuth = on ? 0 : cameraController.azimuth
  cameraController.updateCameraPosition()
  updateHud()
  needsRender = true
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyW' && e.shiftKey) {
    if (walkMode) exitWalk(); else enterWalk()
    e.preventDefault()
  } else if (e.code === 'KeyT' && !walkMode) {
    setTopDown(!topDown)
    e.preventDefault()
  }
})

// HUD ──────────────────────────────────────────────────────────────────────────
function updateHud() {
  document.getElementById('hud').textContent =
    `Blocks 10 (concave/townhouse) · 13 (freestanding) · 14 (square) — ` +
    `WASD: pan · Q/E: rotate · scroll: zoom · T: ${topDown ? 'iso view' : 'top-down view'} · Shift+W: walk mode`
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
