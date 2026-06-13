import * as THREE from 'three'

// Wall material factory shared by all building walls. Adds, via onBeforeCompile:
//  • a world-position varying,
//  • "ground grime" — a green-brown darkening gradient near the ground (world y→0),
//    simulating ambient occlusion + dirt blown onto the wall base,
//  • (stone only) a procedural Voronoi stone pattern driven by world position, so
//    stone never repeats and needs no atlas tile.
// Everything is a pure function of position → deterministic across clients.
// `density` (stone Voronoi) and `grimeHeight` (height over which the ground-grime fades)
// are in WORLD units. When a building is rendered at a small scale, the caller scales
// these so the stone + grime keep their proportions on the geometry.
export function makeWallMaterial({ map = null, stone = false, density = 6.0, grimeHeight = 1.15 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ map, color: 0xffffff, roughness: stone ? 0.95 : 0.85, metalness: 0 })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDensity = { value: density }
    let vhead = 'varying vec3 vWorldPos;\n' + (stone ? 'varying vec3 vWorldNormal;\n' : '')
    shader.vertexShader = vhead + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    )
    if (stone) shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\n  vWorldNormal = mat3(modelMatrix) * objectNormal;',
    )
    const stoneFns = stone ? `
      varying vec3 vWorldNormal;
      vec2 hash2(vec2 p){ p = vec2(dot(p, vec2(127.1,311.7)), dot(p, vec2(269.5,183.3))); return fract(sin(p)*43758.5453123); }
      vec3 stoneCol(vec2 x){
        vec2 n = floor(x), f = fract(x); float md = 8.0; vec2 mr; vec2 mg;
        for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){ vec2 g=vec2(float(i),float(j)); vec2 r=g+hash2(n+g)-f; float d=dot(r,r); if(d<md){md=d;mr=r;mg=g;} }
        float edge=8.0;
        for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){ vec2 g=vec2(float(i),float(j)); vec2 r=g+hash2(n+g)-f; vec2 df=r-mr; if(dot(df,df)>1e-4) edge=min(edge, dot(0.5*(mr+r), normalize(df))); }
        float id = fract(sin(dot(n+mg, vec2(12.9898,78.233)))*43758.5453);
        float grey = 0.32 + 0.28*id;
        return vec3(grey) * mix(0.45, 1.0, smoothstep(0.0, 0.045, edge));
      }
      // Triplanar: blend three world projections by the normal — no mirroring/stretch
      // on any face orientation (walls, chimneys, …).
      vec3 stoneTri(vec3 p, vec3 nrm){
        vec3 w = abs(nrm); w /= max(w.x + w.y + w.z, 1e-4);
        return stoneCol(p.zy) * w.x + stoneCol(p.xz) * w.y + stoneCol(p.xy) * w.z;
      }
    ` : ''
    const gh = grimeHeight.toFixed(5)
    const apply = (stone ? '  diffuseColor.rgb = stoneTri(vWorldPos * uDensity, vWorldNormal);\n' : '') +
      // ground grime / AO darkening near the base (darker, reaching higher up)
      `  float gGrime = smoothstep(0.0, ${gh}, vWorldPos.y);\n` +
      '  diffuseColor.rgb *= mix(0.32, 1.0, gGrime);\n' +
      '  diffuseColor.rgb *= mix(vec3(0.6, 0.7, 0.48), vec3(1.0), gGrime);\n'
    shader.fragmentShader = 'varying vec3 vWorldPos;\nuniform float uDensity;\n' + stoneFns +
      shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + apply)
  }
  mat.customProgramCacheKey = () => `${stone ? 'gw-wall-stone' : 'gw-wall'}:${grimeHeight.toFixed(5)}`
  return mat
}

export const makeStoneMaterial = (opts) => makeWallMaterial({ ...opts, stone: true })
