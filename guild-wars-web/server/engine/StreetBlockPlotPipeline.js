// Street graph / block / plot generation pipeline, district promotion, and building
// generation orchestration — extracted verbatim from SetupPhase.js (see plan
// "wondrous-conjuring-wand", Stage 3). Same this.sp routing pattern as TerrainSetup —
// see that file's header comment.
//
// Also owns 4 static class members relocated from SetupPhase (ALL_DISTRICT_TYPES,
// _shuffleSeeded, INELIGIBLE_PROMOTION_TERRAIN_TYPES, _isIneligibleTerrainPlot) as
// plain module-level consts/functions — confirmed via a full-file usage scan that
// finishSubdivision/promoteTerrainPlotToDistrict/getCityDistrictDataForClient (all in
// this bucket) were their only callers, referenced via SetupPhase.X class-qualification
// (now just X, module-scoped).
import StreetVoronoiGenerator from './CityGenerator/StreetVoronoiGenerator.js'
import CityBlockGenerator, { majorityStreetType, gutterRoadEdges } from './CityGenerator/CityBlockGenerator.js'
import PlotVoronoiGenerator, { markSquareBlocks } from './CityGenerator/PlotVoronoiGenerator.js'
import LandmarkPlacer from './CityGenerator/buildings/LandmarkPlacer.js'
import { CALC_BLOCKS, CALC_PLOTS } from './pipelineFlags.js'
import { convertTerrainCellsToPlots } from './CityGenerator/TerrainPlotConverter.js'
import GroundPointRegistry from './CityGenerator/GroundPointRegistry.js'
import { generateName } from '../../shared/nameLibrary.js'
import { pip } from './voronoi/VoronoiUtils.js'

// For each outer boundary street, cast test points perpendicular to the road and use
// pip to find which terrain plot it faces. Records streetEdges on the terrain plot.
// Boundary connections are identified by: has left/right sides AND right is not a
// city district ID (i.e. not a number) — the "!city" condition.
// Exported: also called from TerrainSetup.regenerateTerrainPlots, not just the 2 call
// sites in this file — confirmed via a live smoke test that caught the miss.
export function computeTerrainPlotStreetAdjacency(streetGraph, terrainPlots) {
  if (!terrainPlots.length || !streetGraph?.junctions?.length) return

  const jPos = new Map(streetGraph.junctions.map(j => [j.id, j]))
  const seenRoads = new Set()
  const TEST_DISTS = [0.1, 0.5, 1.0, 2.0, 5.0]

  for (const j of streetGraph.junctions) {
    for (const conn of (j.connections || [])) {
      // Outer boundary: has left/right fields AND right is not a city district ID
      if (conn.left == null || typeof conn.right === 'number') continue
      if (seenRoads.has(conn.roadId)) continue
      seenRoads.add(conn.roadId)

      const jB = jPos.get(conn.toId)
      if (!jB) continue

      const dx = jB.x - j.x, dy = jB.y - j.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < 1e-10) continue

      const ux = dx / len, uy = dy / len
      const mx = (j.x + jB.x) / 2, my = (j.y + jB.y) / 2

      // Both A→B and B→A connections carry identical left/right, so we don't know
      // which perpendicular is outward. Try both — terrain plots are outside the city
      // so only the outward direction will ever match pip.
      // Probe at 0.25, 0.5, 0.75 fractions along the road to handle short roads where
      // the midpoint probe lands in a junction gap rather than a terrain cell.
      const FRACS = [0.25, 0.5, 0.75]
      let foundPlot = null
      outer: for (const frac of FRACS) {
        const px = j.x + frac * (jB.x - j.x), py = j.y + frac * (jB.y - j.y)
        for (const d of TEST_DISTS) {
          for (const [ox, oy] of [[uy, -ux], [-uy, ux]]) {
            const tx = px + ox * d, ty = py + oy * d
            for (const plot of terrainPlots) {
              if (pip(tx, ty, plot.blockCorners)) { foundPlot = plot; break outer }
            }
          }
        }
      }

      if (!foundPlot) continue

      // Closest polygon edge of the terrain plot to the street midpoint (by edge midpoint)
      const corners = foundPlot.blockCorners
      const n = corners.length
      let bestIdx = 0, bestDistSq = Infinity
      for (let i = 0; i < n; i++) {
        const va = corners[i], vb = corners[(i + 1) % n]
        const emx = (va.x + vb.x) / 2, emy = (va.y + vb.y) / 2
        const dsq = (emx - mx) ** 2 + (emy - my) ** 2
        if (dsq < bestDistSq) { bestDistSq = dsq; bestIdx = i }
      }

      foundPlot.streetEdges.push({ index: bestIdx, roadId: conn.roadId, type: conn.type })
    }
  }
}

// The full set of player-selectable district types (excludes Leadership, which is
// reserved to the one designated Leadership district) — matches DistrictTypePanel.js's
// selectable list on the client exactly.
const ALL_DISTRICT_TYPES = ['Residential', 'Market', 'Religious', 'Military', 'Magical', 'Entertainment', 'Industry']

// Seeded Fisher-Yates — deterministic per city (not re-rolled if finishSubdivision
// were somehow invoked twice), unlike Math.random().
function _shuffleSeeded(arr, seed) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    let s = (((seed + i * 104729) >>> 0) * 2654435761) >>> 0
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    const j = (s >>> 0) % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Lake, Sea, Ice Sheet, and Mountains terrain can never become a city District — not
// buildable land. A plot's own assignedType is only ever set to 'City' at Terrain Setup
// (SetupPhase.js:initialize); its actual terrain type lives on its parent Region.
const INELIGIBLE_PROMOTION_TERRAIN_TYPES = new Set(['Lake', 'Sea', 'Ice Sheet', 'Mountains'])

function _isIneligibleTerrainPlot(plot, wt) {
  const region = wt?.regions?.find(r => r.id === plot.parentRegionId)
  return INELIGIBLE_PROMOTION_TERRAIN_TYPES.has(region?.assignedType)
}

export default class StreetBlockPlotPipeline {
  constructor(setupPhase) {
    this.sp = setupPhase
  }

  _sortIntoPolyline(segments) {
    if (segments.length === 0) return []
    if (segments.length === 1) return [segments[0].v1, segments[0].v2]

    const vertexById = new Map()
    const adj = new Map()
    for (let i = 0; i < segments.length; i++) {
      const { v1, v2 } = segments[i]
      vertexById.set(v1.id, v1)
      vertexById.set(v2.id, v2)
      if (!adj.has(v1.id)) adj.set(v1.id, [])
      if (!adj.has(v2.id)) adj.set(v2.id, [])
      adj.get(v1.id).push({ segIdx: i, otherId: v2.id })
      adj.get(v2.id).push({ segIdx: i, otherId: v1.id })
    }

    let startId = segments[0].v1.id
    for (const [id, links] of adj) {
      if (links.length === 1) { startId = id; break }
    }

    const result = [vertexById.get(startId)]
    const used = new Set()
    let currentId = startId
    while (used.size < segments.length) {
      const links = adj.get(currentId) || []
      let moved = false
      for (const { segIdx, otherId } of links) {
        if (used.has(segIdx)) continue
        used.add(segIdx)
        result.push(vertexById.get(otherId))
        currentId = otherId
        moved = true
        break
      }
      if (!moved) break
    }
    return result
  }

  _splitIntoChains(segments) {
    const remaining = segments.map((s, i) => ({ ...s, _idx: i }))
    const chains = []
    while (remaining.length > 0) {
      const component = [remaining.shift()]
      let grew = true
      while (grew) {
        grew = false
        for (let i = remaining.length - 1; i >= 0; i--) {
          const seg = remaining[i]
          if (component.some(s =>
            s.v1.id === seg.v1.id || s.v1.id === seg.v2.id ||
            s.v2.id === seg.v1.id || s.v2.id === seg.v2.id
          )) {
            component.push(remaining.splice(i, 1)[0])
            grew = true
          }
        }
      }
      chains.push(this._sortIntoPolyline(component))
    }
    return chains
  }

  finishTerrain() {
    const regions = this.sp.gameStateManager.worldTerrainData.regions
    for (const region of regions) {
      if (!region.assignedType) {
        region.assignedType = 'Plains'
        region.description = ''
        this.sp.terrainPlacements.push({ regionId: region.id, terrainType: 'Plains', description: '' })
        this.sp.log.push(`Auto-assigned Plains to region ${region.id}`)
      }
    }
    this.sp.currentStep = 'CitySubdivision'
    this.sp.log.push('Terrain placement complete. Moving to city subdivision.')
    // The Terrain→CitySubdivision transition, exactly when River/Cliff assignment is
    // finalized — pull every district back now rather than leaving them at their raw
    // (never-pulled-back) shape until some later, unrelated action happens to call
    // generateForLocked first.
    this.generateForLocked()
    return { ok: true, log: this.sp.log }
  }

  // Regenerate the committed city geometry over all LOCKED districts, plus an
  // optional in-preview district (typed but not yet locked). Districts outside this
  // set contribute no streets, so their shared boundaries stay deferred until they
  // are locked too. Stable per-district seeds keep locked interiors unchanged.
  generateForLocked(previewDistrictId = null, isFinal = false) {
    const t0 = performance.now()
    const cityData = this.sp.gameStateManager.cityDistrictData
    if (!cityData?.districts?.length) return
    // Pull back EVERY district — typed or not — from any river/cliff, unconditionally.
    // This used to only happen for the typed subset below (via _generateStreetGraph),
    // so an untyped district (the normal state through most of District Setup) never
    // got pulled back at all and its cityData.edgePoints were explicitly reset to raw
    // every call. Pure geometry, decoupled from street/block generation (which legitimately
    // stays gated to typed districts — untyped ones shouldn't get interior streets).
    this.sp._applyRiverCliffPullback(cityData.districts)
    // Generate over every TYPED district (locked or in preview). `locked` governs
    // immutability (no reseed/retype), not graph membership; untyped districts are
    // absent, so their shared boundaries stay deferred until they're typed.
    const subset = cityData.districts.filter(d => d.assignedType || d.id === previewDistrictId)
    if (!subset.length) {
      cityData.streetGraph = null
      cityData.blocks = []
      cityData.plots = []
      return
    }
    this._generateStreetGraph(subset, 0, isFinal)
    this._generateBuildings()
    console.log(`[perf] generateForLocked: ${(performance.now()-t0).toFixed(1)}ms (${subset.length}/${cityData.districts.length} districts typed, final=${isFinal})`)
  }

  // Remove districtEdgePlacements entries whose boundary junctions now exist in the
  // street graph — i.e., at least one adjacent district has been typed and generated.
  _removeAbsorbedDistrictEdgePlacements() {
    const cityData = this.sp.gameStateManager.cityDistrictData
    const typedIds = new Set((cityData?.districts || []).filter(d => d.assignedType && d.locked).map(d => d.id))
    this.sp.districtEdgePlacements = this.sp.districtEdgePlacements.filter(entry => {
      const edge = cityData?.edges?.[entry.edgeId]
      if (!edge) return false
      // Keep entry only while neither adjacent district has been locked yet
      return !typedIds.has(edge.districtA) && !typedIds.has(edge.districtB)
    })
  }

  // Reseed a not-yet-locked district's interior streets, then regenerate. Always rerolls
  // the seed once (that's the point of an explicit "Regenerate Streets" click).
  regenerateDistrict(districtId) {
    const cityData = this.sp.gameStateManager.cityDistrictData
    const district = cityData?.districts?.find(d => d.id === districtId)
    if (!district) throw new Error(`District ${districtId} not found`)
    if (!district.assignedType) throw new Error(`District ${districtId} has no type yet`)
    if (district.locked) throw new Error(`District ${districtId} is already applied and permanent`)

    let s = ((district.streetSeed ?? district.id) * 2654435761) >>> 0
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    district.streetSeed = s >>> 0
    this.generateForLocked(districtId)

    this.sp.log.push(`Regenerated streets for district ${districtId}`)
    return { ok: true, log: this.sp.log }
  }

  // Discard a provisional (previewed, not-yet-locked) district — clear its type/seed
  // so it returns to a blank district polygon, and regenerate without it. Locked
  // districts are final and never reverted.
  revertDistrict(districtId) {
    const cityData = this.sp.gameStateManager.cityDistrictData
    const district = cityData?.districts?.find(d => d.id === districtId)
    if (!district) throw new Error(`District ${districtId} not found`)
    if (district.locked) return { ok: true, log: this.sp.log }

    if (district.promotedFromPlotId != null) {
      // Abandoned City Expansion — undo the promotion entirely rather than leaving a
      // blank district behind. The source terrain plot becomes eligible again (see
      // getCityDistrictDataForClient, which re-derives eligiblePromotionPlotIds).
      cityData.districts = cityData.districts.filter(d => d.id !== districtId)
      for (const key of Object.keys(cityData.edges || {})) {
        const edge = cityData.edges[key]
        if (edge.districtA === districtId || edge.districtB === districtId) delete cityData.edges[key]
      }
      this.generateForLocked()
      this.sp.log.push(`Abandoned promotion of district ${districtId} — plot restored`)
      return { ok: true, log: this.sp.log }
    }

    district.assignedType = null
    district.residentialClass = null
    district.LeadershipClass = null
    district.producedResource = null
    district.secondProducedResource = null
    district.consumedResources = []
    district.streetSeed = null
    district.description = ''
    this.generateForLocked()
    this.sp.log.push(`Reverted district ${districtId} to blank`)
    return { ok: true, log: this.sp.log }
  }

  // Advancing to Guild Creation: auto-assign + lock any still-untyped districts, then
  // finalize the whole-city geometry. Auto-assigned types are spread across every
  // selectable district type (not just Residential) — districts left blank by the
  // player are handed out from a shuffled queue of whichever types the city doesn't
  // have yet, so a small city heavily favours getting one of each type represented;
  // once every type is covered, any further blanks fall back to uniform-random.
  // Resource production/consumption for non-Residential/Leadership auto-assignments use
  // placeholder values for now (real per-type balancing is a separate pass).
  // Promote an unassigned, Living-Boundary-adjacent terrain PLOT (a fine Voronoi cell,
  // not its coarse parent Terrain region) into a new city District (City Expansion).
  // The plot's own polygon becomes the district polygon. After promotion the new
  // district is ordinary — it can be assigned any type including Leadership. Terrain
  // elevation is preserved (future Z-height); surface cover will be removed when the
  // district generates buildings.
  promoteTerrainPlotToDistrict(plotId) {
    const wt = this.sp.gameStateManager.worldTerrainData
    const cityData = this.sp.gameStateManager.cityDistrictData

    // Find the fine terrain plot — NOT the coarse merged Terrain region it belongs to.
    const plot = wt?.terrainPlots?.find(p => p.id === plotId)
    if (!plot) throw new Error(`Terrain plot ${plotId} not found`)

    // Only block if this specific plot already has a terrain DISTRICT assignment
    // (Forestry, Agriculture, etc.), tracked separately in terrainDistrictPlots.
    if (this.sp.terrainDistrictPlots?.some(p => p.plotId === plotId)) {
      throw new Error(`Plot ${plotId} already has a terrain district assignment.`)
    }

    // Water, ice, and mountainous terrain can never become a city District.
    if (_isIneligibleTerrainPlot(plot, wt)) {
      throw new Error(`Plot ${plotId} is Lake/Sea/Ice Sheet/Mountains terrain and cannot become a city district.`)
    }

    // Defensive guard against re-promoting an already-promoted plot (e.g. two seats
    // racing on the same plot in multiplayer). The normal UI path can't reach this —
    // getCityDistrictDataForClient() excludes already-promoted plots from
    // eligiblePromotionPlotIds — but the server must not trust client state alone.
    const districts = cityData?.districts || []
    if (districts.some(d => d.promotedFromPlotId === plotId)) {
      throw new Error(`Plot ${plotId} has already been promoted to a city district.`)
    }

    // Must be within the Living Boundary — share a full boundary edge with any district.
    if (!this._isWithinLivingBoundary(plot, districts)) {
      throw new Error('This terrain plot is not adjacent to the city.')
    }

    // Build the new district from the terrain plot's own TRUE pristine geometry — its
    // _rawPolygon/_rawPointIds if the plot has already been through a river/cliff
    // pullback pass, not its current (possibly already-split) polygon/pointIds. Starting
    // from an already-split id here would make the district's own future pullback pass
    // split a split, and would leave the district's cached "raw" base stale forever if
    // the world-level river/cliff that caused the plot's split is later cleared.
    const newId = Math.max(-1, ...districts.map(d => d.id)) + 1
    const rawSourcePolygon = plot._rawPolygon || plot.polygon || plot.vertices || []
    const rawSourceIds = plot._rawPointIds || plot.pointIds || []
    const polygon = rawSourcePolygon.map(v => ({ x: v.x, y: v.y }))
    if (polygon.length < 3) throw new Error('Terrain plot has no usable polygon')

    const newDistrict = {
      id: newId,
      // z adopted from the originating terrain plot's own seedPoint (TODO.md
      // "Groundplane Z-height implementation", plan "rustling-churning-finch",
      // user-confirmed 2026-07-12: "Districts must adopt the City terrain plots'
      // z-heights that spawned them"). The district's boundary corners (pointIds,
      // below) already share the terrain plot's exact registry point ids, so THEIR z
      // is inherited automatically by construction — only seedPoint needed an explicit
      // copy, since it's a bare object, not a shared registry id (see §2).
      seedPoint: plot.seedPoint
        ? { x: plot.seedPoint.x, y: plot.seedPoint.y, z: plot.seedPoint.z ?? 0 }
        : { x: polygon[0].x, y: polygon[0].y, z: 0 },
      polygon,
      pointIds: [...rawSourceIds],
      assignedType: null,
      description: '',
      promotedFromPlotId: plotId,  // record the origin for future Z-height
    }
    districts.push(newDistrict)

    // Add boundary edges between the new district and its city neighbours.
    this._addPromotedDistrictEdges(newDistrict, cityData)

    // Otherwise the new district's polygon sits raw/un-pulled-back until some later,
    // unrelated action happens to call generateForLocked.
    this.generateForLocked()

    this.sp.log.push(`Promoted terrain plot ${plotId} (region ${plot.parentRegionId}) to city district ${newId}`)
    return { ok: true, newDistrictId: newId, log: this.sp.log }
  }

  // Check if a terrain plot shares a full boundary EDGE (two consecutive matching
  // vertices, not just one coincident corner) with any existing city district — this is
  // the Living Boundary rule (CONTEXT_WorldTerrain.md: "sharing an edge"). A single
  // shared vertex (a diagonal/corner touch) does NOT qualify.
  //
  // Compares RAW (pre-river/cliff-pullback) polygons, not the current ones — a River or
  // Cliff pullback deliberately pulls each side's shared corner apart to open the gap
  // the water/rock face fills, so two plots geometrically split by a river never share
  // an exact vertex in their CURRENT polygons even though they're still adjacent in
  // every sense that matters for city growth. Raw geometry is exactly the pre-split
  // shape, so it still has the exact shared vertices regardless of any river between
  // them (confirmed live: city expansion couldn't reach the far bank of a river running
  // through/beside the city). Falls back to the current polygon for a plot/district that
  // hasn't been through a pullback pass yet (no _rawPolygon captured) — identical to the
  // current polygon in that case anyway, so this is never a regression for the
  // no-river-between-them case.
  _isWithinLivingBoundary(plot, districts) {
    const EPS2 = 0.01 * 0.01
    const closeEnough = (p, q) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 < EPS2
    const poly = plot._rawPolygon || plot.polygon || plot.vertices || []
    if (poly.length < 2) return false
    for (let i = 0; i < poly.length; i++) {
      const a1 = poly[i], a2 = poly[(i + 1) % poly.length]
      for (const d of districts) {
        const dPoly = d._rawPolygon || d.polygon || []
        for (let j = 0; j < dPoly.length; j++) {
          const b1 = dPoly[j], b2 = dPoly[(j + 1) % dPoly.length]
          const matches = (closeEnough(a1, b1) && closeEnough(a2, b2)) || (closeEnough(a1, b2) && closeEnough(a2, b1))
          if (matches) return true
        }
      }
    }
    return false
  }

  // Recompute which terrain plots currently qualify for City Expansion (unassigned +
  // within the Living Boundary) and attach the id list to cityDistrictData, then return
  // it. The server is the single authority for this (ADR-0003) — the client reads the
  // list rather than re-deriving adjacency itself. Call sites: every response that sends
  // cityDistrictData to the client.
  getCityDistrictDataForClient() {
    const cityData = this.sp.gameStateManager.cityDistrictData
    if (!cityData) return cityData
    const wt = this.sp.gameStateManager.worldTerrainData
    const districts = cityData.districts || []
    const alreadyPromoted = new Set(districts.filter(d => d.promotedFromPlotId != null).map(d => d.promotedFromPlotId))
    const alreadyTerrainAssigned = new Set((this.sp.terrainDistrictPlots || []).map(p => p.plotId))
    cityData.eligiblePromotionPlotIds = (wt?.terrainPlots || [])
      .filter(p => !alreadyPromoted.has(p.id) && !alreadyTerrainAssigned.has(p.id))
      .filter(p => !_isIneligibleTerrainPlot(p, wt))
      .filter(p => this._isWithinLivingBoundary(p, districts))
      .map(p => p.id)
    // District z-height (plan "typed-gliding-leaf"): district.polygon only carries {x,y}
    // — real z lives on the shared registry Points, addressed via district.pointIds (see
    // DistrictRenderer.setCityDistrictData's resolvePolygon call). Attach a registry
    // snapshot so every city-district client call site can resolve it, the same way
    // terrain routes already attach pointRegistry (server/index.js). A SHALLOW COPY, not
    // a mutation of the live cityData — GameStateManager.serialize() spreads
    // groundplane.city verbatim into the save, so writing this large, fully-derivable
    // field directly onto the live object would duplicate the whole registry into every
    // autosave.
    return { ...cityData, pointRegistry: this.sp.gameStateManager.pointRegistry.toJSON() }
  }

  // Add District Edges between the newly promoted district and any existing districts
  // that share polygon boundary segments with it. newDistrict.pointIds already carries
  // the real global registry ids (copied straight from the originating terrain plot in
  // promoteTerrainPlotToDistrict), so edge pointIds are read off directly — no
  // coordinate-key resolver needed (the eps=0.01 resolvePointId pass this used to run,
  // and its private edgePoints dedup, are both deleted; see plan §2). StreetVoronoiGenerator
  // skips any city edge with fewer than 2 resolved pointIds, so a promoted district's
  // boundary must carry real point data, not just districtA/districtB references.
  _addPromotedDistrictEdges(newDistrict, cityData) {
    const edges = cityData.edges || (cityData.edges = {})
    const edgePoints = cityData.edgePoints || (cityData.edgePoints = [])
    let edgeIdx = Object.keys(edges).filter(k => k.startsWith('promoted-')).length
    const EPS2 = 0.01 * 0.01
    const close = (p, q) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 < EPS2

    // Classify every boundary SEGMENT of the new district (not just individual vertices):
    // does it coincide with a segment of an existing district (an inner edge), or does it
    // face open terrain (an outer edge, districtB: null)? Mirrors generateCityDistrictData's
    // inner/outer segment split so promoted districts get full-perimeter edge coverage —
    // without it, exterior-facing segments have no edge object at all, so they can never be
    // walled (_applyAutoWalling only iterates existing edges) and StreetVoronoiGenerator
    // never generates a boundary street/gutter there.
    const poly = newDistrict.polygon
    const ids = newDistrict.pointIds
    const n = poly.length

    // Ensure every one of this district's own points is present in cityData.edgePoints —
    // by id, not coordinate proximity, since these ARE the real registry ids already.
    // (cityData.edgePoints itself is a transitional convenience copy for consumers not
    // yet reading the point registry directly — see GroundPointRegistry.js.)
    const edgePointIds = new Set(edgePoints.map(p => p.id))
    for (let i = 0; i < n; i++) {
      if (!edgePointIds.has(ids[i])) {
        edgePoints.push({ id: ids[i], x: poly[i].x, y: poly[i].y })
        edgePointIds.add(ids[i])
      }
    }

    // A promoted district can be adjacent (in the raw, pre-pullback tessellation) to an
    // existing district ACROSS a River/Cliff — the two only "touch" because neither side
    // has been inset from the water yet. Match on the INSET copy instead of the raw one:
    // once each side is properly pulled back off the river/cliff, their segments no
    // longer coincide, so this correctly falls through to the "outer" branch below and
    // each district gets its own independent edge (own Wall, if typed) rather than being
    // merged into one shared inner edge that renders a single wall down the river's
    // centre. Only used for the coincidence test — the actual edge/point data below still
    // uses the raw `poly`, since _applyRiverCliffPullback (run later, once this district
    // is typed) is what actually insets district.polygon and keeps cityData.edgePoints in
    // sync; duplicating that here would double-pull-back this district's own boundary.
    const matchPoly = this.sp._pullBackPolygon(poly, ids, this.sp._riverCliffBoundaryById(0.35), 0.35).pushed

    const segmentNeighbor = new Array(n).fill(null)
    for (let i = 0; i < n; i++) {
      const a1 = matchPoly[i], a2 = matchPoly[(i + 1) % n]
      for (const d of (cityData.districts || [])) {
        if (d.id === newDistrict.id) continue
        const dPoly = d.polygon || []
        for (let j = 0; j < dPoly.length; j++) {
          const b1 = dPoly[j], b2 = dPoly[(j + 1) % dPoly.length]
          if ((close(a1, b1) && close(a2, b2)) || (close(a1, b2) && close(a2, b1))) {
            segmentNeighbor[i] = d.id
            break
          }
        }
        if (segmentNeighbor[i] != null) break
      }
    }

    // Merge consecutive same-neighbor segments into single polyline edges, carrying the
    // real global point ids straight from newDistrict.pointIds — no resolver needed.
    let outerIdx = 0
    let i = 0
    while (i < n) {
      const neighbor = segmentNeighbor[i]
      const start = i
      while (i < n && segmentNeighbor[i] === neighbor) i++
      const runIds = ids.slice(start, i).concat([ids[i % n]])
      if (neighbor != null) {
        const key = `promoted-${edgeIdx++}`
        edges[key] = { districtA: newDistrict.id, districtB: neighbor, pointIds: runIds, assignedType: null, description: '' }
      } else {
        const key = `promoted-outer-${newDistrict.id}-${outerIdx++}`
        edges[key] = { districtA: newDistrict.id, districtB: null, pointIds: runIds, assignedType: null, description: '' }
      }
    }
  }

  finishSubdivision({ skipLeadershipCheck = false } = {}) {
    const cityData = this.sp.gameStateManager.cityDistrictData
    const RESIDENTIAL_CLASSES = ['Slums', 'Middle', 'Noble']
    const districts = cityData?.districts || []

    // Require exactly one Leadership district before finishing. If absent, return early
    // so the client can show the prompt (assign manually, or call autoAssignLeadership).
    if (!skipLeadershipCheck) {
      const hasLeadership = districts.some(d => d.assignedType === 'Leadership')
      if (!hasLeadership) {
        return { ok: false, needsLeadership: true, log: this.sp.log }
      }
    }

    const usedTypes = new Set(districts.filter(d => d.assignedType && d.assignedType !== 'Leadership').map(d => d.assignedType))
    const missingTypes = ALL_DISTRICT_TYPES.filter(t => !usedTypes.has(t))
    const typeQueue = _shuffleSeeded(missingTypes, 1337)

    for (const district of districts) {
      if (!district.assignedType) {
        // Prefer a still-missing type (heavy coverage bias); once the queue is empty
        // every type is already represented somewhere in the city, so fall back to a
        // uniform-random pick among all of them.
        let districtType
        if (typeQueue.length) {
          districtType = typeQueue.shift()
        } else {
          let s = (district.id * 2654435761) >>> 0
          s ^= s << 13; s ^= s >>> 17; s ^= s << 5
          districtType = ALL_DISTRICT_TYPES[(s >>> 0) % ALL_DISTRICT_TYPES.length]
        }
        usedTypes.add(districtType)

        if (districtType === 'Residential') {
          let s = (district.id * 2654435761) >>> 0
          s ^= s << 13; s ^= s >>> 17; s ^= s << 5
          const cls = RESIDENTIAL_CLASSES[(s >>> 0) % RESIDENTIAL_CLASSES.length]
          district.assignedType = 'Residential'
          district.residentialClass = cls
          district.producedResource = cls !== 'Noble' ? 'Labour' : null
          district.secondProducedResource = null
          district.consumedResources = ['Water', 'Basic Food']
          district.description = ''
          district.name = generateName('Residential', cls)
          this.sp.log.push(`Auto-assigned Residential (${cls}) to district ${district.id}`)
        } else {
          district.assignedType = districtType
          district.residentialClass = null
          district.LeadershipClass = null
          // Register a real Recipe for the placeholder good so it derives consumption
          // through the same path as a player-defined resource, rather than a hand-rolled
          // consumedResources list that the Type system doesn't otherwise know about.
          const placeholderName = `Placeholder Good ${district.id}`
          this.sp._registerResourceDef({
            name: placeholderName, gpValue: 10, type: 'Resource',
            ingredients: [`Placeholder Input ${district.id}A`, `Placeholder Input ${district.id}B`],
            specialInput: 'Labour'
          })
          district.producedResource = placeholderName
          district.secondProducedResource = null
          const derived = this.sp._deriveConsumption([placeholderName])
          district.consumedResources = [...derived, ...['Water', 'Basic Food'].filter(r => !derived.some(e => e.toLowerCase() === r.toLowerCase()))]
          district.description = ''
          district.name = generateName('district', districtType)
          this.sp.log.push(`Auto-assigned ${districtType} (placeholder resources) to district ${district.id}`)
        }
      }
      if (district.streetSeed == null) district.streetSeed = district.id
    }
    // Generation must succeed before we commit the locked state — if it throws,
    // districts remain unlocked so the player can retry without a broken state.
    this.generateForLocked()
    this.sp._rebuildFactions()
    for (const district of districts) district.locked = true
    this.sp.currentStep = 'GuildCreation'
    this.sp.log.push('City subdivision complete. Moving to guild creation.')
    return { ok: true, log: this.sp.log }
  }

  // Generate the street graph over `districts` (a subset of the city's districts).
  // Trade routes are placeholder-only during District Setup; pass isFinal=true at
  // completion so they are clipped to the city interior and added as Mud roads.
  _generateStreetGraph(districts, epochSeed = 0, isFinal = false) {
    const t0 = performance.now()
    const cityData = this.sp.gameStateManager.cityDistrictData
    if (!cityData?.districts?.length || !districts?.length) return

    // Market districts always produce Gold (normalisation; harmless if already set).
    for (const d of districts) {
      if (d.assignedType === 'Market') d.producedResource = 'Gold'
    }

    // NOTE: city edges are intentionally left unassigned here. The generator already
    // treats a null edge type as the default (betterStreetType) boundary road, and
    // mutating edge.assignedType would mark every district edge as "assigned" —
    // making it non-selectable and breaking edge editing throughout District Setup.

    const tradeRoutes = []
    if (isFinal) {
      for (const trade of this.sp.tradingDestinations || []) {
        const wp = this.sp._tradeRoadWaypoints(trade.roadPath || [])
        if (wp) tradeRoutes.push(wp)
      }
    }

    // River/cliff pullback now runs unconditionally for every district (typed or not)
    // in generateForLocked, this function's only caller, before the subset filtering
    // that produces `districts` here — see Edge, CONTEXT_WorldTerrain.md. No need to
    // repeat it on just this subset.

    const MAX_TOPOLOGY_RETRIES = 3
    let streetGraph = null
    for (let attempt = 0; attempt <= MAX_TOPOLOGY_RETRIES; attempt++) {
      const gen = new StreetVoronoiGenerator()
      streetGraph = gen.generate(districts, cityData.edges, cityData.edgePoints || [], epochSeed, tradeRoutes, this.sp.gameStateManager.pointRegistry)
      const issues = streetGraph.topologyIssues
      if (!issues || issues.crossings === 0) break

      if (attempt === MAX_TOPOLOGY_RETRIES) {
        console.error(`[street-graph] Topology unrecoverable after ${MAX_TOPOLOGY_RETRIES} retries — ${issues.crossings} crossing(s) remain. Gutter generation may be incorrect.`)
        break
      }

      // Increment seeds for non-locked districts involved in crossings.
      // Locked district seeds are fixed — if all involved districts are locked we cannot
      // fix the crossings by reseeding; the error above will fire on the final attempt.
      const affectedIds = issues.affectedDistrictIds ?? new Set()
      let reseeded = false
      for (const d of districts) {
        if (!affectedIds.has(d.id) || d.locked) continue
        let s = ((d.streetSeed ?? d.id) * 2654435761) >>> 0
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        d.streetSeed = s >>> 0
        reseeded = true
        console.log(`[street-graph] Crossing in district ${d.id} — reseeding (attempt ${attempt + 1}/${MAX_TOPOLOGY_RETRIES})`)
      }
      if (!reseeded) {
        console.error(`[street-graph] Crossing involves only locked districts [${[...affectedIds].join(', ')}] — cannot reseed. Gutter generation may be incorrect.`)
        break
      }
    }
    cityData.streetGraph = streetGraph
    console.log(`[perf]   streets: ${(performance.now()-t0).toFixed(1)}ms (${districts.length} districts → ${cityData.streetGraph.junctions.length} junctions, ${cityData.streetGraph.edges?.length ?? '?'} edges)`)
    this.sp.log.push(`Generated street graph over ${districts.length} district(s): ${cityData.streetGraph.junctions.length} junctions, ${tradeRoutes.length} trade road(s) (final=${isFinal})`)
  }

  _generateBuildings() {
    const t0 = performance.now()
    const cityData = this.sp.gameStateManager.cityDistrictData
    if (!cityData?.streetGraph) return
    cityData.landmarkBuildings = []
    if (!CALC_BLOCKS) {
      cityData.blocks = []
      cityData.plots  = []
      this.sp.log.push('Block calculation disabled (pipelineFlags.CALC_BLOCKS)')
      return
    }

    const tBlocks = performance.now()
    const { blocks, roadEdges } = new CityBlockGenerator().generate(cityData.districts, cityData.streetGraph, this.sp.gameStateManager.pointRegistry)
    cityData.blocks = blocks
    console.log(`[perf]   blocks: ${(performance.now()-tBlocks).toFixed(1)}ms (${blocks.length} blocks)`)

    // Mark City squares, then place Landmarks on their (joined) clusters BEFORE plots,
    // so plot generation can drop the ground beneath each Landmark (ADR-0005).
    const tLandmarks = performance.now()
    markSquareBlocks(blocks, cityData.districts)
    const { landmarkBuildings, footprints } = new LandmarkPlacer().generate(blocks, cityData.districts, this.sp.gameStateManager.pointRegistry)
    cityData.landmarkBuildings = landmarkBuildings
    const squareCount = blocks.filter(b => b.blockType === 'square').length
    console.log(`[perf]   landmarks: ${(performance.now()-tLandmarks).toFixed(1)}ms (${landmarkBuildings.length} landmarks, ${squareCount} squares)`)

    // City squares are paved, walkable extensions of the street network — record
    // them on the street graph so they can be rendered in the street pass and
    // traversed by pathfinding (across the square, not around it). Each square
    // carries the road edges it borders, which form its connectivity to streets.
    cityData.streetGraph.squares = blocks
      .filter(b => b.blockType === 'square')
      .map(b => ({
        blockId: b.id,
        districtId: b.districtId,
        polygon: b.blockCorners,
        streetType: majorityStreetType(b.streetEdges),
        streetEdges: b.streetEdges,
      }))

    if (!CALC_PLOTS) {
      cityData.plots = []
      this.sp.log.push(`Generated ${blocks.length} blocks, ${landmarkBuildings.length} landmarks (plot calculation disabled)`)
      return
    }

    const tPlots = performance.now()
    const junctions = cityData.streetGraph?.junctions || []
    const { plots } = new PlotVoronoiGenerator().generate(blocks, cityData.districts, junctions, roadEdges, footprints, this.sp.gameStateManager.pointRegistry)
    cityData.plots = plots
    console.log(`[perf]   plots: ${(performance.now()-tPlots).toFixed(1)}ms (${plots.length} plots)`)

    // Terrain plots: ALWAYS recomputed fresh from the raw world terrain cells — never
    // reused from a previous pass. A district gaining its street graph for the first
    // time, or an existing district edge becoming a Wall/Canal/Docks/MainRoad (changing
    // what the city footprint covers there), both change which raw terrain plots should
    // be excluded (see the parentRegionId filter below — no boolean clipping against the
    // footprint polygon, see plan "typed-giggling-giraffe" ADR-0020 decision 2), and any
    // district (not just the one that just changed) can have terrain plots bordering it
    // that need to react. Recomputing from scratch every time is the only way that
    // doesn't require tracking which districts changed since the last pass.
    const tTerrain = performance.now()
    const wt = this.sp.gameStateManager.worldTerrainData
    const rawTerrainPlots = this.sp._rawSurroundingTerrainPlots()
    const tradeRoadWaypoints = (this.sp.tradingDestinations || [])
      .map(td => this.sp._tradeRoadWaypoints(td.roadPath || []))
      .filter(Boolean)
    const terrainPlots = convertTerrainCellsToPlots(rawTerrainPlots, tradeRoadWaypoints, wt?.regions || [], wt?.riverCliffFaces || [], this.sp.gameStateManager.pointRegistry)
    cityData.plots = [...cityData.plots, ...terrainPlots]
    console.log(`[perf]   terrain plots: ${(performance.now()-tTerrain).toFixed(1)}ms (${terrainPlots.length} plots)`)
    if (terrainPlots.length > 0) {
      for (const edge of (cityData.streetGraph?.edges || []))
        if (edge.right === null) edge.right = 'terrain'
      for (const junction of (cityData.streetGraph?.junctions || [])) {
        if (junction.right === null) junction.right = 'terrain'
        for (const conn of (junction.connections || []))
          if (conn.right === null) conn.right = 'terrain'
      }
      computeTerrainPlotStreetAdjacency(cityData.streetGraph, terrainPlots)
      
    }


    this.sp._syncDistrictEdgeRegions()
    this.sp._syncGroundplaneSurfaces()

    console.log(`[perf]   _generateBuildings total: ${(performance.now()-t0).toFixed(1)}ms`)
    const terrainPlotCount = cityData.plots.filter(p => p.type === 'terrain').length
    this.sp.log.push(`Generated ${blocks.length} blocks, ${plots.length} plots, ${landmarkBuildings.length} landmarks, ${cityData.streetGraph.squares.length} squares, ${terrainPlotCount} terrain plots`)
  }

  // Re-derive all plots on load: city block plots (from saved blocks + junctions) and
  // terrain plots (from worldTerrainData). Replaces both old saved plot arrays.
  // Returns the total number of plots generated.
  regeneratePlots() {
    const cityData = this.sp.gameStateManager.cityDistrictData
    if (!cityData?.blocks?.length || !cityData?.streetGraph) return 0

    const districts = Array.from(this.sp.gameStateManager.districts.values())
    const blocks    = cityData.blocks
    const junctions = cityData.streetGraph.junctions || []
    const roadEdges = gutterRoadEdges(junctions)

    markSquareBlocks(blocks, districts)
    // Stage D (ADR-0020): resolve blockCorners for square blocks BEFORE the LandmarkPlacer
    // call below — its _clusterSquares needs real coordinates for centroid/area math, and
    // once GameStateManager.serialize() conditionally strips blockCorners (any block with
    // pointIds), a block loaded straight from the save may only have pointIds. Read-only
    // registry.resolve() here, deliberately NOT passing the registry into generate()
    // itself — see the next comment for why that stays forbidden.
    const registry = this.sp.gameStateManager.pointRegistry
    for (const block of blocks) {
      if (block.blockCorners || !block.pointIds?.length) continue
      block.blockCorners = registry.resolve(block.pointIds).map(p => ({ x: p.x, y: p.y, z: p.z }))
    }
    // Deliberately NO registry passed into LandmarkPlacer.generate() (unlike
    // _generateBuildings' own call) — this method re-derives plots on load without
    // touching cityData.landmarkBuildings, which still holds pointIds minted by the
    // ORIGINAL _generateBuildings() pass that produced this save. Passing the registry
    // would clearKind('landmark') and re-mint fresh ids that this call then discards
    // (footprints here is transient, feeding PlotVoronoiGenerator only) — leaving the
    // saved landmarkBuildings[].pointIds dangling against deleted registry points.
    // footprints.polygon (plain {x,y}, no pointIds) is all PlotVoronoiGenerator needs to
    // drop plot cells under each Landmark.
    const { footprints } = new LandmarkPlacer().generate(blocks, districts)
    const { plots } = new PlotVoronoiGenerator().generate(blocks, districts, junctions, roadEdges, footprints, this.sp.gameStateManager.pointRegistry)

    const wt = this.sp.gameStateManager.worldTerrainData
    const rawTerrainPlots = this.sp._rawSurroundingTerrainPlots()
    const tradeRoadWaypoints = (this.sp.tradingDestinations || [])
      .map(td => this.sp._tradeRoadWaypoints(td.roadPath || []))
      .filter(Boolean)
    const terrainPlots = convertTerrainCellsToPlots(rawTerrainPlots, tradeRoadWaypoints, wt?.regions || [], wt?.riverCliffFaces || [], this.sp.gameStateManager.pointRegistry)

    cityData.plots = [...plots, ...terrainPlots]

    if (terrainPlots.length > 0) {
      for (const edge of (cityData.streetGraph?.edges || []))
        if (edge.right === null) edge.right = 'terrain'
      for (const junction of (cityData.streetGraph?.junctions || [])) {
        if (junction.right === null) junction.right = 'terrain'
        for (const conn of (junction.connections || []))
          if (conn.right === null) conn.right = 'terrain'
      }
      computeTerrainPlotStreetAdjacency(cityData.streetGraph, terrainPlots)
      
    }


    return cityData.plots.length
  }
}
