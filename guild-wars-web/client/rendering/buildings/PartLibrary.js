import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { makeWallMaterial, makeFloorMaterial } from './stoneMaterial.js'
import { makeBrickMaterial } from './brickMaterial.js'
import { makeRoofMaterial } from './roofMaterial.js'

// Loads one building-part THEME: its manifest (grid + atlas regions), the shared
// texture atlas, and each part slot's geometry. All parts share ONE atlas material,
// so swapping a theme = pointing at a different folder. get(slot) returns a fresh
// Mesh over the shared geometry; the assembler positions/scales it.
export default class PartLibrary {
  // `worldScale` is the scale the assembled building will be rendered at. The stone +
  // grime shader effects are world-space, so they're tuned by it to stay proportional.
  constructor(base, { worldScale = 1, baseY = 0 } = {}) {
    this.base = base.replace(/\/$/, '')
    this.worldScale = worldScale
    this.baseY = baseY
    this.geos = new Map()
    this.material = null
    this.grid = null
    this.regions = null
  }

  async load() {
    // Retry up to 3 times — the Vite dev-server proxy occasionally returns an empty
    // response on the first request after a hot reload (race during server warm-up).
    let manifest
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`${this.base}/manifest.json`)
      const text = await r.text()
      if (text.trim()) { manifest = JSON.parse(text); break }
      if (attempt < 2) await new Promise(res => setTimeout(res, 200))
    }
    if (!manifest) throw new Error(`PartLibrary: failed to load ${this.base}/manifest.json after 3 attempts`)
    this.grid = manifest.grid
    this.regions = manifest.atlasRegions

    const tex = await new THREE.TextureLoader().loadAsync(`${this.base}/${manifest.atlas}`)
    tex.flipY = false               // UVs authored in glTF (top-left) convention
    tex.colorSpace = THREE.SRGBColorSpace
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestMipmapLinearFilter
    tex.generateMipmaps = true
    // World-space shader effects scaled to the building's render scale (tuned at scale 1).
    // Ground dirt fades over one ground-floor height, measured up from the building base.
    const grimeHeight = (this.grid?.floorHeight ?? 1.4) * this.worldScale
    // Stone density is now sampled in LOCAL/model space (see stoneMaterial.js), so no
    // /worldScale compensation is needed — mirrors the brick material's same fix.
    const stoneDensity = 6.0, baseY = this.baseY
    this.material = makeWallMaterial({ map: tex, grimeHeight, baseY })                          // atlas walls (+ grime)
    this.stoneMaterial = makeWallMaterial({ stone: true, density: stoneDensity, grimeHeight, baseY })  // procedural stone
    // Stone columns get the same procedural stone, offset in the noise so a column
    // standing right against a stone wall doesn't show the identical cell pattern.
    this.stoneColumnMaterial = makeWallMaterial({ stone: true, density: stoneDensity, grimeHeight, baseY, offset: [37.1, 11.7, -23.4] })
    // Brick base colour: the light grey, nudged 10% toward a very pale blue, with a
    // slight (0.2%) per-brick jitter so it isn't perfectly flat.
    const brickBase = new THREE.Color(0x626C6D).lerp(new THREE.Color().setHSL(0.58, 0.35, 0.88), 0.1)
    const brickPalette = [[brickBase.getHex(), 1, 0.002]]
    // Brick: same procedural-wall treatment as stone (no atlas region needed), 2:1 (1:2)
    // brick aspect ratio — bricks twice as wide as tall. Sampled in LOCAL/model space now
    // (see brickMaterial.js), so scale is in model units directly — no /worldScale needed.
    this.brickMaterial = makeBrickMaterial({ scaleU: 4, scaleV: 8, palette: brickPalette, grimeHeight, baseY })
    // Stone columns ("poles") get their own brick instance: a 4:1 aspect ratio and ~80%
    // smaller bricks than a first pass at this used, since a narrow vertical pole reads
    // better with small, elongated bricks than the wide wall-course proportions.
    this.brickColumnMaterial = makeBrickMaterial({ scaleU: 10, scaleV: 25, palette: brickPalette, grimeHeight, baseY })
    this.darkMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2622, roughness: 1, metalness: 0, side: THREE.DoubleSide })  // sooty interiors
    // Floors: sampled in LOCAL space (see makeFloorMaterial), so density is in model units
    // directly — no /worldScale correction needed like the world-space wall materials above.
    this.floorStoneMaterial = makeFloorMaterial({ stone: true })
    this.floorWoodMaterial  = makeFloorMaterial({ stone: false })

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
    if (material === 'stone') return this.stoneMaterial
    if (material === 'brick') return this.brickMaterial
    return this.material
  }

  // Cached procedural roof material by type + color. Avoids re-compiling shaders
  // for roofs that share the same type and district color.
  getRoofMaterial(type, hexColor) {
    this._roofCache ??= new Map()
    const key = `${type}:${hexColor}`
    if (!this._roofCache.has(key)) this._roofCache.set(key, makeRoofMaterial(type, hexColor))
    return this._roofCache.get(key)
  }
}
