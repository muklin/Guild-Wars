// Single source of truth for every per-district-TYPE tunable in the game: street/
// block/plot generation parameters, parametric building style + GLB model weights,
// townhouse probability, square landmark buildings, and the UI/map colour. Used by
// BOTH server (generation) and client (rendering) code — see shared/buildingCatalogue.js
// for the same cross-import pattern (ADR-0005).
//
// Formerly five separate tables that had drifted into three different key schemes:
//   - DISTRICT_PARAMETERS  (server/engine/CityGenerator/StreetVoronoiGenerator.js)
//   - DISTRICT_BUILDING_STYLES (client/rendering/utils/BuildingRenderer.js)
//   - TOWNHOUSE_PROB       (server/engine/SetupPhase.js)
//   - DISTRICT_MODEL_SQUARE (shared/buildingCatalogue.js)
//   - DISTRICT_COLORS      (client/rendering/DistrictRenderer.js)
// Now ONE object per district, with every one of those tables' fields nested under it,
// so a district's whole profile is editable in one place. Leadership is split by ruling-
// body subclass everywhere now too (previously only DISTRICT_PARAMETERS did this; the
// others just had one shared 'Leadership' entry, which is what's been copied across all
// six subclasses below as a starting point — tune them apart freely).
//
// Keys: 'Residential-Slums' / '-Middle' / '-Noble', 'Leadership-Monarchy' / '-Republic' /
// '-Tyrant' / '-Oligarchy' / '-Theocracy' / '-Anarchist', 'Market', 'Religious',
// 'Magical', 'Military', 'Industry', 'Entertainment'. Use districtConfigKey(district) to
// resolve a live district object ({assignedType, residentialClass, LeadershipClass}) to
// its key, and getDistrictConfig(district) to look it up (falling back to DEFAULTS).
//
// Per-district fields:
//   color          UI/map hex colour (DistrictRenderer, GroundRenderer, faction panels).
//   params         Street/block/plot generation tuning — see the field-by-field
//                  breakdown below (was DISTRICT_PARAMETERS).
//     street_width      Street half-width factor (1.0 = StreetVoronoiGenerator's
//                  STREET_HALF_WIDTH baseline). See halfWidthForDistrict().
//     street_spacing    Spacing (world units) of street seeds sampled along the
//                  district boundary; also sets interior-seed clearance. Smaller →
//                  denser boundary-following streets.
//     block_density     Interior street seeds per unit area. Higher → smaller blocks.
//     xyRatio       Interior grid column/row spacing ratio: 1 = square blocks.
//     jitter        Max interior-seed displacement as a fraction of grid spacing.
//     metric        Voronoi cell-vertex style: 'euclidean' / 'manhattan' / 'chebyshev'
//                  / 'centroid'.
//     square_threshhold  Block area below which it becomes a paved 'square' instead
//                  of being subdivided into plots.
//     plotSpacing       Spacing (world units) of plot seeds along a block perimeter.
//     minPlotSize       Minimum plot area.
//   townhouseProb  Probability (0..1) a non-square block becomes a townhouse block.
//   landmarks      { modelName: count } — special models placed on this district's
//                  Square clusters before plots (was DISTRICT_MODEL_SQUARE).
//   buildingStyle  Parametric building probability distributions + GLB model weights
//                  for freestanding/custom slots (was DISTRICT_BUILDING_STYLES):
//     floors            Weighted floor-count options.
//     woodChance        Probability a nonstone wall material is wood (vs plaster).
//     stoneChance       Probability the ground floor uses stone (upper floors always
//                  nonstone).
//     graniteChance     Probability a stone wall is granite (vs regular stone/brick).
//     brickChance       Probability a stone wall is brick (vs regular stone), after
//                  granite.
//     roof          Relative roof-material weights; order is the tiebreak.
//     overhangMin/Max   World-unit eave overhang range.
//     wingDepths        Bay-count options for townhouse wing depth (repeat = weight).
//     floorOptions      Floor-count options for townhouse wings (repeat = weight).
//     modelWeights      GLB models eligible for this district's freestanding/custom
//                  slots, and their relative weight (absent/0 = never).
export const DISTRICTS = {
  'Residential-Slums': {
    color: 0xa08860,
    params: { street_width: 0.8, street_spacing: 0.5, block_density: 3.0, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.05, plotSpacing: 0.15, minPlotSize: 0.025 },
    townhouseProb: 0.95,
    landmarks: { well1: 6 },
    buildingStyle: {
      floors: { 1: 1.00 },
      woodChance: 0.75, stoneChance: 0.05, graniteChance: 0.00, brickChance: 0.00,
      roof: { thatch: 0.70, reed: 0.25, slate: 0.05 },
      overhangMin: 0.06, overhangMax: 0.20,
      wingDepths: [2, 2, 2, 3],
      floorOptions: [1, 1, 2],
      modelWeights: { h10: 2, h11: 2, h8: 2, h9: 1, h14: 3, h17: 3, t5: 1, t1: 1 },
    },
  },
  'Residential-Middle': {
    color: 0xFFF385,
    params: { street_width: 1.2, street_spacing: 1.0, block_density: 2.0, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.1, plotSpacing: 0.2, minPlotSize: 0.025 },
    townhouseProb: 0.95,
    landmarks: { well1: 4 },
    buildingStyle: {
      floors: { 1: 0.45, 2: 0.55 },
      woodChance: 0.50, stoneChance: 0.35, graniteChance: 0.15, brickChance: 0.12,
      roof: { thatch: 0.45, slate: 0.35, reed: 0.20 },
      overhangMin: 0.12, overhangMax: 0.42,
      wingDepths: [2, 4, 4, 5],
      floorOptions: [1, 3],
      modelWeights: { h8: 3, h9: 3, t5: 1, t2: 1, h2: 2, h3: 1, h4: 1, h5: 2, h6: 2, h13: 2 },
    },
  },
  'Residential-Noble': {
    color: 0x9C62CC,
    params: { street_width: 2.0, street_spacing: 0.5, block_density: 1.0, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.3, plotSpacing: 0.5, minPlotSize: 0.07 },
    townhouseProb: 0.95,
    landmarks: { t2: 2 },
    buildingStyle: {
      floors: { 2: 0.65, 3: 0.35 },
      woodChance: 0.20, stoneChance: 0.80, graniteChance: 0.25, brickChance: 0.10,
      roof: { slate: 0.72, reed: 0.18, thatch: 0.10 },
      overhangMin: 0.22, overhangMax: 0.48,
      wingDepths: [3, 6, 6, 8],
      floorOptions: [2, 3],
      modelWeights: { h8: 1, h9: 1, t2: 1, h3: 1, h4: 1, h5: 1, h6: 1, h13: 2, m2: 2, h16: 2, h18: 2, h19: 2 },
    },
  },
  'Leadership-Monarchy': {
    color: 0xdaa520,
    params: { street_width: 1.2, street_spacing: 1.0, block_density: 2.0, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.3, plotSpacing: 0.2, minPlotSize: 0.025 },
    townhouseProb: 0.85,
    landmarks: { hall: 1 },
    buildingStyle: {
      floors: { 1: 0.45, 2: 0.55 },
      woodChance: 0.50, stoneChance: 0.35, graniteChance: 0.15, brickChance: 0.12,
      roof: { thatch: 0.45, slate: 0.35, reed: 0.20 },
      overhangMin: 0.12, overhangMax: 0.42,
      wingDepths: [2, 3, 3, 5],
      floorOptions: [1, 3],
      modelWeights: { m2: 3, h8: 1, h9: 1, t2: 1, h3: 1, h4: 1, h5: 1, h6: 1, h13: 2, h16: 2, h18: 2, h19: 2 },
    },
  },
  'Leadership-Republic': {
    color: 0x2878b5,
    params: { street_width: 2.0, street_spacing: 1.0, block_density: 2.0, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.3, plotSpacing: 0.2, minPlotSize: 0.025 },
    townhouseProb: 0.85,
    landmarks: { hall: 1 },
    buildingStyle: {
      floors: { 1: 0.45, 2: 0.55 },
      woodChance: 0.50, stoneChance: 0.35, graniteChance: 0.15, brickChance: 0.12,
      roof: { thatch: 0.45, slate: 0.35, reed: 0.20 },
      overhangMin: 0.12, overhangMax: 0.42,
      wingDepths: [2, 3, 3, 5],
      floorOptions: [1, 3],
      modelWeights: { m2: 3, h8: 1, h9: 1, t2: 1, h3: 1, h4: 1, h5: 1, h6: 1, h13: 2, h16: 2, h18: 2, h19: 2 },
    },
  },
  'Leadership-Tyrant': {
    color: 0x8b1515,
    params: { street_width: 1.8, street_spacing: 0.5, block_density: 1.0, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.4, plotSpacing: 0.3, minPlotSize: 0.04 },
    townhouseProb: 0.85,
    landmarks: { hall: 1 },
    buildingStyle: {
      floors: { 1: 0.45, 2: 0.55 },
      woodChance: 0.50, stoneChance: 0.35, graniteChance: 0.15, brickChance: 0.12,
      roof: { thatch: 0.45, slate: 0.35, reed: 0.20 },
      overhangMin: 0.12, overhangMax: 0.42,
      wingDepths: [2, 3, 3, 5],
      floorOptions: [1, 3],
      modelWeights: { m2: 3, h8: 1, h9: 1, t2: 1, h3: 1, h4: 1, h5: 1, h6: 1, h13: 2, h16: 2, h18: 2, h19: 2 },
    },
  },
  'Leadership-Oligarchy': {
    color: 0x4b7c59,
    params: { street_width: 2.0, street_spacing: 1.0, block_density: 2.0, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.3, plotSpacing: 0.2, minPlotSize: 0.025 },
    townhouseProb: 0.85,
    landmarks: { hall: 1 },
    buildingStyle: {
      floors: { 1: 0.45, 2: 0.55 },
      woodChance: 0.50, stoneChance: 0.35, graniteChance: 0.15, brickChance: 0.12,
      roof: { thatch: 0.45, slate: 0.35, reed: 0.20 },
      overhangMin: 0.12, overhangMax: 0.42,
      wingDepths: [2, 3, 3, 5],
      floorOptions: [1, 3],
      modelWeights: { m2: 3, h8: 1, h9: 1, t2: 1, h3: 1, h4: 1, h5: 1, h6: 1, h13: 2, h16: 2, h18: 2, h19: 2 },
    },
  },
  'Leadership-Theocracy': {
    color: 0xd4c17f,
    params: { street_width: 1.2, street_spacing: 0.5, block_density: 1.5, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.5, plotSpacing: 0.2, minPlotSize: 0.025 },
    townhouseProb: 0.85,
    landmarks: { hall: 1 },
    buildingStyle: {
      floors: { 1: 0.45, 2: 0.55 },
      woodChance: 0.50, stoneChance: 0.35, graniteChance: 0.15, brickChance: 0.12,
      roof: { thatch: 0.45, slate: 0.35, reed: 0.20 },
      overhangMin: 0.12, overhangMax: 0.42,
      wingDepths: [2, 3, 3, 5],
      floorOptions: [1, 3],
      modelWeights: { m2: 3, h8: 1, h9: 1, t2: 1, h3: 1, h4: 1, h5: 1, h6: 1, h13: 2, h16: 2, h18: 2, h19: 2 },
    },
  },
  'Leadership-Anarchist': {
    color: 0xcc4400,
    params: { street_width: 1.0, street_spacing: 0.5, block_density: 3.0, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.05, plotSpacing: 0.15, minPlotSize: 0.025 },
    townhouseProb: 0.85,
    landmarks: { hall: 1 },
    buildingStyle: {
      floors: { 1: 0.45, 2: 0.55 },
      woodChance: 0.50, stoneChance: 0.35, graniteChance: 0.15, brickChance: 0.12,
      roof: { thatch: 0.45, slate: 0.35, reed: 0.20 },
      overhangMin: 0.12, overhangMax: 0.42,
      wingDepths: [2, 3, 3, 5],
      floorOptions: [1, 3],
      modelWeights: { m2: 3, h8: 1, h9: 1, t2: 1, h3: 1, h4: 1, h5: 1, h6: 1, h13: 2, h16: 2, h18: 2, h19: 2 },
    },
  },
  Market: {
    color: 0xffd700,
    params: { street_width: 1.0, street_spacing: 1.0, block_density: 2.0, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.3, plotSpacing: 0.2, minPlotSize: 0.025 },
    townhouseProb: 0.85,
    landmarks: { m1: 2, t4: 2, hall: 1 },
    buildingStyle: {
      floors: { 1: 1.00 },
      woodChance: 0.75, stoneChance: 0.05, graniteChance: 0.00, brickChance: 0.00,
      roof: { thatch: 0.70, reed: 0.25, slate: 0.05 },
      overhangMin: 0.06, overhangMax: 0.20,
      wingDepths: [2, 2, 2, 3],
      floorOptions: [2, 2, 4],
      modelWeights: { m1: 3, m2: 1, h8: 1, h9: 1, t5: 1, t2: 1, h2: 2, h3: 1, h4: 2, h5: 2, h6: 2, h13: 2, h16: 3, h18: 3, h19: 3, watchmaker: 2 },
    },
  },
  Religious: {
    color: 0xffff00,
    params: { street_width: 1.2, street_spacing: 0.5, block_density: 1.5, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.5, plotSpacing: 0.2, minPlotSize: 0.025 },
    townhouseProb: 0.85,
    landmarks: { church: 1 },
    buildingStyle: {
      floors: { 1: 0.45, 2: 0.55 },
      woodChance: 0.50, stoneChance: 0.35, graniteChance: 0.15, brickChance: 0.12,
      roof: { thatch: 0.45, slate: 0.35, reed: 0.20 },
      overhangMin: 0.12, overhangMax: 0.42,
      wingDepths: [3, 3, 4, 5],
      floorOptions: [1, 3],
      modelWeights: { m1: 3, m2: 1, h8: 1, h9: 1, t5: 1, t2: 1, h2: 2, h3: 1, h4: 2, h5: 2, h6: 2, h13: 2, h16: 3, h18: 3, h19: 3 },
    },
  },
  Magical: {
    color: 0xc39bef,
    params: { street_width: 1.0, street_spacing: 0.6, block_density: 2.0, xyRatio: 1.0, metric: 'centroid', square_threshhold: 0.25, plotSpacing: 0.15, minPlotSize: 0.025 },
    townhouseProb: 0.85,
    landmarks: { t2: 2, hall: 1 },
    buildingStyle: {
      floors: { 1: 1.00 },
      woodChance: 0.75, stoneChance: 0.05, graniteChance: 0.00, brickChance: 0.00,
      roof: { thatch: 0.70, reed: 0.25, slate: 0.05 },
      overhangMin: 0.06, overhangMax: 0.20,
      wingDepths: [2, 2, 2, 3],
      floorOptions: [2, 3, 5],
      modelWeights: { h16: 3, h18: 3, h19: 3, alchemists: 2, t19: 5, watchmaker: 2 },
    },
  },
  Military: {
    color: 0x8b0000,
    params: { street_width: 2.0, street_spacing: 0.5, block_density: 1.0, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.4, plotSpacing: 0.3, minPlotSize: 0.04 },
    townhouseProb: 0.85,
    landmarks: { t3: 2 },
    buildingStyle: {
      floors: { 2: 0.65, 3: 0.35 },
      woodChance: 0.20, stoneChance: 0.80, graniteChance: 0.25, brickChance: 0.10,
      roof: { slate: 0.72, reed: 0.18, thatch: 0.10 },
      overhangMin: 0.22, overhangMax: 0.48,
      wingDepths: [3, 4, 8],
      floorOptions: [2, 3],
      modelWeights: { h11: 2, h13: 2, h6: 2, forge: 2, alchemists: 1 },
    },
  },
  Industry: {
    color: 0xbdb76b,
    params: { street_width: 1.2, street_spacing: 1.2, block_density: 1.0, xyRatio: 1.0, metric: 'manhattan', square_threshhold: 0.05, plotSpacing: 0.3, minPlotSize: 0.04 },
    townhouseProb: 0.85,
    landmarks: { t5: 1, hall: 1 },
    buildingStyle: {
      floors: { 1: 0.45, 2: 0.55 },
      woodChance: 0.50, stoneChance: 0.35, graniteChance: 0.15, brickChance: 0.12,
      roof: { thatch: 0.45, slate: 0.35, reed: 0.20 },
      overhangMin: 0.12, overhangMax: 0.42,
      wingDepths: [3],
      floorOptions: [4, 6],
      modelWeights: { t5: 3, h10: 2, h11: 2, alchemists: 3, forge: 3 },
    },
  },
  Entertainment: {
    color: 0xff69b4,
    params: { street_width: 1.2, street_spacing: 0.5, block_density: 2.0, xyRatio: 1.0, metric: 'centroid', square_threshhold: 0.5, plotSpacing: 0.15, minPlotSize: 0.04 },
    townhouseProb: 0.85,
    landmarks: { colliseum: 1 },
    buildingStyle: {
      floors: { 1: 0.45, 2: 0.55 },
      woodChance: 0.50, stoneChance: 0.35, graniteChance: 0.15, brickChance: 0.12,
      roof: { thatch: 0.45, slate: 0.35, reed: 0.20 },
      overhangMin: 0.12, overhangMax: 0.42,
      wingDepths: [2, 3, 3, 8],
      floorOptions: [1, 3],
      modelWeights: { h8: 2, h9: 2, t5: 2, h15: 1 },
    },
  },
}

// Fallback for unknown / null / unassigned districts. Guarantees every field is
// present so consumers never read undefined.
export const DEFAULTS = {
  color: 0xDAD2AC,   // matches DistrictRenderer's old DISTRICT_COLORS.Neutral
  params: { street_spacing: 1.0, block_density: 1.0, xyRatio: 1.0, jitter: 0.0, metric: 'manhattan', square_threshhold: 0.1, plotSpacing: 0.2 },
  townhouseProb: 0.85,
  landmarks: {},
  buildingStyle: {
    floors: { 1: 0.50, 2: 0.50 },
    woodChance: 0.50, stoneChance: 0.32, graniteChance: 0.18, brickChance: 0.12,
    roof: { slate: 0.40, thatch: 0.32, reed: 0.28 },
    overhangMin: 0.14, overhangMax: 0.48,
    wingDepths: [2, 3, 4, 5],
    floorOptions: [1, 2],
    modelWeights: {},   // empty -> every model eligible
  },
}

// Resolve a live district object ({assignedType, residentialClass, LeadershipClass})
// to its DISTRICTS key. Residential and Leadership are both split by sub-class — note
// they live in different fields (residentialClass vs LeadershipClass). Returns null for
// an unassigned/untyped district (no assignedType yet).
export function districtConfigKey(district) {
  const type = district?.assignedType
  if (!type) return null
  if (type === 'Residential') return `Residential-${district.residentialClass ?? 'Middle'}`
  if (type === 'Leadership') return `Leadership-${district.LeadershipClass ?? 'Monarchy'}`
  return type
}

// Look up a district's full config, falling back to DEFAULTS for anything unassigned
// or not in the table.
export function getDistrictConfig(district) {
  const key = districtConfigKey(district)
  return (key && DISTRICTS[key]) || DEFAULTS
}
