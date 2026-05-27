const ROOF_TYPES      = ['gabled', 'barn', 'hipped', 'flat', 'gabled']
const FOOTPRINT_TYPES = ['single', 'single', 'double', 'double', 'triple']

export default class BuildingTemplateGenerator {
  generate(count = 5, seed = 0) {
    let s = ((seed ^ 0xdeadbeef) * 2654435761) >>> 0
    const rng = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0x100000000 }

    return Array.from({ length: count }, (_, i) => ({
      id:              i,
      roofType:        ROOF_TYPES[i % ROOF_TYPES.length],
      footprintType:   FOOTPRINT_TYPES[i % FOOTPRINT_TYPES.length],
      floors:          1 + Math.floor(rng() * 2),       // 1–2
      widthDepthRatio: 0.8  + rng() * 1.4,              // 0.8–2.2
      roofPitch:       0.35 + rng() * 0.45,             // 0.35–0.8
      hasChimney:      rng() < 0.6,
      hasDormers:      rng() < 0.3,
      wingRatio:       0.4  + rng() * 0.3,              // secondary wing size for double/triple
    }))
  }
}
