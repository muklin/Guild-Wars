// Shared building catalogue — imported by BOTH the client renderers and the server
// Landmark placer (ADR-0005). The server needs model footprints (width/depth) and the
// per-district Landmark spec to place Landmarks and carve their ground out of plots
// before plots are generated; the client needs the same data to render them. Keeping
// one source of truth avoids the two drifting.

// Building / prop model catalogue. width × depth × height are the measured model
// footprint in model units (offline GLB bbox, node transforms applied), used to
// scale a model to a target plot/footprint without measuring at runtime.
export const MODELS = {
  houses: [
    { name: 'h1',  glbPath: '/resources/Models/h1.glb',  width: 0.255, depth: 0.349, height: 0.403 },
    { name: 'h2',  glbPath: '/resources/Models/h2.glb',  width: 1.458, depth: 1.996, height: 2.302 },
    { name: 'h3',  glbPath: '/resources/Models/h3.glb',  width: 1.458, depth: 1.996, height: 2.913 },
    { name: 'h4',  glbPath: '/resources/Models/h4.glb',  width: 2.366, depth: 1.996, height: 2.913 },
    { name: 'h5',  glbPath: '/resources/Models/h5.glb',  width: 1.224, depth: 1.815, height: 1.622 },
    { name: 'h6',  glbPath: '/resources/Models/h6.glb',  width: 1.928, depth: 1.815, height: 1.622 },
    { name: 'h8',  glbPath: '/resources/Models/h8.glb',  width: 1.600, depth: 1.846, height: 1.991 },
    { name: 'h9',  glbPath: '/resources/Models/h9.glb',  width: 1.590, depth: 1.642, height: 2.907 },
    { name: 'h10', glbPath: '/resources/Models/h10.glb', width: 2.184, depth: 2.474, height: 1.937 },
    { name: 'h11', glbPath: '/resources/Models/h11.glb', width: 1.993, depth: 1.515, height: 1.829 },
    { name: 'h12', glbPath: '/resources/Models/h12.glb', width: 1.590, depth: 1.869, height: 2.009 },
    { name: 'h13', glbPath: '/resources/Models/h13.glb', width: 2.629, depth: 1.194, height: 2.772 },
    { name: 'h14', glbPath: '/resources/Models/h14.glb', width: 1.942, depth: 1.829, height: 1.433 },
    { name: 'h15', glbPath: '/resources/Models/h15.glb', width: 1.939, depth: 1.679, height: 3.037 },
    { name: 'h16', glbPath: '/resources/Models/h16.glb', width: 1.816, depth: 2.816, height: 2.235 },
    { name: 'h17', glbPath: '/resources/Models/h17.glb', width: 1.898, depth: 1.627, height: 1.243 },
    { name: 'h18', glbPath: '/resources/Models/h18.glb', width: 1.690, depth: 1.244, height: 2.374 },
    { name: 'h19', glbPath: '/resources/Models/h19.glb', width: 1.725, depth: 2.306, height: 3.193 },
  ],
  markets: [
    { name: 'm1', glbPath: '/resources/Models/m1.glb', width: 1.283, depth: 1.635, height: 2.865 },
    { name: 'm2', glbPath: '/resources/Models/m2.glb', width: 2.478, depth: 2.924, height: 3.601 },
  ],
  towers: [
    { name: 't1', glbPath: '/resources/Models/t1.glb', width: 1.740, depth: 1.575, height: 4.481 },
    { name: 't2', glbPath: '/resources/Models/t2.glb', width: 1.520, depth: 1.523, height: 4.820 },
    { name: 't3', glbPath: '/resources/Models/t3.glb', width: 2.808, depth: 2.844, height: 7.359 },
    { name: 't4', glbPath: '/resources/Models/t4.glb', width: 1.402, depth: 2.072, height: 3.598 },
    { name: 't5', glbPath: '/resources/Models/t5.glb', width: 2.079, depth: 1.229, height: 4.019 },
  ],
  wells: [
    { name: 'well1', glbPath: '/resources/Models/well1.glb', width: 0.900, depth: 0.848, height: 0.829 },
  ],
  walls: [
    { name: 'wallTower', glbPath: '/resources/Models/wallTower.glb', width: 1.421, depth: 1.421, height: 2.822 },
  ],
  special: [
    { name: 'alchemists', glbPath: '/resources/Models/alchemists.glb', width: 2.325, depth: 1.358, height: 3.156 },
    { name: 'church',     glbPath: '/resources/Models/church.glb',     width: 5.627, depth: 4.958, height: 7.190 },
    { name: 'forge',      glbPath: '/resources/Models/forge.glb',      width: 2.382, depth: 2.515, height: 2.106 },
    { name: 'hall',       glbPath: '/resources/Models/hall.glb',       width: 6.517, depth: 2.272, height: 3.873 },
    { name: 'watchmaker', glbPath: '/resources/Models/watchmaker.glb', width: 2.132, depth: 1.349, height: 2.797 },
    { name: 'waterwheel', glbPath: '/resources/Models/waterwheel.glb', width: 2.322, depth: 2.700, height: 3.139 },
    { name: 'colliseum',  glbPath: '/resources/Models/colliseum.glb',  width: 12.250, depth: 13.232, height: 7.620 },
  ],
}

// Flat lookup: model name → { name, glbPath, width, depth, height }.
export const MODEL_BY_NAME = new Map(Object.values(MODELS).flat().map(m => [m.name, m]))

// Fixed model-unit → world-unit scale. Models are NEVER stretched.
export const MODEL_SCALE = 0.13

// Horizontal bbox-centre offset (model units) for each model. Models are authored
// with their ORIGIN at the "front door", so their geometry sits behind the origin
// (mostly −Z). LandmarkPlacer uses this to project a model's true ground footprint
// (it isn't centred on the placement point), so plots under the whole structure —
// not just its entrance — are cleared. Omitted = (0, 0).
export const MODEL_OFFSET = {
  h2: { x: -0.045, z: -0.791 }, h3: { x: -0.033, z: -0.789 }, h4: { x: 0.421, z: -0.789 },
  h5: { x: -0.035, z: -0.714 }, h6: { x: 0.317, z: -0.714 },
  h8: { x: 0.168, z: -0.591 }, h9: { x: 0.173, z: -0.591 }, h10: { x: -0.260, z: -1.179 },
  h11: { x: -0.468, z: -0.370 }, h12: { x: 0.027, z: -0.659 }, h13: { x: 0.156, z: -0.458 },
  h14: { x: 0.595, z: -0.758 }, h15: { x: -0.258, z: -0.619 }, h16: { x: -0.003, z: -1.297 },
  h17: { x: 0.026, z: -0.703 }, h18: { x: -0.022, z: -0.514 }, h19: { x: 0.066, z: -0.784 },
  m1: { x: -0.034, z: -0.684 }, m2: { x: 0.409, z: -1.259 },
  t1: { x: 0.014, z: -0.713 }, t2: { x: -0.036, z: -0.697 }, t3: { x: -0.013, z: -1.580 },
  t4: { x: -0.028, z: -0.926 }, t5: { x: 0.483, z: -0.319 },
  alchemists: { x: 0.534, z: -0.596 }, church: { x: 1.779, z: -1.707 },
  forge: { x: -0.150, z: -0.988 }, hall: { x: 0.221, z: -1.065 },
  watchmaker: { x: -0.085, z: -0.485 }, waterwheel: { x: -0.416, z: -1.106 },
  colliseum: { x: -0.270, z: -6.648 },
}

// Landmark buildings per district: the special models placed on a district's Square
// clusters (a paved plaza of joined squares). Value = count of that model wanted.
// Placed before plots; plot ground under a Landmark footprint is dropped.
export const DISTRICT_MODEL_SQUARE = {
  'Residential-Slums':  { well1: 6 },
  'Residential-Middle': { well1: 4 },
  'Residential-Noble':  { t2: 2 },
  'Market':             { m1: 2, t4: 2, hall: 1 },
  'Leadership':         { hall: 1 },
  'Religious':          { church: 1 },
  'Magical':            { t2: 2, hall: 1 },
  'Military':           { t3: 2 },
  'Industry':           { t5: 1, hall: 1 },
  'Entertainment':      { colliseum: 1 },
  default:              { },
}

// District → DISTRICT_MODEL_SQUARE key (mirrors BuildingRenderer._districtKey).
export function districtModelKey(d) {
  const t = d?.assignedType
  if (!t) return 'default'
  if (t === 'Residential') return `Residential-${d.residentialClass ?? 'Middle'}`
  if (t === 'Leadership') return 'Leadership'
  return t
}
