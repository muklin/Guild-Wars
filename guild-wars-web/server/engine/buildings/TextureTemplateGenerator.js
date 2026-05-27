const SIZE   = 64
const STYLES = ['stone', 'brick', 'timber', 'plaster', 'wood']

function mkRng(seed) {
  let s = (seed * 2654435761) >>> 0
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0x100000000 }
}

const clamp = v => Math.max(0, Math.min(255, Math.round(v)))

// ── Voronoi stone cells ───────────────────────────────────────────────────────
function genStone(pixels, size, rng) {
  const cells = Array.from({ length: 28 }, () => ({
    x: rng() * size, y: rng() * size,
    r: 125 + rng() * 35, g: 115 + rng() * 35, b: 105 + rng() * 30,
  }))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let d1 = Infinity, d2 = Infinity, best = null
      for (const c of cells) {
        const d = (x - c.x) ** 2 + (y - c.y) ** 2
        if (d < d1) { d2 = d1; d1 = d; best = c } else if (d < d2) d2 = d
      }
      const idx = (y * size + x) * 4
      if (Math.sqrt(d2) - Math.sqrt(d1) < 1.5) {
        pixels[idx] = 72; pixels[idx + 1] = 67; pixels[idx + 2] = 62
      } else {
        pixels[idx] = clamp(best.r); pixels[idx + 1] = clamp(best.g); pixels[idx + 2] = clamp(best.b)
      }
      pixels[idx + 3] = 255
    }
  }
}

// ── Alternating-row brickwork ─────────────────────────────────────────────────
function genBrick(pixels, size, rng) {
  const bH = 7, bW = 14
  for (let y = 0; y < size; y++) {
    const row  = Math.floor(y / bH)
    const hMortar = (y % bH) === 0
    const off  = (row % 2) * Math.floor(bW / 2)
    for (let x = 0; x < size; x++) {
      const bx     = Math.floor((x + off) / bW)
      const vMortar = ((x + off) % bW) === 0
      const idx = (y * size + x) * 4
      if (hMortar || vMortar) {
        pixels[idx] = 112; pixels[idx + 1] = 95; pixels[idx + 2] = 76
      } else {
        let s = ((row * 97 + bx) * 1234567) >>> 0
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const v = ((s >>> 0) / 0x100000000) * 28 - 14
        pixels[idx] = clamp(178 + v); pixels[idx + 1] = clamp(88 + v * 0.5); pixels[idx + 2] = clamp(58 + v * 0.3)
      }
      pixels[idx + 3] = 255
    }
  }
}

// ── Timber frame: dark beams on light plaster ────────────────────────────────
function genTimber(pixels, size, rng) {
  const bw    = 4
  const vBeams = [0, Math.floor(size / 2) - 2, size - bw]
  const hBeams = [0, Math.floor(size / 3) - 1, Math.floor(2 * size / 3) - 1, size - bw]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const onV = vBeams.some(bx => x >= bx && x < bx + bw)
      const onH = hBeams.some(by => y >= by && y < by + bw)
      const idx = (y * size + x) * 4
      if (onV || onH) {
        pixels[idx] = 76; pixels[idx + 1] = 50; pixels[idx + 2] = 30
      } else {
        let s = ((y * size + x + 1) * 7919) >>> 0
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const v = ((s >>> 0) / 0x100000000) * 18 - 9
        pixels[idx] = clamp(216 + v); pixels[idx + 1] = clamp(196 + v); pixels[idx + 2] = clamp(166 + v)
      }
      pixels[idx + 3] = 255
    }
  }
}

// ── Smooth plaster with subtle noise ─────────────────────────────────────────
function genPlaster(pixels, size, rng) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = ((y * size + x + 1) * 6271 + 99991) >>> 0
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      const v = ((s >>> 0) / 0x100000000) * 22 - 11
      const idx = (y * size + x) * 4
      pixels[idx] = clamp(216 + v); pixels[idx + 1] = clamp(206 + v); pixels[idx + 2] = clamp(191 + v)
      pixels[idx + 3] = 255
    }
  }
}

// ── Horizontal wood planks with grain ────────────────────────────────────────
function genWood(pixels, size, rng) {
  const plankH = 8
  const planks = [[158, 118, 72], [145, 107, 62], [168, 128, 82], [152, 112, 68]]
  for (let y = 0; y < size; y++) {
    const pi  = Math.floor(y / plankH)
    const gap = (y % plankH) === 0
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4
      if (gap) {
        pixels[idx] = 72; pixels[idx + 1] = 52; pixels[idx + 2] = 32
      } else {
        let s = ((x * 139 + pi * 997) * 6271) >>> 0
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const v   = ((s >>> 0) / 0x100000000) * 18 - 9
        const base = planks[pi % planks.length]
        pixels[idx] = clamp(base[0] + v); pixels[idx + 1] = clamp(base[1] + v); pixels[idx + 2] = clamp(base[2] + v)
      }
      pixels[idx + 3] = 255
    }
  }
}

const GENERATORS = { stone: genStone, brick: genBrick, timber: genTimber, plaster: genPlaster, wood: genWood }

export default class TextureTemplateGenerator {
  generate(count = 5, seed = 0) {
    return Array.from({ length: count }, (_, i) => {
      const style   = STYLES[i % STYLES.length]
      const texSeed = ((seed * 1000 + i * 137) ^ 0xcafe) >>> 0
      const rng     = mkRng(texSeed)
      const pixels  = new Uint8Array(SIZE * SIZE * 4)
      GENERATORS[style](pixels, SIZE, rng)
      return {
        id: i,
        style,
        seed: texSeed,
        size: SIZE,
        data: Buffer.from(pixels).toString('base64'),
      }
    })
  }
}
