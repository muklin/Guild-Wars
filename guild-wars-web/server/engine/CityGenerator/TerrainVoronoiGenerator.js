import Point from '../voronoi/Point.js'
import DelaunayTriangulator from '../voronoi/DelaunayTriangulator.js'
import { clipToPolygon } from '../voronoi/VoronoiUtils.js'

// The organic-world boundary — a many-sided polygon approximating the circle every
// kept region's geometry gets clipped to (see generate()'s Step 5.5 doc comment for
// why a circle instead of the literal [0,worldSize] square). Exported so
// SetupPhase.js's _recoverGeometryFromSeeds can reproduce the EXACT same boundary on
// every load — it used to fall back to a literal square (computeVoronoiCellsHalfPlane
// has no concept of "hidden" seeds bounding a cell the way sentinel-triangulation
// does), which visibly reverted the whole map to the old square-clipped look on every
// server restart-with-save-load (confirmed live 2026-07-12).
export function organicClipCircle(worldSize, sides = 48) {
  const cx = worldSize / 2, cy = worldSize / 2
  const circleRadius = worldSize / Math.sqrt(2 * Math.PI)
  const clipRadius = circleRadius + worldSize * 0.08
  return Array.from({ length: sides }, (_, i) => {
    const theta = (i / sides) * 2 * Math.PI
    return { x: cx + Math.cos(theta) * clipRadius, y: cy + Math.sin(theta) * clipRadius }
  })
}

// Liang-Barsky clip of segment inside->outside against the axis-aligned box
// [0,worldSize]x[0,worldSize]. `inside` MUST already satisfy 0<=x,y<=worldSize;
// `outside` is wherever it actually is. Returns the point where the segment exits the
// box (nearest `outside`), or null if the segment never actually leaves the box
// (shouldn't happen given the caller's own in/out-of-bounds split, but a segment
// exactly along a box edge can produce a degenerate zero-length clip).
export function clipSegmentToWorldBounds(inside, outside, worldSize) {
  const dx = outside.x - inside.x, dy = outside.y - inside.y
  let t0 = 0, t1 = 1
  const edges = [
    [-dx, inside.x], [dx, worldSize - inside.x],
    [-dy, inside.y], [dy, worldSize - inside.y],
  ]
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return null; continue }
    const r = q / p
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r }
    else { if (r < t0) return null; if (r < t1) t1 = r }
  }
  if (t0 > t1 || t1 <= 0) return null
  return { x: inside.x + t1 * dx, y: inside.y + t1 * dy }
}

export default class TerrainVoronoiGenerator {
  generateRawVoronoi(regionCount, worldSize, manhattan = 0) {
    const seedPoints = []
    const delaunayPoints = []

    // Generate random seed positions
    for (let i = 0; i < regionCount; i++) {
      seedPoints.push({ x: Math.random() * worldSize, y: Math.random() * worldSize })
    }

    // Manhattan grid generation: lerp each seed toward its nearest grid point
    
    if (manhattan > 0) {
      const cols = Math.ceil(Math.sqrt(regionCount))
      const step = worldSize / cols
      const half = step * 0.5
      
      for (const sp of seedPoints) {
        if(Math.random() < manhattan){
          const gx = Math.max(half, Math.min(worldSize - half, Math.round(sp.x / step) * step))
          const gy = Math.max(half, Math.min(worldSize - half, Math.round(sp.y / step) * step))
          sp.x += (gx - sp.x)
          sp.y += (gy - sp.y)
        }
      }
    }

    for (const sp of seedPoints) {
      delaunayPoints.push(new Point(sp.x, sp.y))
    }

    // Sentinels placed 3× worldSize outside the map boundary so that every
    // sentinel-triangle circumcenter lands far outside [0, worldSize]. This prevents
    // boundary-cell Voronoi vertices from appearing inside or near the map edge.
    // Opposite sides are staggered by step/2 (a vs b) so no pair shares a coordinate,
    // which would produce collinear degenerate triangles with d≈0.
    const sm     = worldSize * 3   // e.g. 150 for worldSize=50
    const nSteps = 8
    const step   = worldSize / nSteps
    for (let i = 0; i <= nSteps; i++) {
      const a = i * step - step / 4  // -1.5625, 4.6875, ..., 48.4375
      const b = i * step + step / 4  //  1.5625, 7.8125, ..., 51.5625
      delaunayPoints.push(new Point(a, -sm))
      delaunayPoints.push(new Point(b, worldSize + sm))
      delaunayPoints.push(new Point(-sm,            a))
      delaunayPoints.push(new Point(worldSize + sm, b))
    }
    delaunayPoints.push(new Point(-sm,            -sm))
    delaunayPoints.push(new Point(worldSize + sm, -sm))
    delaunayPoints.push(new Point(-sm,            worldSize + sm))
    delaunayPoints.push(new Point(worldSize + sm, worldSize + sm))

    const triangulator = new DelaunayTriangulator(delaunayPoints)
    triangulator.bowyerWatson()

    const regions = []
    for (let i = 0; i < regionCount; i++) {   // only real seeds, not sentinels
      const seedPoint = seedPoints[i]
      const delaunayPoint = delaunayPoints[i]

      const trianglesWithSeed = triangulator.triangulation.filter(t =>
        t.vertices.includes(delaunayPoint)
      )

      if (trianglesWithSeed.length === 0) continue

      const circumcenters = trianglesWithSeed.map(t => t.circumcenter)

      // convexHull preserves circumcenter object references (same objects, just reordered)
      // so reference equality in findSharedEdge still works. It also guarantees convexity,
      // fixing the ~15% of cells where sortByAngle produced non-convex polygons (due to
      // multiple sentinel-side circumcenters clustering at similar angles).
      // convexHull returns CCW; reverse() gives CW for +y normal in fan triangulation.
      const polygon = this.convexHull(circumcenters)
      polygon.reverse()

      if (polygon.length < 3) continue

      regions.push({
        id: i,
        seedPoint,
        polygon,
        assignedType: null,
        gridX: Math.floor(seedPoint.x / 10),
        gridZ: Math.floor(seedPoint.y / 10),
        description: ''
      })
    }

    return { worldSize, regions, edges: {} }
  }

  // `registry` is the game's GroundPointRegistry (server/engine/CityGenerator/
  // GroundPointRegistry.js) — every terrain-plot vertex gets minted into it directly
  // (kind:'terrain'), so districts created later from these plots can reuse the exact
  // same ids by construction instead of re-deriving their own via coordinate matching.
  generate(regionCount = 15, worldSize = 50, mergeDistance = 0, manhattan = 0, registry) {

    // Organic-edged world (TODO.md, plan "federated-baking-dragon", circle-partition
    // revision 2026-07-12): fine cells are split by distance from the map centre into
    // an INSIDE circle (the visible world — `regionCount` merged regions) and an
    // OUTSIDE ring (hidden, but still generated and tracked — a future "guilds
    // discover foreign lands" hook, not deleted). Each half gets its OWN independent
    // farthest-point seed pool and its OWN nearest-seed assignment, so an inside
    // plot can never be assigned to an outside seed or vice versa. This replaces the
    // earlier "oversample the whole square 3x, keep the `regionCount` closest by
    // rank" approach: ranking by distance alone didn't guarantee the kept set was
    // spatially contiguous — with only 1/3 of an evenly-scattered candidate pool
    // kept, nearly every kept region (including the dead-centre one) ended up
    // bordering at least one hidden candidate, so `isEdge` came out true almost
    // everywhere. A hard inside/outside partition means an inside region only
    // borders a hidden one near the circle's actual rim.
    const plotCount = Math.max(regionCount * 2 * 5, 150)
    console.log(`Generating: ${plotCount} terrain plots → ${regionCount} inside + ${regionCount} outside (circle-partitioned, organic edge)`)

    // Step 1: Single triangulation for all terrain plots. Staggered sentinels keep
    // every real seed interior → bounded, valid circumcenter polygons.
    const { regions: allTerrainPlots } = this.generateRawVoronoi(plotCount, worldSize)
    let validTerrainPlots = allTerrainPlots.filter(c =>
      c.polygon && c.polygon.length >= 3 &&
      c.seedPoint.x >= 0 && c.seedPoint.x <= worldSize &&
      c.seedPoint.y >= 0 && c.seedPoint.y <= worldSize
    )
    console.log(`${validTerrainPlots.length}/${plotCount} terrain plots valid`)

    // Step 1.5: Merge circumcenter vertices that are closer than mergeDistance.
    // This eliminates T-junction artefacts where multiple near-coincident
    // circumcenters produce slivers and overlapping edge markers.
    if (mergeDistance > 0) {
      this.mergeNearbyVertices(validTerrainPlots, mergeDistance)
      validTerrainPlots = validTerrainPlots.filter(c => c.polygon.length >= 3)
      console.log(`After vertex merge: ${validTerrainPlots.length} terrain plots valid`)
    }

    // Step 2: partition fine cells by distance from the map centre. Circle area is
    // half the map's total area, so the outside pool has a comparable spread/density
    // to draw its own farthest-point sample from.
    const cx = worldSize / 2, cy = worldSize / 2
    const circleRadius = worldSize / Math.sqrt(2 * Math.PI)
    const circleRadiusSq = circleRadius * circleRadius
    const insidePlots = [], outsidePlots = []
    for (const plot of validTerrainPlots) {
      const dx = plot.seedPoint.x - cx, dy = plot.seedPoint.y - cy
      ;(dx * dx + dy * dy <= circleRadiusSq ? insidePlots : outsidePlots).push(plot)
    }

    // Step 3: scatter `regionCount` seeds evenly within the circle, and the same
    // count evenly outside it — two independent farthest-point samples, each drawn
    // only from its own pool.
    const insideSeeds = this.selectSeeds(insidePlots, regionCount, worldSize)
    const outsideSeeds = this.selectSeeds(outsidePlots, regionCount, worldSize)
    console.log(`Selected ${insideSeeds.length} inside + ${outsideSeeds.length} outside seed points`)

    // Outside ids are offset past the inside range (0..regionCount-1 inside,
    // regionCount..2*regionCount-1 outside) so both pools share one id space without
    // collision — and the inside range is already the compact 0..regionCount-1 ids
    // every downstream consumer expects, no remap step needed later.
    for (const plot of insidePlots)  plot.parentRegionId = this.findNearestSeed(plot.seedPoint, insideSeeds)
    for (const plot of outsidePlots) plot.parentRegionId = this.findNearestSeed(plot.seedPoint, outsideSeeds) + regionCount
    validTerrainPlots = [...insidePlots, ...outsidePlots]

    // Step 3.5: Resolve exclaves — isolated terrain plots disconnected from their
    // region's main body get reassigned to the dominant neighbouring region. Runs
    // across BOTH pools together (an exclave can legitimately flip from inside to
    // outside id-space or back if its true neighbours disagree with the raw circle
    // cutoff) — the final inside/outside partition below reads `parentRegionId`
    // fresh, after this runs, not the pre-exclave pool arrays above.
    const exclavesFixed = this.resolveExclaves(validTerrainPlots)
    if (exclavesFixed > 0) console.log(`Resolved ${exclavesFixed} exclave terrain plots`)

    const keptSet = new Set(Array.from({ length: regionCount }, (_, i) => i))
    const selectedSeeds = insideSeeds

    // Step 4: Mint every still-shared circumcenter object into the GLOBAL point
    // registry (kind:'terrain') — one registry point per physically-shared corner,
    // exactly matching the reference-equality adjacency the rest of this pipeline
    // already relies on. `v.id` continues to double as the local "seen" marker.
    // Must happen before any clipping — clipping creates new vertex objects, breaking
    // the shared circumcenter references that findSharedEdge relies on. Runs on EVERY
    // plot (inside + outside) — an outside plot's vertices still need real ids so
    // Step 5 can detect an inside region's segment bordering it.
    const seenVertices = new Set()
    for (const plot of validTerrainPlots) {
      for (const v of plot.polygon) {
        if (!seenVertices.has(v)) { seenVertices.add(v); v.id = registry.create(v.x, v.y, 0, 'terrain').id }
      }
    }

    // Step 5: Boundary edges via reference equality on unclipped polygons — scans
    // EVERY plot (inside + outside) for correct adjacency, but only builds a real
    // Edge chain between two KEPT (inside) regions (`keptSet`); an inside region
    // bordering an outside one gets no Edge at all (exactly "outside edges don't need
    // a Terrain edge") and is recorded in `regionIdsTouchingVoid` instead — the
    // adjacency-based `isEdge` (Step 6).
    const raw = this.generateBoundaryEdges(validTerrainPlots, keptSet)
    console.log(`Generated ${Object.keys(raw.edges).length} boundary edges, ${raw.edgePoints.length} edge points, ${raw.regionIdsTouchingVoid.size} edge regions`)

    // Split the final (post-exclave) plot list into inside (returned, rendered) and
    // outside (hidden — retained on the return value, not deleted, for a possible
    // future "discover foreign lands" feature).
    const hiddenTerrainPlots = validTerrainPlots.filter(plot => !keptSet.has(plot.parentRegionId))
    validTerrainPlots = validTerrainPlots.filter(plot => keptSet.has(plot.parentRegionId))
    console.log(`Kept ${validTerrainPlots.length} terrain plots across ${selectedSeeds.length} inside regions (hid ${hiddenTerrainPlots.length} outside plots across ${outsideSeeds.length} outside regions)`)

    const edges = raw.edges
    const edgePoints = raw.edgePoints
    const regionIdsTouchingVoid = raw.regionIdsTouchingVoid

    // Step 5.5: Clip terrain plot polygons to world bounds for client rendering.
    // Must happen AFTER edge detection — clipping creates new vertex objects that
    // break the reference equality used by findSharedEdge. Clipped polygons improve
    // click-detection accuracy and eliminate huge sentinel-extended polys from the renderer.
    // clipToPolygon (VoronoiUtils.js) pushes the SAME object reference for any vertex
    // that survives clipping unchanged (so `.id` is preserved for free); only genuinely
    // NEW boundary-intersection vertices come back with no `.id`, needing a fresh
    // registry point. plot.pointIds is the authoritative Surface reference from here on;
    // plot.polygon is kept as a resolved convenience copy during this transitional stage
    // (later pipeline stages, and all current renderer/consumer code, still read it) —
    // see plan Stage 7 for its eventual removal once every consumer reads pointIds.
    // Clip against the CIRCLE (the true organic-world boundary), not the literal
    // [0,worldSize] square. A kept fine cell near the circle's rim can have a
    // naturally elongated Voronoi polygon — sparse real neighbours on its outward
    // side (its nearest points out there belong to the hidden outside pool, or are
    // sentinel-influenced) mean nothing bounds it tightly except the eventual
    // sentinel wall. Clipping that only against the square let those elongated
    // cells stretch all the way out to the map's literal edge as long thin spikes
    // radiating from the kept cluster — confirmed live (2026-07-12), and got much
    // more visible after lowering plot density (fewer points → bigger boundary
    // cells). A modest circleRadius margin gives rim cells room for their own
    // normal size without truncating them right at the boundary.
    const W = worldSize
    const clipCircle = organicClipCircle(worldSize)
    // Collect clipped polygons WITHOUT minting new vertex ids per-plot — two adjacent
    // plots whose shared boundary crosses the clip circle each compute their OWN
    // intersection point independently (Sutherland-Hodgman clipping isn't guaranteed
    // to land on the bit-identical point when the same physical crossing is traversed
    // in opposite directions by each plot's own polygon winding), so minting
    // immediately, per plot, mints two near-but-different points for what should be
    // one shared corner — a real, thin sliver/wedge gap right at that junction
    // (confirmed live 2026-07-12: ~10 genuine "nearMiss" HOLE findings per generation
    // before this fix, at multi-region junctions along the clip circle). Collect every
    // brand-new (not-yet-id'd) vertex across ALL plots first, then dedupe them
    // together in one pass — same technique mintDeduped's own doc comment describes
    // for near-cocircular circumcenters.
    const clippedPlots = []
    const newClipVertices = []
    for (const plot of validTerrainPlots) {
      const clipped = clipToPolygon(plot.polygon, clipCircle)
      if (!clipped) continue
      plot.polygon = clipped
      clippedPlots.push(plot)
      for (const v of clipped) if (v.id === undefined) newClipVertices.push(v)
    }
    const dedupedClipIds = registry.mintDeduped(newClipVertices, 'terrain', 0.01)
    newClipVertices.forEach((v, i) => { v.id = dedupedClipIds[i] })
    for (const plot of clippedPlots) {
      plot.pointIds = plot.polygon.map(v => v.id)
    }

    // Step 5.6: Clip edge chains to world bounds too — Step 5 built them from the
    // UNCLIPPED polygons above, so a chain touching an unbounded Voronoi vertex (a real,
    // if rare, case for cells near the sentinel-triangle-influenced convex hull — see
    // generateRawVoronoi's sentinel comment) keeps that wild, far-outside-the-map
    // position forever; nothing in Step 5.5 ever touches `edges`. Confirmed live
    // (2026-07-12): a 3-region junction vertex landed at y=-27 (worldSize=50), used only
    // as an edge terminus (no terrain plot referenced it — plot clipping had already
    // replaced it with a proper boundary point on every plot that used to share it), so
    // the River/Cliff pullback built a face stretching from the map edge down to y=-27,
    // overlapping dozens of unrelated plots on the way. Terminus-only fix (only the
    // leading/trailing run of out-of-bounds points is trimmed) rather than general
    // polyline clipping — interior chain points are real shared corners between two
    // valid, already-in-bounds plots and have never been observed out of bounds.
    this._clipEdgeChainsToWorldBounds(edges, registry, W)

    // Step 6: Build merged region convex hulls (used for click hit-testing fallback)
    const vertsByRegion = new Map()
    for (let i = 0; i < selectedSeeds.length; i++) vertsByRegion.set(i, [])
    for (const plot of validTerrainPlots) {
      const bucket = vertsByRegion.get(plot.parentRegionId)
      if (bucket) {
        for (const v of plot.polygon) {
          if (isFinite(v.x) && isFinite(v.y)) bucket.push(v)
        }
      }
    }
    const regions = selectedSeeds.map((seed, i) => ({
      id: i,
      seedPoint: seed,
      polygon: this.convexHull(vertsByRegion.get(i) || []),
      assignedType: null,
      isEdge: regionIdsTouchingVoid.has(i),
      description: ''
    }))

    // Step 6b: same merged-hull treatment for the OUTSIDE regions — not rendered or
    // exposed to the client today, but retained on the return value rather than
    // discarded, per the "still exist in the game, may be discoverable later" design
    // (2026-07-12). `id` is kept in the SAME offset (regionCount..2*regionCount-1)
    // space as `hiddenTerrainPlots[].parentRegionId` and `hiddenNeighborsByRegion`'s
    // values — a compact 0..regionCount-1 id here (an earlier version of this code)
    // silently never matched either of those when looking a hidden region up by id.
    const hiddenVertsByRegion = new Map()
    for (let i = 0; i < outsideSeeds.length; i++) hiddenVertsByRegion.set(i, [])
    for (const plot of hiddenTerrainPlots) {
      const bucket = hiddenVertsByRegion.get(plot.parentRegionId - regionCount)
      if (bucket) {
        for (const v of plot.polygon) {
          if (isFinite(v.x) && isFinite(v.y)) bucket.push(v)
        }
      }
    }
    const hiddenRegions = outsideSeeds.map((seed, i) => ({
      id: i + regionCount,
      seedPoint: seed,
      polygon: this.convexHull(hiddenVertsByRegion.get(i) || []),
      assignedType: null,
      isEdge: false,
      description: ''
    }))

    // Plain-object form (id → array of hidden ids) — Maps don't survive JSON
    // serialization (save files, worldTerrainData), and this needs to persist so a
    // later terrain assignment (SetupPhase.js's _revealAdjacentHiddenTerrain) can
    // look up what to reveal.
    const hiddenNeighborsByRegion = {}
    for (const [regionId, hiddenIds] of raw.hiddenNeighborsByRegion) {
      hiddenNeighborsByRegion[regionId] = [...hiddenIds]
    }

    return { worldSize, regions, terrainPlots: validTerrainPlots, edges, edgePoints, hiddenRegions, hiddenTerrainPlots, hiddenNeighborsByRegion }
  }

  // Trims the leading/trailing run of out-of-[0,worldSize] points from every edge
  // chain, replacing each with a single point where the chain crosses the world
  // boundary (Liang-Barsky segment-vs-box clip against the last in-bounds point and its
  // wayward neighbour) — see the Step 5.6 call site's doc comment for why this is
  // needed at all. Mutates `edges` in place.
  _clipEdgeChainsToWorldBounds(edges, registry, worldSize) {
    const inBounds = (p) => p && p.x >= -1e-9 && p.x <= worldSize + 1e-9 && p.y >= -1e-9 && p.y <= worldSize + 1e-9
    for (const edge of Object.values(edges)) {
      const pts = edge.pointIds.map(id => registry.get(id))
      let start = 0
      while (start < pts.length && !inBounds(pts[start])) start++
      let end = pts.length - 1
      while (end >= 0 && !inBounds(pts[end])) end--
      if (start > end) continue   // entire chain out of bounds — nothing sane to clip to, leave as-is

      const ids = edge.pointIds.slice(start, end + 1)
      if (start > 0) {
        const cross = clipSegmentToWorldBounds(pts[start], pts[start - 1], worldSize)
        if (cross) ids.unshift(registry.create(cross.x, cross.y, 0, 'terrain').id)
      }
      if (end < pts.length - 1) {
        const cross = clipSegmentToWorldBounds(pts[end], pts[end + 1], worldSize)
        if (cross) ids.push(registry.create(cross.x, cross.y, 0, 'terrain').id)
      }
      edge.pointIds = ids
    }
  }

  // Finds terrain plots that are disconnected from their region's largest contiguous
  // component and reassigns them to the dominant neighbouring region. Runs once
  // after the initial nearest-seed assignment; a single pass eliminates isolated
  // islands (the common case). Adjacency uses shared vertex object references,
  // which are valid before Step 5.5 clips polygons.
  resolveExclaves(plots) {
    // Build vertex → plots map by reference equality
    const vertexPlots = new Map()
    for (const plot of plots) {
      for (const v of plot.polygon) {
        if (!vertexPlots.has(v)) vertexPlots.set(v, [])
        vertexPlots.get(v).push(plot)
      }
    }

    // Build full plot adjacency (plots sharing at least one vertex)
    const adj = new Map()
    for (const plot of plots) adj.set(plot, new Set())
    for (const group of vertexPlots.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          adj.get(group[i]).add(group[j])
          adj.get(group[j]).add(group[i])
        }
      }
    }

    // BFS to find connected components restricted to same-region plots
    const visited = new Set()
    const plotComponent = new Map()  // plot → component array

    for (const plot of plots) {
      if (visited.has(plot)) continue
      const component = []
      const queue = [plot]
      visited.add(plot)
      while (queue.length) {
        const cur = queue.shift()
        component.push(cur)
        for (const nb of adj.get(cur)) {
          if (!visited.has(nb) && nb.parentRegionId === cur.parentRegionId) {
            visited.add(nb)
            queue.push(nb)
          }
        }
      }
      for (const p of component) plotComponent.set(p, component)
    }

    // For each region, keep the largest component; everything else is an exclave
    const mainByRegion = new Map()
    for (const [plot, comp] of plotComponent) {
      const rid = plot.parentRegionId
      if (!mainByRegion.has(rid) || comp.length > mainByRegion.get(rid).length) {
        mainByRegion.set(rid, comp)
      }
    }

    // Reassign exclave plots to the most common neighbouring region
    let reassigned = 0
    for (const plot of plots) {
      if (plotComponent.get(plot) === mainByRegion.get(plot.parentRegionId)) continue

      const counts = new Map()
      for (const nb of adj.get(plot)) {
        const r = nb.parentRegionId
        if (r !== plot.parentRegionId) counts.set(r, (counts.get(r) || 0) + 1)
      }
      if (!counts.size) continue

      let bestRegion = null, bestCount = -1
      for (const [r, n] of counts) {
        if (n > bestCount) { bestCount = n; bestRegion = r }
      }
      if (bestRegion !== null) { plot.parentRegionId = bestRegion; reassigned++ }
    }

    return reassigned
  }

  selectSeeds(plots, count, worldSize) {
    // Prefer interior plots so region seeds are evenly spread, not boundary-biased.
    const margin = worldSize * 0.15
    const pool = plots.filter(c =>
      c.seedPoint.x >= margin && c.seedPoint.x <= worldSize - margin &&
      c.seedPoint.y >= margin && c.seedPoint.y <= worldSize - margin
    )
    const source = pool.length >= count ? pool : plots

    // Greedy farthest-point: each new seed maximises its minimum distance to
    // already-selected seeds, ensuring even spatial coverage.
    const selected = []
    const used = new Set()

    // Start from the plot closest to world centre
    const cx = worldSize / 2, cy = worldSize / 2
    let bestIdx = 0, bestDist = Infinity
    for (let i = 0; i < source.length; i++) {
      const d = (source[i].seedPoint.x - cx) ** 2 + (source[i].seedPoint.y - cy) ** 2
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    selected.push(source[bestIdx].seedPoint)
    used.add(bestIdx)

    while (selected.length < count) {
      let farthest = -1, farthestDist = -Infinity
      for (let i = 0; i < source.length; i++) {
        if (used.has(i)) continue
        let minDist = Infinity
        for (const s of selected) {
          const d = (source[i].seedPoint.x - s.x) ** 2 + (source[i].seedPoint.y - s.y) ** 2
          if (d < minDist) minDist = d
        }
        if (minDist > farthestDist) { farthestDist = minDist; farthest = i }
      }
      if (farthest === -1) break
      selected.push(source[farthest].seedPoint)
      used.add(farthest)
    }

    return selected
  }

  findNearestSeed(point, seeds) {
    let minDist = Infinity
    let nearest = 0
    seeds.forEach((seed, idx) => {
      const dx = point.x - seed.x
      const dy = point.y - seed.y
      const dist = dx * dx + dy * dy
      if (dist < minDist) {
        minDist = dist
        nearest = idx
      }
    })
    return nearest
  }

  convexHull(points) {
    if (points.length < 3) return points

    // Sort by x, then by y
    const sorted = [...points].sort((a, b) => {
      return a.x !== b.x ? a.x - b.x : a.y - b.y
    })

    // Build lower hull
    const lower = []
    for (const p of sorted) {
      while (lower.length >= 2 && this.cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
        lower.pop()
      }
      lower.push(p)
    }

    // Build upper hull
    const upper = []
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i]
      while (upper.length >= 2 && this.cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
        upper.pop()
      }
      upper.push(p)
    }

    // Remove last point of each half because it's repeated
    lower.pop()
    upper.pop()

    return lower.concat(upper)
  }

  cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  }

  mergeNearbyVertices(plots, mergeDistance) {
    // Collect all unique circumcenter vertex objects
    const allVerts = []
    const seen = new Set()
    for (const cell of plots) {
      for (const v of cell.polygon) {
        if (!seen.has(v)) { seen.add(v); allVerts.push(v) }
      }
    }

    // Spatial grid for O(n) neighbour lookup
    const gs = mergeDistance
    const grid = new Map()
    for (const v of allVerts) {
      const key = `${Math.floor(v.x / gs)},${Math.floor(v.y / gs)}`
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key).push(v)
    }

    // Union-Find: track which vertex each vertex is replaced by
    const rep = new Map()
    const find = (v) => { while (rep.has(v)) v = rep.get(v); return v }

    for (const v of allVerts) {
      const gx = Math.floor(v.x / gs)
      const gy = Math.floor(v.y / gs)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const n of (grid.get(`${gx + dx},${gy + dy}`) || [])) {
            if (n === v) continue
            if (Math.hypot(v.x - n.x, v.y - n.y) < mergeDistance) {
              const rv = find(v), rn = find(n)
              if (rv !== rn) rep.set(rn, rv)
            }
          }
        }
      }
    }

    // Apply replacements and deduplicate within each polygon
    for (const cell of plots) {
      const dedup = new Set()
      cell.polygon = cell.polygon.map(v => find(v)).filter(v => {
        if (dedup.has(v)) return false
        dedup.add(v)
        return true
      })
    }
  }

  // `keptSet`: Set of KEPT candidate region ids (see generate()'s Step 3.7) — `plots`
  // itself must still include HIDDEN candidates' plots too, so their Voronoi cells
  // keep correctly bounding the kept ones; this function just skips building an
  // Edge/isEdge FROM a hidden region's own perspective, and never emits an Edge chain
  // for a kept-to-hidden boundary (only kept-to-kept ones), per generate()'s Step 5
  // doc comment.
  generateBoundaryEdges(plots, keptSet) {
    // Build vertex → cells map by reference so we can find which cells share
    // each polygon segment without an O(n²) cell-pair scan. Built from EVERY plot
    // (kept + hidden) so adjacency — and therefore Voronoi-cell bounding — stays
    // correct regardless of which regions end up in the output.
    const vertexCells = new Map()
    for (const cell of plots) {
      for (const v of cell.polygon) {
        if (!vertexCells.has(v)) vertexCells.set(v, [])
        vertexCells.get(v).push(cell)
      }
    }

    const edgePointsMap = new Map()
    const segmentsByKey = new Map() // edgeKey → [{v1, v2}]
    const metaByKey     = new Map() // edgeKey → {regionA, regionB}
    const registeredPairs = new Set()
    // A KEPT region with a segment whose only neighbour(s) are HIDDEN (or genuinely
    // nothing) is an edge region — the new, adjacency-based isEdge (see generate()'s
    // Step 6), replacing the old post-hoc square-touching geometry test entirely.
    const regionIdsTouchingVoid = new Set()
    // Which specific hidden region(s) each kept region borders — needed for the
    // "assigning Sea/Mountains/Desert/Ice Sheet reveals adjacent hidden terrain"
    // feature (SetupPhase.js's _revealAdjacentHiddenTerrain): regionIdsTouchingVoid
    // alone is just a boolean, this tracks WHICH hidden region(s) to reveal.
    const hiddenNeighborsByRegion = new Map()

    for (const cell of plots) {
      const regionA = cell.parentRegionId
      if (!keptSet.has(regionA)) continue   // hidden regions need no Edges/isEdge of their own
      const poly = cell.polygon
      for (let i = 0; i < poly.length; i++) {
        const va = poly[i]
        const vb = poly[(i + 1) % poly.length]
        if (va.id === undefined || vb.id === undefined) continue

        // Canonical key — each physical edge is processed exactly once
        const lo = Math.min(va.id, vb.id), hi = Math.max(va.id, vb.id)
        const pairKey = `${lo}:${hi}`
        if (registeredPairs.has(pairKey)) continue
        registeredPairs.add(pairKey)

        // Cells containing BOTH va and vb are the two cells on opposite sides
        // of this Delaunay edge (reference equality preserved throughout). Exclude
        // `cell` itself BY REFERENCE (not by comparing parentRegionId) — a coarse
        // region merges many fine cells, so an ordinary INTERNAL seam between two
        // fine cells that both belong to regionA has its one real neighbour cell
        // filtered right back out if self-exclusion goes by id instead of identity,
        // leaving an empty neighbour list that reads as "touching void". That bug
        // fired for every internal seam of every coarse region (i.e. essentially
        // always, for any region built from >1 fine cell), which is why every kept
        // region came out isEdge=true regardless of the seed-selection scheme —
        // confirmed live (2026-07-12) across both the old ranked-candidate approach
        // and the circle-partition rewrite.
        const cellsOfB = new Set(vertexCells.get(vb) || [])
        const otherCells = (vertexCells.get(va) || []).filter(c => c !== cell && cellsOfB.has(c))

        if (otherCells.length === 0) {
          // No neighbouring fine cell shares this edge at all — a true topological
          // boundary (literal generation-area edge, or a convex-hull artefact).
          regionIdsTouchingVoid.add(regionA)
          continue
        }

        const neighborIds = [...new Set(otherCells.map(c => c.parentRegionId))]

        // Every neighbour sharing this edge is the SAME coarse region as `cell` —
        // purely an internal seam, not a region boundary. Skip entirely (no Edge,
        // no void flag).
        if (neighborIds.every(r => r === regionA)) continue

        const keptNeighborIds = neighborIds.filter(r => r !== regionA && keptSet.has(r))

        // No KEPT neighbour — either genuinely nothing, or the neighbour is hidden.
        // Either way, no Edge chain gets built (outside edges don't need one) and
        // regionA becomes an edge region.
        if (keptNeighborIds.length === 0) {
          regionIdsTouchingVoid.add(regionA)
          for (const nid of neighborIds) {
            if (nid === regionA || keptSet.has(nid)) continue
            if (!hiddenNeighborsByRegion.has(regionA)) hiddenNeighborsByRegion.set(regionA, new Set())
            hiddenNeighborsByRegion.get(regionA).add(nid)
          }
          continue
        }

        const regionB = keptNeighborIds[0]
        const rA = Math.min(regionA, regionB)
        const rB = Math.max(regionA, regionB)
        const edgeKey = `${rA}-${rB}`

        for (const v of [va, vb]) {
          if (!edgePointsMap.has(v.id)) {
            edgePointsMap.set(v.id, { id: v.id, x: v.x, y: v.y })
          }
        }

        if (!segmentsByKey.has(edgeKey)) {
          segmentsByKey.set(edgeKey, [])
          metaByKey.set(edgeKey, { regionA: rA, regionB: rB })
        }
        segmentsByKey.get(edgeKey).push({ v1: va, v2: vb })
      }
    }

    const edges = {}
    for (const [edgeKey, segments] of segmentsByKey) {
      const meta     = metaByKey.get(edgeKey)
      const polyline = this.sortSegmentsIntoPolyline(segments)
      if (polyline.length < 2) continue
      edges[edgeKey] = {
        regionA:      meta.regionA,
        regionB:      meta.regionB,
        pointIds:     polyline.map(v => v.id),
        assignedType: null
      }
    }

    return { edges, edgePoints: Array.from(edgePointsMap.values()), regionIdsTouchingVoid, hiddenNeighborsByRegion }
  }

  sortSegmentsIntoPolyline(segments) {
    if (segments.length === 0) return []
    if (segments.length === 1) return [segments[0].v1, segments[0].v2]

    // Build adjacency: vertex → [{segIdx, otherVertex}]
    const adj = new Map()
    for (let i = 0; i < segments.length; i++) {
      const { v1, v2 } = segments[i]
      if (!adj.has(v1)) adj.set(v1, [])
      if (!adj.has(v2)) adj.set(v2, [])
      adj.get(v1).push({ idx: i, other: v2 })
      adj.get(v2).push({ idx: i, other: v1 })
    }

    // Find an endpoint: a vertex connected to exactly one segment
    // (chain ends). Fall back to segments[0].v1 for loops (shouldn't occur).
    let start = segments[0].v1
    for (const [v, links] of adj) {
      if (links.length === 1) { start = v; break }
    }

    const result = [start]
    const used   = new Set()
    let current  = start

    while (used.size < segments.length) {
      const links = adj.get(current) || []
      let found = false
      for (const { idx, other } of links) {
        if (used.has(idx)) continue
        used.add(idx)
        result.push(other)
        current = other
        found = true
        break
      }
      if (!found) break
    }

    return result
  }

}
