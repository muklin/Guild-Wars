import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Assembles a Parametric Building from a Building Spec using a PartLibrary (theme).
// PURE + DETERMINISTIC: all variation comes from spec.seed — NO Math.random() here.
//
// Spec: { seed, floors, footprint:{type:'rect',w,d}, wallMaterial:[perFloor],
//         roof:{shape:'gable',material,pitch,overhang?} }
// Material rules (enforced by the spec producer): ≤2 materials/building; stone ONLY on
// the ground floor; wood roof only if every floor is wood.

const WINDOWS = ['window', 'window-short', 'window-single', 'window-shutter', 'window-closed']
const STONE_MATS = new Set(['stone', 'granite'])

function makeRng(seed) {
  let s = (Math.floor(seed) * 2654435761) >>> 0
  if (s === 0) s = 0x9e3779b9
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296 }
}
// L geometry: a w×d bbox with a rectangular notch removed from the +X/+Z corner.
function lDims(fp) {
  const W = fp.w ?? 3.4, D = fp.d ?? 3.0
  return { W, D, nx: fp.notchW ?? W * 0.42, nz: fp.notchD ?? D * 0.42 }
}
function footprintPolygon(fp) {
  if (fp.type === 'wings') {
    // Single-wing: outer perimeter IS the wing rectangle. Multi-wing: use bbox (approximate;
    // correct union polygon is future work — for now only single-wing wings are placed on plots).
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (const w of fp.wings) { x0 = Math.min(x0, w.minX); x1 = Math.max(x1, w.maxX); z0 = Math.min(z0, w.minZ); z1 = Math.max(z1, w.maxZ) }
    return [{ x: x0, y: z0 }, { x: x1, y: z0 }, { x: x1, y: z1 }, { x: x0, y: z1 }]
  }
  if (fp.type === 'L') {
    const { W, D, nx, nz } = lDims(fp)
    return [
      { x: -W / 2, y: -D / 2 }, { x: W / 2, y: -D / 2 }, { x: W / 2, y: D / 2 - nz },
      { x: W / 2 - nx, y: D / 2 - nz }, { x: W / 2 - nx, y: D / 2 }, { x: -W / 2, y: D / 2 },
    ]
  }
  const w = fp.w ?? 3, d = fp.d ?? 2
  return [{ x: -w / 2, y: -d / 2 }, { x: w / 2, y: -d / 2 }, { x: w / 2, y: d / 2 }, { x: -w / 2, y: d / 2 }]
}
// Roof wings: rectangles that tile the footprint, each roofed independently (the L's
// valley emerges where two wing roofs meet). Rect → one wing; L → two.
function footprintWings(fp, bbox) {
  if (fp.type === 'wings') return fp.wings
  if (fp.type === 'L') {
    const { W, D, nx, nz } = lDims(fp)
    // Foot = primary wing, natural ridge direction.
    // Upright = secondary wing, ridge FORCED perpendicular to foot so they form a T-intersection
    // (cross-gable). The junction face (minZ) gets no gable trim or bargeboard.
    const footRidgeAlongX = W >= (D - nz)
    return [
      { minX: -W / 2, maxX: W / 2, minZ: -D / 2, maxZ: D / 2 - nz, dormersOnMinSide: true },
      { minX: -W / 2, maxX: W / 2 - nx, minZ: D / 2 - nz, maxZ: D / 2,
        forceRidgeAlongX: !footRidgeAlongX,
        junctionSide: 'minZ',
        noDormers: true,
      },
    ]
  }
  return [{ ...bbox, dormersOnMinSide: true }]
}

export function assemble(spec, lib) {
  const group = new THREE.Group()
  const rand = makeRng(spec.seed ?? 1)
  const { bayWidth: B, floorHeight: H } = lib.grid
  const poly = footprintPolygon(spec.footprint)
  const floors = Math.max(1, spec.floors ?? 1)
  const mats = spec.wallMaterial?.length ? spec.wallMaterial : ['stone']
  const matAt = (f) => mats[Math.min(f, mats.length - 1)]

  // building-level params (drawn first so the rand stream is stable)
  const ovMin = spec.roof?.overhangMin ?? 0.14
  const overhang = ovMin + rand() * ((spec.roof?.overhangMax ?? 0.48) - ovMin)
  // Jetty: a stone ground floor can carry a larger jettied upper storey, supported by
  // poles down to the ground. (Per-floor footprints.)
  const jettied = matAt(0) === 'stone' && floors > 1 && spec.footprint?.type !== 'L' && rand() < 0.5
  const jettyAmt = jettied ? 0.16 + rand() * 0.18 : 0
  const braceSlot = rand() < 0.4 ? 'brace-double' : 'brace'   // consistent knee style per house
  // Gable decoration, consistent per house: ⅓ king post to the apex, ⅓ chevron braces,
  // ⅓ double horizontal bracing (the latter two stop the centre pole at the story plank).
  // A king post is only used when a wall post lines up under the gable centre; otherwise
  // it falls back to `gableBrace`.
  const gableStyle = ['kingpost', 'angled', 'horizontal'][Math.floor(rand() * 3)]
  const gableBrace = rand() < 0.5 ? 'angled' : 'horizontal'
  const expandRect = (p, j) => p.map((v) => ({ x: v.x + Math.sign(v.x) * j, y: v.y + Math.sign(v.y) * j }))
  const floorPoly = (f) => (f === 0 || !jettied ? poly : expandRect(poly, jettyAmt))
  const topPoly = floorPoly(floors - 1)

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of topPoly) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y) }
  const topY = floors * H

  // suppressedFaces: faces baked in by the server (neighbour-height pre-pass). edgeIndex is
  // 0-based into the outer perimeter polygon; upToFloor is inclusive. wingIndex reserved for
  // future multi-wing suppression — currently only wingIndex 0 is acted on.
  const specSF = spec.suppressedFaces ?? []
  // Edges suppressed for ALL floors (upToFloor ≥ floors−1) → also suppress roof trim.
  const suppressedRoofEdges = new Set(specSF.filter(sf => sf.wingIndex === 0 && sf.upToFloor >= floors - 1).map(sf => sf.edgeIndex))

  const place = (mesh, px, pz, y, rotY, scaleX = 1, sign = 1) => {
    if (!mesh) return
    mesh.position.set(px, y, pz); mesh.rotation.y = rotY; mesh.scale.x = scaleX * sign; group.add(mesh)
  }

  // ── Walls ────────────────────────────────────────────────────────────────────
  for (let f = 0; f < floors; f++) {
    const yBase = f * H, mat = matAt(f), pf = floorPoly(f)
    // Edges suppressed on this floor — panels + interior posts omitted, corner posts survive.
    // All rand() calls still execute to keep the seed stream deterministic across specs that
    // differ only in suppressedFaces.
    const suppressedWallEdges = new Set(specSF.filter(sf => sf.wingIndex === 0 && sf.upToFloor >= f).map(sf => sf.edgeIndex))
    for (let i = 0; i < pf.length; i++) {
      const a = pf[i], b = pf[(i + 1) % pf.length]
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy)
      if (L < 1e-6) continue
      const ux = dx / L, uy = dy / L
      const rotY = Math.atan2(uy, -ux)
      const nBays = Math.max(1, Math.round(L / B)), pitch = L / nBays
      const braceA = mat === 'plaster' && rand() < 0.5   // knee braces (plaster, corners only)
      const braceB = mat === 'plaster' && rand() < 0.5
      const vis = !suppressedWallEdges.has(i)             // visible face?

      for (let k = 0; k < nBays; k++) {
        const t = (k + 0.5) * pitch, px = a.x + ux * t, pz = a.y + uy * t
        if (vis) place(makeFlatPanel(pitch, H, lib.regions[mat] ?? lib.regions.plaster, lib.materialFor(mat)), px, pz, yBase, rotY)
        const bracedHere = (braceA && k === 0) || (braceB && k === nBays - 1)   // no window where a knee is
        let slot = null
        // rand() calls execute unconditionally to keep the seed stream identical whether or
        // not the face is visible — only placement is gated on `vis`.
        if (f === 0 && i === 0 && k === Math.floor(nBays / 2)) { if (vis) slot = 'door' }
        else if (STONE_MATS.has(mat) && !bracedHere && rand() < 0.5) { if (vis) addStoneWindow(group, lib, mat, px, pz, yBase, rotY, H) }
        else if (!STONE_MATS.has(mat) && !bracedHere && rand() < 0.6) { const w = WINDOWS[Math.floor(rand() * WINDOWS.length)]; if (vis) slot = w }
        if (slot) place(lib.get(slot), px, pz, yBase, rotY)
      }
      if (vis) {
        for (let k = 1; k < nBays; k++) place(lib.get('post'), a.x + ux * k * pitch, a.y + uy * k * pitch, yBase, rotY)
        if (braceA) place(lib.get(braceSlot), a.x, a.y, yBase, rotY, 1, 1)
        if (braceB) place(lib.get(braceSlot), b.x, b.y, yBase, rotY, 1, -1)
      }
    }
    for (const c of pf) place(lib.get('post'), c.x, c.y, yBase, 0)
    if (f < floors - 1) addEdgeParts(group, lib, 'beam', floorPoly(f + 1), (f + 1) * H, B)
  }
  // Jetty supports: a pole from the ground up to each jettied upper corner.
  if (jettied) for (const c of topPoly) { const pole = lib.get('post'); if (pole) { pole.position.set(c.x, 0, c.y); group.add(pole) } }

  // ── Roof + trim (per wing: rect → 1 wing, L → 2 → valley where they meet) ─────────
  const roofSpec = spec.roof ?? { material: 'slate' }
  const matTop = matAt(floors - 1)
  const wings = footprintWings(spec.footprint, { minX, maxX, minZ, maxZ })
  // Each wing gets its own ridge height from span × pitch (no forced sharing). For an L,
  // the secondary wing is perpendicular (forceRidgeAlongX) creating a T-intersection roof.
  const wingRs = wings.map((w, i) => {
    const pitchMult = spec.wingHeights ? (spec.wingHeights[i] ?? 1.0) : 1.0
    return wingRoof(w, topY, roofSpec.pitch * pitchMult, overhang)
  })
  const dormerPositions = []
  for (const R of wingRs) {
    const wp = [
      { x: R.minX, y: R.minZ }, { x: R.maxX, y: R.minZ },
      { x: R.maxX, y: R.maxZ }, { x: R.minX, y: R.maxZ },
    ]
    addRoof(group, R, roofSpec, lib)
    addGableFills(group, wp, { topY, ht: R.ht, overhang, isGableEnd: R.isGableEnd, junctionSide: R.junctionSide, suppressedEdges: suppressedRoofEdges }, matTop, lib)
    addGableTrim(group, wp, { topY, apexY: R.apexY, ht: R.ht, isGableEnd: R.isGableEnd, overhang, gableStyle, gableBrace, roofMat: roofSpec.material, junctionSide: R.junctionSide, suppressedEdges: suppressedRoofEdges }, lib)
    if (R.roofAngle >= 50 && !R.noDormers) dormerPositions.push(...addDormers(group, R, roofSpec, rand, lib))
  }
  // Chimneys: building-level count; dormer positions passed so chimneys avoid them.
  addChimneys(group, wingRs, floors, rand, lib, dormerPositions)

  // Per-building atlas tint: clone the shared material once with a hue/brightness shift
  // so neighbouring buildings don't look identical. Stone (procedural) is unaffected.
  if (spec.tint) {
    const tintedMat = lib.material.clone()
    tintedMat.color.copy(spec.tint)
    group.traverse((o) => { if (o.isMesh && o.material === lib.material) o.material = tintedMat })
  }
  return mergeBuilding(group)
}

// Derive a wing rectangle's roof parameters. Wing may carry forceRidgeAlongX (for the
// perpendicular cross-gable on L-shapes) and junctionSide (which face abuts the neighbour).
function wingRoof(wing, topY, pitch, overhang) {
  const { minX, maxX, minZ, maxZ } = wing
  const W = maxX - minX, D = maxZ - minZ
  // forceRidgeAlongX lets L-shape upright be perpendicular to the foot (T-intersection).
  const ridgeAlongX = wing.forceRidgeAlongX !== undefined ? wing.forceRidgeAlongX : W >= D
  const halfSpan = (ridgeAlongX ? D : W) / 2
  const ht = Math.min(W, D) * (pitch ?? 0.55)
  const apexY = topY + ht
  const roofAngle = Math.atan2(ht, halfSpan) * 180 / Math.PI
  const isGableEnd = (ux, uy) => ridgeAlongX ? Math.abs(uy) > Math.abs(ux) : Math.abs(ux) > Math.abs(uy)
  return { ...wing, ridgeAlongX, halfSpan, ht, topY, apexY, roofAngle, isGableEnd, overhang }
}

// Place a flex part along each polygon edge at height y (optionally edge-filtered).
function addEdgeParts(group, lib, slot, poly, y, B, edgeFilter) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy)
    if (L < 1e-6) continue
    const ux = dx / L, uy = dy / L
    if (edgeFilter && !edgeFilter(ux, uy)) continue
    const rotY = Math.atan2(uy, -ux), n = Math.max(1, Math.round(L / B)), pitch = L / n
    for (let k = 0; k < n; k++) {
      const m = lib.get(slot); if (!m) continue
      const t = (k + 0.5) * pitch
      m.position.set(a.x + ux * t, y, a.y + uy * t); m.rotation.y = rotY; m.scale.x = pitch / B; group.add(m)
    }
  }
}

// ── Generated geometry helpers ───────────────────────────────────────────────────
function regionUV(r, u, v) { return [r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0)] }
// Flat (PlaneGeometry) wall panel: zero thickness, atlas-textured. Sized exactly bw×h so no
// scale needed. Geometry base at y=0, face +Z, so place() with rotY handles orientation.
function makeFlatPanel(bw, h, reg, material) {
  const g = new THREE.PlaneGeometry(bw, h)
  g.translate(0, h / 2, 0)
  const uv = g.attributes.uv
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i)
    uv.setXY(i, reg.u0 + u * (reg.u1 - reg.u0), reg.v0 + v * (reg.v1 - reg.v0))
  }
  return new THREE.Mesh(g, material)
}
function quadTris(p0, p1, p2, p3) { return [[p0, p1, p2, [0, 0], [1, 0], [1, 1]], [p0, p2, p3, [0, 0], [1, 1], [0, 1]]] }
// A quad whose UVs span only [0,uvS] of the atlas tile — used to match texel density
// across differently-sized roof faces (e.g. a small dormer roof vs. the main roof).
function texQuad(p0, p1, p2, p3, region, material, uvS) {
  return trisMesh([[p0, p1, p2, [0, 0], [uvS, 0], [uvS, uvS]], [p0, p2, p3, [0, 0], [uvS, uvS], [0, uvS]]], region, material, true)
}
function trisMesh(tris, region, material, doubleSided = false) {
  const pos = [], uv = []
  const add = (t) => { pos.push(...t[0], ...t[1], ...t[2]); uv.push(...regionUV(region, t[3][0], t[3][1]), ...regionUV(region, t[4][0], t[4][1]), ...regionUV(region, t[5][0], t[5][1])) }
  for (const t of tris) { add(t); if (doubleSided) add([t[0], t[2], t[1], t[3], t[5], t[4]]) }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.computeVertexNormals()
  return new THREE.Mesh(g, material)
}
// A flat board p0→p1: length along the run, `width` across (in the plane whose
// outward `normal` is given), `thick` out of plane. Atlas-textured with `region`.
function flatBoard(p0, p1, width, thick, normal, region, material) {
  const dir = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
  const len = dir.length(); if (len < 1e-6) return null
  dir.normalize()
  // Build a RIGHT-HANDED basis (X=dir along the run, Y=side in-plane, Z=board normal):
  // side = nrm × dir, then z = dir × side ⇒ dir×side=z (det +1). A left-handed basis
  // here makes setFromRotationMatrix emit a garbage quaternion (boards fly off-axis).
  const nrm = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize()
  const side = new THREE.Vector3().crossVectors(nrm, dir).normalize()
  const zAxis = new THREE.Vector3().crossVectors(dir, side).normalize()
  const g = new THREE.BoxGeometry(len, width, thick)
  for (let i = 0; i < g.attributes.uv.count; i++) { const u = g.attributes.uv.getX(i), v = g.attributes.uv.getY(i); g.attributes.uv.setXY(i, ...regionUV(region, u, v)) }
  const m = new THREE.Mesh(g, material)
  m.position.set((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2)
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(dir, side, zAxis))
  return m
}

// Verge along a gable rake p0→p1. Tile/wood roofs get a real wooden bargeboard sitting
// proud above the rake; thatch/reed roofs instead get a band HANGING down from the rake,
// in the roof's own material, to simulate the thick cut edge of the thatch/reed.
function addVergeBoard(group, p0, p1, nOut, roofMat, lib) {
  if (roofMat === 'thatch' || roofMat === 'reed') {
    const region = roofMat === 'thatch' ? lib.regions.thatch : lib.regions.reed
    const hang = 0.16
    const b0 = [p0[0], p0[1] - hang, p0[2]], b1 = [p1[0], p1[1] - hang, p1[2]]
    group.add(trisMesh(quadTris(p0, p1, b1, b0), region, lib.material, true))
  } else {
    group.add(flatBoard(p0, p1, 0.15, 0.05, nOut, lib.regions.woodtrim, lib.material))
  }
}

function addRoof(group, R, roof, lib) {
  const region = lib.regions[roof.material] || lib.regions.slate
  const { minX, maxX, minZ, maxZ, ridgeAlongX, topY, apexY, overhang: o, junctionSide } = R
  // Eaves overhang by `o` on all sides except the junction face (where this wing meets a
  // neighbour wing at a valley — the neighbour's roof covers that edge).
  const oa = junctionSide === 'minZ' ? 0 : o, ob = junctionSide === 'maxZ' ? 0 : o
  const oc = junctionSide === 'minX' ? 0 : o, od = junctionSide === 'maxX' ? 0 : o
  let tris = []
  if (ridgeAlongX) {
    const xa = minX - oc, xb = maxX + od, za = minZ - oa, zb = maxZ + ob, zc = (minZ + maxZ) / 2
    tris = tris.concat(quadTris([xa, apexY, zc], [xb, apexY, zc], [xb, topY, za], [xa, topY, za]))
    tris = tris.concat(quadTris([xb, apexY, zc], [xa, apexY, zc], [xa, topY, zb], [xb, topY, zb]))
  } else {
    const za = minZ - oa, zb = maxZ + ob, xa = minX - oc, xb = maxX + od, xc = (minX + maxX) / 2
    tris = tris.concat(quadTris([xc, apexY, za], [xc, apexY, zb], [xb, topY, zb], [xb, topY, za]))
    tris = tris.concat(quadTris([xc, apexY, zb], [xc, apexY, za], [xa, topY, za], [xa, topY, zb]))
  }
  group.add(trisMesh(tris, region, lib.material, true))
}

// Triangular wall fill on the gable-end edges → top floor's material, up to the apex.
// Double-sided so it's never invisible regardless of winding.
function addGableFills(group, poly, { topY, ht, overhang, isGableEnd, junctionSide, suppressedEdges }, material, lib) {
  const region = lib.regions[material] || lib.regions.plaster, tris = []
  const pyMin = Math.min(...poly.map((p) => p.y)), pyMax = Math.max(...poly.map((p) => p.y))
  const pxMin = Math.min(...poly.map((p) => p.x)), pxMax = Math.max(...poly.map((p) => p.x))
  const ov = overhang ?? 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy); if (L < 1e-6) continue
    const ux = dx / L, uy = dy / L
    if (!isGableEnd(ux, uy)) continue
    if (suppressedEdges?.has(i)) continue
    // Skip the junction face — no gable fill where this wing meets the neighbour at a valley.
    if (junctionSide === 'minZ' && a.y <= pyMin + 0.01 && b.y <= pyMin + 0.01) continue
    if (junctionSide === 'maxZ' && a.y >= pyMax - 0.01 && b.y >= pyMax - 0.01) continue
    if (junctionSide === 'minX' && a.x <= pxMin + 0.01 && b.x <= pxMin + 0.01) continue
    if (junctionSide === 'maxX' && a.x >= pxMax - 0.01 && b.x >= pxMax - 0.01) continue
    // Extend base by overhang so the gable triangle's pitch angle matches the overhanging roof slope.
    const ax = a.x - ux * ov, ay = a.y - uy * ov
    const bx = b.x + ux * ov, by = b.y + uy * ov
    const mx = (ax + bx) / 2, mz = (ay + by) / 2
    tris.push([[ax, topY, ay], [bx, topY, by], [mx, topY + ht, mz], [0, 0], [1, 0], [0.5, 1]])
  }
  if (tris.length) group.add(trisMesh(tris, region, lib.materialFor(material), true))
}

// Gable-end trim: bargeboards lying ON the roof rake (so angle + length match the roof),
// an always-present top-of-story plank, and one of three gable decorations.
function addGableTrim(group, poly, { topY, apexY, ht, isGableEnd, overhang, gableStyle, gableBrace, roofMat, junctionSide, suppressedEdges }, lib) {
  const region = lib.regions.woodtrim
  const B = lib.grid.bayWidth
  const pyMin = Math.min(...poly.map((p) => p.y)), pyMax = Math.max(...poly.map((p) => p.y))
  const pxMin = Math.min(...poly.map((p) => p.x)), pxMax = Math.max(...poly.map((p) => p.x))
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy); if (L < 1e-6) continue
    if (!isGableEnd(dx / L, dy / L)) continue
    if (suppressedEdges?.has(i)) continue
    if (junctionSide === 'minZ' && a.y <= pyMin + 0.01 && b.y <= pyMin + 0.01) continue
    if (junctionSide === 'maxZ' && a.y >= pyMax - 0.01 && b.y >= pyMax - 0.01) continue
    if (junctionSide === 'minX' && a.x <= pxMin + 0.01 && b.x <= pxMin + 0.01) continue
    if (junctionSide === 'maxX' && a.x >= pxMax - 0.01 && b.x >= pxMax - 0.01) continue
    const ux = dx / L, uy = dy / L, nOut = [uy, 0, -ux]     // gable-plane outward normal
    const proudX = uy * 0.04, proudZ = -ux * 0.04           // sit just proud of the infill
    const ox = uy * overhang, oz = -ux * overhang           // verge offset (perp to gable)
    const ex = ux * overhang, ez = uy * overhang            // extension to the eave-overhang corner
    const mx = (a.x + b.x) / 2, mz = (a.y + b.y) / 2, apex = apexY + 0.02
    // A king post can only reach the apex if a wall post lines up under the gable centre
    // (an even bay count puts a post at the midpoint); otherwise fall back to a brace.
    const centrePole = Math.max(1, Math.round(L / B)) % 2 === 0
    const style = gableStyle === 'kingpost' ? (centrePole ? 'kingpost' : gableBrace) : gableStyle
    // Verge: from the eave-overhang corner up to the apex, at the verge offset — on the rake.
    addVergeBoard(group, [a.x - ex + ox, topY, a.y - ez + oz], [mx + ox, apex, mz + oz], nOut, roofMat, lib)
    addVergeBoard(group, [b.x + ex + ox, topY, b.y + ez + oz], [mx + ox, apex, mz + oz], nOut, roofMat, lib)
    // Top-of-story plank: always, horizontal across the gable base.
    group.add(flatBoard([a.x + proudX, topY, a.y + proudZ], [b.x + proudX, topY, b.y + proudZ], 0.13, 0.05, nOut, region, lib.material))
    if (style === 'kingpost') {                             // single king post to the apex
      group.add(flatBoard([mx + proudX, topY, mz + proudZ], [mx + proudX, apexY, mz + proudZ], 0.12, 0.05, nOut, region, lib.material))
    } else if (style === 'angled') {                        // chevron braces from base centre
      const fr = 0.5, hw = (L / 2) * fr                      // tip lands ON the rake (height ht·(1−fr))
      for (const s of [-1, 1]) {
        group.add(flatBoard([mx + proudX, topY, mz + proudZ], [mx + s * ux * hw + proudX, topY + ht * (1 - fr), mz + s * uy * hw + proudZ], 0.1, 0.05, nOut, region, lib.material))
      }
    } else {                                                // double horizontal bracing
      for (const fr of [0.34, 0.66]) {
        const y = topY + ht * fr, hw = (L / 2) * (1 - fr)
        group.add(flatBoard([mx - ux * hw + proudX, y, mz - uy * hw + proudZ], [mx + ux * hw + proudX, y, mz + uy * hw + proudZ], 0.1, 0.05, nOut, region, lib.material))
      }
    }
  }
}

// A dormer is a single-width gabled "house" embedded in the roof: flat plaster front wall
// + window + bargeboards (with full overhang past window corners) + corner poles, facing
// down-slope. Roof runs back at the same pitch, truncated at the main roofline.
// Returns array of {x,z} world positions so chimneys can avoid them.
function addDormers(group, R, roof, rand, lib) {
  const { minX, maxX, minZ, maxZ, ridgeAlongX, apexY, ht, halfSpan, topY } = R
  const region = lib.regions[roof.material] || lib.regions.slate
  const ridgeSpan = ridgeAlongX ? maxX - minX : maxZ - minZ
  const pitch = ht / halfSpan
  const onMinSide = R.dormersOnMinSide !== false   // which slope to use
  const n = 1 + (rand() < 0.4 ? 1 : 0)
  const winMode = rand() < 0.5 ? 'frame' : 'closed'
  const slot = ridgeSpan / (n + 1)
  const dw = Math.min(1.4, slot * 0.7), uvS = Math.min(1, (dw / 2) / halfSpan)
  const ov = 0.15, gap = 0.14, fz = 0.5, eaveZ = fz + ov, slopeT = 0.62
  const baseY = apexY - slopeT * ht
  const peakY = (apexY - gap) - baseY
  const wallTop = peakY - pitch * (dw / 2)
  // Clamp front-wall base so the window never dips below the top of the wall story.
  const fBase = Math.max(-pitch * fz, topY - baseY)
  const backRidge = -peakY / pitch, backEave = -wallTop / pitch
  const positions = []
  for (let s = 0; s < n; s++) {
    const u = (s + 1) / (n + 1)
    let cx, cz
    if (ridgeAlongX) { cx = minX + u * (maxX - minX); cz = (minZ + maxZ) / 2 + (onMinSide ? -1 : 1) * slopeT * halfSpan }
    else { cz = minZ + u * (maxZ - minZ); cx = (minX + maxX) / 2 + (onMinSide ? -1 : 1) * slopeT * halfSpan }
    positions.push({ x: cx, z: cz })
    const g = new THREE.Group()
    // flat plaster front wall (no thickness → no gap with window frame)
    g.add(texQuad([-dw / 2, fBase, fz], [dw / 2, fBase, fz], [dw / 2, wallTop, fz], [-dw / 2, wallTop, fz], lib.regions.plaster, lib.material, 1))
    g.add(trisMesh([[[-dw / 2, wallTop, fz], [dw / 2, wallTop, fz], [0, peakY, fz], [0, 0], [1, 0], [0.5, 1]]], lib.regions.plaster, lib.material, true))
    addDormerWindow(g, lib, dw, fBase, wallTop, peakY, fz, winMode)
    for (const sx of [-dw / 2, dw / 2]) {
      g.add(boxAt(0.07, wallTop - fBase, 0.07, lib.regions.woodtrim, lib.material, sx, (fBase + wallTop) / 2, fz))
      g.add(trisMesh([[[sx, fBase, fz], [sx, wallTop, fz], [sx, wallTop, backEave], [0, 0], [0, 1], [1, 1]]], lib.regions.plaster, lib.material, true))
    }
    const eaveX = dw / 2 + ov, eaveY = wallTop - pitch * ov
    // Panels extend FORWARD (eaveZ past the front face) AND laterally (eaveX past window corners).
    g.add(texQuad([0, peakY, fz], [0, peakY, backRidge], [-eaveX, eaveY, backEave], [-eaveX, eaveY, eaveZ], region, lib.material, uvS))
    g.add(texQuad([0, peakY, backRidge], [0, peakY, fz], [eaveX, eaveY, eaveZ], [eaveX, eaveY, backEave], region, lib.material, uvS))
    // Verge boards run along the actual rake edge: eave corner (forward) up to ridge (back at fz)
    addVergeBoard(g, [-eaveX, eaveY, eaveZ ], [0, peakY, fz ], [0, 0, 1], roof.material, lib)
    addVergeBoard(g, [eaveX, eaveY, eaveZ ], [0, peakY, fz ], [0, 0, 1], roof.material, lib)
    g.position.set(cx, baseY + 0.01, cz)
    if (ridgeAlongX) g.rotation.y = onMinSide ? Math.PI : 0
    else g.rotation.y = onMinSide ? -Math.PI / 2 : Math.PI / 2
    group.add(g)
  }
  return positions
}

// A full-height dormer window rising into the gable: glass + horizontal mullions + a wood
// frame (jambs/lintel/sill). `mode` 'closed' adds shut shutters over it; 'frame' leaves it open.
function addDormerWindow(g, lib, dw, fBase, wallTop, peakY, fz, mode) {
  const z = fz + 0.04, winW = dw * 0.42
  const bottom = fBase + 0.06, top = wallTop + (peakY - wallTop) * 0.5   // up into the gable
  const winH = top - bottom, cy = (bottom + top) / 2
  g.add(boxAt(winW, winH, 0.02, lib.regions.glass, lib.material, 0, cy, z))
  for (const fr of [1 / 3, 2 / 3]) g.add(boxAt(winW, 0.03, 0.04, lib.regions.woodtrim, lib.material, 0, bottom + winH * fr, z + 0.01))  // mullions
  g.add(boxAt(winW + 0.08, 0.05, 0.05, lib.regions.woodtrim, lib.material, 0, top + 0.03, z))            // lintel
  g.add(boxAt(winW + 0.12, 0.06, 0.08, lib.regions.woodtrim, lib.material, 0, bottom - 0.03, fz + 0.06)) // sill (proud)
  for (const sx of [-1, 1]) g.add(boxAt(0.04, winH + 0.06, 0.05, lib.regions.woodtrim, lib.material, sx * (winW / 2 + 0.02), cy, z))  // jambs
  if (mode === 'closed') {                                       // shut shutters cover the glass
    for (const sx of [-1, 1]) g.add(boxAt(winW / 2 - 0.006, winH, 0.03, lib.regions.doorwood, lib.material, sx * winW / 4, cy, z + 0.02))
  }
}

// Small rectangular stone window with thick frame (jambs, lintel, sill + glass).
// Used for stone and granite walls instead of the kit's timber-framed window slots.
function addStoneWindow(group, lib, mat, px, pz, yBase, rotY, floorH) {
  const isGranite = mat === 'granite'
  const winW = 0.36, winH = Math.min(0.50, floorH * 0.62), frameT = 0.09, front = 0.03
  const mkFrame = (w, h, d, x, y, z) => isGranite
    ? boxAt(w, h, d, lib.regions.granite, lib.material, x, y, z)
    : plainBox(w, h, d, lib.stoneMaterial, x, y, z)
  const g = new THREE.Group()
  g.add(mkFrame(winW + frameT * 2, frameT, frameT * 2, 0, winH / 2 + frameT / 2, front))     // lintel
  g.add(mkFrame(winW + frameT * 2, frameT, frameT * 2, 0, -(winH / 2 + frameT / 2), front))   // sill
  g.add(mkFrame(frameT, winH, frameT * 2, -(winW / 2 + frameT / 2), 0, front))                // left jamb
  g.add(mkFrame(frameT, winH, frameT * 2, winW / 2 + frameT / 2, 0, front))                   // right jamb
  g.add(boxAt(winW, winH, 0.01, lib.regions.glass, lib.material, 0, 0, front + 0.015))        // glass
  g.position.set(px, yBase + floorH * 0.5, pz)
  g.rotation.y = rotY
  group.add(g)
}

// Generated stone chimneys: procedural-stone walls (no cap) with a shallow dark flue.
// ONE building-level count (constant whatever the footprint), each placed on a chosen
// wing — either ON its ridge (peak) or flush against the inside face of any wall (gable
// end or eave side). Each emerges from the roof surface at its spot and rises randomly.
function addChimneys(group, wings, floors, rand, lib, dormerPositions = []) {
  const W = 0.3, rimH = 0.34, hole = 0.16, rimT = (W - hole) / 2, inset = W / 2 + 0.03
  const n = Math.min(floors, 1 + (rand() < 0.5 ? 1 : 0))
  for (let i = 0; i < n; i++) {
    const R = wings[Math.floor(rand() * wings.length)]
    const { minX, maxX, minZ, maxZ, ridgeAlongX, apexY, ht, halfSpan } = R
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
    const roofYAt = (x, z) => apexY - Math.min(1, (ridgeAlongX ? Math.abs(z - cz) : Math.abs(x - cx)) / halfSpan) * ht
    let x, z
    if (rand() < 0.4) {
      const t = 0.2 + rand() * 0.6
      x = ridgeAlongX ? minX + t * (maxX - minX) : cx
      z = ridgeAlongX ? cz : minZ + t * (maxZ - minZ)
    } else {
      const t = 0.25 + rand() * 0.5
      switch (Math.floor(rand() * 4)) {
        case 0: x = minX + inset; z = minZ + t * (maxZ - minZ); break
        case 1: x = maxX - inset; z = minZ + t * (maxZ - minZ); break
        case 2: z = minZ + inset; x = minX + t * (maxX - minX); break
        default: z = maxZ - inset; x = minX + t * (maxX - minX)
      }
    }
    // Skip this chimney position if it would overlap a dormer
    if (dormerPositions.some((d) => Math.hypot(x - d.x, z - d.z) < 0.6)) continue
    const surfY = roofYAt(x, z), rootY = surfY - 0.3
    const top = surfY + 0.45 + rand() * 0.7                 // rise above the roof, varied
    const base = Math.max(0.3, top - rimH - rootY)
    const g = new THREE.Group()
    g.add(plainBox(W, base, W, lib.stoneMaterial, 0, base / 2, 0))                          // solid lower
    const ry = base + rimH / 2                                                              // rim walls (hole between)
    g.add(plainBox(W, rimH, rimT, lib.stoneMaterial, 0, ry, (hole + rimT) / 2))
    g.add(plainBox(W, rimH, rimT, lib.stoneMaterial, 0, ry, -(hole + rimT) / 2))
    g.add(plainBox(rimT, rimH, hole, lib.stoneMaterial, (hole + rimT) / 2, ry, 0))
    g.add(plainBox(rimT, rimH, hole, lib.stoneMaterial, -(hole + rimT) / 2, ry, 0))
    g.add(plainBox(hole + 0.01, rimH - 0.02, hole + 0.01, lib.darkMaterial, 0, ry - 0.01, 0))  // dark flue
    g.position.set(x, rootY, z)
    group.add(g)
  }
}

// small mesh helpers
function boxAt(w, h, d, region, material, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d)
  for (let i = 0; i < g.attributes.uv.count; i++) { const u = g.attributes.uv.getX(i), v = g.attributes.uv.getY(i); g.attributes.uv.setXY(i, ...regionUV(region, u, v)) }
  const m = new THREE.Mesh(g, material); m.position.set(x, y, z); return m
}
function plainBox(w, h, d, material, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); m.position.set(x, y, z); return m }

// Collapse the assembled group from ~50-100 Mesh objects down to one Mesh per material.
// All sub-meshes are world-flattened into merged BufferGeometries before being discarded.
function mergeBuilding(group) {
  group.updateMatrixWorld(true)
  const byMat = new Map()
  group.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return
    // Convert indexed geometries (PlaneGeometry, BoxGeometry) to non-indexed so
    // mergeGeometries can combine them with our hand-built non-indexed trisMesh geometry.
    const g = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone()
    g.applyMatrix4(obj.matrixWorld)
    if (!byMat.has(obj.material)) byMat.set(obj.material, [])
    byMat.get(obj.material).push(g)
  })
  // Dispose originals before dropping the group
  group.traverse(obj => { if (obj.isMesh) obj.geometry?.dispose() })
  const out = new THREE.Group()
  for (const [mat, geoms] of byMat) {
    const merged = mergeGeometries(geoms, false)
    for (const g of geoms) g.dispose()
    if (merged) {
      const mesh = new THREE.Mesh(merged, mat)
      mesh.castShadow = false
      mesh.receiveShadow = false
      out.add(mesh)
    }
  }
  return out
}
