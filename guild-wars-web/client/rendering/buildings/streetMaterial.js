import * as THREE from 'three'
import { STONE_GLSL } from './stoneMaterial.js'

// Street and square surface materials. Ground meshes have no UV attribute;
// all tiling is driven by world X/Z position (computed per-fragment so fract()
// tiles correctly across any mesh length without seam/stretch artifacts).
//
//  • Brick — procedural brick courses (mirrors buildings' brickMaterial.js pattern,
//      flattened to the XZ plane), rotated per-mesh to the road segment's own
//      direction so bricks lay with their long axis across the road. One material
//      instance per segment mesh already (see GroundRenderer.js call sites), so the
//      rotation angle is just a uniform — no shared-material baking needed.
//  • Mud          — sample one tile of the shared atlas via onBeforeCompile.
//  • Stone        — procedural Voronoi flagstone, same as building walls but
//      on the flat XZ plane and coloured darker.

const ATLAS_TILE_SCALE = 10.0   // atlas-tile repeats per world unit
const STONE_DENSITY    = 60.0   // doubled (halved physical stone scale)
const STONE_DARKEN     = 0.35
const BRICK_STREET_ASPECT    = 2      // brick long axis : short axis — 1:2
const BRICK_STREET_DENSITY   = 140.0  // bricks (short-axis count) per world unit across the road (doubled — halved physical brick scale)
const BRICK_STREET_VARIATION = 0.05   // ±5% colour jitter per brick

// Procedural brick road surface. `angleRad` is the road segment's own direction
// (atan2(dz,dx) of its run) — 0 for non-directional surfaces (junction fans, squares),
// which just render with bricks aligned to world axes. Base colour is the flat "Brick"
// street colour (STREET_COLORS.Brick) with BRICK_STREET_VARIATION jitter per brick.
function makeBrickStreetMaterial(baseColor, angleRad = 0) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide })
  const r = ((baseColor >> 16) & 255) / 255, g = ((baseColor >> 8) & 255) / 255, b = (baseColor & 255) / 255
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAngle = { value: angleRad }
    shader.uniforms.uScale = { value: new THREE.Vector2(BRICK_STREET_DENSITY / BRICK_STREET_ASPECT, BRICK_STREET_DENSITY) }
    shader.vertexShader = 'varying vec3 vStWP;\nvarying vec3 vLocalNormal;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vStWP = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    ).replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\n  vLocalNormal = objectNormal;',
    )
    const brickFn = `
      float gwHash1(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
      vec3 brickStreetCol(vec2 p){
        float row = floor(p.y);
        float off = mod(row, 2.0) * 0.5;          // running-bond stagger
        vec2 n = floor(vec2(p.x + off, p.y));
        vec2 f = fract(vec2(p.x + off, p.y));
        if (f.x < 0.06 || f.y < 0.12) return vec3(0.08, 0.07, 0.065);   // mortar
        vec3 base = vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)});
        float j = (gwHash1(n) - 0.5) * 2.0 * ${BRICK_STREET_VARIATION.toFixed(4)};
        return clamp(base + j, 0.0, 1.0);
      }
      // Vertical faces (a kerb/edge, should one exist) don't show the paved brick FACE —
      // just the cut edge of the course, a flat cap tone with thin mortar lines where the
      // horizontal face's own joints continue down the side. Mirrors brickMaterial.js's
      // brickCapLines (walls show this on TOP faces; streets show it on the inverse — see
      // brickStreetTri below).
      vec3 brickStreetCapLines(vec2 p){
        vec2 gl = fract(p);
        float line = step(gl.x, 0.05) + step(gl.y, 0.05);
        vec3 cap = vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}) * 0.85;
        vec3 mortar = vec3(0.08, 0.07, 0.065);
        return mix(cap, mortar, clamp(line, 0.0, 1.0));
      }
      // Box-projected per-face pick (LOCAL/OBJECT-space normal — see brickMaterial.js's
      // brickTri for why local, not world). Street meshes are flat (Y-dominant normal)
      // almost everywhere, so this is the SAME rotated-world-XZ projection as before for
      // the common case; only a genuinely vertical face (X/Z-dominant) falls back to
      // cap-lines-only, on whichever in-plane axis plus world Y.
      vec3 brickStreetTri(vec3 wp, vec3 nrm, float angle, vec2 scale){
        vec3 a = abs(nrm);
        if (a.y >= a.x && a.y >= a.z) {
          float ca = cos(angle), sa = sin(angle);
          vec2 rp = vec2(-wp.x * sa + wp.z * ca, wp.x * ca + wp.z * sa) * scale;
          return brickStreetCol(rp);
        }
        vec2 vp = (a.x >= a.z) ? wp.zy : wp.xy;
        return brickStreetCapLines(vp * scale);
      }
    `
    // Rotate world XZ by -uAngle: rp.y (row/short axis, stacks frequently) tracks
    // "along the road"; rp.x (long axis) tracks "across the road" — so each brick's
    // long side spans the road's width, matching real brick-paved roads.
    const apply = `
      diffuseColor.rgb = brickStreetTri(vStWP, vLocalNormal, uAngle, uScale);
    `
    shader.fragmentShader = 'varying vec3 vStWP;\nvarying vec3 vLocalNormal;\nuniform float uAngle;\nuniform vec2 uScale;\n' + brickFn +
      shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + apply)
  }
  mat.customProgramCacheKey = () => `gw-street-brick-proc:${angleRad.toFixed(4)}`
  return mat
}

// World-XZ atlas tile, per-fragment. `region` is {u0,v0,u1,v1} in atlas space.
function makeAtlasStreetMaterial(tex, region, cacheKey, tileScale = ATLAS_TILE_SCALE) {
  const mat = new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRegion    = { value: new THREE.Vector4(region.u0, region.v0, region.u1, region.v1) }
    shader.uniforms.uTileScale = { value: tileScale }
    shader.vertexShader = 'varying vec3 vStWP;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vStWP = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    )
    shader.fragmentShader = 'varying vec3 vStWP;\nuniform vec4 uRegion;\nuniform float uTileScale;\n' +
      shader.fragmentShader.replace('#include <map_fragment>', `
        vec2 tuv = fract(vStWP.xz * uTileScale);
        vec2 auv = mix(uRegion.xy, uRegion.zw, tuv);
        diffuseColor *= texture2D( map, auv );
      `)
  }
  mat.customProgramCacheKey = () => cacheKey
  return mat
}

function makeStoneStreetMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDensity = { value: STONE_DENSITY }
    shader.uniforms.uDarken  = { value: STONE_DARKEN }
    shader.vertexShader = 'varying vec3 vStWP;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vStWP = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    )
    shader.fragmentShader = 'varying vec3 vStWP;\nuniform float uDensity;\nuniform float uDarken;\n' + STONE_GLSL +
      shader.fragmentShader.replace('#include <map_fragment>', `
        diffuseColor.rgb *= stoneCol(vStWP.xz * uDensity) * uDarken;
      `)
  }
  mat.customProgramCacheKey = () => 'gw-street-stone'
  return mat
}

// Return a fresh surface material for the given street type.
// `atlas` is { tex, regions } from the loaded atlas; falls back to flat colour when absent.
// `angleRad` (Brick only) is the road segment's own direction — see makeBrickStreetMaterial.
export function makeStreetMaterial(type, atlas, fallbackColor, tileScale = ATLAS_TILE_SCALE, angleRad = 0) {
  if (type === 'Brick') return makeBrickStreetMaterial(fallbackColor, angleRad)
  // Stone is a pure procedural shader (world-position driven, like Brick) — it never
  // needed the atlas at all. It used to sit inside the atlas-readiness check below,
  // so a square (or street segment) rendered before the atlas finished loading got
  // stuck on a flat untextured fallback colour forever, even after the atlas loaded —
  // the atlas-loaded re-render only fixes Mud (the one type that genuinely needs it).
  if (type === 'Stone') return makeStoneStreetMaterial()
  if (atlas?.tex && atlas?.regions) {
    if (type === 'Mud' && atlas.regions.woodtrim)
      return makeAtlasStreetMaterial(atlas.tex, atlas.regions.woodtrim, 'gw-street-atlas-mud', tileScale)
  }
  return new THREE.MeshStandardMaterial({
    color: fallbackColor, roughness: 0.6, metalness: 0,
    emissive: fallbackColor, emissiveIntensity: 0.5, side: THREE.DoubleSide,
  })
}
