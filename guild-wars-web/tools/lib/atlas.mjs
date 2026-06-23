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

// Flat bright magenta — marks an atlas slot with no consumer, so free slots are obvious
// at a glance instead of silently wasting atlas space.
function unused(px, W, ox, oy, T) {
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) put(px, W, ox + x, oy + y, 255, 0, 255)
}
// Periodic patterns below use periods that evenly divide TILE (64) so the tile wraps
// seamlessly under the streets/walls shaders' fract()-based repeat — a period that
// doesn't divide TILE leaves a visible seam where the tile re-starts.
function brick(px, W, ox, oy, T) {
  const bH = 8, bW = 16
  for (let y = 0; y < T; y++) { const row = Math.floor(y / bH), hM = (y % bH) === 0, off = (row % 2) * (bW / 2)
    for (let x = 0; x < T; x++) { const vM = ((x + off) % bW) === 0
      if (hM || vM) put(px, W, ox + x, oy + y, 112, 95, 76)
      else { let s = ((row * 97 + Math.floor((x + off) / bW)) * 1234567) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 28 - 14; put(px, W, ox + x, oy + y, 178 + v, 88 + v * 0.5, 58 + v * 0.3) }
    } }
}
function plaster(px, W, ox, oy, T) {
  // Flat plaster — no baked edge-darkening. Contact shadows next to posts/beams are
  // applied separately (as geometry/shading), not baked into the tile.
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    let s = ((y * T + x + 1) * 6271 + 99991) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 22 - 11
    put(px, W, ox + x, oy + y, 216 + v, 206 + v, 191 + v)
  }
}
// Shared board-plank texture: boards of `period` px (incl. a 1px gap) running either
// horizontally or vertically. Grain streaks are fixed per (board, position-across-the-
// board) so they run the FULL LENGTH of each board unbroken — real wood grain follows the
// board, not across it. No per-board blotches (knots): on a 64px tile a knot would land
// in the same spot every repeat and read as an obvious stamp, so grain stays linear streaks
// plus fine high-frequency noise only.
function plankTexture(px, W, ox, oy, T, period, vertical, gapColor, boardColorFn) {
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const along = vertical ? y : x, across = vertical ? x : y
      if ((across % period) < 1) { put(px, W, ox + x, oy + y, ...gapColor); continue }
      const board = Math.floor(across / period), within = across % period
      let s1 = ((board * 9176 + within * 6271) * 2246822519) >>> 0; s1 ^= s1 << 13; s1 ^= s1 >>> 17; s1 ^= s1 << 5
      const streak = ((s1 >>> 0) / 4294967296) * 2 - 1                     // per-column grain streak, constant along the board
      let s2 = ((board * 733 + within * 97 + along * 131) * 2654435761) >>> 0; s2 ^= s2 << 13; s2 ^= s2 >>> 17; s2 ^= s2 << 5
      const fine = ((s2 >>> 0) / 4294967296) * 2 - 1                       // tiny per-pixel grain texture
      put(px, W, ox + x, oy + y, ...boardColorFn(board, streak * 5 + fine))
    }
  }
}
function wood(px, W, ox, oy, T) {   // horizontal weatherboard; grain runs along the boards (x)
  const pal = [[155, 114, 71], [148, 109, 66], [161, 120, 77], [151, 111, 69]]   // narrower board-to-board spread
  plankTexture(px, W, ox, oy, T, 8, false, [72, 52, 32], (board, v) => {
    const b = pal[board % pal.length]
    return [b[0] + v, b[1] + v, b[2] + v]
  })
}
// Shared straw-bundle base for thatch/reed: horizontal noisy rows. The band uses an
// integer number of cycles over T so it wraps seamlessly; `colorFn(band, v)` → [r,g,b].
function strawRows(px, W, ox, oy, T, cycles, colorFn) {
  const omega = (2 * Math.PI * cycles) / T
  for (let y = 0; y < T; y++) { const band = Math.sin(y * omega) * 8
    for (let x = 0; x < T; x++) { let s = ((x * 71 + y * 911) * 2654435761) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      const v = ((s >>> 0) / 4294967296) * 30 - 10
      const [r, g, b] = colorFn(band, v)
      put(px, W, ox + x, oy + y, r, g, b) } }
}
function thatch(px, W, ox, oy, T) {   // straw: golden-brown
  strawRows(px, W, ox, oy, T, 8, (band, v) => [150 + band + v, 120 + band + v * 0.8, 60 + v * 0.5])
}
function reed(px, W, ox, oy, T) {      // same straw bundles, weathered dark grey (verge bundles)
  strawRows(px, W, ox, oy, T, 8, (band, v) => { const g = 72 + band * 0.75 + v * 0.73; return [g, g + 2, g + 5] })
}
function slate(px, W, ox, oy, T) {     // overlapping shingle courses, blue-grey, shadowed under each course's overlap
  const ch = 8, tw = 16
  for (let y = 0; y < T; y++) { const row = Math.floor(y / ch), within = y % ch, off = (row % 2) * (tw / 2)
    // Texture row 0 (within=0) maps to the RIDGE-side edge of each course (see addBuildingRoof's
    // quadTris(ridge,...,eave) → ridge=uv.v0). That edge sits UNDER the course above, so it's
    // shadowed: darker at within=0, lightening toward the exposed eave-side edge (within=ch-1).
    const shade = -9 + (within / ch) * 18
    for (let x = 0; x < T; x++) { const edge = (x + off) % tw < 1
      let s = ((row * 313 + Math.floor((x + off) / tw)) * 6271) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const v = ((s >>> 0) / 4294967296) * 16 - 8
      if (edge) put(px, W, ox + x, oy + y, 46, 50, 56)
      else put(px, W, ox + x, oy + y, 92 + v + shade, 98 + v + shade, 110 + v + shade) } }
}
function glass(px, W, ox, oy, T) {     // leaded panes, blue-grey, one light streak crossing a few panes
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
function doorwood(px, W, ox, oy, T) {  // dark VERTICAL planks (door / shutters); grain runs along the planks (y)
  plankTexture(px, W, ox, oy, T, 8, true, [44, 30, 18], (board, v) => [80 + v, 53 + v, 32 + v])
}

function granite(px, W, ox, oy, T) { // hewn granite: dark rectangular blocks, rough surface
  const bH = 8, bW = 16
  for (let y = 0; y < T; y++) {
    const row = Math.floor(y / bH), hM = (y % bH) < 1, off = (row % 2) * (bW / 2)
    for (let x = 0; x < T; x++) {
      const vM = ((x + off) % bW) < 1
      if (hM || vM) { put(px, W, ox + x, oy + y, 22, 22, 24); continue }
      let s = ((row * 97 + Math.floor((x + off) / bW)) * 1234567) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      const v = ((s >>> 0) / 4294967296) * 18 - 9
      put(px, W, ox + x, oy + y, 42 + v, 42 + v, 46 + v)
    }
  }
}

// 'stone' and 'timber' have no consumer (stone walls render via the procedural Voronoi
// shader, never this tile; timber is referenced nowhere) — painted bright magenta via
// `unused` so they read as free slots at a glance. Names kept as-is since buildPartKit.mjs
// still looks up `R.stone` for the panel-stone part (its material is swapped before the
// atlas pixels would ever show). Repaint with a real texture to reclaim a slot.
const MATERIALS = [
  { name: 'stone', paint: unused }, { name: 'brick', paint: brick }, { name: 'timber', paint: unused },
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
