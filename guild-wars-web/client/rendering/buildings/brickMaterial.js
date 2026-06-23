import * as THREE from 'three'

// Procedural brick wall, as a material factory (mirrors stoneMaterial.js's pattern):
// position driven (no UV needed, never stretches/repeats visibly across any mesh size),
// staggered coursing with mortar lines, each brick colored from a weighted palette and
// jittered within that color's own random range — "bricks of different greyscale" when
// the palette is built from greys, but any hex colors work.
//
// Triplanar-projected from LOCAL/OBJECT-space position+normal (not world-space): for box
// geometry (e.g. stone columns/"poles") the object-space normal is always exactly
// axis-aligned per face regardless of how the mesh itself is rotated in the world (e.g. a
// column rotated to align with its wall edge) — so every face gets one clean, un-blended
// projection ("box projected") instead of world-space triplanar blending two projections
// together across a now off-axis side face, which read as a top-down texture smeared down
// the sides. Only the grime gradient (ground darkening) still needs true WORLD height.
//
// `scaleU`/`scaleV` — bricks per local unit horizontally / vertically. Local Y is always
// the "vertical" (row) axis so brick courses run horizontal on every wall regardless of
// facing (object-space normals make this exact, not just approximate).
// `palette` — array of [hexColor, weight, randomRange]: `weight` is this color's relative
// chance of being picked for a given brick (weights need not sum to 1, they're
// normalized); `randomRange` is how far that brick's value can jitter around the base
// color (0..1ish; e.g. 0.08 = ±8% brightness wobble), so even same-palette bricks differ.
export function makeBrickMaterial({ scaleU = 8, scaleV = 4, palette = [[0x999999, 1, 0.08]], grimeHeight = 1.15, baseY = 0 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, side: THREE.DoubleSide })
  const totalWeight = palette.reduce((s, [, w = 1]) => s + w, 0) || 1
  let cum = 0
  const paletteGLSL = palette.map(([hex, weight = 1, range = 0.08]) => {
    cum += weight
    const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255
    return `if (col.a < 0.0 && r <= ${(cum / totalWeight).toFixed(6)}) { col = vec4(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}, ${range.toFixed(4)}); }`
  }).join('\n        ')

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uScale = { value: new THREE.Vector2(scaleU, scaleV) }
    shader.vertexShader = 'varying vec3 vLocalPos;\nvarying vec3 vLocalNormal;\nvarying float vWorldY;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vLocalPos = transformed;\n  vWorldY = (modelMatrix * vec4(transformed, 1.0)).y;',
    ).replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\n  vLocalNormal = objectNormal;',
    )
    const brickFn = `
      float gwHash1(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
      vec3 brickCol(vec2 x, vec2 scale){
        vec2 p = x * scale;
        float row = floor(p.y);
        float off = mod(row, 2.0) * 0.5;          // running-bond stagger
        vec2 n = floor(vec2(p.x + off, p.y));
        vec2 f = fract(vec2(p.x + off, p.y));
        if (f.x < 0.05 || f.y < 0.10) return vec3(0.10, 0.095, 0.09);   // mortar
        float r = gwHash1(n);
        // col.a doubles as "already picked" (-1 = no, else this colour's jitter range)
        vec4 col = vec4(0.5, 0.5, 0.5, -1.0);
        ${paletteGLSL}
        float j = (gwHash1(n + 7.31) - 0.5) * 2.0 * max(col.a, 0.0);
        return clamp(col.rgb + j, 0.0, 1.0);
      }
      // Horizontal "top" faces (Y-dominant normal — wall caps, pole tops) don't show a
      // brick FACE at all in reality, just the cut/mortared top edge of the course
      // below: a flat cap tone with thin mortar lines where the face's own vertical
      // joints would continue across. No coursing (row) lines — there's only ever one
      // course's edge visible from above. Drawn along BOTH in-plane axes since a single
      // top fragment can't know which one wall run it belongs to; on a narrow cap strip
      // (depth well under one brick spacing) the along-the-wall lines rarely land within
      // the strip anyway, so this reads as "joints continuing across", matching reality.
      vec3 brickCapLines(vec2 p, vec2 scale){
        vec2 g = fract(p * scale.x);
        float line = step(g.x, 0.035) + step(g.y, 0.035);
        vec3 cap = vec3(0.55, 0.53, 0.50);
        vec3 mortar = vec3(0.10, 0.095, 0.09);
        return mix(cap, mortar, clamp(line, 0.0, 1.0));
      }
      // Box-projected in LOCAL/OBJECT space — see file header. A HARD per-face pick of
      // whichever axis the normal points closest to (not a smooth triplanar BLEND of
      // all three) — a blend looks fine on axis-aligned geometry but smears two
      // different projections together on an angled face (a gable that follows the
      // wall's own non-perpendicular line, a sloped Foundation batter, …), since
      // neither projection alone is a clean fit there. A hard pick is always exactly
      // one clean, un-smeared projection, at the cost of a seam where the picked axis
      // flips — true box mapping has that same seam, so it reads as correct, not buggy.
      // Local Y is always the "vertical"/row axis so brick courses run horizontal.
      // Y-dominant (top) faces get brickCapLines instead of the full brick body — see
      // its own comment above.
      vec3 brickTri(vec3 p, vec3 nrm, vec2 scale){
        vec3 a = abs(nrm);
        if (a.x >= a.y && a.x >= a.z) return brickCol(p.zy, scale);
        if (a.y >= a.x && a.y >= a.z) return brickCapLines(p.xz, scale);
        return brickCol(p.xy, scale);
      }
    `
    const apply = '  diffuseColor.rgb = brickTri(vLocalPos, vLocalNormal, uScale);\n' +
      `  float gGrime = smoothstep(${baseY.toFixed(5)}, ${(baseY + grimeHeight).toFixed(5)}, vWorldY);\n` +
      '  diffuseColor.rgb *= mix(0.45, 1.0, gGrime);\n'
    shader.fragmentShader = 'varying vec3 vLocalPos;\nvarying vec3 vLocalNormal;\nvarying float vWorldY;\nuniform vec2 uScale;\n' + brickFn +
      shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + apply)
  }
  mat.customProgramCacheKey = () => `gw-brick:${scaleU}:${scaleV}:${palette.map(p => p.join(',')).join('|')}:${grimeHeight.toFixed(5)}:${baseY.toFixed(5)}`
  return mat
}
