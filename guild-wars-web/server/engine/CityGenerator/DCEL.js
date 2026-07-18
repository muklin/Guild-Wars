// A doubly-connected edge list (half-edge topology) over the SAME shared vertex store
// GroundPointRegistry.js already provides. See plan "typed-giggling-giraffe" (full DCEL
// groundplane topology, supersedes the lighter Point/Surface model) for the design this
// implements. GroundPointRegistry's Point shape ({id,x,y,z,kind}) IS this DCEL's Vertex —
// composed here, not replaced; every Vertex-minting/dedup call (create, mintDeduped,
// getOrCreateSplit, clearKind) still goes straight through the registry unchanged.
//
// HalfEdge: { id, origin: vertexId, twin: heId, next: heId, prev: heId, face: faceId|null,
//             chain: chainId|null }
//   face === null means "void" — the unbounded/outer side of a boundary edge with no
//   neighboring Face yet (or ever, for a true outer boundary).
//
// Face: { id, outerEdge: heId, kind, ...domain payload (assignedType, seedPoint, etc,
//         passed through untouched — DCEL only owns topology, not domain fields) }
//
// Two vertex lifetimes coexist, exactly as in GroundPointRegistry: 'terrain' vertices
// (and non-split Face loops built from them) are durable, rebuilt only by an explicit
// _recoverGeometryFromSeeds-style wholesale rebuild; '*-split' / 'street' / 'gutter' /
// 'block' / 'plot' vertices and the half-edges/faces built from them are ephemeral,
// wiped every generation pass via clearEphemeral (mirrors registry.clearKind).

// Collapse consecutive duplicate ids (including the wraparound last-equals-first case)
// before handing a vertex-id loop to insertFace. A near-duplicate PAIR of ADJACENT
// polygon corners is a real, observed case — registry.mintDeduped's coordinate-
// proximity tolerance can legitimately map two consecutive input vertices onto the
// SAME point id (confirmed: two ~0.0001-apart corners in real generated plot geometry).
// Left alone, that produces a zero-length (u===v) directed edge, which insertFace
// correctly rejects as a self-loop rather than silently accepting a degenerate face —
// sanitize the INPUT here instead of loosening insertFace's own validation.
export function dedupeConsecutiveIds(ids) {
  const out = []
  for (const id of ids) {
    if (out.length === 0 || out[out.length - 1] !== id) out.push(id)
  }
  if (out.length > 1 && out[0] === out[out.length - 1]) out.pop()
  return out
}
export default class DCEL {
  constructor(pointRegistry) {
    this.points = pointRegistry
    this._halfEdgesById = new Map()
    this._facesById = new Map()
    this._chainsById = new Map()
    // Directed vertex-pair -> half-edge id, e.g. "3,7" for the half-edge whose origin is
    // vertex 3 and which ends at vertex 7. The construction-time adjacency index —
    // insertFace both reads it (to find/reclaim an already-minted twin) and writes it
    // (registering its own new half-edges) every call.
    this._heByDirectedPair = new Map()
    this._nextHeId = 1
    this._nextFaceId = 1
    this._nextChainId = 1
  }

  // ─── Half-edge / face access ────────────────────────────────────────────────

  getHalfEdge(id) { return this._halfEdgesById.get(id) }
  getFace(id) { return this._facesById.get(id) }
  getChain(id) { return this._chainsById.get(id) }

  _mintHalfEdge(origin, face) {
    const he = { id: this._nextHeId++, origin, twin: null, next: null, prev: null, face, chain: null }
    this._halfEdgesById.set(he.id, he)
    return he
  }

  _deleteHalfEdgePair(heId, twinId) {
    const he = this._halfEdgesById.get(heId), twin = this._halfEdgesById.get(twinId)
    if (he) {
      this._heByDirectedPair.delete(`${he.origin},${twin?.origin}`)
      this._halfEdgesById.delete(heId)
    }
    if (twin) {
      this._heByDirectedPair.delete(`${twin.origin},${he?.origin}`)
      this._halfEdgesById.delete(twinId)
    }
  }

  _setVertexAnchor(vertexId, heId) {
    const v = this.points.get(vertexId)
    if (v) v.halfEdge = heId
  }

  // ─── Construction ───────────────────────────────────────────────────────────

  // Insert a new Face whose boundary is the given ordered (consistently-wound) list of
  // EXISTING vertex ids. For each boundary segment (u->v): if a half-edge (v->u) was
  // already minted by a previously-inserted neighboring face, twin to it directly (or,
  // if THIS exact directed edge (u->v) was already minted as a void-side placeholder by
  // an earlier call, reclaim it — see below). Otherwise mint a fresh half-edge pair,
  // (u->v) owned by this face and (v->u) as a void placeholder (face:null) that a LATER
  // neighboring face's insertFace call will reclaim, or that stays void forever for a
  // true outer boundary. This placeholder-then-reclaim scheme is what lets faces be
  // inserted in any order and still end up correctly twinned, without a two-pass
  // "insert everything, then link" step.
  // options.detached: mint every half-edge fresh, neither reading nor writing
  // _heByDirectedPair — the face gets valid internal next/prev/twin structure but is
  // NOT stitched into the surrounding topology (no placeholder reclaim, no conflict
  // checks). Last-resort escape hatch for a face whose boundary legitimately traverses
  // directed pairs owned in BOTH directions (e.g. a river face between two confluence
  // splices of opposite local winding — see SetupPhase._buildRiverCliffFaces): the
  // rendered polygon is exactly right even though the pointer graph around it isn't
  // manifold. Stage C's topology-native generation removes the need for this.
  insertFace(vertexIds, kind, payload = {}, { detached = false } = {}) {
    const n = vertexIds.length
    if (n < 3) throw new Error(`DCEL.insertFace: need >=3 vertices, got ${n}`)
    const faceId = this._nextFaceId++
    // `id`/`outerEdge` last, after the payload spread — the DCEL's own id-space must
    // win over a caller-supplied payload field of the same name, or _facesById's key
    // (always the real numeric faceId) silently stops matching face.id.
    const face = { kind, ...payload, id: faceId, outerEdge: null }

    const loopHalfEdges = []
    for (let i = 0; i < n; i++) {
      const u = vertexIds[i], v = vertexIds[(i + 1) % n]
      const key = `${u},${v}`
      let he = detached ? null : this._halfEdgesById.get(this._heByDirectedPair.get(key))
      if (he) {
        if (he.face !== null) {
          throw new Error(`DCEL.insertFace: directed edge ${key} already owned by face ${he.face} — overlapping faces or inconsistent winding`)
        }
        he.face = faceId
      } else if (detached) {
        he = this._mintHalfEdge(u, faceId)
        const twin = this._mintHalfEdge(v, null)
        he.twin = twin.id
        twin.twin = he.id
      } else {
        he = this._mintHalfEdge(u, faceId)
        this._heByDirectedPair.set(key, he.id)
        const revKey = `${v},${u}`
        const existingRevId = this._heByDirectedPair.get(revKey)
        if (existingRevId) {
          const rev = this._halfEdgesById.get(existingRevId)
          he.twin = rev.id
          rev.twin = he.id
        } else {
          const twin = this._mintHalfEdge(v, null)
          he.twin = twin.id
          twin.twin = he.id
          this._heByDirectedPair.set(revKey, twin.id)
        }
      }
      loopHalfEdges.push(he)
    }

    for (let i = 0; i < n; i++) {
      const cur = loopHalfEdges[i], nxt = loopHalfEdges[(i + 1) % n]
      cur.next = nxt.id
      nxt.prev = cur.id
    }
    face.outerEdge = loopHalfEdges[0].id
    for (let i = 0; i < n; i++) this._setVertexAnchor(vertexIds[i], loopHalfEdges[i].id)
    this._facesById.set(faceId, face)
    return face
  }

  // Ordered vertex ids around a face's boundary, walking outerEdge -> .next -> ... .
  // Asserts manifold-ness (see plan "Hard cases to test"): the walk must return to the
  // start within faceHalfEdgeIds().length steps, visiting that many DISTINCT half-edges
  // — a loop that doesn't close (or revisits) indicates corrupted next/prev pointers,
  // which is a strictly worse failure mode than the flat-polygon model ever had (that
  // model just produced a visibly-wrong polygon; this one can spin forever), so this
  // fails loudly rather than silently.
  walkFacePolygon(faceId) {
    return this._faceHalfEdges(faceId).map(he => he.origin)
  }

  _faceHalfEdges(faceId) {
    const face = this._facesById.get(faceId)
    if (!face) throw new Error(`DCEL._faceHalfEdges: no face ${faceId}`)
    const start = face.outerEdge
    const seen = new Set()
    const out = []
    let cur = start
    do {
      if (seen.has(cur)) throw new Error(`DCEL._faceHalfEdges: face ${faceId} loop revisits half-edge ${cur} without closing — corrupted next/prev pointers`)
      seen.add(cur)
      const he = this._halfEdgesById.get(cur)
      if (!he) throw new Error(`DCEL._faceHalfEdges: face ${faceId} references missing half-edge ${cur}`)
      out.push(he)
      cur = he.next
      if (out.length > this._halfEdgesById.size + 1) {
        throw new Error(`DCEL._faceHalfEdges: face ${faceId} loop did not close after ${out.length} steps — corrupted next/prev pointers`)
      }
    } while (cur !== start)
    return out
  }

  // Resolve a face's boundary straight to {x,y,z} — the materialized-view mechanism
  // that keeps every existing .polygon/.blockCorners consumer unchanged (see plan
  // Data model section).
  resolveFacePolygon(faceId) {
    return this.walkFacePolygon(faceId).map(id => {
      const p = this.points.get(id)
      return p ? { x: p.x, y: p.y, z: p.z ?? 0 } : null
    }).filter(Boolean)
  }

  // ─── Face merge (replaces CityBlockGenerator._unionPolygons and
  // PlotVoronoiGenerator._mergeSmallPlots' independently-duplicated directed-edge-
  // cancellation union) ────────────────────────────────────────────────────────
  //
  // Kills every shared half-edge pair between faceA and faceB (their common boundary,
  // one or more segments, contiguous or not), relinks prev/next across each seam, and
  // reassigns faceB's remaining boundary to faceA. faceA's id/payload survives; faceB is
  // deleted. Returns the merged face, or null if the two faces don't share a boundary.
  mergeFaces(faceIdA, faceIdB) {
    if (faceIdA === faceIdB) throw new Error('DCEL.mergeFaces: faceIdA === faceIdB')
    const faceA = this._facesById.get(faceIdA)
    if (!faceA) throw new Error(`DCEL.mergeFaces: no face ${faceIdA}`)
    if (!this._facesById.get(faceIdB)) throw new Error(`DCEL.mergeFaces: no face ${faceIdB}`)

    const sharedHeIds = this._faceHalfEdges(faceIdA)
      .filter(he => this._halfEdgesById.get(he.twin)?.face === faceIdB)
      .map(he => he.id)
    if (sharedHeIds.length === 0) return null

    for (const heId of sharedHeIds) {
      const he = this._halfEdgesById.get(heId)
      if (!he) continue   // already consumed by an earlier splice in this same run
      const twin = this._halfEdgesById.get(he.twin)
      const prevA = this._halfEdgesById.get(he.prev), nextA = this._halfEdgesById.get(he.next)
      const prevB = this._halfEdgesById.get(twin.prev), nextB = this._halfEdgesById.get(twin.next)
      prevA.next = nextB.id; nextB.prev = prevA.id
      prevB.next = nextA.id; nextA.prev = prevB.id
      this._deleteHalfEdgePair(he.id, twin.id)
    }

    let survivor = null
    for (const he of this._halfEdgesById.values()) {
      if (he.face === faceIdB) he.face = faceIdA
      if (he.face === faceIdA) survivor = he.id
    }
    if (survivor == null) throw new Error(`DCEL.mergeFaces: merging ${faceIdA}+${faceIdB} left no boundary — degenerate merge (faces cancelled entirely)`)
    faceA.outerEdge = survivor
    this._facesById.delete(faceIdB)
    return faceA
  }

  // Insert a raw graph edge between two EXISTING vertices, with no face on either side
  // and no rotational next/prev linkage yet (both null on both sides). This is the entry
  // point for a raw planar graph (nodes+edges, no face structure — e.g. a street graph
  // mid-repair, before any block/road face has been traced over it) to become real DCEL
  // half-edges. rechainEdge and deleteDanglingEdge both already tolerate a null
  // next/prev (see their own "no neighbor" branches) — that's what makes an edge
  // inserted here immediately usable by them, before any face-tracing pass establishes
  // a genuine rotation system. Mirrors insertFace's own void-side placeholder, which
  // also starts out with prev/next left for a later reclaiming face to set — the
  // difference is nothing is ever "reclaiming" this pair into a real face here; that's
  // a separate, later step (e.g. CityBlockGenerator._traceFaces-style angular walk).
  // Throws if this directed pair (in either direction) already exists.
  insertEdge(u, v) {
    const key = `${u},${v}`, revKey = `${v},${u}`
    if (this._heByDirectedPair.has(key) || this._heByDirectedPair.has(revKey)) {
      throw new Error(`DCEL.insertEdge: directed pair ${key} already exists`)
    }
    const he = this._mintHalfEdge(u, null)
    const twin = this._mintHalfEdge(v, null)
    he.twin = twin.id
    twin.twin = he.id
    this._heByDirectedPair.set(key, he.id)
    this._heByDirectedPair.set(revKey, twin.id)
    this._setVertexAnchor(u, he.id)
    this._setVertexAnchor(v, twin.id)
    return he
  }

  // Re-route half-edge heId (and its twin) through an ordered chain of intermediate
  // vertices, splitting one boundary segment origin->dest into
  // origin->v1->v2->...->vk->dest — without touching which face(s) (or void side) the
  // edge belongs to on either side. Mechanically similar to mergeFaces's prev/next
  // relinking, but through vertices unrelated to any shared boundary between two faces —
  // see plan "logical-booping-bonbon" (StreetVoronoiGenerator DCEL rewrite) §2(c),
  // replacing StreetVoronoiGenerator.absorbCollinearNodes' "delete edge A->B, insert
  // edges A->N1,N1->N2,...,Nk->B".
  //
  // heId: an existing half-edge whose origin->[twin's origin] segment is being split.
  // throughVertexIds: ordered intermediate vertex ids (v1..vk), origin->dest order. []
  //   is a no-op. Both he and its twin keep their original .face/.chain unchanged —
  //   only .next/.prev (and each new segment's own .origin) change; face=null (void)
  //   sides are handled the same as real faces, no special-casing needed.
  // Throws if heId/its twin is missing, or if any NEW directed pair this would create
  // already exists elsewhere in the topology — refusing to silently overwrite, same
  // discipline splitVertexGeneral's fwdKey/revKey guard uses.
  rechainEdge(heId, throughVertexIds) {
    if (!throughVertexIds?.length) return
    const he = this._halfEdgesById.get(heId)
    if (!he) throw new Error(`DCEL.rechainEdge: no half-edge ${heId}`)
    const twin = this._halfEdgesById.get(he.twin)
    if (!twin) throw new Error(`DCEL.rechainEdge: half-edge ${heId} has no twin`)

    const origin = he.origin, dest = twin.origin
    const chain = [origin, ...throughVertexIds, dest]
    for (let i = 0; i < chain.length - 1; i++) {
      const key = `${chain[i]},${chain[i + 1]}`, revKey = `${chain[i + 1]},${chain[i]}`
      if (this._heByDirectedPair.has(key) || this._heByDirectedPair.has(revKey)) {
        throw new Error(`DCEL.rechainEdge: directed pair ${key} already exists — refusing to overwrite`)
      }
    }

    // A void (face:null) side that no face has reclaimed yet never had .next/.prev set
    // in the first place (see insertFace's void-branch — it mints the placeholder but
    // only a LATER reclaiming face's own loop-closing pass assigns them) — splice into
    // an existing neighbor only when one actually exists; an unreclaimed side's new
    // chain ends stay null, exactly like a freshly-minted void placeholder would.
    const prevHe = he.prev != null ? this._halfEdgesById.get(he.prev) : null
    const nextHe = he.next != null ? this._halfEdgesById.get(he.next) : null
    const prevTwin = twin.prev != null ? this._halfEdgesById.get(twin.prev) : null
    const nextTwin = twin.next != null ? this._halfEdgesById.get(twin.next) : null

    this._deleteHalfEdgePair(he.id, twin.id)

    // Forward chain (origin -> v1 -> ... -> dest) reuses he's face/chain; reversed chain
    // (dest -> vk -> ... -> origin) reuses twin's. Twin them pairwise: fwd[i] (chain[i]
    // -> chain[i+1]) pairs with rev[fwd.length-1-i] (chain[i+1] -> chain[i]).
    const fwd = [], rev = []
    for (let i = 0; i < chain.length - 1; i++) {
      const f = this._mintHalfEdge(chain[i], he.face)
      f.chain = he.chain
      this._heByDirectedPair.set(`${chain[i]},${chain[i + 1]}`, f.id)
      fwd.push(f)
    }
    for (let i = chain.length - 1; i > 0; i--) {
      const r = this._mintHalfEdge(chain[i], twin.face)
      r.chain = twin.chain
      this._heByDirectedPair.set(`${chain[i]},${chain[i - 1]}`, r.id)
      rev.push(r)
    }
    for (let i = 0; i < fwd.length; i++) {
      const r = rev[fwd.length - 1 - i]
      fwd[i].twin = r.id
      r.twin = fwd[i].id
    }
    for (let i = 0; i < fwd.length - 1; i++) { fwd[i].next = fwd[i + 1].id; fwd[i + 1].prev = fwd[i].id }
    for (let i = 0; i < rev.length - 1; i++) { rev[i].next = rev[i + 1].id; rev[i + 1].prev = rev[i].id }
    if (prevHe) { prevHe.next = fwd[0].id; fwd[0].prev = prevHe.id }
    if (nextHe) { fwd[fwd.length - 1].next = nextHe.id; nextHe.prev = fwd[fwd.length - 1].id }
    if (prevTwin) { prevTwin.next = rev[0].id; rev[0].prev = prevTwin.id }
    if (nextTwin) { rev[rev.length - 1].next = nextTwin.id; nextTwin.prev = rev[rev.length - 1].id }

    // Either side's owning face (if real, not void) may have anchored its outerEdge on
    // the exact half-edge just deleted — repoint to the new chain's first segment on
    // that side, or the face's own walkFacePolygon would throw on a dangling reference.
    const heFace = he.face != null ? this._facesById.get(he.face) : null
    if (heFace?.outerEdge === he.id) heFace.outerEdge = fwd[0].id
    const twinFace = twin.face != null ? this._facesById.get(twin.face) : null
    if (twinFace?.outerEdge === twin.id) twinFace.outerEdge = rev[0].id

    this._setVertexAnchor(origin, fwd[0].id)
    this._setVertexAnchor(dest, rev[0].id)
    for (let i = 0; i < throughVertexIds.length; i++) this._setVertexAnchor(throughVertexIds[i], fwd[i + 1].id)
  }

  // Delete a half-edge pair that is provably dangling — void (face:null) on BOTH sides —
  // splicing any existing chain neighbors together so a longer void chain stays walkable
  // after removing one hop, same splice shape rechainEdge uses when inserting one. See
  // plan "logical-booping-bonbon" (StreetVoronoiGenerator DCEL rewrite) §2(e): the
  // DCEL-native replacement for pruneAcuteStubs/removeOrphanComponents, which delete
  // dead-end stub edges and small disconnected components respectively.
  //
  // Throws if either side has a REAL face — deleting an edge that's part of an actual
  // face's boundary would corrupt that face (merge or rebuild the face instead; this
  // primitive is only for topology that was never claimed by one), or if heId is
  // unknown. Re-anchors either endpoint vertex if it was pointing at the deleted edge,
  // to any other surviving half-edge originating there, or null if now fully isolated
  // (a linear scan, not outgoingFan — this loose, not-yet-face-bound graph phase can't
  // rely on outgoingFan's manifold-fan-walk assumptions holding).
  deleteDanglingEdge(heId) {
    const he = this._halfEdgesById.get(heId)
    if (!he) throw new Error(`DCEL.deleteDanglingEdge: no half-edge ${heId}`)
    const twin = this._halfEdgesById.get(he.twin)
    if (!twin) throw new Error(`DCEL.deleteDanglingEdge: half-edge ${heId} has no twin`)
    if (he.face !== null || twin.face !== null) {
      throw new Error(`DCEL.deleteDanglingEdge: half-edge ${heId} is part of a real face — not dangling`)
    }

    const prevHe = he.prev != null ? this._halfEdgesById.get(he.prev) : null
    const nextHe = he.next != null ? this._halfEdgesById.get(he.next) : null
    const prevTwin = twin.prev != null ? this._halfEdgesById.get(twin.prev) : null
    const nextTwin = twin.next != null ? this._halfEdgesById.get(twin.next) : null

    if (prevHe && nextHe) { prevHe.next = nextHe.id; nextHe.prev = prevHe.id }
    else { if (prevHe) prevHe.next = null; if (nextHe) nextHe.prev = null }
    if (prevTwin && nextTwin) { prevTwin.next = nextTwin.id; nextTwin.prev = prevTwin.id }
    else { if (prevTwin) prevTwin.next = null; if (nextTwin) nextTwin.prev = null }

    for (const vId of [he.origin, twin.origin]) {
      const v = this.points.get(vId)
      if (!v || (v.halfEdge !== he.id && v.halfEdge !== twin.id)) continue
      let replacement = null
      for (const cand of this._halfEdgesById.values()) {
        if (cand.id !== he.id && cand.id !== twin.id && cand.origin === vId) { replacement = cand.id; break }
      }
      v.halfEdge = replacement
    }

    this._deleteHalfEdgePair(he.id, twin.id)
  }

  // ─── Ephemeral layer lifecycle ──────────────────────────────────────────────

  // Drop every half-edge/face built from vertices of the given kind(s) — the DCEL
  // counterpart to GroundPointRegistry.clearKind, which only removes the Points
  // themselves. Call BOTH (registry.clearKind, then this) when wiping the ephemeral
  // layer (street/gutter/block/plot) before a fresh generation pass.
  clearEphemeral(kinds) {
    const set = new Set(Array.isArray(kinds) ? kinds : [kinds])
    const deadFaceIds = new Set()
    for (const face of this._facesById.values()) {
      if (set.has(face.kind)) deadFaceIds.add(face.id)
    }
    for (const id of deadFaceIds) this._facesById.delete(id)
    for (const [heId, he] of [...this._halfEdgesById]) {
      if (he.face != null && deadFaceIds.has(he.face)) this._halfEdgesById.delete(heId)
      else if (he.face === null) {
        // orphaned void-side placeholder whose owning vertex kind is being cleared
        const v = this.points.get(he.origin)
        if (v && set.has(v.kind)) this._halfEdgesById.delete(heId)
      }
    }
    for (const [key, heId] of [...this._heByDirectedPair]) {
      if (!this._halfEdgesById.has(heId)) this._heByDirectedPair.delete(key)
    }
  }

  // ─── Edge chains (river/cliff bank tagging) ─────────────────────────────────

  // Register half-edge heId as a member of chain chainId (an opaque caller-supplied
  // key — SetupPhase uses the source worldTerrainData.edges key). Lazily creates the
  // chain record on first use. See plan "typed-giggling-giraffe" addendum: this is what
  // lets a river/cliff face's boundary be assembled from the tagged half-edges of the
  // land faces that were pulled back away from it, instead of re-deriving geometry.
  getOrCreateChain(chainId, payload = {}) {
    let chain = this._chainsById.get(chainId)
    if (!chain) { chain = { id: chainId, halfEdges: [], ...payload }; this._chainsById.set(chainId, chain) }
    return chain
  }

  tagChain(heId, chainId) {
    const he = this._halfEdgesById.get(heId)
    if (!he) throw new Error(`DCEL.tagChain: no half-edge ${heId}`)
    const chain = this.getOrCreateChain(chainId)
    chain.halfEdges.push(heId)
    he.chain = chainId
  }

  getAllChains() { return [...this._chainsById.values()] }

  // Full half-edge / face enumeration — for callers that need to scan the whole
  // structure (e.g. a manifold audit looking for unreclaimed void half-edges), not just
  // walk one face/vertex/chain at a time like every other accessor above.
  allHalfEdges() { return [...this._halfEdgesById.values()] }
  allFaces() { return [...this._facesById.values()] }

  // Directed-pair lookup, exposed for callers (river/cliff face assembly) that need to
  // confirm a candidate boundary step already exists as a void placeholder before
  // relying on insertFace to reclaim it, rather than risk it silently minting a fresh
  // (wrong) half-edge pair instead.
  findHalfEdge(u, v) {
    return this._halfEdgesById.get(this._heByDirectedPair.get(`${u},${v}`)) ?? null
  }

  // ─── Vertex split (river/cliff pullback) ────────────────────────────────────

  // Direct port of GroundPointRegistry.getOrCreateSplit, unchanged semantics — kept as
  // a thin pass-through so callers only ever talk to the DCEL, not the registry
  // directly, for anything topology-adjacent.
  getOrCreateSplitVertex(baseId, sideRef, x, y, z, kind) {
    return this.points.getOrCreateSplit(baseId, sideRef, x, y, z, kind)
  }

  // The outgoing half-edge fan at vertex v: he0, he0.prev.twin, (that).prev.twin, ...
  // Each element is exactly one face's corner at v (see plan's "fan-walk identity").
  // Returns [] if v has no incident half-edges (orphaned/unused vertex).
  outgoingFan(vertexId) {
    const v = this.points.get(vertexId)
    if (!v || v.halfEdge == null) return []
    const guard = this._halfEdgesById.size + 2

    // Void (face:null) placeholder half-edges never get .next/.prev linked until a real
    // face reclaims them (see insertFace) — a vertex that isn't fully surrounded by
    // faces (the common case: any boundary/outer vertex) has real fan gaps there. Find
    // a true rotational start first by walking backward (he.prev.twin — the previous
    // face's own outgoing edge at v) only through REAL faces, stopping at the first void
    // gap or back at the anchor if the fan is fully closed (interior vertex).
    //
    // prevTwin.origin !== vertexId (not just prevTwin.face === null) ALSO ends the walk:
    // splitVertexGeneral can leave a neighbor's twin pointer referencing a half-edge that
    // no longer originates at vertexId — its origin moved to a split vertex, but the
    // OTHER face flanking that same edge hasn't had ITS OWN corner split yet (that's a
    // separate, later splitVertexSimple call), so the two sides are geometrically
    // consistent again only once both have run. Until then this is exactly like a void
    // gap for THIS vertex's fan — treat it identically, or the walk follows a real (non-
    // null) but stale-for-this-vertex face into the wrong topology.
    let start = v.halfEdge
    for (let i = 0; i < guard; i++) {
      const he = this._halfEdgesById.get(start)
      const prev = he && this._halfEdgesById.get(he.prev)
      const prevTwin = prev && this._halfEdgesById.get(prev.twin)
      if (!prevTwin || prevTwin.face === null || prevTwin.origin !== vertexId || prevTwin.id === v.halfEdge) break
      start = prevTwin.id
    }

    // Walk forward (he.twin.next — the next face's own outgoing edge at v) collecting
    // every real half-edge until a void gap or a closed loop back to `start`. `start`
    // itself is guaranteed to originate at vertexId (it came from v.halfEdge or the
    // backward walk above, both already origin-checked) — only THAT first iteration
    // throws on a mismatch, since it would mean v.halfEdge itself is corrupted. Every
    // later step instead treats a non-originating candidate as a fan boundary (see the
    // backward walk's matching comment on splitVertexGeneral's transient inconsistency)
    // and stops gracefully, same as a void gap.
    const out = []
    let cur = start
    for (let i = 0; i < guard; i++) {
      const he = this._halfEdgesById.get(cur)
      if (!he || he.origin !== vertexId) {
        if (i === 0) throw new Error(`DCEL.outgoingFan: half-edge ${cur} does not originate at vertex ${vertexId}`)
        break
      }
      out.push(he)
      const twin = this._halfEdgesById.get(he.twin)
      if (!twin || twin.face === null || twin.next == null) break
      cur = twin.next
      if (cur === start) break
      if (i === guard - 1) throw new Error(`DCEL.outgoingFan: vertex ${vertexId} fan did not close after ${out.length} steps — corrupted topology`)
    }
    return out
  }

  // Partition vertex v's outgoing fan by groupOf(heOut) -> group key (any value;
  // reference-identity compared, not stringified — SameValueZero via Map, exactly as
  // GroundPointRegistry.getOrCreateSplit's own _splitIndex). A null/undefined group
  // means "stays at v, unmoved". Every other distinct group gets its own vertex via
  // getOrCreateSplitVertex(v, group, ...). posFor(group, heOut) -> {x,y,z} supplies the
  // target position for a newly-split vertex; called once per (vertex, group) pair,
  // memoized identically to getOrCreateSplit's own per-pass memoization.
  splitVertexSimple(vertexId, groupOf, posFor, kind) {
    const fan = this.outgoingFan(vertexId)
    if (fan.length === 0) return
    for (const heOut of fan) {
      const group = groupOf(heOut)
      if (group == null) continue   // unmoved — stays at vertexId
      const pos = posFor(group, heOut)
      const target = this.getOrCreateSplitVertex(vertexId, group, pos.x, pos.y, pos.z ?? 0, kind)
      heOut.origin = target.id
      this._setVertexAnchor(target.id, heOut.id)
    }
  }

  // The river-mouth / multi-bank confluence case splitVertexSimple can't handle: a water
  // face (Lake/Sea) with exactly ONE corner at vertexId, flanked in the fan by two banks
  // retreating in geometrically INCOMPATIBLE directions (groupA, groupB — the dot-product
  // grouping in _computeRiverCliffDeltas couldn't merge them into one group). Instead of
  // moving the water face's one corner to a single new position (which can only be flush
  // with ONE bank, leaving a gap against the other — the lossy fallback this replaces),
  // the water face GAINS a vertex: its corner splits into two, one flush with each bank,
  // joined by a new inserted edge that becomes the "mouth opening" between them.
  //
  // waterHe must be the water face's own outgoing arm at vertexId (i.e. an element of
  // outgoingFan(vertexId)). groupA is the group belonging to waterHe's fan-PREDECESSOR
  // (the bank whose own outgoing arm is waterHe.prev.twin — see the fan-walk identity in
  // outgoingFan's comment); groupB belongs to the fan-SUCCESSOR (waterHe.twin.next). Call
  // this BEFORE or AFTER splitVertexSimple has processed those two banks' own corners —
  // order doesn't matter, since getOrCreateSplitVertex's memoization means vA/vB resolve
  // to the exact same vertices a bank's own split would produce, by construction.
  //
  // Generalizes to a 3+-bank confluence by calling this once per adjacent incompatible
  // pair around the water face's original wedge (caller's responsibility to iterate —
  // this handles exactly one notch per call).
  splitVertexGeneral(vertexId, waterHe, groupA, groupB, kind) {
    if (waterHe.origin !== vertexId) throw new Error(`DCEL.splitVertexGeneral: waterHe does not originate at vertex ${vertexId}`)
    const base = this.points.get(vertexId)
    if (!base) throw new Error(`DCEL.splitVertexGeneral: no vertex ${vertexId}`)

    const vA = this.getOrCreateSplitVertex(vertexId, groupA, base.x + groupA.dx, base.y + groupA.dy, base.z ?? 0, kind)
    const vB = this.getOrCreateSplitVertex(vertexId, groupB, base.x + groupB.dx, base.y + groupB.dy, base.z ?? 0, kind)
    // The two banks' groups resolved to the same split vertex after all (e.g. a very
    // acute confluence angle) — nothing to insert, the simple single-vertex move is
    // already correct; caller can fall back to treating this as a simple split.
    if (vA.id === vB.id) return { vA, vB, inserted: false }

    const heIn = this.getHalfEdge(waterHe.prev)
    if (!heIn) throw new Error(`DCEL.splitVertexGeneral: waterHe has no prev — not a valid face loop member`)

    const fwdKey = `${vA.id},${vB.id}`, revKey = `${vB.id},${vA.id}`
    if (this._heByDirectedPair.has(fwdKey) || this._heByDirectedPair.has(revKey)) {
      throw new Error(`DCEL.splitVertexGeneral: directed edge ${fwdKey} already exists — unexpected topology, refusing to overwrite`)
    }

    const eIn = this._mintHalfEdge(vA.id, waterHe.face)
    const eOut = this._mintHalfEdge(vB.id, null)
    eIn.twin = eOut.id
    eOut.twin = eIn.id
    this._heByDirectedPair.set(fwdKey, eIn.id)
    this._heByDirectedPair.set(revKey, eOut.id)

    // Splice eIn between the water face's incoming and outgoing arms: heIn now arrives
    // at vA (via eIn.origin) instead of vertexId, then eIn hands off to waterHe, which
    // now departs from vB instead of vertexId.
    heIn.next = eIn.id
    eIn.prev = heIn.id
    eIn.next = waterHe.id
    waterHe.prev = eIn.id
    waterHe.origin = vB.id

    this._setVertexAnchor(vA.id, eIn.id)
    this._setVertexAnchor(vB.id, waterHe.id)
    // vertexId's own anchor may have been waterHe itself (now stale — its origin just
    // moved to vB), which would break outgoingFan(vertexId) the next time anything calls
    // it (e.g. splitVertexSimple processing the still-unmoved banks). heIn.twin — the
    // fan-predecessor bank's own outgoing arm — is guaranteed to still originate at
    // vertexId at this point (untouched by this call), so it's always a valid fallback.
    this._setVertexAnchor(vertexId, heIn.twin)

    return { vA, vB, inserted: true, insertedHalfEdge: eIn.id }
  }
}
