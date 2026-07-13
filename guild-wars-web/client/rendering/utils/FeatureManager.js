import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js'
import { pointInPolygon } from './renderUtils.js'
import { assetUrl } from '../../config.js'
import { MODELS } from '../../../shared/buildingCatalogue.js'

// Re-exported from the shared catalogue (ADR-0005) so existing importers are unchanged.
export { MODELS }

const FEATURES = {
  fields: {
    glbPath: '/resources/Models/fields.glb',
    strategy: 'fixed',   // one instance per cell, placed at seed point
    baseScale: .8,
    scaleVariation: 0,
    minScale: 1,
    loop: false           // wind-sway loops continuously
  },
  forest: {
    glbPaths: [
      '/resources/Models/tree.glb',
      '/resources/Models/tree1.glb',
      '/resources/Models/tree2.glb',
      '/resources/Models/tree3.glb',
    ],
    strategy: 'scatter',
    count: 60,              // doubled (user-confirmed 2026-07-14, was 30)
    baseScale: 0.104,
    scaleVariation: 0.064,
    minScale: 0.08,
    heightScale: 2,         // Y-axis only (user-confirmed 2026-07-14, "increase tree heights by 2x") — footprint/count are separate knobs
    leanMax: 0.03,
  },
  bridge: {
    glbPath: '/resources/Models/bridge.glb',
    strategy: 'absolute',
    baseScale: 1,
    scaleVariation: 0,
    minScale: 1,
    noAnimation: true
  },
  building: {
    glbPath: '/resources/Models/h2.glb',
    fitFootprint: 0.95,    // model is scaled so its footprint ≈ this × the plot building footprint
    rotationOffset: 0,     // added to the street-facing rotation if the model's front isn't +Z
    noAnimation: true,
  },
  wallTower: {
    glbPath: '/resources/Models/wallTower.glb',
    footprint: 0.22,       // world-unit diameter the model is scaled to
    rotationOffset: 0,     // added to the per-tower facing if the model's front isn't +Z
    noAnimation: true,
  },
  wallGate: {
    glbPath: '/resources/Models/t1.glb',
    footprint: 0.22,
    rotationOffset: 0,
    noAnimation: true,
  },
  barbican: {
    glbPath: '/resources/Models/t1.glb',
    footprint: 0.30,
    rotationOffset: 0,
    noAnimation: true,
  }
}

// ── Shared, app-wide GLB cache ────────────────────────────────────────────────
// One loader and one cache for the whole app: every GLB is fetched and parsed
// exactly once, and all FeatureManager instances reuse the same parsed gltf.
// (SkeletonUtils.clone shares geometries and materials by reference, so per-
// instance memory is just the node hierarchy — geometry/textures are not copied.)
const _sharedLoader = new GLTFLoader()
const _sharedGltfCache = new Map()   // path → Promise<gltf>

function loadGLTFShared(path) {
  if (!_sharedGltfCache.has(path)) {
    // Cache key stays the original '/resources/Models/...' path; assetUrl() resolves it
    // against assetBase (local bundle in Electron, same-origin in dev) at fetch time.
    _sharedGltfCache.set(path, new Promise((resolve, reject) => {
      _sharedLoader.load(assetUrl(path), resolve, undefined, reject)
    }))
  }
  return _sharedGltfCache.get(path)
}

// Preload every building/feature GLB up front (at startup) so the first render
// has no load latency. Safe to call repeatedly — cached paths are not refetched.
export function preloadModels() {
  const paths = new Set()
  for (const arr of Object.values(MODELS)) for (const m of arr) if (m.glbPath) paths.add(m.glbPath)
  for (const cfg of Object.values(FEATURES)) {
    if (cfg.glbPath) paths.add(cfg.glbPath)
    if (cfg.glbPaths) for (const p of cfg.glbPaths) paths.add(p)
  }
  return Promise.all([...paths].map(p =>
    loadGLTFShared(p).catch(err => console.error(`preloadModels: failed to load ${p}`, err))
  ))
}

export default class FeatureManager {
  constructor(scene) {
    this.scene = scene
    this._objects = []
    this._mixers = []
    this._billboardWrappers = []
    this._epoch = 0   // bumped on clear() so in-flight async spawns can self-cancel
  }

  _loadGLTF(path) {
    return loadGLTFShared(path)
  }

  _mkRng(seed) {
    let s = (seed * 2654435761) >>> 0
    return () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      return ((s >>> 0) / 0x100000000)
    }
  }

  _samplePolygon(polygon, count, rng) {
    const xs = polygon.map(v => v.x), ys = polygon.map(v => v.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const pts = []
    let attempts = 0
    while (pts.length < count && attempts < count * 40) {
      const x = minX + rng() * (maxX - minX)
      const y = minY + rng() * (maxY - minY)
      if (pointInPolygon(x, y, polygon)) pts.push({ x, z: y, worldY: this._polygonHeightAt(polygon, x, y) })
      attempts++
    }
    return pts
  }

  // Real per-vertex terrain height (see TODO.md "Groundplane Z-height implementation")
  // interpolated at (x,y) — fan-triangulated from polygon[0], barycentric-weighted
  // across whichever fan triangle contains the point (user-confirmed 2026-07-14: trees
  // were always spawning at Y=0 regardless of the terrain height they landed on). Falls
  // back to the nearest vertex's own z if the point lands in no fan triangle at all
  // (float-precision edge case at a concave polygon's boundary).
  _polygonHeightAt(polygon, x, y) {
    if (!polygon?.length) return 0
    const z0 = polygon[0].z ?? 0
    for (let i = 1; i < polygon.length - 1; i++) {
      const a = polygon[0], b = polygon[i], c = polygon[i + 1]
      const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
      if (Math.abs(d) < 1e-9) continue
      const w1 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / d
      const w2 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / d
      const w3 = 1 - w1 - w2
      if (w1 >= -1e-6 && w2 >= -1e-6 && w3 >= -1e-6) {
        return w1 * z0 + w2 * (b.z ?? 0) + w3 * (c.z ?? 0)
      }
    }
    let nearest = polygon[0], bestD = Infinity
    for (const v of polygon) {
      const d = (v.x - x) ** 2 + (v.y - y) ** 2
      if (d < bestD) { bestD = d; nearest = v }
    }
    return nearest.z ?? 0
  }

  _spawnOne(gltf, x, z, scale, rotY, rotX = 0, rotZ = 0, billboard = false, loop = false, skipAnimation = false, worldY = 0, scaleY = null) {
    // Wrapper holds world position/rotation/scale so the animation on the inner
    // scene cannot displace the prop from its terrain plot seed point.
    const inner = skeletonClone(gltf.scene)
    inner.position.set(0, 0, 0)  // clear any baked-in GLB root offset

    const wrapper = new THREE.Group()
    wrapper.rotation.set(rotX, rotY, rotZ)
    // scaleY (user-confirmed 2026-07-14, forest's heightScale): non-uniform scale so a
    // feature can be made taller without also widening its footprint — omitted (null)
    // keeps every other caller's existing uniform-scale behaviour unchanged.
    if (scaleY != null) wrapper.scale.set(scale, scaleY, scale)
    else wrapper.scale.setScalar(scale)
    wrapper.position.set(x, worldY, z)
    wrapper.add(inner)
    this.scene.add(wrapper)
    this._objects.push(wrapper)
    if (billboard) this._billboardWrappers.push(wrapper)

    if (!skipAnimation && gltf.animations?.length > 0) {
      const mixer = new THREE.AnimationMixer(inner)
      const action = mixer.clipAction(gltf.animations[0])
      if (loop) {
        action.setLoop(THREE.LoopRepeat)
      } else {
        action.setLoop(THREE.LoopOnce)
        action.clampWhenFinished = true
      }
      action.play()
      this._mixers.push(mixer)
    }
  }

  async spawn(featureName, cells, absolutePos={x:0,z:0,rotX:0,rotY:0,rotZ:0}) {

    const cfg = FEATURES[featureName]
    if (!cfg) { console.warn(`FeatureManager: unknown feature '${featureName}'`); return }

    // Support both single glbPath and multi-model glbPaths array
    let gltf
    let gltfs = null  // array for glbPaths mode
    if (cfg.glbPaths) {
      try {
        gltfs = await Promise.all(cfg.glbPaths.map(p => this._loadGLTF(p)))
      } catch (err) {
        console.error(`FeatureManager: failed to load models for '${featureName}'`, err)
        return
      }
    } else {
      try {
        gltf = await this._loadGLTF(cfg.glbPath)
      } catch (err) {
        console.error(`FeatureManager: failed to load ${cfg.glbPath}`, err)
        return
      }
    }

    console.log(`FeatureManager: spawning '${featureName}' for ${cells.length} cells`)

    for (const cell of cells) {
      const rng = this._mkRng(cell.id ?? 0)

      if (cfg.strategy === 'fixed') {
        const scale = Math.max(cfg.minScale, cfg.baseScale + (rng() - 0.5) * 2 * cfg.scaleVariation)
        const rotY = rng() * Math.PI * 2
        this._spawnOne(gltf, cell.seedPoint.x, cell.seedPoint.y, scale, rotY, 0, 0, false, cfg.loop ?? false, false, cell.seedPoint.z ?? 0)
      } else if (cfg.strategy === 'scatter') {
        const points = (cell.polygon?.length >= 3)
          ? this._samplePolygon(cell.polygon, cfg.count, rng)
          : [{ x: cell.seedPoint.x, z: cell.seedPoint.y, worldY: cell.seedPoint.z ?? 0 }]

        for (const pt of points) {
          const rotY = cfg.billboardY ? 0 : rng() * Math.PI * 2
          const rotX = (rng() - 0.5) * 2 * (cfg.leanMax ?? 0)
          const rotZ = (rng() - 0.5) * 2 * (cfg.leanMax ?? 0)
          const scale = Math.max(cfg.minScale, cfg.baseScale + (rng() - 0.5) * 2 * cfg.scaleVariation)
          const scaleY = cfg.heightScale ? scale * cfg.heightScale : null
          const model = gltfs ? gltfs[Math.floor(rng() * gltfs.length)] : gltf
          this._spawnOne(model, pt.x, pt.z, scale, rotY, rotX, rotZ, cfg.billboardY ?? false, false, false, pt.worldY ?? 0, scaleY)
        }
      } else if (cfg.strategy === 'absolute') {
        const scale = Math.max(cfg.minScale, cfg.baseScale + (rng() - 0.5) * 2 * cfg.scaleVariation)
        this._spawnOne(gltf, absolutePos.x, absolutePos.z, scale, absolutePos.rotY, absolutePos.rotX, absolutePos.rotZ, cfg.billboardY ?? false, false, cfg.noAnimation ?? false)
      }
    }
  }

  // Spawn building models. Each placement is { x, z, rotY, glbPath, scale }:
  // rotY faces the street, glbPath selects the model, scale is precomputed from
  // the model's stored footprint. Placements are grouped by model so each GLB is
  // loaded once; each is seated on the ground.
  async spawnBuildings(placements, baseY = 0) {
    if (!placements?.length) return
    const t0 = performance.now()
    const epoch = this._epoch   // capture; a clear() during loading bumps this
    const byPath = new Map()
    for (const p of placements) {
      if (!p.glbPath) continue
      if (!byPath.has(p.glbPath)) byPath.set(p.glbPath, [])
      byPath.get(p.glbPath).push(p)
    }
    let loadMs = 0, instantiateMs = 0, seatMs = 0
    for (const [glbPath, group] of byPath) {
      let gltf
      const tLoad = performance.now()
      try {
        gltf = await this._loadGLTF(glbPath)
      } catch (err) {
        console.error(`FeatureManager: failed to load ${glbPath}`, err)
        continue
      }
      loadMs += performance.now() - tLoad
      if (this._epoch !== epoch) return   // cleared while loading — don't spawn stale buildings
      const tInst = performance.now()
      for (const p of group) {
        const scale = p.scale ?? 1
        const idx = this._objects.length
        this._spawnOne(gltf, p.x, p.z, scale, p.rotY ?? 0, 0, 0, false, false, true)
        const wrapper = this._objects[idx]
        if (wrapper) {
          // Seat the base on the ground by measuring the actual spawned wrapper
          // in world space (its real clone, scale and rotation), then lifting it
          // so the lowest vertex sits at y = baseY. Robust regardless of model origin.
          wrapper.updateMatrixWorld(true)
          const wb = new THREE.Box3().setFromObject(wrapper)
          if (isFinite(wb.min.y)) wrapper.position.y = baseY - wb.min.y
        }
      }
      const dt = performance.now() - tInst
      instantiateMs += dt
      console.log(`[perf]   GLB ${glbPath.split('/').pop()}: load=${loadMs.toFixed(1)}ms clone+seat=${dt.toFixed(1)}ms ×${group.length}`)
    }
    console.log(`[perf] spawnBuildings total: ${(performance.now()-t0).toFixed(1)}ms (${placements.length} buildings, ${byPath.size} models — load=${loadMs.toFixed(1)}ms inst=${instantiateMs.toFixed(1)}ms)`)
  }

  // Local bounding box of the model as it is actually rendered (a clone with its
  // root position cleared, matching _spawnOne). Returns { minY, size }.
  _measureModel(gltf) {
    const m = gltf.scene.clone(true)
    m.position.set(0, 0, 0)
    m.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(m)
    const size = new THREE.Vector3(); box.getSize(size)
    return { minY: box.min.y, size }
  }

  // Spawn a wall tower at each { x, y } position (y is the world Z), scaled to a
  // fixed footprint and seated with its base at `baseY`.
  async spawnTowers(positions, baseY = 0) {
    if (!positions?.length) return
    const epoch = this._epoch   // capture; a clear() during loading bumps this
    const cfg = FEATURES.wallTower
    let gltf
    try {
      gltf = await this._loadGLTF(cfg.glbPath)
    } catch (err) {
      console.error(`FeatureManager: failed to load ${cfg.glbPath}`, err)
      return
    }
    if (this._epoch !== epoch) return   // cleared while loading — don't spawn stale towers

    const { minY, size } = this._measureModel(gltf)
    const scale = (cfg.footprint ?? 0.2) / (Math.max(size.x, size.z) || 1)
    const rotOff = cfg.rotationOffset ?? 0

    for (const p of positions) {
      const idx = this._objects.length
      this._spawnOne(gltf, p.x, p.y, scale, (p.rotY ?? 0) + rotOff, 0, 0, false, false, true)
      // Seat the model's base at baseY (the wall foot).
      const wrapper = this._objects[idx]
      if (wrapper) wrapper.position.y = baseY - minY * scale
    }
  }

  // Generic spawn: use any FEATURES entry by key. Same sizing logic as spawnTowers.
  async spawnFeature(featureKey, positions, baseY = 0) {
    if (!positions?.length) return
    const epoch = this._epoch
    const cfg = FEATURES[featureKey]
    if (!cfg) { console.warn(`FeatureManager: unknown feature key '${featureKey}'`); return }
    let gltf
    try { gltf = await this._loadGLTF(cfg.glbPath) }
    catch (err) { console.error(`FeatureManager: failed to load ${cfg.glbPath}`, err); return }
    if (this._epoch !== epoch) return

    const { minY, size } = this._measureModel(gltf)
    const scale = (cfg.footprint ?? 0.2) / (Math.max(size.x, size.z) || 1)
    const rotOff = cfg.rotationOffset ?? 0
    for (const p of positions) {
      const idx = this._objects.length
      this._spawnOne(gltf, p.x, p.y, scale, (p.rotY ?? 0) + rotOff, 0, 0, false, false, true)
      const wrapper = this._objects[idx]
      if (wrapper) wrapper.position.y = baseY - minY * scale
    }
  }

  update(delta, camera) {
    for (const mixer of this._mixers) mixer.update(delta)
    if (camera && this._billboardWrappers.length > 0) {
      const cameraYRot = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').y
      for (const wrapper of this._billboardWrappers) wrapper.rotation.y = cameraYRot
    }
  }

  clear() {
    this._epoch++   // invalidate any async spawn (e.g. spawnBuildings) still loading
    for (const obj of this._objects) this.scene.remove(obj)
    this._objects = []
    this._mixers = []
    this._billboardWrappers = []
    // _gltfCache intentionally kept — GLBs can be reused after clear
  }
}
