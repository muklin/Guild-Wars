// Terrain generation, region/edge type assignment, and hidden-terrain reveal —
// extracted verbatim from SetupPhase.js (see plan "wondrous-conjuring-wand", Stage 3)
// as the second of 4 seamed modules. Unlike GroundplaneAudit, this bucket has real
// cross-module CALLS (into DistrictSetup and the GroundplaneAudit-backed Orchestrator
// delegates) — every such call is routed through `this.sp` (the owning SetupPhase
// instance), never a direct instance reference to a sibling module. The one exception
// is computeTerrainPlotStreetAdjacency, a plain pure function (not a method) shared
// with StreetBlockPlotPipeline — imported directly, same as any other utility import.
import TerrainVoronoiGenerator, { organicClipCircle, organicOuterClipRadius } from './CityGenerator/TerrainVoronoiGenerator.js'
import { gutterRoadEdges } from './CityGenerator/CityBlockGenerator.js'
import { convertTerrainCellsToPlots } from './CityGenerator/TerrainPlotConverter.js'
import { applyTerrainTypeZEffect, getRegionCornerIds, applyRiverZGradient, computeCliffChainSides, forceInitialCliffSeparation } from './CityGenerator/TerrainZHeight.js'
import { auditGroundplane } from './CityGenerator/auditGroundplane.js'
import { pip, clipToPolygon } from './voronoi/VoronoiUtils.js'
import { computeTerrainPlotStreetAdjacency } from './StreetBlockPlotPipeline.js'
// TERRAIN_REVEAL_TYPES/EDGE_ONLY_TYPES/NORTH_HALF_ANGLE_DEG live in
// worldConfig/terrainConfig.js now (the single source of truth for every terrain
// tunable) — TERRAIN_REVEAL_TYPES' own doc comment there covers "the edge of the known
// world" reveal/merge behaviour and _recoverGeometryFromSeeds' matching use of the list;
// NORTH_HALF_ANGLE_DEG's covers the angular "north" convention (organic world boundary,
// not a literal straight edge — callers must also check region.isEdge separately, this
// only answers "which direction").
import { TERRAIN_REVEAL_TYPES, EDGE_ONLY_TYPES, NORTH_HALF_ANGLE_DEG, CLIFF_MIN_SEPARATION } from '../../worldConfig/terrainConfig.js'

export default class TerrainSetup {
  constructor(setupPhase) {
    this.sp = setupPhase
  }

  // Generates the world, then runs auditGroundplane (server/engine/CityGenerator/
  // auditGroundplane.js) against the resulting terrain plots — user-confirmed
  // 2026-07-13, prompted by a live-observed hole in the generated terrain. Only checks
  // HOLE count (not OVERLAP/PINCH/AREA_OVERLAP — those are a separate, not-yet-
  // requested concern): auditGroundplane's own onWorldBoundary check already excludes
  // the map's outer edge from HOLE findings ("exclude the outside edges" — a genuine
  // gap at the edge of the generated world is expected, not a bug), so any remaining
  // HOLE finding is a real interior gap. Retries generation from scratch (fresh
  // registry each time — clearKind('terrain') wipes the failed attempt's points, since
  // nothing else has been built yet this early in initialize()) up to maxAttempts times;
  // ships the last attempt's result with a warning if it never comes back clean rather
  // than hanging New Game indefinitely.
  _generateWorldWithHoleCheck(regionCount, worldSize, mergeDistance, manhattan, maxAttempts = 5) {
    const registry = this.sp.gameStateManager.pointRegistry
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) registry.clearKind('terrain')
      const worldData = this.sp.worldGenerator.generate(regionCount, worldSize, mergeDistance, manhattan, registry)
      // worldData.terrainPlots now holds kept + hidden plots merged (tagged via
      // `.hidden`) — the audit still wants both included, so no filtering here; the
      // id prefix keeps kept/hidden cell ids from colliding, same as the old two-array
      // split did with separate `tp:`/`htp:` prefixes.
      const surfaces = worldData.terrainPlots.map(p => ({
        id: `${p.hidden ? 'htp' : 'tp'}:${p.id}`,
        kind: 'terrain-plot',
        pointIds: p.pointIds
      }))
      const groundplane = { points: registry.toJSON(), surfaces, terrain: { worldSize } }
      const { counts, boundaryEdgeKeys } = auditGroundplane(groundplane)
      if (counts.HOLE === 0) {
        if (attempt > 1) this.sp.log.push(`Terrain generation succeeded on attempt ${attempt} (hole-free)`)
        // User-specified design: compute the map's outer ring of edges ONCE, right here
        // (a hole-free generation's boundaryEdgeKeys IS exactly that ring, nothing else —
        // every other unpaired edge would have shown up as a HOLE finding and failed the
        // check above), and treat it as permanently exempt from HOLE reporting for the
        // rest of the game — every subsequent audit (Cliff/River/Berm splits, District→
        // Street→Block→Plot generation, all wired through _auditAndLogGroundplane) reads
        // this same set, so a genuinely NEW gap near the map edge is no longer masked by
        // onWorldBoundary's radius heuristic (which this replaces as the primary test —
        // see auditGroundplane.js).
        this.sp.gameStateManager.groundplane.outerRingEdgeKeys = boundaryEdgeKeys
        this.sp.log.push(`Outer ring: ${boundaryEdgeKeys.length} boundary edge(s) marked permanently exempt from hole audits`)
        return worldData
      }
      console.warn(`[SetupPhase] Terrain generation attempt ${attempt}/${maxAttempts} has ${counts.HOLE} hole(s) (excluding world boundary) — ${attempt < maxAttempts ? 'retrying' : 'giving up, shipping anyway'}`)
      if (attempt === maxAttempts) {
        this.sp.gameStateManager.groundplane.outerRingEdgeKeys = boundaryEdgeKeys
        return worldData
      }
    }
  }

  initialize() {
    this.sp.gameStateManager.clear()
    this.sp.log = []
    this.sp.terrainPlacements = []
    this.sp.edgePlacements = []
    this.sp.districtTypePlacements = []
    this.sp.districtEdgePlacements = []
    this.sp.districtClassAssignments.clear()
    this.sp.resourceRegistry = []
    this.sp.resourceDefinitions = {}
    this.sp.threats = []
    this.sp.tradingDestinations = []
    this.sp.factions = []
    this.sp.gods = []
    this.sp.magicSystem = null
    this.sp.foreignPowers = []
    this.sp.worldDomains = null
    this.sp.terrainDistrictPlots = []
    this.sp.terrainFeaturePlots = []
    this.sp.log.push('Initializing Setup Phase...')

    this.sp.worldGenerator = new TerrainVoronoiGenerator()
    // mergeDistance 0.02 (was 0, user-confirmed 2026-07-14): Step 1.5's
    // mergeNearbyVertices exists specifically to merge near-coincident circumcenters at
    // complex multi-region junctions, but sat permanently disabled (mergeDistance=0)
    // since this call was first written. Root-caused live via a save file: two raw
    // 'terrain' points 0.0114 apart — a genuine near-miss circumcenter pair at a 4+-way
    // junction, never merged — each independently got zLocked by its own Ice Sheet
    // domain pass (slightly different jittered z) and then each independently split by
    // the Cliff pullback, producing a visible 4-point cluster/gap where the user should
    // have seen one clean shared corner. 0.02 comfortably covers that case (and the
    // general class of near-cocircular-circumcenter noise this function's own doc
    // comment describes) while staying far below real inter-point spacing (~1.6 units
    // average at this world's density), so it can't merge two legitimately distinct
    // corners.
    const worldData = this._generateWorldWithHoleCheck(15, 50, 0.02, 0)
    this.sp.gameStateManager.worldTerrainData = worldData
    this.sp.log.push(`Generated ${worldData.regions.length} terrain regions`)

    // region.isEdge already set by the generator (Step 3.7/Step 5's void-adjacency
    // scan — see TerrainVoronoiGenerator.js) — the organic world boundary means "edge"
    // is now a real adjacency fact from generation, not a post-hoc square-touching
    // geometry test. isNorthEdge still needs computing here (a SetupPhase-only
    // gameplay concept, Ice Sheet gating) — see isNorthOfCentre's doc comment for why
    // it's angular now instead of a literal straight-edge test.
    const worldSize = 50
    for (const region of worldData.regions) {
      region.isNorthEdge = region.isEdge && this.isNorthOfCentre(region, worldSize)
    }

    const cityRegion = this.findCityRegion(worldData.regions, worldSize)
    if (cityRegion) {
      cityRegion.assignedType = 'City'
      for (const cell of worldData.terrainPlots || [])
        if (cell.parentRegionId === cityRegion.id) cell.assignedType = 'City'
      this.sp.log.push(`Identified city region: Region ${cityRegion.id}`)

      const cityTerrainPlots = worldData.terrainPlots.filter(c => c.parentRegionId === cityRegion.id)
      const cityData = this.sp.generateCityDistrictData(cityTerrainPlots)
      this.sp.gameStateManager.cityDistrictData = cityData
      this.sp.log.push(`Generated ${cityData.districts.length} city districts`)
    }

    // Build the initial subdivided terrain mesh + manifold audit up front (ADR-0022), so a
    // freshly generated world already renders as the welded smooth surface, not flat plots
    // that only subdivide after the first edit.
    this.sp._syncGroundplaneSurfaces()

    this.sp.currentStep = 'Terrain'
    return {
      step: this.sp.currentStep,
      regions: worldData.regions,
      terrainPlots: worldData.terrainPlots,
      edges: worldData.edges,
      edgePoints: worldData.edgePoints,
      terrainSurfaces: worldData.terrainSurfaces || [],
      pointRegistry: this.sp.gameStateManager.pointRegistry.toJSON(),
      log: this.sp.log
    }
  }

  // City region = whichever region's polygon actually CONTAINS the map's centre point
  // (TODO.md; organic-world plan "federated-baking-dragon") — replaces the old
  // "largest non-edge region by terrain-plot count" heuristic, which existed only
  // because a forced-square world had no other natural notion of "the middle."
  findCityRegion(regions, worldSize = 50) {
    const cx = worldSize / 2, cy = worldSize / 2
    const containing = regions.find(r => r.polygon?.length >= 3 && pip(cx, cy, r.polygon))
    if (containing) return containing
    // Fallback (rare: centre lands exactly on a shared boundary edge, so neither
    // region's polygon strictly contains it) — nearest region by seed distance to
    // centre, keeping the old function's "always returns something" guarantee.
    return regions.reduce((a, b) => {
      const da = (a.seedPoint.x - cx) ** 2 + (a.seedPoint.y - cy) ** 2
      const db = (b.seedPoint.x - cx) ** 2 + (b.seedPoint.y - cy) ** 2
      return da <= db ? a : b
    })
  }

  isNorthOfCentre(region, worldSize) {
    const cx = worldSize / 2, cy = worldSize / 2
    const dx = region.seedPoint.x - cx, dy = region.seedPoint.y - cy
    if (dx === 0 && dy === 0) return false
    const bearing = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360
    return bearing <= NORTH_HALF_ANGLE_DEG || bearing >= 360 - NORTH_HALF_ANGLE_DEG
  }

  assignTerrainToRegion(regionId, terrainType, description = '', name = '') {
    const regions = this.sp.gameStateManager.worldTerrainData.regions
    const region = regions.find(r => r.id === regionId)
    if (!region) throw new Error(`Region ${regionId} not found`)
    if (region.assignedType) throw new Error(`Region ${regionId} is already assigned ${region.assignedType}`)

    if (EDGE_ONLY_TYPES.includes(terrainType) && !region.isEdge) {
      throw new Error(`${terrainType} can only be placed on edge regions`)
    }
    if (terrainType === 'Ice Sheet' && !region.isNorthEdge) {
      throw new Error('Ice Sheet can only be placed on north-edge regions')
    }

    // Ice Sheet and Desert are mutually exclusive world-wide (not just adjacency, unlike
    // Sea/Lake below) — the first one placed anywhere on the map fixes the whole world's
    // climate as "cold" or "hot", ruling out the other for the rest of the game.
    if (terrainType === 'Ice Sheet' || terrainType === 'Desert') {
      const forbidden = terrainType === 'Ice Sheet' ? 'Desert' : 'Ice Sheet'
      if (regions.some(r => r.assignedType === forbidden)) {
        throw new Error(`${terrainType} cannot be placed — ${forbidden} already exists on this map`)
      }
    }

    if (terrainType === 'Sea' || terrainType === 'Lake') {
      const forbidden = terrainType === 'Sea' ? 'Lake' : 'Sea'
      const edges = this.sp.gameStateManager.worldTerrainData.edges
      for (const edge of Object.values(edges)) {
        const otherId = edge.regionA === regionId ? edge.regionB : edge.regionB === regionId ? edge.regionA : null
        if (otherId !== null) {
          const other = regions.find(r => r.id === otherId)
          if (other?.assignedType === forbidden) {
            throw new Error(`${terrainType} cannot be adjacent to ${forbidden}`)
          }
        }
      }
    }

    region.assignedType = terrainType
    region.description = description
    region.name = name?.trim() || ''
    const rawCells = this.sp.gameStateManager.worldTerrainData?.terrainPlots || []
    for (const cell of rawCells)
      if (cell.parentRegionId === region.id) cell.assignedType = terrainType
    this.sp.terrainPlacements.push({ regionId, terrainType, description, name: region.name })
    this.sp.log.push(`Assigned ${terrainType} to region ${regionId}`)

    // Ice Sheet: auto-assign all adjacent unassigned inter-region edges as Cliffs. Goes
    // straight to `edge.assignedType = 'Cliff'` rather than routing through
    // assignEdgeType() (region assignment vs. edge assignment are different call paths)
    // — so it must also call forceInitialCliffSeparation itself, the same way
    // assignEdgeType does, or an auto-cliffed edge (by far the most common way a Cliff
    // gets created) never gets the "forced apart at definition" step at all.
    const autoCliffEdgeIds = []
    if (terrainType === 'Ice Sheet') {
      const wt = this.sp.gameStateManager.worldTerrainData
      const edges = wt.edges
      const regionsById = new Map(regions.map(r => [r.id, r]))
      for (const [edgeId, edge] of Object.entries(edges)) {
        if ((edge.regionA === regionId || edge.regionB === regionId) && !edge.assignedType) {
          edge.assignedType = 'Cliff'
          edge.description = ''
          edge.name = ''
          this.sp.edgePlacements.push({ edgeId, edgeType: 'Cliff', description: '', name: '' })
          this.sp.log.push(`Auto-cliffed edge ${edgeId} (borders Ice Sheet)`)
          autoCliffEdgeIds.push(edgeId)
          forceInitialCliffSeparation(this.sp.gameStateManager.pointRegistry, edges, edgeId, wt.terrainPlots || [], regionsById)
        }
      }
    }

    const clearedEdgeIds = []
    if (terrainType === 'Lake' || terrainType === 'Sea') {
      const edges = this.sp.gameStateManager.worldTerrainData.edges
      for (const [edgeId, edge] of Object.entries(edges)) {
        if ((edge.regionA === regionId || edge.regionB === regionId) && edge.assignedType === 'River') {
          edge.assignedType = null
          edge.description = ''
          this.sp.edgePlacements = this.sp.edgePlacements.filter(p => p.edgeId !== edgeId)
          this.sp.log.push(`Cleared River from edge ${edgeId} (borders ${terrainType})`)
          clearedEdgeIds.push(edgeId)
        }
      }
    }

    // Ice Sheet next to Ice Sheet: there are no valid edge types between two Ice Sheets,
    // EVER, even a Cliff that was genuinely valid before both sides became Ice Sheet
    // (user-confirmed 2026-07-26, "ice sheet should never have cliffs, even when the
    // cliff was previously valid") — clear whatever's there, same as Sea/Lake clearing
    // River above, but ANY assignedType (not just River). Must run again after the
    // SECOND auto-cliff pass below (post-reveal), not just once here — that pass can
    // just as easily auto-cliff a newly-revealed edge that turns out to border another
    // Ice Sheet, and without a second sweep it would stay a Cliff forever (confirmed
    // live 2026-07-26: cliffs appearing INSIDE a contiguous Ice Sheet area, from exactly
    // this ordering gap). See _clearIceSheetAdjacentCliffs' own doc comment for why a
    // freshly-Cliffed edge can't just skip itself instead of clearing after the fact.
    if (terrainType === 'Ice Sheet') clearedEdgeIds.push(...this._clearIceSheetAdjacentCliffs(regionId))

    // Restored (2026-07-11, after a same-day revert-and-re-revert): pullback runs here
    // again, during Terrain Setup, NOT deferred to District mode. The deferral (tried
    // earlier today) broke District-mode block/plot generation catastrophically: a
    // district's boundary pointIds are only re-adopted from its originating terrain
    // plot's CURRENT pointIds when their lengths match (see _applyRiverCliffPullback's
    // adoption loop) — but a district's own _rawPointIds snapshot is frozen at whatever
    // its pointIds were on its FIRST pullback call ever. With pullback deferred, a
    // district got created (and took that snapshot) from RAW, unsplit terrain geometry;
    // the first real pullback (adding confluence-split vertices) then happened later,
    // permanently mismatching the frozen raw length against the new, larger current
    // length. Adoption failed forever for most districts (confirmed live: "2/9 adopted"),
    // leaving their pointIds — and every edge derived from them, especially the outer
    // city-boundary edges — orphaned, referencing point ids the next pass's clearKind()
    // deletes outright. That's what broke "boundary streets" and left most blocks
    // uncovered (black voids): the face tracer can't close a loop through a boundary
    // edge whose points no longer resolve. The stroke-rendering revert in
    // TerrainRenderer.js (client-side only) already fully solves the ORIGINAL visual
    // complaint (notches in Terrain mode) on its own — the deferral was never actually
    // needed for that, and is unsafe for the reasons above.
    // Moved off a conditional (only if THIS Apply cleared/auto-cliffed something) to the
    // single unconditional call at the very end of this method — see that call site's own
    // doc comment (ADR-0022 Shore bands need it to run on every Apply, including a
    // first-ever Sea/Lake, which alone never sets autoCliffEdgeIds/clearedEdgeIds).

    // Sea/Mountains/Desert/Ice Sheet represent "the edge of the known world" — reveal
    // and absorb whatever hidden terrain borders this region directly (see
    // _revealAdjacentHiddenTerrain's doc comment).
    let revealedRegionIds = [], newEdgeIds = []
    if (TERRAIN_REVEAL_TYPES.includes(terrainType)) {
      ;({ revealedRegionIds, newEdgeIds } = this._revealAdjacentHiddenTerrain(regionId, terrainType))
    }

    // Second Ice Sheet auto-cliff pass, AFTER the reveal above (user-confirmed
    // 2026-07-26, "these (previously hidden) edges should also be (ice) cliffs"): the
    // FIRST auto-cliff pass (right after region.assignedType is set, above) only ever
    // sees edges that existed at THAT moment — reveal can create brand-new Terrain
    // Edges (newEdgeIds) between the newly-revealed terrain and its own neighbours,
    // including this same Ice Sheet region, which the first pass could never have
    // known about. Re-running the identical scan catches exactly those (everything the
    // first pass already Cliffed is skipped, same `!edge.assignedType` guard) — not
    // narrowed to newEdgeIds specifically, since a revealed plot can also create a new
    // edge against a DIFFERENT already-kept neighbour that isn't in that list.
    if (terrainType === 'Ice Sheet') {
      const wt = this.sp.gameStateManager.worldTerrainData
      const edges = wt.edges
      const regionsById = new Map(regions.map(r => [r.id, r]))
      for (const [edgeId, edge] of Object.entries(edges)) {
        if ((edge.regionA === regionId || edge.regionB === regionId) && !edge.assignedType) {
          edge.assignedType = 'Cliff'
          edge.description = ''
          edge.name = ''
          this.sp.edgePlacements.push({ edgeId, edgeType: 'Cliff', description: '', name: '' })
          this.sp.log.push(`Auto-cliffed edge ${edgeId} (borders Ice Sheet, newly revealed)`)
          autoCliffEdgeIds.push(edgeId)
          forceInitialCliffSeparation(this.sp.gameStateManager.pointRegistry, edges, edgeId, wt.terrainPlots || [], regionsById)
        }
      }
      // Re-sweep: this pass can just as easily have auto-cliffed a newly-revealed edge
      // that borders another Ice Sheet — see _clearIceSheetAdjacentCliffs' own doc
      // comment and the matching call right after the FIRST auto-cliff pass above.
      clearedEdgeIds.push(...this._clearIceSheetAdjacentCliffs(regionId))
    }

    // Terrain z-height (§3/§4 minus Cliff, plan "rustling-churning-finch", ADR-0021):
    // runs on Apply, not on preview/selection — this IS Apply, `region.assignedType`
    // above is the commit point. Deliberately placed AFTER the reveal-hidden-terrain
    // block above, not right after `region.assignedType` is set: Sea/Mountains/Desert/
    // Ice Sheet can absorb hidden terrain plots into this SAME region here, and Sea's
    // whole-domain flatten-and-lock (see applyTerrainTypeZEffect) must see the region's
    // FINAL plot membership, including anything just revealed/absorbed — running earlier
    // would silently miss those plots' points (confirmed live: an edge-of-map Sea left
    // its newly-revealed hidden water unflattened). "Adjust, don't freeze" still holds
    // for every OTHER type: a later-Applied neighbour's own effect can still adjust this
    // region's already-set corners afterward — nothing about this call prevents that,
    // since it only ever touches `.z`, never `.assignedType`.
    // Hidden (generated-but-unrendered) terrain plots are included alongside the kept
    // ones (user-confirmed 2026-07-14, "those terrains are only hidden — they should
    // still be getting height updates resultant of nearby hills etc changes"): a hidden
    // plot's own domain never matches `region.id` (it belongs to a different, hidden
    // region) so the DOMAIN write above is unaffected — this only widens the fine
    // Point/Edge graph propagateFromRegion walks, so a wave from a kept region's Apply
    // can now actually cross into hidden territory instead of stopping dead at the
    // kept/hidden boundary.
    applyTerrainTypeZEffect(
      this.sp.gameStateManager.pointRegistry,
      region,
      getRegionCornerIds(this.sp.gameStateManager.worldTerrainData.edges, regionId),
      this.sp.gameStateManager.worldTerrainData.terrainPlots || [],
      this.sp.gameStateManager.worldTerrainData.regions || []
    )

    // Single unconditional pullback call, moved here (after applyTerrainTypeZEffect, not
    // before) so everything downstream of it sees THIS Apply's own z-height changes —
    // most importantly Shore bands (ADR-0022 Stage 2, built inside this same call): a
    // freshly-Applied Sea/Lake's flatten-and-lock only just happened above, and Shore
    // needs that correct, final water z to build a real band, not whatever the region's
    // corners read before Apply. This call's own trailing _syncGroundplaneSurfaces()
    // then rebuilds terrainSurfaces (ADR-0022's welded, subdivided mesh — Hills included:
    // it's now just a raised rolling height field carried by the z-effect above, its
    // centre-to-edge taper already giving each hill plot an interior peak, so hill↔hill
    // and hill↔flat seams smooth the same as everything else) + runs the manifold audit.
    // Always running (not conditional on cliff/river changes) is what makes a first-ever
    // Sea/Lake's shore appear immediately instead of waiting for an unrelated later edit
    // that happens to trigger pullback.
    this.sp._applyRiverCliffPullbackToTerrainPlots()

    return { ok: true, clearedEdgeIds, autoCliffEdgeIds, revealedRegionIds, newEdgeIds, log: this.sp.log }
  }

  // Clears any edge touching `regionId` (a just-(re)confirmed Ice Sheet) whose OTHER
  // side is ALSO Ice Sheet — there is no valid edge type between two Ice Sheets, EVER,
  // even a Cliff that was genuinely valid before both sides became Ice Sheet
  // (user-confirmed 2026-07-26: "ice sheet should never have cliffs, even when the
  // cliff was previously valid" — confirmed live as cliffs appearing INSIDE a
  // contiguous Ice Sheet area). Deliberately a clear-after-the-fact sweep, not a
  // skip-before-cliffing guard in the auto-cliff passes themselves: two DIFFERENT Ice
  // Sheets placed in sequence share an edge that was unassigned (so eligible for
  // auto-cliff) when the FIRST one was placed, since the second region wasn't Ice
  // Sheet yet — only a sweep run every time ANY Ice Sheet is (re)confirmed catches
  // that retroactively. Callers: both auto-cliff passes in assignTerrainToRegion (each
  // can freshly Cliff an edge that turns out to border another Ice Sheet — confirmed
  // live for the second, post-reveal pass specifically, 2026-07-26).
  _clearIceSheetAdjacentCliffs(regionId) {
    const wt = this.sp.gameStateManager.worldTerrainData
    const edges = wt.edges
    const regions = wt.regions
    const cleared = []
    for (const [edgeId, edge] of Object.entries(edges)) {
      if (!edge.assignedType) continue
      const otherId = edge.regionA === regionId ? edge.regionB : edge.regionB === regionId ? edge.regionA : null
      if (otherId === null) continue
      const other = regions.find(r => r.id === otherId)
      if (other?.assignedType !== 'Ice Sheet') continue
      edge.assignedType = null
      edge.description = ''
      this.sp.edgePlacements = this.sp.edgePlacements.filter(p => p.edgeId !== edgeId)
      this.sp.log.push(`Cleared ${edgeId}'s edge type — no valid edge type between two Ice Sheets`)
      cleared.push(edgeId)
    }
    return cleared
  }

  // "Which hidden region(s) does this KEPT region border" — replaces the former
  // persisted `wt.hiddenNeighborsByRegion` map with an on-demand query over `wt.edges`,
  // which already carries `regionA`/`regionB` on every edge (kept↔hidden and
  // hidden↔hidden pairs included — generateBoundaryEdges builds the full adjacency
  // graph unconditionally, not just kept-kept). Only ever meaningful for a kept
  // `regionId` (a hidden region never gets an isEdge/reveal concept of its own), same
  // as the removed map's original KEPT-regionA-only bookkeeping.
  _hiddenNeighborsOf(regionId) {
    const wt = this.sp.gameStateManager.worldTerrainData
    const keptSet = new Set(wt.regions.filter(r => !r.hidden).map(r => r.id))
    const found = new Set()
    for (const edge of Object.values(wt.edges)) {
      if (edge.regionA === regionId && !keptSet.has(edge.regionB)) found.add(edge.regionB)
      else if (edge.regionB === regionId && !keptSet.has(edge.regionA)) found.add(edge.regionA)
    }
    return [...found]
  }

  // Sea/Mountains/Desert/Ice Sheet only ever get placed on an `isEdge` region — the
  // organic-world boundary means "edge" is literally "borders hidden (generated but
  // unrendered) terrain" (see TerrainVoronoiGenerator's circle-partition design). For
  // these four types specifically there's no real conceptual boundary between "our"
  // Sea and the Sea beyond it, so instead of leaving that hidden territory dark
  // forever, reveal it and merge it directly into the assigning region — same id,
  // same assignedType, no Terrain Edge needed between the two (they're one region
  // now). The newly-exposed area's own outer edge can, though, newly touch OTHER
  // already-kept regions it didn't border before; those get ordinary new Terrain
  // Edges, same as any other kept-kept boundary. Single ring only — reveals exactly
  // the hidden region(s) directly adjacent to `regionId`, not a cascade into hidden-
  // neighbours-of-hidden-neighbours.
  _revealAdjacentHiddenTerrain(regionId, terrainType) {
    const wt = this.sp.gameStateManager.worldTerrainData
    const hiddenIds = this._hiddenNeighborsOf(regionId)
    if (!hiddenIds?.length) return { revealedRegionIds: [], newEdgeIds: [] }

    const registry = this.sp.gameStateManager.pointRegistry
    const worldSize = wt.worldSize || 50
    // Organic outer-ring clip circle (NEVER the literal world square — user-confirmed
    // 2026-07-14, "I never want these to be square, remove whatever is making it
    // square, and make it never happen") — the exact same clip shape generate()'s Step
    // 5.5 gives every kept plot at generation time (TerrainVoronoiGenerator.js). A
    // literal `[0,worldSize]` square clip was used here before the outer-ring rewrite
    // (2026-07-13) replaced Step 5.5's own square clip with this organic circle; this
    // reveal path was never updated to match, so a revealed plot came out square-cut
    // even though every plot kept from the start never does.
    const outerClipCircle = organicClipCircle(worldSize, 48, organicOuterClipRadius(worldSize))

    // Flip `hidden` in place rather than moving objects between separate arrays —
    // hidden regions/plots already live in wt.regions/wt.terrainPlots (merged, tagged
    // via `.hidden`), so "revealing" them is exactly the one-field update the merge was
    // meant to enable.
    const hiddenIdSet = new Set(hiddenIds)
    const revealedPlots = wt.terrainPlots.filter(p => p.hidden && hiddenIdSet.has(p.parentRegionId))
    for (const p of revealedPlots) p.hidden = false
    for (const r of wt.regions) if (hiddenIdSet.has(r.id)) r.hidden = false

    // Clip each revealed plot to the same organic outer clip circle every kept plot
    // already gets at generation time. Hidden plots already receive this exact clip
    // uniformly with kept ones at generation (Step 5.5), so this is a re-clip against
    // an unchanged polygon in the common case — kept for safety/idempotency rather than
    // because hidden plots are known to still need it.
    //
    // Collect every brand-new (not-yet-id'd) clip vertex across ALL revealed plots
    // FIRST, then dedupe them together in one pass — the exact same technique
    // generate()'s Step 5.5 already uses for this identical situation (user-confirmed
    // 2026-07-14, traced live via a duplicate-coordinate 'terrain' point pair: two
    // adjacent revealed plots whose shared boundary crosses the clip circle each
    // computed their OWN intersection point independently — Sutherland-Hodgman clipping
    // isn't guaranteed to land on the bit-identical point when the same physical
    // crossing is traversed in opposite directions by each plot's own polygon winding —
    // and this loop used to call registry.create() directly per vertex with NO
    // deduplication at all, minting two separate ids for what should be one shared
    // corner. That stray duplicate then persists forever: nothing else in the pipeline
    // ever merges two already-distinct 'terrain' points after the fact, only prevents
    // minting new ones going forward.)
    const revealZ = wt.regions.find(r => r.id === regionId)?.seedPoint?.z ?? 0
    const clippedPlots = []
    const newClipVertices = []
    for (const plot of revealedPlots) {
      const clipped = clipToPolygon(plot.polygon, outerClipCircle)
      if (!clipped) continue
      plot.polygon = clipped
      clippedPlots.push(plot)
      for (const v of clipped) if (v.id === undefined) newClipVertices.push(v)
    }
    // z: the revealing region's current z rather than a hardcoded 0 — Sea/Lake
    // immediately overwrite every domain point's z below regardless (see
    // applyTerrainTypeZEffect), but Mountains/Desert/Ice Sheet only ever write
    // boundary-corner z, so a freshly-minted INTERIOR vertex here would otherwise be
    // stuck at 0 forever (a flat pit inside e.g. a revealed Mountains plot). mintDeduped
    // itself always creates a NEW point at z=0, so that's patched on right after — but
    // ONLY for ids that didn't already exist before this call (reuseExisting can hand
    // back an EXISTING point with a real, already-correct z from elsewhere; overwriting
    // that unconditionally would be a regression, not the fix).
    const existingIdsBefore = new Set(registry.toJSON().map(p => p.id))
    const dedupedClipIds = registry.mintDeduped(newClipVertices, 'terrain', 0.01, { reuseExisting: true })
    newClipVertices.forEach((v, i) => {
      v.id = dedupedClipIds[i]
      if (existingIdsBefore.has(v.id)) return   // reused an existing point — leave its z alone
      const p = registry.get(v.id)
      if (p) p.z = revealZ
    })
    for (const plot of clippedPlots) {
      plot.pointIds = plot.polygon.map(v => v.id)
      plot.parentRegionId = regionId
      plot.assignedType = terrainType
      // No push here — the plot is already resident in wt.terrainPlots (merged array),
      // only its fields are updated in place.
    }

    // Rebuild the revealing region's own merged-hull polygon (click hit-testing
    // fallback only — see generate()'s Step 6 doc comment) now that it includes the
    // newly-merged plots.
    const region = wt.regions.find(r => r.id === regionId)
    const allVerts = []
    for (const p of wt.terrainPlots) {
      if (p.parentRegionId !== regionId) continue
      for (const v of p.polygon) if (isFinite(v.x) && isFinite(v.y)) allVerts.push(v)
    }
    region.polygon = this.sp.worldGenerator.convexHull(allVerts)
    // Staleness bug fix: the hull rebuild above used to update `.polygon` without ever
    // refreshing `.pointIds` to match — every vertex here already carries a real
    // registry id (they come from already-minted plot polygons), so this is a direct
    // map, no fresh minting needed. Mirrors _recoverGeometryFromSeeds's own region-hull
    // refresh (SetupPhase.js, its own `r.pointIds = hull.map(v => v.id)` line).
    region.pointIds = region.polygon.map(v => v.id)

    // Recompute boundary edges fresh over the CURRENT plot set (kept + still-hidden)
    // — the exact same adjacency scan generate() used initially. generateBoundaryEdges
    // now builds the FULL edge graph unconditionally (TerrainVoronoiGenerator.js,
    // 2026-07-13), so an edge between regionId and this hidden neighbour — or between
    // two still-hidden regions — likely already exists in `wt.edges`, but with STALE
    // geometry: hidden plots are never clipped to the world square until revealed
    // (just above), so their pre-generated edge pointIds can reference vertices well
    // outside [0,worldSize]. Refresh any edge whose BOTH sides just became shown
    // (kept) with this fresh post-clip computation — but never touch one the player
    // has already assigned a type to. An edge with at least one side still hidden is
    // stored if missing (keeps the full graph complete for a future reveal) and
    // otherwise left alone.
    // wt.regions now contains hidden regions too (merged, tagged via `.hidden`) — this
    // used to be implicitly kept-only because hidden regions lived in a separate array;
    // an explicit filter now preserves that original meaning.
    const keptSet = new Set(wt.regions.filter(r => !r.hidden).map(r => r.id))
    const raw = this.sp.worldGenerator.generateBoundaryEdges(wt.terrainPlots, keptSet)

    const newEdgeIds = []
    for (const [key, edge] of Object.entries(raw.edges)) {
      const bothShown = keptSet.has(edge.regionA) && keptSet.has(edge.regionB)
      const existing = wt.edges[key]
      if (!existing) {
        wt.edges[key] = edge
        if (bothShown) newEdgeIds.push(key)
      } else if (bothShown && !existing.assignedType) {
        wt.edges[key] = edge
        newEdgeIds.push(key)
      }
    }

    // Remove now-stale edges that still reference a just-absorbed hidden region. Every one
    // of `hiddenIds`' plots was reassigned to `regionId` above, so any edge to/from those
    // regions is now either interior to the merged region, or has already been re-created
    // against `regionId` (keyed by the new region pair) by the generateBoundaryEdges
    // refresh above. Left in place they render as stray boundary strokes floating INSIDE
    // the merged Sea/Mountains/Desert blob — the client's same-type edge hider
    // (_edgeHasNoValidType) can't catch them because the absorbed region object is left
    // type-less, so the edge reads as "typed region vs untyped region", not same-type.
    // This is exactly the "edges bordering previously-hidden terrain aren't removed" bug
    // (2026-07-26): Lake never hit it because Lake isn't a TERRAIN_REVEAL_TYPE and so never
    // absorbs anything, which is why Lake|Lake looked correct while Sea/Mountains/Desert
    // did not. Doing it HERE — after the unhide/absorb — is the fix the symptom pointed to.
    // A player-assigned edge never references a still-hidden region (it was never shown to
    // click), so nothing typed is lost.
    for (const key of Object.keys(wt.edges)) {
      const e = wt.edges[key]
      if (hiddenIdSet.has(e.regionA) || hiddenIdSet.has(e.regionB)) delete wt.edges[key]
    }

    // Only regionId's own adjacency changed (its footprint grew) — every other
    // region's neighbours are unaffected. isEdge is the only per-region bookkeeping
    // still refreshed here; "which hidden regions border regionId" is no longer
    // persisted at all — _hiddenNeighborsOf computes it on demand from wt.edges.
    region.isEdge = raw.regionIdsTouchingVoid.has(regionId)

    this.sp.log.push(`Revealed ${revealedPlots.length} hidden terrain plot(s) (region${hiddenIds.length > 1 ? 's' : ''} ${hiddenIds.join(', ')}) into region ${regionId} (${terrainType}); added ${newEdgeIds.length} new Terrain Edge(s)`)

    return { revealedRegionIds: hiddenIds, newEdgeIds }
  }

  assignEdgeType(edgeId, edgeType, description = '', name = '') {
    const edge = this.sp.gameStateManager.worldTerrainData.edges[edgeId]
    if (!edge) throw new Error(`Edge ${edgeId} not found`)
    if (edge.assignedType) throw new Error(`Edge ${edgeId} is already assigned ${edge.assignedType}`)

    edge.assignedType = edgeType
    edge.description = description
    edge.name = name?.trim() || ''
    this.sp.edgePlacements.push({ edgeId, edgeType, description, name: edge.name })
    this.sp.log.push(`Assigned ${edgeType} to edge ${edgeId}`)
    // River z-gradient MUST run before the pullback/split below, not after (plan
    // "typed-gliding-leaf", user-confirmed 2026-07-14, "left/right banks of a river must
    // always remain at the same z-height"): the pullback mints each bank corner as its
    // own registry point, snapshotting z from the raw centreline point at THAT moment
    // (_dcelPullbackMaterialize's posFor copies `base.z` unchanged for a River — no
    // per-side differentiation the way Cliff gets). Grading the centreline first, then
    // splitting, means both bank copies snapshot the SAME already-correct z for free —
    // no separate bank-sync step needed. Grading AFTER the split (the original order)
    // would edit the raw point too late: the split copies already exist with their own
    // frozen z, and wouldn't pick up the change until some later, unrelated pullback
    // recompute. Defining a River doesn't itself trigger propagation elsewhere
    // ("adjust, don't freeze"'s one exception) — this only grades the River's OWN path,
    // reading whatever z already exists at each endpoint/crossing right now.
    if (edgeType === 'River') {
      const wt = this.sp.gameStateManager.worldTerrainData
      const cliffPointIds = new Set()
      for (const e of Object.values(wt.edges)) {
        if (e.assignedType === 'Cliff') for (const pid of e.pointIds || []) cliffPointIds.add(pid)
      }
      applyRiverZGradient(this.sp.gameStateManager.pointRegistry, edge, cliffPointIds)
    }
    // Forces this Cliff's two sides to at least CLIFF_MIN_SEPARATION apart, right now —
    // user-confirmed 2026-07-26, "one side should be forced to be higher, at time of
    // application" (today's z-hook is purely reactive, with no such moment). Same
    // before-the-pullback ordering as River's z-gradient above, and for the same reason:
    // the pullback mints split copies from whatever z already exists right now, so this
    // must land before it, not after. See forceInitialCliffSeparation's own doc comment —
    // one-time only; later edits elsewhere can still narrow or widen it.
    if (edgeType === 'Cliff') {
      const wt = this.sp.gameStateManager.worldTerrainData
      const regionsById = new Map((wt.regions || []).map(r => [r.id, r]))
      forceInitialCliffSeparation(this.sp.gameStateManager.pointRegistry, wt.edges, edgeId, wt.terrainPlots || [], regionsById)
    }
    // Restored (2026-07-11) — see assignTerrainToRegion's matching comment for why
    // deferring this to District mode broke block/plot generation.
    if (edgeType === 'River' || edgeType === 'Cliff') this.sp._applyRiverCliffPullbackToTerrainPlots()
    return { ok: true, log: this.sp.log }
  }

  // Auto-clears any Cliff edge that ends up without CLIFF_MIN_SEPARATION when Terrain mode
  // is left (ADR-0022 one-way commit; user-confirmed 2026-07-26: "remove cliff segments...
  // for all cliffs that do not still have sufficient zheight separation") — neighbouring
  // terrain edits since a Cliff was defined (forceInitialCliffSeparation, above) can still
  // narrow it back down afterwards. Reuses computeCliffChainSides' own per-edge local
  // averages, and applies any weak-local-inversion downgrades it finds too (same clearing
  // GroundplaneAudit._computeCliffSideAtVertex already applies on every pullback pass —
  // repeating it here isn't redundant, since this can run without a pullback happening
  // first). Called from StreetBlockPlotPipeline.finishTerrain(), the exact "leaving
  // Terrain mode" hook, before that method's own generateForLocked() pullback.
  clearWeakCliffSegments() {
    const wt = this.sp.gameStateManager.worldTerrainData
    const registry = this.sp.gameStateManager.pointRegistry
    const regionsById = new Map((wt.regions || []).map(r => [r.id, r]))
    const { sidesByEdge, downgradeEdgeIds } = computeCliffChainSides(wt.edges || {}, wt.terrainPlots || [], registry, regionsById)

    const clear = (edgeId, reason) => {
      const edge = wt.edges[edgeId]
      if (!edge || edge.assignedType !== 'Cliff') return
      edge.assignedType = null
      edge.description = ''
      this.sp.edgePlacements = this.sp.edgePlacements.filter(p => p.edgeId !== edgeId)
      this.sp.log.push(`Cleared Cliff from edge ${edgeId} — ${reason}`)
    }

    for (const edgeId of downgradeEdgeIds) clear(edgeId, 'too weak against a stronger local inversion elsewhere on the run')

    for (const [edgeId, sides] of sidesByEdge) {
      const edge = wt.edges[edgeId]
      if (!edge) continue
      const infoA = sides.get(edge.regionA), infoB = sides.get(edge.regionB)
      if (!infoA || !infoB || infoA.targetAvg == null || infoB.targetAvg == null) continue
      const separation = Math.abs(infoA.targetAvg - infoB.targetAvg)
      if (separation < CLIFF_MIN_SEPARATION) clear(edgeId, `insufficient z separation (${separation.toFixed(3)} < ${CLIFF_MIN_SEPARATION})`)
    }
  }

  // Terrain plots to render as "surrounding countryside" outside the city — excludes
  // both the original City region's plots AND any individually City-Expansion-
  // promoted plot (promoteTerrainPlotToDistrict). A promoted plot becomes a district
  // (its own blocks/plots/buildings) but was never removed from
  // worldTerrainData.terrainPlots itself (by design — other code still needs its raw
  // geometry, e.g. _isWithinLivingBoundary) — without this exclusion its OLD raw
  // terrain-plot Surface kept rendering underneath/around the new district's own
  // content forever (confirmed live 2026-07-12: a district's buildings/streets sitting
  // on top of a visible leftover green terrain fill). Three call sites used to
  // duplicate this filter inline with only the cityRegionId half of it — factored out
  // so the promoted-plot half can't be missed in any of them again.
  _rawSurroundingTerrainPlots() {
    const wt = this.sp.gameStateManager.worldTerrainData
    const cityRegionId = (wt?.regions || []).find(r => r.assignedType === 'City')?.id
    const promotedPlotIds = new Set(
      (this.sp.gameStateManager.cityDistrictData?.districts || [])
        .filter(d => d.promotedFromPlotId != null)
        .map(d => d.promotedFromPlotId)
    )
    return (wt?.terrainPlots || []).filter(p => p.parentRegionId !== cityRegionId && !promotedPlotIds.has(p.id))
  }

  // Re-derive terrain plots from the current world terrain plots — run on save-load so
  // that saved terrain plots always reflect the latest conversion code.
  regenerateTerrainPlots() {
    const cityData = this.sp.gameStateManager.cityDistrictData
    if (!cityData?.blocks?.length) return 0
    const wt = this.sp.gameStateManager.worldTerrainData
    if (!(wt?.terrainPlots?.length)) return 0
    const rawTerrainPlots = this._rawSurroundingTerrainPlots()
    const tradeRoadWaypoints = (this.sp.tradingDestinations || [])
      .map(td => this.sp._tradeRoadWaypoints(td.roadPath || []))
      .filter(Boolean)
    const terrainPlots = convertTerrainCellsToPlots(rawTerrainPlots, tradeRoadWaypoints, wt?.regions || [], wt?.riverCliffFaces || [], this.sp.gameStateManager.pointRegistry)
    cityData.plots = [...(cityData.plots || []).filter(p => p.type !== 'terrain'), ...terrainPlots]
    if (terrainPlots.length > 0) {
      const junctions = cityData.streetGraph?.junctions || []
      const roadEdges = gutterRoadEdges(junctions)
      computeTerrainPlotStreetAdjacency(cityData.streetGraph, terrainPlots)
      
    }
    return terrainPlots.length
  }
}
