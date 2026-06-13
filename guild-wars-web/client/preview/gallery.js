import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import PartLibrary from '../rendering/buildings/PartLibrary.js'
import { assemble } from '../rendering/buildings/ParametricBuilding.js'
import { MODELS, MODEL_SCALE } from '../../shared/buildingCatalogue.js'

// Standalone gallery: a grid of varied Parametric Buildings, a pure visual smoke test
// for the kit + generator. Not part of the game SPA.

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x2a2f33)

// Orthographic, isometric-ish angle — matches the in-game city view, and shows the
// buildings at true (un-foreshortened) proportions for comparison.
const VIEW = 1.4   // half-height of the view, in world units
function frustum() {
  const a = window.innerWidth / window.innerHeight
  return { left: -VIEW * a, right: VIEW * a, top: VIEW, bottom: -VIEW }
}
const f0 = frustum()
const camera = new THREE.OrthographicCamera(f0.left, f0.right, f0.top, f0.bottom, 0.01, 500)
camera.position.set(30, 26, 30)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(1.0, 0.12, 0.3)

scene.add(new THREE.AmbientLight(0xffffff, 0.6))
const sun = new THREE.DirectionalLight(0xffffff, 1.4)
sun.position.set(8, 16, 6)
scene.add(sun)

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80),
  new THREE.MeshStandardMaterial({ color: 0x6b7a52, roughness: 1 }),
)
ground.rotation.x = -Math.PI / 2
scene.add(ground)

// Deterministic spec producer. Material rules: ≤2 materials per building; stone only
// as a contiguous bottom prefix (so stone is never above a non-stone floor); never all
// three of stone/wood/plaster.
function rngOf(seed) { let s = (seed * 2654435761) >>> 0; if (!s) s = 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296 } }
function pickMaterials(floors, rand) {
  const nonstone = rand() < 0.5 ? 'wood' : 'plaster'   // one non-stone choice per building
  const r = rand()
  // r < 0.15 → granite (hewn dark blocks); 0.15–0.5 → regular stone; ≥ 0.5 → nonstone.
  // Reuses the existing r sample so the rand stream length is unchanged.
  const stoneType = r < 0.15 ? 'granite' : 'stone'
  if (r < 0.5 && floors > 1) return Array.from({ length: floors }, (_, f) => (f === 0 ? stoneType : nonstone))
  const m = (floors === 1 && r < 0.35) ? stoneType : nonstone
  return Array.from({ length: floors }, () => m)
}
// Roof material: a wood (shingle) roof only when the whole house is wood; otherwise a
// tile (slate), thatch, or reed roof. Bargeboards are paired to the covering downstream.
function pickRoof(wall, rand) {
  const allWood = wall.every((m) => m === 'wood')
  if (allWood && rand() < 0.5) return 'wood'
  const r = rand()
  return r < 0.4 ? 'slate' : r < 0.7 ? 'thatch' : 'reed'
}
const specs = []
let seed = 1
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 4; col++) {
    const s = seed++
    const rand = rngOf(s)
    const floors = 1 + ((row + col) % 3)
    const wall = pickMaterials(floors, rand)
    // Every third building is L-shaped, so the gallery shows both footprint types.
    const isL = (row + col) % 3 === 2
    const footprint = isL
      ? { type: 'L', w: 3.2 + (col % 2) * 0.8, d: 3.0 + (row % 2) * 0.7 }
      : { type: 'rect', w: 2.4 + (col % 3) * 0.8, d: 2.0 + (row % 2) * 0.8 }
    const roofMat = pickRoof(wall, rand)
    // Per-building hue tint (seeded): plaster/wood/thatch/reed get slight jitter, slate/tile
    // gets a bit more. All expressed as a THREE.Color multiplied against the atlas material.
    const isWarm = roofMat === 'thatch' || roofMat === 'reed'
    const tintH = 0.07 + (rand() - 0.5) * (isWarm ? 0.04 : 0.12)   // hue: warm-ish base ± jitter
    const tintS = 0.25 + rand() * (isWarm ? 0.20 : 0.35)            // saturation (clearly visible)
    const tintL = 0.84 + (rand() - 0.5) * 0.12                      // lightness
    const tint = new THREE.Color().setHSL(tintH, tintS, tintL)
    const wingHeights = isL ? [1.0, 0.55 + rand() * 0.40] : undefined
    specs.push({
      seed: s,
      floors,
      footprint,
      wallMaterial: wall,
      roof: { shape: 'gable', material: roofMat, pitch: 0.42 + rand() * 0.5 },
      tint,
      wingHeights,
      _grid: { row, col },
    })
  }
}

// Parametric buildings are authored in model units (bay = 1). They run ~2.3× larger than
// the fixed GLB houses, so render them at MODEL_SCALE/2.3 to match true game size. The
// PartLibrary tunes its world-space stone/grime shaders to that same scale.
const PARA_SCALE = MODEL_SCALE / 2.3
const SPACING = 0.6
new PartLibrary('/resources/buildingparts/default', { worldScale: PARA_SCALE }).load().then((lib) => {
  for (const spec of specs) {
    const b = assemble(spec, lib)
    b.scale.setScalar(PARA_SCALE)
    b.position.set(spec._grid.col * SPACING, 0, spec._grid.row * SPACING)
    scene.add(b)
  }
  document.getElementById('hud').textContent =
    `Parametric building gallery — ${specs.length} buildings + 5 fixed h-models (front row) — drag to orbit`
}).catch((e) => {
  console.error('gallery load failed', e)
  document.getElementById('hud').textContent = 'Load failed — see console (did you run `npm run build:parts`?)'
})

// Five random fixed house models (h2–h19) at their real game scale, in a front row, to
// compare scale + style against the parametric buildings. h1.glb no longer ships.
const gltf = new GLTFLoader()
const hrand = rngOf(4242)
const housePool = MODELS.houses.filter((h) => h.name !== 'h1')
const chosen = [...housePool].sort(() => hrand() - 0.5).slice(0, 5)
chosen.forEach((m, i) => {
  gltf.load(m.glbPath, (g) => {
    const obj = g.scene
    obj.scale.setScalar(MODEL_SCALE)
    obj.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(obj)
    const c = box.getCenter(new THREE.Vector3())
    obj.position.set(i * SPACING - c.x, -box.min.y, -SPACING)   // recentre x, rest on ground
    scene.add(obj)
  }, undefined, (err) => console.warn('house load failed', m.name, err))
})

window.addEventListener('resize', () => {
  const f = frustum()
  camera.left = f.left; camera.right = f.right; camera.top = f.top; camera.bottom = f.bottom
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

;(function loop() {
  requestAnimationFrame(loop)
  controls.update()
  renderer.render(scene, camera)
})()
