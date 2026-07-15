import * as THREE from 'three'

// Procedural Voronoi stone, as GLSL. `stoneCol(vec2)` returns the flagstone colour at
// a 2D position (cells + darkened mortar seams); shared by building walls (triplanar)
// and stone streets (flat ground projection). Pure function of position → deterministic.
export const STONE_GLSL = `
  vec2 hash2(vec2 p){ p = vec2(dot(p, vec2(127.1,311.7)), dot(p, vec2(269.5,183.3))); return fract(sin(p)*43758.5453123); }
  vec3 stoneCol(vec2 x){
    vec2 n = floor(x), f = fract(x); float md = 8.0; vec2 mr; vec2 mg;
    for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){ vec2 g=vec2(float(i),float(j)); vec2 r=g+hash2(n+g)-f; float d=dot(r,r); if(d<md){md=d;mr=r;mg=g;} }
    float edge=8.0;
    for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){ vec2 g=vec2(float(i),float(j)); vec2 r=g+hash2(n+g)-f; vec2 df=r-mr; if(dot(df,df)>1e-4) edge=min(edge, dot(0.5*(mr+r), normalize(df))); }
    float id = fract(sin(dot(n+mg, vec2(12.9898,78.233)))*43758.5453);
    float grey = 0.32 + 0.28*id;
    // Near-black mortar; convex AO — stone darkens at its own edges, brightens at center
    float t = smoothstep(0.0, 0.06, edge);
    float ao = smoothstep(0.0, 0.25, edge);
    float contrast = mix(0.30, 1.18, ao);
    vec3 mortar = vec3(0.05, 0.045, 0.04);
    return mix(mortar, vec3(grey) * contrast, t);
  }
`

// Wall material factory shared by all building walls. Adds, via onBeforeCompile:
//  • a world-position varying (for grime) and, for stone, a LOCAL/OBJECT-space
//    position+normal varying (for the stone pattern itself),
//  • "ground grime" — a green-brown darkening gradient near the ground (world y→0),
//    simulating ambient occlusion + dirt blown onto the wall base,
//  • (stone only) a procedural Voronoi stone pattern, box-projected in LOCAL space —
//    not world space — so a rotated box (e.g. a stone column turned to align with a
//    wall edge) gets one clean, un-blended projection per face instead of world-space
//    triplanar blending two projections together across a now off-axis side face (see
//    brickMaterial.js, which has the same fix and the full rationale).
// Everything is a pure function of position → deterministic across clients.
// `density` (stone Voronoi, now in LOCAL/model units — no /worldScale needed) and
// `grimeHeight` (height over which the ground-grime fades, in WORLD units) are tuned by
// the caller to stay proportional at whatever scale the building renders at.
// `offset` (stone only) shifts the position sampled into the Voronoi noise — two stone
// surfaces at the same position (e.g. a column standing right against a wall) would
// otherwise show the exact same cell pattern; give one of them a nonzero offset so they
// read as physically distinct stone.
export function makeWallMaterial({ map = null, stone = false, density = 6.0, grimeHeight = 1.15, baseY = 0, offset = [0, 0, 0] } = {}) {
  const mat = new THREE.MeshStandardMaterial({ map, color: 0xffffff, roughness: stone ? 0.95 : 0.85, metalness: 0, side: THREE.DoubleSide })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDensity = { value: density }
    shader.uniforms.uStoneOffset = { value: new THREE.Vector3(...offset) }
    let vhead = 'varying float vWorldY;\n' + (stone ? 'varying vec3 vLocalPos;\nvarying vec3 vLocalNormal;\n' : '')
    shader.vertexShader = vhead + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vWorldY = (modelMatrix * vec4(transformed, 1.0)).y;' + (stone ? '\n  vLocalPos = transformed;' : ''),
    )
    if (stone) shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\n  vLocalNormal = objectNormal;',
    )
    const stoneFns = stone ? `
      varying vec3 vLocalPos;
      varying vec3 vLocalNormal;
      ${STONE_GLSL}
      // Box-projected in LOCAL space — see file header. A HARD per-face pick of
      // whichever axis the normal points closest to (not a smooth triplanar BLEND) —
      // a blend smears two projections together on an angled face (a gable that
      // follows the wall's own non-perpendicular line, a sloped Foundation batter, …);
      // a hard pick is always exactly one clean projection, immune to the mesh's own
      // world rotation AND to the face not being perfectly axis-aligned.
      vec3 stoneTri(vec3 p, vec3 nrm){
        vec3 a = abs(nrm);
        if (a.x >= a.y && a.x >= a.z) return stoneCol(p.zy);
        if (a.y >= a.x && a.y >= a.z) return stoneCol(p.xz);
        return stoneCol(p.xy);
      }
    ` : ''
    const gh = grimeHeight.toFixed(5), by = baseY.toFixed(5)
    const apply = (stone ? '  diffuseColor.rgb = stoneTri(vLocalPos * uDensity + uStoneOffset, vLocalNormal);\n' : '') +
      // Ground dirt: darkening over the ground floor, measured UP FROM the building base
      // (baseY) — darkest at the base, fading to nothing at the top of the ground level.
      `  float gGrime = smoothstep(${by}, ${by} + ${gh}, vWorldY);\n` +
      '  diffuseColor.rgb *= mix(0.45, 1.0, gGrime);\n' +
      '  diffuseColor.rgb *= mix(vec3(0.68, 0.62, 0.5), vec3(1.0), gGrime);\n' +
      '  { float hJ = (fract(sin(dot(modelMatrix[3].xz, vec2(127.1,311.7)))*43758.5) - 0.5) * 0.10; diffuseColor.rgb = clamp(diffuseColor.rgb + hJ, 0.0, 1.0); }\n'
    shader.fragmentShader = 'varying float vWorldY;\nuniform float uDensity;\nuniform vec3 uStoneOffset;\n' + stoneFns +
      shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + apply)
  }
  mat.customProgramCacheKey = () => `${stone ? 'gw-wall-stone' : 'gw-wall'}:${grimeHeight.toFixed(5)}:${baseY.toFixed(5)}:${offset.join(',')}`
  return mat
}

export const makeStoneMaterial = (opts) => makeWallMaterial({ ...opts, stone: true })

// Dark plank floor, as GLSL. `woodFloorCol(vec2)` returns the board colour at a 2D
// position — long boards along local Y, dark seams between them, per-board + per-pixel
// grain variation. Pure function of position, same contract as STONE_GLSL.
const WOOD_FLOOR_GLSL = `
  float gwHash1(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  vec3 woodFloorCol(vec2 x){
    float plank = 0.22;
    float n = floor(x.y / plank), within = fract(x.y / plank);
    float seam = step(within, 0.04) + step(0.97, within);
    float id = gwHash1(vec2(n, 1.7));
    float grain = (gwHash1(vec2(floor(x.x * 9.0), n)) - 0.5) * 0.05;
    vec3 base = mix(vec3(0.10, 0.065, 0.045), vec3(0.16, 0.105, 0.07), id) + grain;
    return mix(base, vec3(0.04, 0.025, 0.018), seam);
  }
`

// Floor material — stone (flat Voronoi, reusing STONE_GLSL) or dark wood plank. Sampled
// from a per-vertex `floorSample` attribute (set by ParametricBuilding.js's addFloor),
// NOT raw local/object position — this material is one shared instance reused by every
// floor in the city, so per-WING alignment (each wing can sit at any angle within its
// building's shared model space) has to be baked into the geometry's own vertex data
// rather than driven by a uniform. `density` is in local (pre-PARA_SCALE) model units.
export function makeFloorMaterial({ stone = false, density = 3.0 } = {}) {
  // DoubleSide: addFloor() triangulates the wing's raw vertex order with no explicit
  // winding correction, so the computed face normal can end up pointing down depending
  // on that wing's winding — making the floor invisible from above with FrontSide.
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: stone ? 0.92 : 0.8, metalness: 0, side: THREE.DoubleSide })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDensity = { value: density }
    shader.vertexShader = 'attribute vec2 floorSample;\nvarying vec2 vFloorSample;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vFloorSample = floorSample;',
    )
    const apply = stone
      ? '  diffuseColor.rgb = stoneCol(vFloorSample * uDensity) * 0.85;\n'
      : '  diffuseColor.rgb = woodFloorCol(vFloorSample * uDensity);\n'
    shader.fragmentShader = 'varying vec2 vFloorSample;\nuniform float uDensity;\n' + STONE_GLSL + WOOD_FLOOR_GLSL +
      shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + apply)
  }
  mat.customProgramCacheKey = () => `gw-floor:${stone ? 'stone' : 'wood'}:${density}`
  return mat
}
