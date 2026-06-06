import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js'
import { pointInPolygon } from './renderUtils.js'

const FEATURES = {
  fields: {
    glbPath: '/resources/fields.glb',
    strategy: 'fixed',   // one instance per cell, placed at seed point
    baseScale: .8,
    scaleVariation: 0,
    minScale: 1,
    loop: false           // wind-sway loops continuously
  },
  forest: {
    glbPath: '/resources/tree.glb',
    strategy: 'scatter',  // multiple instances spread across the cell polygon
    count: 15,
    baseScale: 0.38,
    scaleVariation: 0.18,
    minScale: 0.15,
    leanMax: 0.03,
  },
  mountains: {
    glbPath: '/resources/mtn.glb',
    strategy: 'single',   // one instance at the cell seed point, scaled by polygon area
    scaleFactor: 0.05,
    scaleVariation: 0,
    minScale: 1
  },
  hills: {
    glbPath: '/resources/hills.glb',
    strategy: 'single',
    scaleFactor: 0.30,
    scaleVariation: 0.15,
    minScale: 0.10
  },
  sea: {
    glbPath: '/resources/sea.glb',
    strategy: 'scatter',
    count: 20,
    baseScale: 0.3,
    scaleVariation: 0.5,
    minScale: 0.3,
    leanMax: 0.1 ,
    billboardY: true,   // Y rotation tracks camera azimuth each frame
  },
  lake: {
    glbPath: '/resources/lake.glb',
    strategy: 'scatter',
    count: 5,
    baseScale: 1,
    scaleVariation: 1,
    minScale: 1 ,
    leanMax: 0 ,
    billboardY: true,   // Y rotation tracks camera azimuth each frame
  },
  bridge: {
    glbPath: '/resources/bridge.glb',
    strategy: 'absolute',
    baseScale: 1,
    scaleVariation: 0,
    minScale: 1,
    noAnimation: true
  }
}

export default class FeatureManager {
  constructor(scene) {
    this.scene = scene
    this.loader = new GLTFLoader()
    this._gltfCache = new Map()
    this._objects = []
    this._mixers = []
    this._billboardWrappers = []
  }

  _loadGLTF(path) {
    if (!this._gltfCache.has(path)) {
      this._gltfCache.set(path, new Promise((resolve, reject) => {
        this.loader.load(path, resolve, undefined, reject)
      }))
    }
    return this._gltfCache.get(path)
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
      if (pointInPolygon(x, y, polygon)) pts.push({ x, z: y })
      attempts++
    }
    return pts
  }

  _polygonArea(polygon) {
    let area = 0
    const n = polygon.length
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      area += polygon[i].x * polygon[j].y
      area -= polygon[j].x * polygon[i].y
    }
    return Math.abs(area) / 2
  }

  _spawnOne(gltf, x, z, scale, rotY, rotX = 0, rotZ = 0, billboard = false, loop = false, skipAnimation = false) {
    // Wrapper holds world position/rotation/scale so the animation on the inner
    // scene cannot displace the prop from its fine-cell seed point.
    const inner = skeletonClone(gltf.scene)
    inner.position.set(0, 0, 0)  // clear any baked-in GLB root offset

    const wrapper = new THREE.Group()
    wrapper.rotation.set(rotX, rotY, rotZ)
    wrapper.scale.setScalar(scale)
    wrapper.position.set(x, 0, z)
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

    let gltf
    try {
      gltf = await this._loadGLTF(cfg.glbPath)
    } catch (err) {
      console.error(`FeatureManager: failed to load ${cfg.glbPath}`, err)
      return
    }

    console.log(`FeatureManager: spawning '${featureName}' for ${cells.length} cells`)

    for (const cell of cells) {
      const rng = this._mkRng(cell.id ?? 0)

      if (cfg.strategy === 'fixed') {
        const scale = Math.max(cfg.minScale, cfg.baseScale + (rng() - 0.5) * 2 * cfg.scaleVariation)
        const rotY = rng() * Math.PI * 2
        this._spawnOne(gltf, cell.seedPoint.x, cell.seedPoint.y, scale, rotY, 0, 0, false, cfg.loop ?? false)
      } else if (cfg.strategy === 'scatter') {
        const points = (cell.polygon?.length >= 3)
          ? this._samplePolygon(cell.polygon, cfg.count, rng)
          : [{ x: cell.seedPoint.x, z: cell.seedPoint.y }]

        for (const pt of points) {
          const rotY = cfg.billboardY ? 0 : rng() * Math.PI * 2
          const rotX = (rng() - 0.5) * 2 * (cfg.leanMax ?? 0)
          const rotZ = (rng() - 0.5) * 2 * (cfg.leanMax ?? 0)
          const scale = Math.max(cfg.minScale, cfg.baseScale + (rng() - 0.5) * 2 * cfg.scaleVariation)
          this._spawnOne(gltf, pt.x, pt.z, scale, rotY, rotX, rotZ, cfg.billboardY ?? false)
        }
      } else if (cfg.strategy === 'single') {
        const area = cell.polygon?.length >= 3 ? this._polygonArea(cell.polygon) : 1
        const base = Math.sqrt(area) * cfg.scaleFactor
        const scale = Math.max(cfg.minScale, base * (1 + (rng() - 0.5) * 2 * cfg.scaleVariation))
        const rotY = rng() * Math.PI * 2
        this._spawnOne(gltf, cell.seedPoint.x, cell.seedPoint.y, scale, rotY)
      } else if (cfg.strategy === 'absolute') {
        const scale = Math.max(cfg.minScale, cfg.baseScale + (rng() - 0.5) * 2 * cfg.scaleVariation)
        this._spawnOne(gltf, absolutePos.x, absolutePos.z, scale, absolutePos.rotY, absolutePos.rotX, absolutePos.rotZ, cfg.billboardY ?? false, false, cfg.noAnimation ?? false)
      }
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
    for (const obj of this._objects) this.scene.remove(obj)
    this._objects = []
    this._mixers = []
    this._billboardWrappers = []
    // _gltfCache intentionally kept — GLBs can be reused after clear
  }
}
