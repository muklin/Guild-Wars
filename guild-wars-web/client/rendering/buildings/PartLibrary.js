import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { makeWallMaterial } from './stoneMaterial.js'

// Loads one building-part THEME: its manifest (grid + atlas regions), the shared
// texture atlas, and each part slot's geometry. All parts share ONE atlas material,
// so swapping a theme = pointing at a different folder. get(slot) returns a fresh
// Mesh over the shared geometry; the assembler positions/scales it.
export default class PartLibrary {
  // `worldScale` is the scale the assembled building will be rendered at. The stone +
  // grime shader effects are world-space, so they're tuned by it to stay proportional.
  constructor(base, { worldScale = 1 } = {}) {
    this.base = base.replace(/\/$/, '')
    this.worldScale = worldScale
    this.geos = new Map()
    this.material = null
    this.grid = null
    this.regions = null
  }

  async load() {
    const manifest = await fetch(`${this.base}/manifest.json`).then((r) => r.json())
    this.grid = manifest.grid
    this.regions = manifest.atlasRegions

    const tex = await new THREE.TextureLoader().loadAsync(`${this.base}/${manifest.atlas}`)
    tex.flipY = false               // UVs authored in glTF (top-left) convention
    tex.colorSpace = THREE.SRGBColorSpace
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestMipmapLinearFilter
    tex.generateMipmaps = true
    // World-space shader effects scaled to the building's render scale (tuned at scale 1).
    const grimeHeight = 1.15 * this.worldScale, stoneDensity = 6.0 / this.worldScale
    this.material = makeWallMaterial({ map: tex, grimeHeight })                          // atlas walls (+ grime)
    this.stoneMaterial = makeWallMaterial({ stone: true, density: stoneDensity, grimeHeight })  // procedural stone
    this.darkMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2622, roughness: 1, metalness: 0 })  // sooty interiors

    const loader = new GLTFLoader()
    for (const name of Object.keys(manifest.parts)) {
      const gltf = await loader.loadAsync(`${this.base}/${name}.glb`)
      let geo = null
      gltf.scene.traverse((o) => { if (o.isMesh && !geo) geo = o.geometry })
      if (geo) this.geos.set(name, geo)
    }
    return this
  }

  // A fresh mesh instance for a slot. Stone panels get the procedural stone material;
  // everything else shares the atlas material.
  get(slot) {
    const geo = this.geos.get(slot)
    if (!geo) return null
    return new THREE.Mesh(geo, slot === 'panel-stone' ? this.stoneMaterial : this.material)
  }

  // Material for generated geometry (gable fills, roof) of a given wall material.
  materialFor(material) {
    return material === 'stone' ? this.stoneMaterial : this.material
  }
}
