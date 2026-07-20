import * as THREE from 'three'

// Procedural roof material factory.
// All types use local-space position + surface normal to align patterns to the roof slope.
// `makeRoofMaterial(type, hexColor)` — type: 'slate' | 'thatch' | 'reed'
export function makeRoofMaterial(type, hexColor) {
  if (type === 'thatch' || type === 'reed') return _makeThatch(type)
  return _makeSlate(hexColor ?? 0x7a8d95)
}

// ── Slate / roof tiles ───────────────────────────────────────────────────────
// Tiles are asymmetric: even anchor row at the TOP (tucked under the tile above),
// per-tile varying length + slight angled cut at the BOTTOM. Each tile's exposed
// lower lip has a strong highlight (the thick stone edge facing out), with near-
// black shadow in the gap beneath. The tile face darkens gently toward the top,
// simulating the shadow cast by the tile in the row above.
function _makeSlate(hexColor) {
  const color = new THREE.Color(hexColor)
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, side: THREE.DoubleSide })

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSlateColor = { value: new THREE.Vector3(color.r, color.g, color.b) }

    shader.vertexShader = 'varying vec3 vRoofLocalPos;\nvarying vec3 vRoofLocalNorm;\nvarying vec2 vModelXZ;\n' +
      shader.vertexShader
        .replace('#include <begin_vertex>',     '#include <begin_vertex>\n  vRoofLocalPos  = transformed;\n  vModelXZ = modelMatrix[3].xz;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vRoofLocalNorm = objectNormal;')

    const fn = `
      float gwHashS(vec2 p){ return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453); }

      vec3 slateColor(vec3 lp, vec3 ln, vec3 base){
        vec3 N  = normalize(ln);
        float horiz = length(N.xz);
        // Flat cap (ridge/hip): simple mortar grid in XZ
        if(horiz < 0.08){
          vec2 g = fract(lp.xz * 3.5);
          float line = step(g.x, 0.07) + step(g.y, 0.08);
          return mix(base * 0.7, vec3(0.03,0.03,0.04), clamp(line,0.0,1.0));
        }
        // Surface-aligned basis: eave (horizontal) and slope (up-roof)
        vec3 up    = vec3(0.0,1.0,0.0);
        vec3 eave  = normalize(cross(N, up));
        vec3 slope = normalize(cross(eave, N));

        float tU = dot(lp, eave)  * 3.5;
        float tV = dot(lp, slope) * 3.5;

        float row     = floor(tV);
        float stagger = mod(row, 2.0) * 0.5;
        vec2  cell    = vec2(floor(tU + stagger), row);
        float fu      = fract(tU + stagger);  // 0..1 across tile width
        float fv      = fract(tV);            // 0=row bottom, 1=row top

        // Thin side joints between tiles (even, constant along the row)
        if(fu < 0.04 || fu > 0.96) return vec3(0.03, 0.03, 0.04);

        // Per-tile varying bottom edge — anchored at top, irregular cut at bottom
        float r1 = gwHashS(cell);
        float r2 = gwHashS(cell + vec2(13.7, 7.3));
        float tileLen   = 0.68 + r1 * 0.20;                              // 68-88% of row height
        float tilt      = (gwHashS(cell + vec2(5.1, 3.7)) - 0.5) * 0.12; // ±6% angled cut
        float bottomCut = clamp((1.0 - tileLen) + tilt * (fu - 0.5), 0.02, 0.45);

        // Near-black shadow in the gap beneath the tile
        if(fv < bottomCut) return vec3(0.02, 0.02, 0.025);

        // Clean mortar at the fixed top anchor row
        if(fv > 0.93) return vec3(0.03, 0.03, 0.04);

        // Normalized position within the visible tile face (0=bottom lip, 1=near top)
        float tFace = (fv - bottomCut) / max(0.93 - bottomCut, 0.01);

        // Strong highlight at the exposed bottom lip (the thick tile edge catches light)
        float lip = smoothstep(0.25, 0.0, tFace) * 0.90;

        // Tile face darkens toward top (shadow cast by the tile in the row above)
        float topShadow = smoothstep(0.25, 1.0, tFace) * 0.42;

        float jitter = (r1 - 0.5) * 0.14;
        vec3 col = base;
        col.b += r2 * 0.05 - 0.025;
        col = clamp(col, 0.0, 1.0);

        return clamp(col * ((0.55 + jitter) + lip - topShadow), 0.0, 1.0);
      }
    `

    shader.fragmentShader =
      'varying vec3 vRoofLocalPos;\nvarying vec3 vRoofLocalNorm;\nvarying vec2 vModelXZ;\nuniform vec3 uSlateColor;\n' +
      fn + '\n' +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        '#include <map_fragment>\n  diffuseColor.rgb = slateColor(vRoofLocalPos, vRoofLocalNorm, uSlateColor);\n' +
        '  { float hJ = (fract(sin(dot(vModelXZ, vec2(127.1,311.7)))*43758.5) - 0.5) * 0.10; diffuseColor.rgb = clamp(diffuseColor.rgb + hJ, 0.0, 1.0); }\n'
      )
  }
  mat.customProgramCacheKey = () => `gw-slate:${hexColor}`
  return mat
}

// ── Thatch / Reed ────────────────────────────────────────────────────────────
// Stacked horizontal strand bands aligned to the roof slope.
// Per-band displacement via value noise gives organic, non-straight band edges.
// Shadow darkening at the bottom of each band (underside in shadow), slight highlight
// at the top (exposed to light). Fine strand noise within each band for texture.
function _makeThatch(type) {
  const isReed = type === 'reed'
  // Thatch: warm straw gold-brown. Reed: slightly cooler, more greenish.
  const baseHex = isReed ? 0x888a60 : 0x9a8a55
  const color = new THREE.Color(baseHex)
  const bandScale = isReed ? 8.5 : 5.5   // bands per local unit (reed = tighter, finer)

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, metalness: 0, side: THREE.DoubleSide })

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uThatchColor = { value: new THREE.Vector3(color.r, color.g, color.b) }
    shader.uniforms.uBandScale   = { value: bandScale }

    shader.vertexShader = 'varying vec3 vRoofLocalPos;\nvarying vec3 vRoofLocalNorm;\n' +
      shader.vertexShader
        .replace('#include <begin_vertex>',     '#include <begin_vertex>\n  vRoofLocalPos  = transformed;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vRoofLocalNorm = objectNormal;')

    const fn = `
      float gwHashT(vec2 p){ return fract(sin(dot(p,vec2(37.1,311.7)))*91745.2341); }
      float gwNoiseT(vec2 p){
        vec2 i=floor(p), f=fract(p);
        float a=gwHashT(i), b=gwHashT(i+vec2(1,0)), c=gwHashT(i+vec2(0,1)), d=gwHashT(i+vec2(1,1));
        vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
      }

      vec3 thatchColor(vec3 lp, vec3 ln, vec3 base, float bScale){
        vec3 N = normalize(ln);
        float horiz = length(N.xz);
        if(horiz < 0.08) return base * 0.55;
        vec3 up    = vec3(0.0,1.0,0.0);
        vec3 eave  = normalize(cross(N, up));
        vec3 slope = normalize(cross(eave, N));

        float tU = dot(lp, eave)  * bScale;
        float tV = dot(lp, slope) * bScale;

        float band = floor(tV);
        // Organic band edges: displace tV by noise based on U position and band index
        float disp = (gwNoiseT(vec2(tU*0.35 + band*0.31, band*0.73)) - 0.5) * 0.55;
        float fv   = fract(tV + disp);

        // Shadow at band bottom (underside of each layer catches no direct light)
        float shadow    = smoothstep(0.0, 0.28, fv);     // 0=darkest, ramps up quickly
        float highlight = smoothstep(0.55, 0.90, fv);    // slight brightness near top of each strand

        // Fine strand texture within the band
        float strandFreq = bScale * 0.28;
        float strand = gwNoiseT(vec2(tU * strandFreq + band * 0.5, fv * 2.8)) * 0.14;

        // Per-band brightness wobble
        float bandBright = 0.82 + gwHashT(vec2(band, 1.0)) * 0.26;

        float val = shadow * (0.58 + highlight * 0.42 + strand) * bandBright;
        return clamp(base * val, 0.0, 1.0);
      }
    `

    shader.fragmentShader =
      'varying vec3 vRoofLocalPos;\nvarying vec3 vRoofLocalNorm;\nuniform vec3 uThatchColor;\nuniform float uBandScale;\n' +
      fn + '\n' +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        '#include <map_fragment>\n  diffuseColor.rgb = thatchColor(vRoofLocalPos, vRoofLocalNorm, uThatchColor, uBandScale);\n'
      )
  }
  mat.customProgramCacheKey = () => `gw-thatch:${type}`
  return mat
}
