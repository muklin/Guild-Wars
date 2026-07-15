// The authoritative shared Groundplane vertex store (see CONTEXT_WorldTerrain.md's
// "Point"/"Surface" definitions; supersedes docs/adr/0018, which kept polygon-soup and
// only added point dedup as an additive diagnostic — see docs/adr/0020). Every terrain
// plot, district, street, gutter, block, and building-plot Surface references its
// corners by Point id here, not by embedding its own {x,y} copies. Two Surfaces that
// share a corner reference the SAME id, so moving that Point's x/y/z moves it for every
// Surface that touches it — no coordinate-rounding, snapping, or delta-propagation
// needed to keep them in sync, because there is nothing to keep in sync.
//
// Two different point lifetimes coexist deliberately (see plan Grounding findings):
//   - 'terrain' points are DURABLE — minted once by TerrainVoronoiGenerator, then only
//     ever read, never rebuilt, until _recoverGeometryFromSeeds() does a full intentional
//     reset.
//   - 'district-split' | 'terrain-split' | 'street' | 'gutter' | 'block' | 'plot' points
//     are EPHEMERAL — river/cliff pullback recomputes every split point fresh from the
//     pristine 'terrain' base on every call (SetupPhase._applyRiverCliffPullback /
//     _applyRiverCliffPullbackToTerrainPlots each call registry.clearKind() on their own
//     split kind first), exactly like the street graph, blocks, and building plots are
//     already fully rebuilt from scratch on every generation pass (GameStateManager.
//     serialize() doesn't even persist plots). None of these kinds need cross-call id
//     stability — only 'terrain' points do.
export default class GroundPointRegistry {
  constructor(points = []) {
    this._byId = new Map(points.map(p => [p.id, p]))
    this._nextId = points.reduce((m, p) => Math.max(m, p.id), -1) + 1
    // baseId -> Map(side -> split Point). `side` is typically the exact {dx,dy} group
    // object _computeRiverCliffDeltas resolved for a vertex (a real object reference,
    // shared across every vertex that landed in the same direction-group) — a nested Map
    // is used specifically so `side` can be compared by REFERENCE identity (Map's
    // SameValueZero semantics), not stringified, which would collide every distinct
    // object onto the same "[object Object]" key. Rebuilt fresh by every pullback pass
    // (never persisted) — see getOrCreateSplit.
    this._splitIndex = new Map()
  }

  create(x, y, z = 0, kind) {
    const p = { id: this._nextId++, x, y, z, kind }
    this._byId.set(p.id, p)
    return p
  }

  get(id) {
    return this._byId.get(id)
  }

  // Resolve an ordered list of ids to their current point objects. Missing ids are
  // dropped (with a warning) rather than throwing — a renderer with one stale/missing
  // corner should still draw the rest of the polygon, not crash the frame.
  resolve(ids) {
    const out = []
    for (const id of ids) {
      const p = this._byId.get(id)
      if (p) out.push(p)
      else console.warn(`[GroundPointRegistry] resolve: missing point id ${id}`)
    }
    return out
  }

  // Remove every point of the given kind(s) — used to wipe the ephemeral layer
  // (street/gutter/block/plot) before each fresh generation pass. Also clears the split
  // index, since splits are always re-derived alongside whatever they were split from.
  clearKind(kinds) {
    const set = new Set(Array.isArray(kinds) ? kinds : [kinds])
    for (const [id, p] of this._byId) if (set.has(p.kind)) this._byId.delete(id)
    this._splitIndex.clear()
  }

  // River/cliff pullback support: get (or lazily create) the Point that `baseId` splits
  // into on a given `side` this pass. Called once per (baseId, side) per pullback pass —
  // repeat calls for the same pair within one pass return the same Point object, so
  // every Surface whose delta resolved to the same side gets the same split Point by
  // construction. The index is NOT persisted and is cleared at the start of every
  // pullback pass (via clearKind, or explicitly — see SetupPhase's pullback functions),
  // so a River/Cliff assignment that's later cleared naturally stops producing splits.
  getOrCreateSplit(baseId, side, x, y, z, kind) {
    let inner = this._splitIndex.get(baseId)
    if (!inner) { inner = new Map(); this._splitIndex.set(baseId, inner) }
    let split = inner.get(side)
    if (!split) {
      split = this.create(x, y, z, kind)
      // Lineage back to the vertex this was split FROM — survives this pass's
      // _splitIndex being cleared (unlike the index itself), so a caller holding onto
      // a RAW/pre-split id (e.g. a district's frozen _rawPointIds snapshot) can still
      // re-resolve "what does my raw vertex X currently look like" by scanning any
      // CURRENT point set for a matching .baseId — without needing the two id spaces
      // to stay positionally aligned. See SetupPhase._applyRiverCliffPullback.
      split.baseId = baseId
      inner.set(side, split)
    }
    return split
  }

  clearSplits() {
    this._splitIndex.clear()
  }

  // Resolve a flat batch of {x,y} vertex refs to point ids, deduping by coordinate
  // proximity (grid-bucketed, so this stays roughly O(n) for realistic inputs) rather
  // than object identity — two DIFFERENT vertex objects that land within `tolerance` of
  // each other resolve to the SAME id. Two uses:
  //  1. Initial minting (TerrainVoronoiGenerator Step 4): most shared corners already
  //     arrive as genuinely-shared object references (fast-pathed here for free via an
  //     object-identity cache), but a real minority of Voronoi vertices that are
  //     conceptually the same corner come back as numerically-close-but-distinct
  //     circumcenter objects (near-cocircular seed quadruples are numerically unstable)
  //     — those need coordinate dedup too, or they mint permanently-different ids for
  //     what's visually one corner, and river/cliff pullback (which groups strictly by
  //     id) can never keep them in sync, showing up as a gap/spike right at that corner.
  //  2. _recoverGeometryFromSeeds: the recovery polygon comes from a DIFFERENT Voronoi
  //     implementation (computeVoronoiCellsHalfPlane) with no vertex-object relationship
  //     to the original 'terrain' points at all — `reuseExisting: true` seeds the lookup
  //     from every existing point of this kind first, so a recovered vertex reuses the
  //     ORIGINAL id at that position (ids stay durable) instead of every recovery pass
  //     minting a fresh, unrelated set and leaving old pointIds referencing stale spots.
  mintDeduped(vertices, kind, tolerance = 0.05, { reuseExisting = false } = {}) {
    const cellSize = tolerance * 4
    const cellKey = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`
    const buckets = new Map()
    const addToBucket = (x, y, id) => {
      const k = cellKey(x, y)
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k).push({ x, y, id })
    }
    if (reuseExisting) {
      for (const p of this._byId.values()) if (p.kind === kind) addToBucket(p.x, p.y, p.id)
    }
    const tol2 = tolerance * tolerance
    const byRef = new Map()   // object reference -> id, fast path for genuinely shared refs
    const ids = new Array(vertices.length)
    for (let vi = 0; vi < vertices.length; vi++) {
      const v = vertices[vi]
      if (byRef.has(v)) { ids[vi] = byRef.get(v); continue }
      const [gx, gy] = cellKey(v.x, v.y).split(',').map(Number)
      let foundId = null
      for (let dgx = -1; dgx <= 1 && foundId === null; dgx++) {
        for (let dgy = -1; dgy <= 1 && foundId === null; dgy++) {
          const bucket = buckets.get(`${gx + dgx},${gy + dgy}`)
          if (!bucket) continue
          for (const entry of bucket) {
            if ((entry.x - v.x) ** 2 + (entry.y - v.y) ** 2 < tol2) { foundId = entry.id; break }
          }
        }
      }
      let id
      if (foundId !== null) {
        id = foundId
        // Snap the reused point to this call's (freshly-known-correct, e.g. post-
        // recovery) coordinate rather than leaving it at whatever position it was first
        // minted at — self-healing on every call instead of accumulating drift.
        const existing = this._byId.get(id)
        if (existing) { existing.x = v.x; existing.y = v.y }
      } else {
        // v.z, when the caller set one (e.g. a District/Terrain z-height pass backfilling
        // before minting) — not a hardcoded 0. A tolerance-miss here used to silently
        // flatten real z data: _recoverGeometryFromSeeds calls this with `reuseExisting`
        // on a freshly-recomputed (pre-pullback) polygon, and a corner that went through
        // Cliff/River pullback can legitimately sit further than `tolerance` from its own
        // already-correct point, missing the dedup match and mint a "new" point here —
        // previously always at z=0 regardless of what the caller knew.
        const p = this.create(v.x, v.y, v.z ?? 0, kind); id = p.id; addToBucket(v.x, v.y, id)
      }
      byRef.set(v, id)
      ids[vi] = id
    }
    return ids
  }

  get size() {
    return this._byId.size
  }

  toJSON() {
    return [...this._byId.values()]
  }
}
