// Erosion filter (ADR-0024 — supersedes ADR-0023 §2 of 2's per-region version; see
// TerrainPeak.js for the Peak cones this layers on top of). A faithful port of the real
// "Fast and Gorgeous Erosion Filter" Buffer A source (ErosionFilter + PhacelleNoise, by
// Rune Skovbo Johansen — obtained directly after Shadertoy blocked automated fetching;
// ported and validated against a synthetic Voronoi mesh prototype before landing here —
// see docs/adr/0023, docs/adr/0024). Z-only: no point is ever minted, only existing
// registry points' z is mutated, so this can never produce a hole/overlap by construction.
//
// Unlike TerrainPeak.js (regenerated only when a High-ground cluster's own membership
// changes), this runs on EVERY pullback pass (GroundplaneAudit.
// _applyRiverCliffPullbackToTerrainPlots calls it right after _syncGroundplaneSurfaces),
// because it operates on the SUBDIVIDED mesh — the coarse generative-layer mesh is too
// sparse for gully/ridge detail to read — and TerrainSubdivision.js fully wipes and
// re-mints the 'terrain-subdiv' point kind every single call. It MUST recompute fresh from
// the current (already cone-bumped, already-subdivision-smoothed) base z every time, never
// accumulating its own prior output — verified idempotent in TerrainErosion.test.mjs, the
// same discipline TerrainZHeight.js's own _zEffectCallCount diagnostic exists to enforce
// elsewhere.
//
// Global reach, not grouped by region or cluster at all (confirmed live 2026-07-31:
// "erosion should flow over to all adjacent terrains within the Cone height, no matter if
// high terrain or not") — ONE shared vertex-neighbour graph across the ENTIRE map's own
// non-hidden terrainSurfaces, and every Peak from every region (regardless of that
// region's own type) competes for "nearest Peak" at every vertex. A Peak's own
// erosionRadius doesn't stop at its containing region's or cluster's boundary; it reaches
// into whatever neighbouring terrain is geometrically within range — Plains, Forest,
// anything — the same way the real slope of a real mountain doesn't stop being eroded
// just because the map drew an administrative line nearby. Every EROSION_* tunable is one
// shared HIGH_GROUND_EROSION config; only a Peak's own coneRadius/peakBump/erosionRadius
// (sized off ITS OWN containing region's CONE_RADIUS_FRACTION/CONE_HEIGHT_RATIO) stay
// per-region. Each vertex scopes itself to its NEAREST Peak (Peaks never combine here —
// TerrainPeak.js's own max-combine already resolved overlapping cones at cone-write time;
// this only decides which Peak's erosionRadius/edge-fade/maxSlopeRef a given vertex falls
// under, and which other vertices assigned to the SAME Peak its own min/max-height
// normalization is computed against).
//
// Two-pass, snapshot-then-write (confirmed live 2026-07-31, root-caused after roughness
// was measured INCREASING with subdivision resolution — 2/3/4/5 passes giving
// monotonically worse edge-slope, the opposite of what a converging/smooth signal should
// do): every vertex's gradient and base height must read the SAME pre-pass snapshot, never
// the registry as it's being mutated mid-pass. The original single-pass version computed
// `gradientAt` and wrote `p.z` in the same loop, over the same mutable registry — a vertex
// visited later in iteration order could read an EARLIER vertex's already-eroded z as one
// of its own "neighbour" inputs, contaminating its gradient with already-eroded data
// instead of the true pre-erosion slope. This produced a real, order-dependent feedback
// loop: more vertices (finer subdivision) meant longer compounding chains, which is
// exactly why roughness got WORSE at higher TERRAIN_SUBDIVISION_PASSES instead of
// converging — a genuine bug, not aliasing. Fixed by resolving gradient/baseH/fadeTarget
// for every vertex against one shared read-only snapshot, then writing every result back
// to the registry only after every vertex has been evaluated.
//
// The gradient the article's technique needs is approximated via a local least-squares
// finite difference against each vertex's own mesh neighbours (this mesh has no
// closed-form height function to differentiate analytically, unlike the synthetic
// prototype's cone base function).
import { TERRAIN_TYPES, HIGH_GROUND_EROSION } from '../../../worldConfig/terrainConfig.js'

// ── shared math helpers, ported verbatim from the real Buffer A source ──────────────────
function saturate(t) { return Math.max(0, Math.min(1, t)) }
function lerp(a, b, t) { return a + (b - a) * t }
function inverse_lerp(a, b, v) { return (v - a) / (b - a) }
function ease_out(t) { const v = 1 - saturate(t); return 1 - v * v }
function pow_inv(t, power) { return 1 - Math.pow(1 - saturate(t), power) }
// smooth_start: quadratic ease-in below `smoothing`, shifted-linear above it — shapes
// ridge/crease rounding onset in the real filter.
function smooth_start(t, smoothing) {
  if (t >= smoothing) return t - 0.5 * smoothing
  return 0.5 * t * t / smoothing
}
function hash2(x, y) {
  let n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  const hx = 2 * (n - Math.floor(n)) - 1
  n = Math.sin(x * 269.5 + y * 183.3) * 43758.5453123
  const hy = 2 * (n - Math.floor(n)) - 1
  return [hx, hy]
}

// PhacelleNoise: a 4x4-cell, Gaussian-weighted, magnitude-renormalized blend of
// cosine/sine stripe waves oriented along `dirx,diry`.
function phacelleNoise(px, py, dirx, diry, cellFreq, offset, normalization) {
  const TAU = Math.PI * 2
  const sidex = diry * -1 * cellFreq * TAU
  const sidey = dirx * 1 * cellFreq * TAU
  const off = offset * TAU
  const pIntX = Math.floor(px), pIntY = Math.floor(py)
  const pFracX = px - pIntX, pFracY = py - pIntY
  let phaseX = 0, phaseY = 0, weightSum = 0
  for (let i = -1; i <= 2; i++) {
    for (let j = -1; j <= 2; j++) {
      const [rx, ry] = hash2(pIntX + i, pIntY + j)
      const randX = rx * 0.5, randY = ry * 0.5
      const vecX = pFracX - i - randX, vecY = pFracY - j - randY
      const sqrDist = vecX * vecX + vecY * vecY
      let weight = Math.exp(-sqrDist * 2.0)
      weight = Math.max(0, weight - 0.01111)
      weightSum += weight
      const waveInput = vecX * sidex + vecY * sidey + off
      phaseX += Math.cos(waveInput) * weight
      phaseY += Math.sin(waveInput) * weight
    }
  }
  const interpX = phaseX / weightSum, interpY = phaseY / weightSum
  let magnitude = Math.sqrt(interpX * interpX + interpY * interpY)
  magnitude = Math.max(1 - normalization, magnitude)
  return { c: interpX / magnitude, s: interpY / magnitude, sidex, sidey }
}

// Fixed demo defaults from the real Buffer A source, not exposed per-type — see the
// validated prototype's own doc comment for why these specific values are kept as
// constants rather than TERRAIN_TYPES fields.
const CELL_SCALE = 0.7
const ONSET = [1.25, 1.25, 2.8, 1.5]
const ASSUMED_SLOPE = [0.7, 1.0]
const ROUNDING_Z = 0.1

// Faithful port of the real ErosionFilter octave loop. `p.maxSlopeRef` is a labelled
// adaptation (not in the original source): ONSET's constants were tuned for the shader's
// own ~[0,1] UV/height range, which this game's world doesn't share, so slope is
// normalized against a domain-scaled reference before feeding the onset thresholds —
// everything else here is a direct, unscaled port, including the sign-corrected gradient
// (redirects the NEXT octave, does not warp height into a triangle wave) and fading
// unmasked height toward fadeTarget rather than toward "add nothing".
//
// `strength *= scale; freq = 1/(scale*CELL_SCALE)` (== p.freq, a no-op round trip — kept
// exactly as the source has it rather than simplified away): this is a DELIBERATE
// coupling both the real Buffer A source AND our own validated synthetic-mesh prototype
// have — there is no independent EROSION_SCALE knob, `p.freq` alone drives it, so a lower
// freq deliberately produces a stronger effect (confirmed live 2026-07-29 against the
// prototype's own "Gully frequency: 0.50" being the user's validated favourite: at that
// value the effective strength is already ~2.9x the nominal EROSION_STRENGTH, and that
// amplification is part of what "looked good", not incidental to it).
// An EARLIER version of this file removed the coupling entirely, reasoning it caused
// runaway strength for a large coneRadius — that diagnosis conflated two different
// things. The coupling itself is fine (it's exactly what the prototype validated); the
// actual problem was `p.freq` being pre-divided by `coneRadius` in applyTerrainErosion
// below, landing far outside the ~0.5-6 range the prototype's own slider (and this
// formula) was designed around — a coneRadius of 32 turned EROSION_FREQ=0.5 into
// freq=0.016, and `scale=1/(freq*CELL_SCALE)` exploded from there. Fixed at the source
// (applyTerrainErosion no longer divides by coneRadius — EROSION_FREQ is a raw value,
// same semantics as the prototype's own slider), not by stripping this coupling again.
export function erosionFilterAt(px, py, height0, gx0, gy0, fadeTarget0, p) {
  const scale = 1 / (p.freq * CELL_SCALE)
  let strength = p.strength * scale
  let fadeTarget = Math.max(-1, Math.min(1, fadeTarget0))

  let h = height0, gx = gx0, gy = gy0
  let freq = p.freq   // == 1/(scale*CELL_SCALE), see comment above
  const slopeLenRaw = Math.max(Math.hypot(gx, gy), 1e-10)
  let slopeLength = slopeLenRaw / p.maxSlopeRef
  let roundingMult = 1.0
  const roundingW = p.lacunarity

  const roundingForInput = lerp(p.creaseRound, p.ridgeRound, saturate(fadeTarget * 0.5 + 0.5)) * ROUNDING_Z
  let combiMask = ease_out(smooth_start(slopeLength * ONSET[0], roundingForInput * ONSET[0]))

  let gsx = lerp(gx, (gx / slopeLenRaw) * ASSUMED_SLOPE[0], ASSUMED_SLOPE[1])
  let gsy = lerp(gy, (gy / slopeLenRaw) * ASSUMED_SLOPE[0], ASSUMED_SLOPE[1])

  for (let i = 0; i < p.octaves; i++) {
    const dirLen = Math.hypot(gsx, gsy)
    const ndx = dirLen > 1e-10 ? gsx / dirLen : gsx
    const ndy = dirLen > 1e-10 ? gsy / dirLen : gsy

    const ph = phacelleNoise(px * freq, py * freq, ndx, ndy, CELL_SCALE, 0.25, p.normalization)
    const dzx = ph.sidex * -freq, dzy = ph.sidey * -freq
    const sloping = Math.abs(ph.s)
    const sgn = Math.sign(ph.s)

    gsx += sgn * dzx * strength * p.gullyWeight
    gsy += sgn * dzy * strength * p.gullyWeight

    const gulliesX = ph.c, gulliesY = ph.s * dzx, gulliesZ = ph.s * dzy
    const fadedX = lerp(fadeTarget, gulliesX * p.gullyWeight, combiMask)
    const fadedY = lerp(0, gulliesY * p.gullyWeight, combiMask)
    const fadedZ = lerp(0, gulliesZ * p.gullyWeight, combiMask)

    h += fadedX * strength
    gx += fadedY * strength
    gy += fadedZ * strength
    fadeTarget = fadedX

    const roundingForOctave = lerp(p.creaseRound, p.ridgeRound, saturate(ph.c * 0.5 + 0.5)) * roundingMult
    const newMask = ease_out(smooth_start(sloping * ONSET[1], roundingForOctave * ONSET[1]))
    combiMask = pow_inv(combiMask, p.detail) * newMask

    strength *= p.gain
    freq *= p.lacunarity
    roundingMult *= roundingW
  }
  return h
}

// Local least-squares gradient estimate over a vertex's own mesh neighbours — this mesh
// has no closed-form height function to differentiate analytically, unlike the synthetic
// prototype's cone base. Falls back to a flat (zero) gradient wherever a vertex has fewer
// than 2 neighbours or its neighbours are near-collinear (a degenerate, near-zero
// determinant) — a reasonable degrade at the sparse edge of a region's own quad set.
// `snapshotZ`: Map<id, z> — the pre-pass snapshot every vertex's gradient must read
// against (see this file's own top-of-file doc comment for why: reading the live,
// mid-mutation registry here was a real, order-dependent feedback bug).
function gradientAt(registry, id, neighbors, snapshotZ) {
  const p = registry.get(id)
  const pz = snapshotZ.get(id)
  if (!p || pz == null) return { gx: 0, gy: 0 }
  const nbs = [...(neighbors.get(id) || [])]
    .map(nid => {
      const np = registry.get(nid)
      const nz = snapshotZ.get(nid)
      return np && nz != null ? { x: np.x, y: np.y, z: nz } : null
    })
    .filter(Boolean)
  if (nbs.length < 2) return { gx: 0, gy: 0 }
  let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0
  for (const n of nbs) {
    const dx = n.x - p.x, dy = n.y - p.y, dz = n.z - pz
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy
    sxz += dx * dz; syz += dy * dz
  }
  const det = sxx * syy - sxy * sxy
  if (Math.abs(det) < 1e-9) return { gx: 0, gy: 0 }
  return { gx: (sxz * syy - syz * sxy) / det, gy: (syz * sxx - sxz * sxy) / det }
}

// Applies the erosion filter across the WHOLE map's non-hidden subdivided quads in
// `terrainSurfaces`, mutating registry point z in place. `regionsById`: Map<id, region> —
// every region with Peaks contributes them, regardless of that region's own assignedType.
// `pinnedSurfaceArrays`: the same [riverCliffFaces, cliffEdgeBands, shoreBands] pattern
// TerrainExtrusion.js used to pin — a corner already owned by one of those must never move
// here either, or the transition band on the other side of it goes out of sync.
export function applyTerrainErosion(registry, terrainSurfaces, regionsById, pinnedSurfaceArrays = []) {
  if (!terrainSurfaces?.length) return

  const pinnedIds = new Set()
  for (const arr of pinnedSurfaceArrays) for (const surf of arr || []) for (const id of surf.pointIds || []) pinnedIds.add(id)

  const quads = terrainSurfaces.filter(q => !q.hidden)
  if (!quads.length) return

  const vertexIds = new Set()
  const neighbors = new Map()
  for (const q of quads) {
    const ids = q.pointIds, n = ids.length
    for (let i = 0; i < n; i++) {
      vertexIds.add(ids[i])
      const a = ids[i], b = ids[(i + 1) % n]
      if (a === b) continue
      if (!neighbors.has(a)) neighbors.set(a, new Set())
      if (!neighbors.has(b)) neighbors.set(b, new Set())
      neighbors.get(a).add(b)
      neighbors.get(b).add(a)
    }
  }

  // Every Peak from every region with one, regardless of that region's own type — a
  // Peak's reach isn't limited to its own region or cluster (see top-of-file doc comment).
  // Sized off ITS OWN containing region's bounding radius, approximated from that region's
  // own quad points across the WHOLE map's mesh (terrainPlots isn't available in this
  // function — the subdivided points span the same extent the coarse domain did).
  const regionBoundingRadius = new Map()
  const boundingRadiusFor = (region) => {
    if (regionBoundingRadius.has(region.id)) return regionBoundingRadius.get(region.id)
    let r = 0
    for (const q of quads) {
      if (q.parentRegionId !== region.id) continue
      for (const id of q.pointIds) {
        const p = registry.get(id)
        if (p) r = Math.max(r, Math.hypot(p.x - region.seedPoint.x, p.y - region.seedPoint.y))
      }
    }
    regionBoundingRadius.set(region.id, r)
    return r
  }
  const peaks = []
  for (const region of regionsById.values()) {
    const rule = TERRAIN_TYPES[region.assignedType]
    if (!rule?.CONE_RADIUS_FRACTION || !region.peaks?.length) continue
    const boundingRadius = boundingRadiusFor(region)
    const coneRadius = rule.CONE_RADIUS_FRACTION * boundingRadius
    const peakBump = rule.CONE_HEIGHT_RATIO * boundingRadius
    const erosionRadius = HIGH_GROUND_EROSION.RADIUS_FRACTION * boundingRadius
    if (erosionRadius <= 0) continue
    // Same "average amplitude/radius" proxy for a typical slope magnitude the synthetic
    // prototype used (avgAmpR * 1.6) — the cone's own average slope stands in for the
    // mound amplitude/radius ratio.
    const maxSlopeRef = Math.max((peakBump / Math.max(coneRadius, 1e-6)) * 1.6, 1e-6)
    for (const pk of region.peaks) peaks.push({ x: pk.x, y: pk.y, region, erosionRadius, maxSlopeRef })
  }
  if (!peaks.length) return

  const params = {
    strength: HIGH_GROUND_EROSION.STRENGTH,
    octaves: HIGH_GROUND_EROSION.OCTAVES,
    // Raw, NOT normalized by any region's own coneRadius (see erosionFilterAt's own doc
    // comment) — same semantics as the validated prototype's own "Gully frequency" slider:
    // one absolute value shared everywhere, not scaled per-region.
    freq: HIGH_GROUND_EROSION.FREQ,
    lacunarity: HIGH_GROUND_EROSION.LACUNARITY,
    gain: HIGH_GROUND_EROSION.GAIN,
    detail: HIGH_GROUND_EROSION.DETAIL,
    gullyWeight: HIGH_GROUND_EROSION.GULLY_WEIGHT,
    ridgeRound: HIGH_GROUND_EROSION.RIDGE_ROUNDING,
    creaseRound: HIGH_GROUND_EROSION.CREASE_ROUNDING,
    normalization: HIGH_GROUND_EROSION.NORMALIZATION,
  }

  // Pass 1: assign every eligible vertex to its nearest Peak, and snapshot its CURRENT
  // (pre-this-pass) z — the read-only baseline everything below is computed against, so no
  // vertex's own result can ever depend on another vertex's result from this same pass
  // (see top-of-file doc comment for why that was a real bug).
  const snapshotZ = new Map()
  const assignment = new Map()   // vertex id -> { nearest, nearestD }
  for (const id of vertexIds) {
    if (pinnedIds.has(id)) continue
    const p = registry.get(id)
    if (!p || p.zLocked) continue
    let nearest = null, nearestD = Infinity
    for (const peak of peaks) {
      const d = Math.hypot(p.x - peak.x, p.y - peak.y)
      if (d < nearestD) { nearestD = d; nearest = peak }
    }
    if (!nearest || nearestD >= nearest.erosionRadius) continue
    assignment.set(id, { nearest, nearestD })
    snapshotZ.set(id, p.z)
  }
  if (!assignment.size) return
  // A vertex just outside every Peak's radius can still be an eroding neighbour's own
  // gradient input — its real (untouched) height needs to be in the snapshot too.
  for (const id of assignment.keys()) {
    for (const nid of neighbors.get(id) || []) {
      if (!snapshotZ.has(nid)) { const np = registry.get(nid); if (np) snapshotZ.set(nid, np.z) }
    }
  }

  // Pass 2: min/max height per Peak, over only the vertices actually assigned to it (from
  // the snapshot) — the fadeTarget0 normalization each of its own vertices needs.
  const peakMinMax = new Map()
  for (const [id, { nearest }] of assignment) {
    const z = snapshotZ.get(id)
    let mm = peakMinMax.get(nearest)
    if (!mm) { mm = { min: Infinity, max: -Infinity }; peakMinMax.set(nearest, mm) }
    if (z < mm.min) mm.min = z
    if (z > mm.max) mm.max = z
  }

  // Pass 3: compute every result from the snapshot only, store separately, and write to
  // the registry once everything's been computed — never mid-pass (see top-of-file doc
  // comment; this is the actual fix for the order-dependent feedback bug).
  const newZ = new Map()
  for (const [id, { nearest, nearestD }] of assignment) {
    const p = registry.get(id)
    const mm = peakMinMax.get(nearest)
    if (!mm || mm.max <= mm.min) continue
    const { gx, gy } = gradientAt(registry, id, neighbors, snapshotZ)
    const baseH = snapshotZ.get(id)
    const fadeTarget0 = saturate(inverse_lerp(mm.min, mm.max, baseH)) * 2 - 1
    // Fades erosion strength to 0 at erosionRadius — no hard seam at the boundary.
    const edgeFade = ease_out(saturate(1 - nearestD / nearest.erosionRadius))
    const scopedParams = { ...params, strength: params.strength * edgeFade, maxSlopeRef: nearest.maxSlopeRef }
    newZ.set(id, erosionFilterAt(p.x, p.y, baseH, gx, gy, fadeTarget0, scopedParams))
  }
  for (const [id, z] of newZ) registry.get(id).z = z

  // subdivideTerrain()'s quads carry a materialized `.polygon` snapshot, not a live
  // reference — TerrainHeightSampler.js (walk-mode height queries) reads `.polygon`
  // directly, so it must be refreshed here or eroded terrain renders correctly but
  // samples the wrong (pre-erosion) height.
  for (const q of quads) {
    const resolved = q.pointIds.map(id => {
      const rp = registry.get(id)
      return rp ? { x: rp.x, y: rp.y, z: rp.z } : null
    })
    if (resolved.every(Boolean)) q.polygon = resolved
  }
}
