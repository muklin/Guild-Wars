import * as THREE from 'three'
import CameraController, { FLOOR_SCROLL_MAX } from '../input/CameraController.js'
import WalkMode from '../rendering/WalkMode.js'
import GroundRenderer from '../rendering/GroundRenderer.js'
import { PARA_SCALE, GROUND_Y as BUILDING_GROUND_Y } from '../rendering/utils/BuildingRenderer.js'
import { computeWingRoofFrame } from '../rendering/buildings/ParametricBuilding.js'

// Load data ─────────────────────────────────────────────────────────────────
// Either the static stub (committed fixture) or a real subset exported from a save
// (tools/exportPlot.mjs / Export-Plot.ps1) — both share the same cityDistrictData shape.
const data = await fetch('/client/preview/testBlocks.json').then(r => r.json())
const { districts, streetGraph } = data.cityDistrictData
let { blocks, plots, landmarkBuildings } = data.cityDistrictData
const exportMeta = data._exportMeta ?? null

// Focus point — centroid of every plot corner (falls back to junctions, then origin) —
// so the camera centers on whatever was actually loaded, whether that's the fixed stub
// or an arbitrary plot/block/junction exported from a real save.
function computeFocusPoint() {
  let sx = 0, sy = 0, n = 0
  for (const p of plots) for (const v of (p.blockCorners || [])) { sx += v.x; sy += v.y; n++ }
  if (!n) for (const j of (streetGraph?.junctions || [])) { sx += j.x; sy += j.y; n++ }
  return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 }
}
const { x: CX, y: CZ } = computeFocusPoint()

// Scene + renderer ─────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
// Floor-scroll (PageUp/PageDown — see CameraController), same mechanism as WorldRenderer.
renderer.localClippingEnabled = true
const floorScrollClipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)
let lastAppliedFloorScrollUnits = null
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
camera.position.set(CX, 60, CZ)
camera.lookAt(CX, 0, CZ)

// CameraController — identical wiring to WorldRenderer
let needsRender = true
const cameraController = new CameraController(camera, renderer, () => { needsRender = true })
cameraController.worldSize = 50
cameraController.minZoom   = 6
// Much higher than the main game's iso default (150) — this is a building-detail
// inspection tool, so zooming in close enough to fill the screen with a single wing
// corner (for the pass-debug overlay, notch bugs, etc.) needs to be possible.
cameraController.maxZoom   = 500
cameraController.focusOn(CX, CZ)
camera.zoom = 14
camera.updateProjectionMatrix()

// Lighting (matches WorldRenderer)
scene.add(new THREE.AmbientLight(0xffffff, 0.075))
const sun = new THREE.DirectionalLight(0xffffff, 2.0)
sun.position.set(50, 100, 50)
scene.add(sun)

// Ground plane backdrop ─────────────────────────────────────────────────────────
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(10, 10),
  new THREE.MeshStandardMaterial({ color: 0x5a7048, roughness: 0.9 }),
)
ground.rotation.x = -Math.PI / 2
ground.position.set(CX, 0, CZ)
scene.add(ground)

// Ground + streets + plots + buildings + fences — the SAME GroundRenderer the main game
// uses (WorldRenderer.js), so this harness renders exactly what the game would for the
// same data: real gutter-shaped street meshes, junction fill caps, district-coloured
// plot/block fills, and fences (which avoid building footprints the same way too).
const originalMaterials = new Map()
const groundRenderer = new GroundRenderer(scene, originalMaterials)
const buildingRenderer = groundRenderer.buildingRenderer
buildingRenderer.setDirtyCallback(() => { needsRender = true })

// Needed for _squareType()'s junction fallback AND _computeSquareClusterAngles — both
// read this directly, separately from the streetGraph passed to renderStreetGraph().
groundRenderer.setStreetGraph(streetGraph)
groundRenderer.renderStreetGraph(streetGraph)
// Block/plot/street-seed debug markers — same calls App.js makes once after city
// generation (WorldRenderer.drawBlockCenters/drawPlotCenters/drawStreetSeeds delegate
// straight to these). Without this, GroundRenderer.setDebugVisible(true) has nothing
// to reveal: these marker meshes only exist once drawn here.
groundRenderer.drawBlockCenters(blocks)
groundRenderer.drawPlotCenters(plots)
groundRenderer.drawStreetSeeds(streetGraph)

// District-center markers — GroundRenderer has no notion of districts, so this mirrors
// DistrictRenderer.drawDistrictCenters() directly rather than pulling in that whole class
// (district fills, city edges, wall towers) just for one debug marker.
const districtDebugGroup = new THREE.Group()
scene.add(districtDebugGroup)
function drawDistrictCenters(districtList) {
  districtDebugGroup.clear()
  const geo = new THREE.SphereGeometry(0.075, 8, 8)
  const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 })
  for (const d of (districtList || [])) {
    const sp = d.seedPoint
    if (!sp) continue
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(sp.x, 0.15, sp.y)
    mesh.userData = { kind: 'districtCenter', id: d.id, assignedType: d.assignedType, residentialClass: d.residentialClass }
    districtDebugGroup.add(mesh)
  }
}
drawDistrictCenters(districts)
districtDebugGroup.visible = false   // only shown in debug mode (Shift+D) — see toggleDebugVisualization

// Debug overlay group — wing + footprint lines, redrawn each regenerate.
const debugGroup = new THREE.Group()
scene.add(debugGroup)

const SHOW_FOOTPRINT_DEBUG = false   // white merged-footprint outline — off for now, ridge/wing lines are enough
const WING_COLORS = [0x3399ff, 0x33dd55, 0xdd33dd, 0xffaa22, 0x22dddd, 0xff5555]  // wing 0,1,2,…
const FLOOR_H_MODEL = 1.4   // approximate model-space floor height (matches PartLibrary default)
// World Y of the top of a wing's walls (wall-plate height, not ridge).
const wingTopY = (wing, entry) => {
  // wing.floors is the per-wing floor list — [{zHeight,height,material}, …], possibly
  // with a trailing {type:'roof'} entry once assemble() has run on this same spec.
  const floorOnly = (wing.floors ?? []).filter(e => e.type !== 'roof')
  if (floorOnly.length) {
    const last = floorOnly[floorOnly.length - 1]
    return BUILDING_GROUND_Y + (last.zHeight + last.height) * FLOOR_H_MODEL * PARA_SCALE
  }
  const floors = Math.max(1, entry.spec?.floors ?? 2)
  return BUILDING_GROUND_Y + floors * FLOOR_H_MODEL * PARA_SCALE
}

// Compute the two world-space endpoints of a wing's planned ridge line, using the exact
// same geometry function ParametricBuilding.js uses to build the real roof mesh — so this
// debug line can never end up drawn somewhere different from the actual ridge.
// Returns [THREE.Vector3, THREE.Vector3] or null if the wing has no front edge.
function computeWingRidge(wing, entry, wings) {
  const toPolyObj = (verts) => verts.map(([x, z]) => ({ x, y: z }))
  const neighborPolys = [
    ...wings.filter(w => w !== wing).map(w => ({ poly: toPolyObj(w.vertices) })),
    ...(entry.spec?.neighborWings ?? []).map(w => ({ poly: toPolyObj(w.vertices) })),
  ]
  const floors = Math.max(1, entry.spec?.floors ?? 2)   // fallback only — computeWingRoofFrame prefers wing.floors' own list
  // The real per-building overhang is a random draw inside assemble(); approximate it with
  // the midpoint of its [min,max] range (same approximation FLOOR_H_MODEL already makes).
  const overhang = ((entry.spec?.roof?.overhangMin ?? 0.14) + (entry.spec?.roof?.overhangMax ?? 0.48)) / 2
  const frame = computeWingRoofFrame([wing], floors, entry.spec?.roof ?? {}, FLOOR_H_MODEL, overhang, neighborPolys)
  if (!frame) return null
  const toWorld = ([x, modelY, z]) => wingToWorld([x, z], entry, BUILDING_GROUND_Y + modelY * PARA_SCALE)
  return [toWorld(frame.ridgeP0), toWorld(frame.ridgeP1)]
}

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

    if (SHOW_FOOTPRINT_DEBUG) {
      // Solid white = merged building footprint at the tallest wing's wall-top height.
      const maxTopY = Math.max(...wings.map(w => wingTopY(w, entry)))
      for (const [p0, p1] of unionBoundarySegments(polys)) {
        const geo = new THREE.BufferGeometry().setFromPoints([wingToWorld(p0, entry, maxTopY), wingToWorld(p1, entry, maxTopY)])
        debugGroup.add(new THREE.Line(geo, white))
      }
    }

    // Dashed, colour-per-wing — inset 1% toward the wing centroid so it nests just
    // inside the white footprint and the colour stays visible.
    for (let wi = 0; wi < polys.length; wi++) {
      const verts = polys[wi]
      let cx = 0, cz = 0
      for (const [x, z] of verts) { cx += x; cz += z }
      cx /= verts.length; cz /= verts.length
      const inset = verts.map(([x, z]) => [x + (cx - x) * 0.01, z + (cz - z) * 0.01])
      const colored = inset.map(v => wingToWorld(v, entry, wingTopY(wings[wi], entry)))
      const color = WING_COLORS[wi % WING_COLORS.length]
      const mat = new THREE.LineDashedMaterial({ color, dashSize: 0.012, gapSize: 0.008 })
      debugGroup.add(closedLine(colored, mat))

      // Ridge line — dashed, same color, at calculated apex height above this wing
      const ridge = computeWingRidge(wings[wi], entry, wings)
      if (ridge) {
        const ridgeMat = new THREE.LineDashedMaterial({ color, dashSize: 0.015, gapSize: 0.01 })
        const ridgeGeo = new THREE.BufferGeometry().setFromPoints(ridge)
        const ridgeLine = new THREE.Line(ridgeGeo, ridgeMat)
        ridgeLine.computeLineDistances()
        debugGroup.add(ridgeLine)
      }
    }
  }
  needsRender = true
}

// Per-pass wing debug ("?debugPlot=581" or default 581) — visualizes
// BuildingRenderer._spawnWingBuilding's pass output for one plot directly, world-space:
//   white = pass 1's full (setback+depthBays) quad
//   grey  = that edge's own setback-only strip (a REFERENCE shape — the "pushback
//           region" itself, not a wing snapshot)
//   red   = white minus grey (the naive single-edge-only setback result — possibly
//           more than one piece, drawn separately)
//   blue  = the wing's REAL polygon snapshot after pass 4 actually runs (cross-edge
//           setback subtraction + wing-vs-wing boolean + corner nudge all included)
//   green = the wing's REAL polygon snapshot after pass 5 (pass 5 is currently
//           disabled for debugging, so this equals the final built footprint)
// Comparing blue/green against red is the diagnostic: anything red has that blue/green
// doesn't is the EXTRA notch cut by cross-edge subtraction or wing-vs-wing overlap,
// beyond the single-edge setback you'd naively expect.
const districtById = new Map(districts.map(d => [d.id, d]))
const urlParams = new URLSearchParams(location.search)
const PASS_DEBUG_PLOT_ID = urlParams.has('debugPlot') ? Number(urlParams.get('debugPlot')) : 581
const passDebugGroup = new THREE.Group()
scene.add(passDebugGroup)

// Line loops, not filled meshes — reuses the exact same closedLine() helper
// drawDebugWings already draws with above, which is proven visible (the dashed
// colour-per-wing outlines in the screenshots). A filled ShapeGeometry+rotation.x mesh
// was tried first and silently mirrored the Z axis (Three's rotation matrix for
// rotation.x=-PI/2 sends local y to world z=-y), which is its own bug worth remembering,
// but line loops at a fixed elevated height sidestep both that AND any roof/wall
// occlusion entirely — no depthTest/renderOrder fighting to get right.
const PASS_DEBUG_Y = BUILDING_GROUND_Y + 0.01   // just above the ground floor, under the roof
function passDebugLine(corners, color, y) {
  if (!corners || corners.length < 3) return null
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false })
  const line = closedLine(corners.map(c => new THREE.Vector3(c.x, y, c.y)), mat)
  line.renderOrder = 999
  return line
}

function drawPassDebug() {
  passDebugGroup.clear()
  const plot = plots.find(p => p.id === PASS_DEBUG_PLOT_ID)
  if (!plot) {
    console.warn(`[passDebug] plot ${PASS_DEBUG_PLOT_ID} not found in loaded data`)
    return
  }
  const district = districtById.get(plot.districtId)
  const sink = buildingRenderer.debugTownhouseWingPasses(plot, district)
  // y resets for EACH wing — every wing's white/grey/red/green/blue stack sits in the
  // same low height band, so wings are told apart by their (differing) XY footprint,
  // not by one wing being drawn progressively higher than the next.
  for (const rec of sink) {
    let y = PASS_DEBUG_Y
    const lineWhite = passDebugLine(rec.white, 0xffffff, y); if (lineWhite) passDebugGroup.add(lineWhite)
    y += 0.002   // squished 80% from the original 0.01 — colours were too spread apart to compare
    const lineGrey = passDebugLine(rec.grey, 0x999999, y); if (lineGrey) passDebugGroup.add(lineGrey)
    y += 0.002
    for (const piece of (rec.red || [])) {
      if (Math.abs(polyAreaXYDebug(piece)) < 1e-7) continue   // skip degenerate slivers from convex-difference
      const lineRed = passDebugLine(piece, 0xff2222, y)
      if (lineRed) passDebugGroup.add(lineRed)
    }
    y += 0.002
    const lineBlue = passDebugLine(rec.blue, 0x3355ff, y); if (lineBlue) passDebugGroup.add(lineBlue)
    y += 0.002
    const lineGreen = passDebugLine(rec.green, 0x22ff44, y); if (lineGreen) passDebugGroup.add(lineGreen)
  }
  const built = sink.filter(r => r.green).length
  const droppedEarly = sink.filter(r => r.dropped).map(r => `edge ${r.edgeIndex} (${r.dropped})`)
  console.log(
    `[passDebug] plot ${PASS_DEBUG_PLOT_ID}: streetEdges=${plot.streetEdges?.length ?? 0}, ` +
    `wings attempted=${sink.length}, built=${built}` +
    (droppedEarly.length ? `, dropped before pass 1 finished: ${droppedEarly.join('; ')}` : ''),
    sink)
}
function polyAreaXYDebug(poly) {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    area += a.x * b.y - b.x * a.y
  }
  return area
}

function renderBuildings() {
  buildingRenderer.randomizeSeed()
  // Attached/Freestanding/Custom Model are now rolled per-plot inside BuildingRenderer
  // itself (ADR-0019), seeded from plot geometry — no pre-stamping needed here anymore.
  // renderPlots() rebuilds ground/block fills, buildings (via groundRenderer.buildingRenderer),
  // AND fences together — same call the main game makes (GroundRenderer.renderPlots).
  groundRenderer.renderPlots(plots, { districts, landmarkBuildings })
  drawDebugWings()
  drawPassDebug()
}

renderBuildings()

// Regenerate — re-roll wing/footprint geometry on the SAME blocks/plots (no server rebuild).
window._regenBuildings = renderBuildings

// Floor-scroll (PageUp/PageDown — handled inside CameraController.onKeyDown already,
// for BOTH iso and top-down) — this just applies the resulting clip plane each frame,
// the exact same logic as WorldRenderer._applyFloorScrollClip.
function clearFloorScrollClip() {
  renderer.clippingPlanes = []
  lastAppliedFloorScrollUnits = null
}
function applyFloorScrollClip() {
  if (cameraController.floorScrollUnits === lastAppliedFloorScrollUnits) return
  lastAppliedFloorScrollUnits = cameraController.floorScrollUnits
  if (cameraController.floorScrollUnits >= FLOOR_SCROLL_MAX) {
    renderer.clippingPlanes = []
    return
  }
  const clipY = BUILDING_GROUND_Y + (cameraController.floorScrollUnits * 0.5 + 0.1) * buildingRenderer.floorHeightWorld
  floorScrollClipPlane.constant = clipY
  renderer.clippingPlanes = [floorScrollClipPlane]
}

// Walk mode — same isolation as WorldRenderer: walking always force-exits top-down
// first and clears the floor-scroll clip on both entry and exit, so none of the three
// modes (iso / top-down / walk) leak elevation, zoom, or clip state into another.
let walkMode = null

function enterWalk() {
  if (walkMode) return
  if (cameraController._topDown) cameraController.toggleTopDown()
  clearFloorScrollClip()
  const targetPos = { x: cameraController.targetPosition.x, z: cameraController.targetPosition.z }
  // Real fence segments (groundRenderer._fenceSegments) so walk-mode collision matches
  // the main game instead of treating fences as walk-through.
  walkMode = new WalkMode(scene, renderer, streetGraph, targetPos, cameraController.azimuth, exitWalk, buildingRenderer, groundRenderer._fenceSegments)
  cameraController.setEnabled(false)
  document.getElementById('hud').textContent = 'WALK MODE — WASD: move · Mouse: look · CapsLock: sprint · Shift+W: exit'
}

function exitWalk() {
  walkMode?.destroy()
  walkMode = null
  clearFloorScrollClip()
  cameraController.setEnabled(true)
  updateHud()
  needsRender = true
}

// Debug visualization (Shift+D) — same mechanism as WorldRenderer.toggleDebugVisualization:
// GroundRenderer's own debug layers (street seeds, block/plot centers/seeds) toggle via
// setDebugVisible(), and every OTHER visible mesh in the scene (buildings, fences, the
// pass-debug overlay, etc.) gets swapped to a random-hue flat MeshBasicMaterial so
// overlapping/Z-fighting geometry reads clearly, restored from `originalMaterials` on toggle-off.
let showDebug = false
function toggleDebugVisualization() {
  showDebug = !showDebug
  groundRenderer.setDebugVisible(showDebug)
  districtDebugGroup.visible = showDebug
  const allDebug = new Set(groundRenderer.debugObjects)
  if (showDebug) {
    scene.children.forEach(child => {
      if (child.isMesh && child.material && !allDebug.has(child) && child.visible) {
        originalMaterials.set(child, child.material)
        child.material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.7, 0.6) })
      }
    })
  } else {
    scene.children.forEach(child => {
      if (originalMaterials.has(child)) child.material = originalMaterials.get(child)
    })
    originalMaterials.clear()
  }
  console.log(`Debug mode ${showDebug ? 'ON' : 'OFF'}`)
  needsRender = true
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyW' && e.shiftKey) {
    if (walkMode) exitWalk(); else enterWalk()
    e.preventDefault()
  } else if (e.code === 'KeyT') {
    if (walkMode) exitWalk()   // T while walking switches straight to top-down, like the main game
    cameraController.toggleTopDown()
    lastAppliedFloorScrollUnits = null   // force a resync next frame
    updateHud()
    e.preventDefault()
  } else if (e.code === 'KeyD' && e.shiftKey) {
    toggleDebugVisualization()
    updateHud()
    e.preventDefault()
  }
})

// Debug-marker hover tooltips — the whole point of the centre points is that they're
// hoverable to get their info out, same as InputHandler.onMouseMove's debug branch.
const tooltipEl = document.createElement('div')
Object.assign(tooltipEl.style, {
  position: 'fixed', display: 'none', zIndex: 3, pointerEvents: 'none',
  background: 'rgba(20,24,26,0.92)', color: '#cee', padding: '6px 9px',
  borderRadius: '4px', fontFamily: 'Arial, sans-serif', fontSize: '12px',
  boxShadow: '0 2px 6px rgba(0,0,0,0.4)', maxWidth: '260px',
})
document.body.appendChild(tooltipEl)

function showTooltip(html, e) {
  tooltipEl.innerHTML = html
  tooltipEl.style.left = (e.clientX + 10) + 'px'
  tooltipEl.style.top  = (e.clientY + 10) + 'px'
  tooltipEl.style.display = 'block'
}
function hideTooltip() { tooltipEl.style.display = 'none' }

// Orthographic-camera screen→world (y=0 ground plane), same construction as
// InputHandler.screenToWorld — rays are parallel for an ortho camera, so the screen
// offset is applied along the camera's own right/up axes before intersecting y=0.
function screenToWorld(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect()
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1
  const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1
  const cameraRight = new THREE.Vector3(), cameraUp = new THREE.Vector3(), cameraBackward = new THREE.Vector3()
  camera.matrixWorld.extractBasis(cameraRight, cameraUp, cameraBackward)
  const halfWidth  = (camera.right - camera.left) / (2 * camera.zoom)
  const halfHeight = (camera.top - camera.bottom) / (2 * camera.zoom)
  const rayOrigin = camera.position.clone()
    .addScaledVector(cameraRight, ndcX * halfWidth)
    .addScaledVector(cameraUp, ndcY * halfHeight)
  const rayDir = cameraBackward.clone().negate()
  if (Math.abs(rayDir.y) < 0.0001) return { x: 0, y: 0 }
  const t = -rayOrigin.y / rayDir.y
  if (t < 0) return { x: 0, y: 0 }
  rayOrigin.addScaledVector(rayDir, t)
  return { x: rayOrigin.x, y: rayOrigin.z }
}

// Mirrors DistrictRenderer.getDistrictCenterAtWorldPos — districtDebugGroup's spheres
// aren't owned by GroundRenderer, so this is its own small hit-test.
function getDistrictCenterAtWorldPos(worldX, worldY, threshold = 0.3) {
  const rSq = threshold * threshold
  for (const mesh of districtDebugGroup.children) {
    const dx = worldX - mesh.position.x, dy = worldY - mesh.position.z
    if (dx * dx + dy * dy < rSq) return mesh.userData
  }
  return null
}

document.addEventListener('mousemove', (e) => {
  if (walkMode || !showDebug) { hideTooltip(); return }
  needsRender = true   // hover highlight (setBlockHover/clearBlockHover) needs a redraw
  const worldPos = screenToWorld(e.clientX, e.clientY)
  // Priority matches InputHandler.onMouseMove: block > plot > street junction seed > district center.
  const blockCenter    = groundRenderer.getBlockCenterAtWorldPos(worldPos.x, worldPos.y, 0.05)
  const plotCenter     = blockCenter ? null : groundRenderer.getPlotCenterAtWorldPos(worldPos.x, worldPos.y, 0.04)
  const streetSeed     = (!blockCenter && !plotCenter) ? groundRenderer.getStreetSeedAtWorldPos(worldPos.x, worldPos.y, 0.03) : null
  const districtCenter = (!blockCenter && !plotCenter && !streetSeed) ? getDistrictCenterAtWorldPos(worldPos.x, worldPos.y, 0.1) : null
  const dot = blockCenter || plotCenter || streetSeed || districtCenter
  if (!dot) { groundRenderer.clearBlockHover(); hideTooltip(); return }

  if (dot.kind === 'block') {
    groundRenderer.setBlockHover(dot.id)
    showTooltip(
      `<div style="font-weight:bold">Block ${dot.id}</div>` +
      `<div style="font-size:0.9em;margin-top:2px">type: ${dot.blockType ?? '?'} &nbsp;|&nbsp; district: ${dot.districtId ?? '?'}</div>`,
      e)
  } else if (dot.kind === 'plot') {
    groundRenderer.clearBlockHover()
    showTooltip(
      `<div style="font-weight:bold">Plot ${dot.id}</div>` +
      `<div style="font-size:0.9em;margin-top:2px">block: ${dot.blockId ?? '?'} &nbsp;|&nbsp; district: ${dot.districtId ?? '?'}</div>` +
      `<div style="font-size:0.85em;opacity:0.85">blockType: ${dot.blockType} &nbsp;|&nbsp; streetEdges: ${dot.streetEdges}</div>`,
      e)
  } else if (dot.kind === 'streetSeed') {
    groundRenderer.clearBlockHover()
    showTooltip(
      `<div style="font-weight:bold">Junction ${dot.id}</div>` +
      `<div style="font-size:0.9em;margin-top:2px">type: ${dot.type ?? '?'} &nbsp;|&nbsp; district: ${dot.districtId ?? '?'}</div>` +
      `<div style="font-size:0.85em;opacity:0.85">connections: ${dot.connections} &nbsp;|&nbsp; (${dot.x?.toFixed(3)}, ${dot.y?.toFixed(3)})</div>`,
      e)
  } else if (dot.kind === 'districtCenter') {
    groundRenderer.clearBlockHover()
    showTooltip(
      `<div style="font-weight:bold">District ${dot.id}</div>` +
      `<div style="font-size:0.9em;margin-top:2px">type: ${dot.assignedType ?? '?'}</div>` +
      (dot.residentialClass ? `<div style="font-size:0.85em;opacity:0.85">class: ${dot.residentialClass}</div>` : ''),
      e)
  }
})

// HUD ──────────────────────────────────────────────────────────────────────────
function updateHud() {
  const source = exportMeta ? `Loaded: ${exportMeta.query} (from ${exportMeta.source})` : 'Loaded: static stub (testBlocks.json)'
  document.getElementById('hud').textContent =
    `${source} — ` +
    `WASD: pan · Q/E: rotate · scroll: zoom · [/]: zoom · PgUp/PgDn: floor scroll · ` +
    `T: ${cameraController._topDown ? 'iso view' : 'top-down view'} · Shift+W: walk mode · ` +
    `Shift+D: debug ${showDebug ? 'ON' : 'OFF'}`
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
  applyFloorScrollClip()
  const p = camera.position
  const camMoved = !lastCamPos || lastCamPos.x !== p.x || lastCamPos.y !== p.y || lastCamPos.z !== p.z
  const periodicRefresh = frameCount % 60 === 0
  if (camMoved || needsRender || periodicRefresh) {
    lastCamPos = { x: p.x, y: p.y, z: p.z }
    needsRender = false
    renderer.render(scene, camera)
  }
})()
