// Builds one texture atlas: a grid of procedurally-painted material tiles, plus the
// UV region of each material. Painters adapted from the (dead) server
// TextureTemplateGenerator; thatch/slate/glass/woodtrim added.

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))

function mkRng(seed) {
  let s = (seed * 2654435761) >>> 0
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0x100000000 }
}

// Each painter fills a TILE×TILE region of `px` (atlas RGBA) at offset (ox,oy).
function put(px, W, x, y, r, g, b) { const i = (y * W + x) * 4; px[i] = clamp(r); px[i + 1] = clamp(g); px[i + 2] = clamp(b); px[i + 3] = 255 }

function stone(px, W, ox, oy, T, rng) {
  // Smaller, denser cells; neutral grey (no warm tint); mortar a darker grey.
  const cells = Array.from({ length: 60 }, () => { const v = 110 + rng() * 70, j = rng() * 8 - 4; return { x: rng() * T, y: rng() * T, r: v + j, g: v + j, b: v + j + rng() * 4 } })
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    let d1 = Infinity, d2 = Infinity, best = cells[0]
    for (const c of cells) { const d = (x - c.x) ** 2 + (y - c.y) ** 2; if (d < d1) { d2 = d1; d1 = d; best = c } else if (d < d2) d2 = d }
    if (Math.sqrt(d2) - Math.sqrt(d1) < 1.1) put(px, W, ox + x, oy + y, 66, 66, 68)
    else put(px, W, ox + x, oy + y, best.r, best.g, best.b)
  }
}
function brick(px, W, ox, oy, T) {
  const bH = 7, bW = 14
  for (let y = 0; y < T; y++) { const row = Math.floor(y / bH), hM = (y % bH) === 0, off = (row % 2) * 7
    for (let x = 0; x < T; x++) { const vM = ((x + off) % bW) === 0
      if (hM || vM) put(px, W, ox + x, oy + y, 112, 95, 76)
      else { let s = ((row * 97 + Math.floor((x + off) / bW)) * 1234567) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 28 - 14; put(px, W, ox + x, oy + y, 178 + v, 88 + v * 0.5, 58 + v * 0.3) }
    } }
}
function timber(px, W, ox, oy, T) {
  const bw = 4, vB = [0, (T >> 1) - 2, T - bw], hB = [0, Math.floor(T / 3) - 1, Math.floor(2 * T / 3) - 1, T - bw]
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const on = vB.some(b => x >= b && x < b + bw) || hB.some(b => y >= b && y < b + bw)
    if (on) put(px, W, ox + x, oy + y, 76, 50, 30)
    else { let s = ((y * T + x + 1) * 7919) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 18 - 9; put(px, W, ox + x, oy + y, 216 + v, 196 + v, 166 + v) }
  }
}
function plaster(px, W, ox, oy, T) {
  // Plaster darkens toward the tile edges (which abut the timber posts/beams).
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    let s = ((y * T + x + 1) * 6271 + 99991) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 22 - 11
    const e = Math.min(x, T - 1 - x, y, T - 1 - y)
    const f = 0.62 + 0.38 * Math.min(1, e / 11)
    put(px, W, ox + x, oy + y, (216 + v) * f, (206 + v) * f, (191 + v) * f)
  }
}
function wood(px, W, ox, oy, T) {
  const pH = 8, pal = [[158, 118, 72], [145, 107, 62], [168, 128, 82], [152, 112, 68]]
  for (let y = 0; y < T; y++) { const pi = Math.floor(y / pH), gap = (y % pH) === 0
    for (let x = 0; x < T; x++) { if (gap) put(px, W, ox + x, oy + y, 72, 52, 32)
      else { let s = ((x * 139 + pi * 997) * 6271) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 18 - 9; const b = pal[pi % 4]; put(px, W, ox + x, oy + y, b[0] + v, b[1] + v, b[2] + v) } } }
}
function thatch(px, W, ox, oy, T) {   // straw: horizontal noisy rows, golden-brown
  for (let y = 0; y < T; y++) { const band = Math.sin(y * 0.7) * 8
    for (let x = 0; x < T; x++) { let s = ((x * 71 + y * 911) * 2654435761) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 30 - 10; put(px, W, ox + x, oy + y, 150 + band + v, 120 + band + v * 0.8, 60 + v * 0.5) } }
}
function reed(px, W, ox, oy, T) {      // thatch texture, weathered dark grey (verge bundles)
  for (let y = 0; y < T; y++) { const band = Math.sin(y * 0.7) * 6
    for (let x = 0; x < T; x++) { let s = ((x * 71 + y * 911) * 2654435761) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 22 - 8; const g = 72 + band + v; put(px, W, ox + x, oy + y, g, g + 2, g + 5) } }
}
function slate(px, W, ox, oy, T) {     // overlapping fish-scale tiles, blue-grey
  const sw = 10, sh = 6
  for (let y = 0; y < T; y++) { const row = Math.floor(y / sh), off = (row % 2) * (sw >> 1)
    for (let x = 0; x < T; x++) { const within = (y % sh), edge = within < 1 || ((x + off) % sw) < 1
      let s = ((row * 313 + Math.floor((x + off) / sw)) * 6271) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 22 - 11
      if (edge) put(px, W, ox + x, oy + y, 50, 54, 60)
      else put(px, W, ox + x, oy + y, 96 + v, 102 + v, 114 + v) } }
}
function glass(px, W, ox, oy, T) {     // leaded panes, blue-grey with light streak
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const lead = (x % 16 < 1) || (y % 16 < 1)
    const streak = clamp(40 * Math.max(0, 1 - Math.abs((x - y) - 8) / 10))
    if (lead) put(px, W, ox + x, oy + y, 60, 58, 54)
    else put(px, W, ox + x, oy + y, 96 + streak, 116 + streak, 130 + streak)
  }
}
function woodtrim(px, W, ox, oy, T) {  // dark solid beam wood
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) { let s = ((x * 311 + y * 17) * 2246822519) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 16 - 8; put(px, W, ox + x, oy + y, 84 + v, 56 + v, 34 + v) }
}
function doorwood(px, W, ox, oy, T) {  // dark VERTICAL planks (door / shutters), woodtrim tone
  const pw = 9
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const gap = (x % pw) < 1
    if (gap) put(px, W, ox + x, oy + y, 44, 30, 18)
    else { let s = ((Math.floor(x / pw) * 733 + y * 19) * 2246822519) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 14 - 7; put(px, W, ox + x, oy + y, 80 + v, 53 + v, 32 + v) }
  }
}

function granite(px, W, ox, oy, T) { // hewn granite: dark rectangular blocks, rough surface
  const bH = 10, bW = 20
  for (let y = 0; y < T; y++) {
    const row = Math.floor(y / bH), hM = (y % bH) < 1, off = (row % 2) * 10
    for (let x = 0; x < T; x++) {
      const vM = ((x + off) % bW) < 1
      if (hM || vM) { put(px, W, ox + x, oy + y, 22, 22, 24); continue }
      let s = ((row * 97 + Math.floor((x + off) / bW)) * 1234567) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      const v = ((s >>> 0) / 4294967296) * 18 - 9
      put(px, W, ox + x, oy + y, 42 + v, 42 + v, 46 + v)
    }
  }
}

const MATERIALS = [
  { name: 'stone', paint: stone }, { name: 'brick', paint: brick }, { name: 'timber', paint: timber },
  { name: 'plaster', paint: plaster }, { name: 'wood', paint: wood }, { name: 'thatch', paint: thatch },
  { name: 'slate', paint: slate }, { name: 'glass', paint: glass }, { name: 'woodtrim', paint: woodtrim },
  { name: 'doorwood', paint: doorwood }, { name: 'reed', paint: reed }, { name: 'granite', paint: granite },
]

// Returns { size, pixels, regions } — regions keyed by material → {u0,v0,u1,v1} in
// glTF (top-left origin) UV space, slightly inset to avoid bleeding between tiles.
export function buildAtlas(seed = 1, TILE = 64, COLS = 4) {
  const rows = Math.ceil(MATERIALS.length / COLS)
  const W = COLS * TILE, H = rows * TILE
  const pixels = new Uint8Array(W * H * 4)
  const regions = {}
  MATERIALS.forEach((mat, i) => {
    const col = i % COLS, row = Math.floor(i / COLS), ox = col * TILE, oy = row * TILE
    mat.paint(pixels, W, ox, oy, TILE, mkRng((seed * 1000 + i * 137) ^ 0xcafe))
    const inset = 0.5
    regions[mat.name] = {
      u0: (ox + inset) / W, v0: (oy + inset) / H,
      u1: (ox + TILE - inset) / W, v1: (oy + TILE - inset) / H,
    }
  })
  return { size: { w: W, h: H }, pixels, regions }
}
