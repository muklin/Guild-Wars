import TerrainVoronoiGenerator, { organicClipCircle, organicOuterClipRadius } from './CityGenerator/TerrainVoronoiGenerator.js'
import StreetVoronoiGenerator from './CityGenerator/StreetVoronoiGenerator.js'
import CityBlockGenerator, { majorityStreetType, gutterRoadEdges } from './CityGenerator/CityBlockGenerator.js'
import PlotVoronoiGenerator, { markSquareBlocks } from './CityGenerator/PlotVoronoiGenerator.js'
import LandmarkPlacer from './CityGenerator/buildings/LandmarkPlacer.js'
import BuildingTemplateGenerator from './CityGenerator/buildings/BuildingTemplateGenerator.js'
import TextureTemplateGenerator from './CityGenerator/buildings/TextureTemplateGenerator.js'
import { CALC_BLOCKS, CALC_PLOTS } from './pipelineFlags.js'
import { convertTerrainCellsToPlots } from './CityGenerator/TerrainPlotConverter.js'
import GroundPointRegistry from './CityGenerator/GroundPointRegistry.js'
import DCEL, { dedupeConsecutiveIds } from './CityGenerator/DCEL.js'
import { computeRiverCliffBoundaries } from './CityGenerator/riverCliffBoundary.js'
import { applyTerrainTypeZEffect, getRegionCornerIds, computeCliffChainSides, propagateFromPoints, CLIFF_Z_RULE, CLIFF_LERP_T, lerp, applyRiverZGradient } from './CityGenerator/TerrainZHeight.js'
import { applyCanalZDelta } from './CityGenerator/DistrictZHeight.js'
import { auditGroundplane } from './CityGenerator/auditGroundplane.js'
import { pip, clipPolygonToSide, polygonCrossesSegment, computeVoronoiCellsHalfPlane, clipToPolygon } from './voronoi/VoronoiUtils.js'
import { getDistrictConfig } from '../../shared/districtConfig.js'
import { generateName } from '../../shared/nameLibrary.js'
import { extractBoundaryChain, boundaryConnectionAt } from '../../shared/boundaryChain.js'
import GroundplaneAudit from './GroundplaneAudit.js'
import TerrainSetup from './TerrainSetup.js'
import DistrictSetup from './DistrictSetup.js'
import StreetBlockPlotPipeline from './StreetBlockPlotPipeline.js'

// Attached/Freestanding/Custom Model are no longer decided here. They're rolled
// per-building, client-side, entirely from plot geometry (see ADR-0019 and
// BuildingRenderer.js) — there is no more server-side blockType/'townhouse' pass.

export default class SetupPhase {
  constructor(gameStateManager) {
    this.gameStateManager = gameStateManager
    this.groundplaneAudit = new GroundplaneAudit(this)
    this.terrainSetup = new TerrainSetup(this)
    this.districtSetup = new DistrictSetup(this)
    this.streetBlockPlotPipeline = new StreetBlockPlotPipeline(this)
    this.currentStep = 'Terrain'
    this.log = []
    // Stateless utility instance (no per-generation state — generateBoundaryEdges,
    // convexHull etc. work standalone) — constructed here, not just inside
    // initialize(), so it's never null after a server restart that loads an existing
    // save instead of calling initialize() fresh. _revealAdjacentHiddenTerrain relies
    // on this being present; before this fix a restart-then-reveal threw
    // "Cannot read properties of null (reading 'convexHull')", silently failing the
    // whole assignment before autoSave/broadcast ever ran (confirmed live 2026-07-12).
    this.worldGenerator = new TerrainVoronoiGenerator()
    this.selectedRegionId = null
    this.selectedDistrictId = null
    this.terrainPlacements = []
    this.edgePlacements = []
    this.districtTypePlacements = []
    this.districtEdgePlacements = []
    this.districtClassAssignments = new Map()
    this.resourceRegistry = []
    this.resourceDefinitions = {}
    this.threats = []
    this.tradingDestinations = []
    this.factions = []
    this.gods = []
    this.magicSystem = null
    this.foreignPowers = []
    this.worldDomains = null
    this.terrainDistrictPlots = []
    this.terrainFeaturePlots = []
  }

  _generateWorldWithHoleCheck(...args) { return this.terrainSetup._generateWorldWithHoleCheck(...args) }

  initialize(...args) { return this.terrainSetup.initialize(...args) }

  generateCityDistrictData(...args) { return this.districtSetup.generateCityDistrictData(...args) }

  _sortIntoPolyline(...args) { return this.streetBlockPlotPipeline._sortIntoPolyline(...args) }

  _splitIntoChains(...args) { return this.streetBlockPlotPipeline._splitIntoChains(...args) }

  findCityRegion(...args) { return this.terrainSetup.findCityRegion(...args) }


  isNorthOfCentre(...args) { return this.terrainSetup.isNorthOfCentre(...args) }

  assignTerrainToRegion(...args) { return this.terrainSetup.assignTerrainToRegion(...args) }

  _hiddenNeighborsOf(...args) { return this.terrainSetup._hiddenNeighborsOf(...args) }

  _revealAdjacentHiddenTerrain(...args) { return this.terrainSetup._revealAdjacentHiddenTerrain(...args) }

  assignEdgeType(...args) { return this.terrainSetup.assignEdgeType(...args) }

  assignDistrictType(...args) { return this.districtSetup.assignDistrictType(...args) }

  _applyAutoWalling(...args) { return this.districtSetup._applyAutoWalling(...args) }

  previewDistrictType(...args) { return this.districtSetup.previewDistrictType(...args) }

  _registerResource(...args) { return this.districtSetup._registerResource(...args) }

  _registerResourceDef(...args) { return this.districtSetup._registerResourceDef(...args) }

  attachIngredientToResource(...args) { return this.districtSetup.attachIngredientToResource(...args) }

  getWiringCandidates(...args) { return this.districtSetup.getWiringCandidates(...args) }

  _dependsOn(...args) { return this.districtSetup._dependsOn(...args) }

  _deriveConsumption(...args) { return this.districtSetup._deriveConsumption(...args) }

  addThreat(...args) { return this.districtSetup.addThreat(...args) }

  addTradingDestination(...args) { return this.districtSetup.addTradingDestination(...args) }

  _findRoadPath(...args) { return this.districtSetup._findRoadPath(...args) }

  _tradeRoadWaypoints(...args) { return this.districtSetup._tradeRoadWaypoints(...args) }

  assignCityEdgeType(...args) { return this.districtSetup.assignCityEdgeType(...args) }

  // District Edge→Region conversion (ADR-0020 decisions 4–6, plan Addendum 2 Stage C) —
  // same pattern as _syncLinearFeatureRegions, applied to cityDistrictData.edges
  // (Wall/MainRoad/Canal/Docks) instead of worldTerrainData.edges (River/Cliff).
  // centrelinePointIds is the district Edge's own pointIds — already registry-backed
  // (district polygons/edges resolve through the shared GroundPointRegistry, same as
  // terrain edges — see plan Stage A finding on edgePoints). surfaceIds is populated from
  // _buildDistrictEdgeFaces (see that method) wherever a chain's street-graph junctions
  // resolve cleanly — a chain that's still genuinely pending (fewer than 2 junctions,
  // same as DistrictRenderer's own fallback) simply gets no Surface yet, same
  // recompute-from-pristine philosophy as River/Cliff. This still always records the
  // canonical Region (type, centreline, name/description) so it's queryable/persisted
  // regardless, and reversion (clearing a district edge's type) works the same
  // not-recreated way as linear terrain features, once edge clearing exists for
  // district edges.
  // ── GroundplaneAudit delegates (server/engine/GroundplaneAudit.js) ───────────────
  // River/Cliff/District-Edge pullback, DCEL materialize/parity, groundplane
  // Surface/Region sync, and the audit log now live there — see plan
  // "wondrous-conjuring-wand" Stage 3. Only the methods still called from elsewhere
  // in this file (or, for _recoverGeometryFromSeeds, from server/index.js) get a
  // delegate; every other method that moved is now purely internal to that module.
  _syncDistrictEdgeRegions(...args) { return this.groundplaneAudit._syncDistrictEdgeRegions(...args) }
  _cityEdgeIsNearWater(...args) { return this.groundplaneAudit._cityEdgeIsNearWater(...args) }
  _pullBackPolygon(...args) { return this.groundplaneAudit._pullBackPolygon(...args) }
  _applyRiverCliffPullback(...args) { return this.groundplaneAudit._applyRiverCliffPullback(...args) }
  _riverCliffBoundaryById(...args) { return this.groundplaneAudit._riverCliffBoundaryById(...args) }
  _applyRiverCliffPullbackToTerrainPlots(...args) { return this.groundplaneAudit._applyRiverCliffPullbackToTerrainPlots(...args) }
  _syncGroundplaneSurfaces(...args) { return this.groundplaneAudit._syncGroundplaneSurfaces(...args) }
  _recoverGeometryFromSeeds(...args) { return this.groundplaneAudit._recoverGeometryFromSeeds(...args) }

  finishTerrain(...args) { return this.streetBlockPlotPipeline.finishTerrain(...args) }

  generateForLocked(...args) { return this.streetBlockPlotPipeline.generateForLocked(...args) }

  _removeAbsorbedDistrictEdgePlacements(...args) { return this.streetBlockPlotPipeline._removeAbsorbedDistrictEdgePlacements(...args) }

  regenerateDistrict(...args) { return this.streetBlockPlotPipeline.regenerateDistrict(...args) }

  revertDistrict(...args) { return this.streetBlockPlotPipeline.revertDistrict(...args) }



  promoteTerrainPlotToDistrict(...args) { return this.streetBlockPlotPipeline.promoteTerrainPlotToDistrict(...args) }

  _isWithinLivingBoundary(...args) { return this.streetBlockPlotPipeline._isWithinLivingBoundary(...args) }

  getCityDistrictDataForClient(...args) { return this.streetBlockPlotPipeline.getCityDistrictDataForClient(...args) }


  _addPromotedDistrictEdges(...args) { return this.streetBlockPlotPipeline._addPromotedDistrictEdges(...args) }

  autoAssignLeadership(...args) { return this.districtSetup.autoAssignLeadership(...args) }

  finishSubdivision(...args) { return this.streetBlockPlotPipeline.finishSubdivision(...args) }

  _generateStreetGraph(...args) { return this.streetBlockPlotPipeline._generateStreetGraph(...args) }

  _generateBuildings(...args) { return this.streetBlockPlotPipeline._generateBuildings(...args) }

  _rawSurroundingTerrainPlots(...args) { return this.terrainSetup._rawSurroundingTerrainPlots(...args) }

  regenerateTerrainPlots(...args) { return this.terrainSetup.regenerateTerrainPlots(...args) }

  regeneratePlots(...args) { return this.streetBlockPlotPipeline.regeneratePlots(...args) }

  assignTerrainDistrict(...args) { return this.districtSetup.assignTerrainDistrict(...args) }

  assignDistrictClass(...args) { return this.districtSetup.assignDistrictClass(...args) }

  createPlayerGuild(...args) { return this.districtSetup.createPlayerGuild(...args) }

  setGuildHeadquarters(...args) { return this.districtSetup.setGuildHeadquarters(...args) }

  _resolveHeadquarters(...args) { return this.districtSetup._resolveHeadquarters(...args) }

  _leadershipFaction(...args) { return this.districtSetup._leadershipFaction(...args) }

  _finalizeLeadershipInfluence(...args) { return this.districtSetup._finalizeLeadershipInfluence(...args) }

  _initFactionStandings(...args) { return this.districtSetup._initFactionStandings(...args) }

  _initGuildRelations(...args) { return this.districtSetup._initGuildRelations(...args) }


  getLog() { return this.log }

  reset() {
    this.currentStep = 'Terrain'
    this.log = []
    this.selectedRegionId = null
    this.selectedDistrictId = null
    this.terrainPlacements = []
    this.edgePlacements = []
    this.districtTypePlacements = []
    this.districtEdgePlacements = []
    this.districtClassAssignments.clear()
    this.resourceRegistry = []
    this.threats = []
    this.tradingDestinations = []
    this.factions = []
    this.gods = []
    this.magicSystem = null
    this.foreignPowers = []
    this.worldDomains = null
    this.terrainDistrictPlots = []
    this.terrainFeaturePlots = []
  }

  serialize() {
    return {
      currentStep: this.currentStep,
      terrainPlacements: this.terrainPlacements,
      edgePlacements: this.edgePlacements,
      districtTypePlacements: this.districtTypePlacements,
      districtEdgePlacements: this.districtEdgePlacements,
      districtClassAssignments: Array.from(this.districtClassAssignments.entries()),
      resourceRegistry: this.resourceRegistry,
      resourceDefinitions: this.resourceDefinitions,
      threats: this.threats,
      tradingDestinations: this.tradingDestinations,
      factions: this.factions,
      gods: this.gods,
      magicSystem: this.magicSystem,
      foreignPowers: this.foreignPowers,
      worldDomains: this.worldDomains,
      terrainDistrictPlots: this.terrainDistrictPlots,
      terrainFeaturePlots: this.terrainFeaturePlots
    }
  }

  deserialize(data) {
    // Street Setup was folded into City Subdivision; old saves map to Guild Creation.
    if (data.currentStep) this.currentStep = data.currentStep === 'StreetSetup' ? 'GuildCreation' : data.currentStep
    if (data.terrainPlacements) this.terrainPlacements = data.terrainPlacements
    if (data.edgePlacements) this.edgePlacements = data.edgePlacements
    if (data.districtTypePlacements) this.districtTypePlacements = data.districtTypePlacements
    if (data.districtEdgePlacements) this.districtEdgePlacements = data.districtEdgePlacements
    if (data.districtClassAssignments) {
      this.districtClassAssignments = new Map(data.districtClassAssignments)
    }
    if (data.threats) this.threats = data.threats
    if (data.tradingDestinations) this.tradingDestinations = data.tradingDestinations
    this.gods = data.gods ?? []
    this.magicSystem = data.magicSystem ?? null
    this.foreignPowers = data.foreignPowers ?? []
    this.worldDomains = data.worldDomains ?? null
    this.terrainDistrictPlots = data.terrainDistrictPlots ?? []
    this.resourceDefinitions = data.resourceDefinitions ?? {}
    // Rebuild derived lists from source-of-truth data so older saves are reconciled on load.
    this._rebuildFactions()
    this._rebuildRegistry()
  }

  addGod(...args) { return this.districtSetup.addGod(...args) }

  defineMagicSystem(...args) { return this.districtSetup.defineMagicSystem(...args) }

  refineMagicSystem(...args) { return this.districtSetup.refineMagicSystem(...args) }

  addForeignPowerThreat(...args) { return this.districtSetup.addForeignPowerThreat(...args) }

  addForeignPowerTrade(...args) { return this.districtSetup.addForeignPowerTrade(...args) }

  addForeignPower(...args) { return this.districtSetup.addForeignPower(...args) }

  _rebuildRegistry() {
    const PREDEFINED_LOWER = ['gold', 'water', 'labour', 'basic food', 'security']
    this.resourceRegistry = []
    const reg = (name) => {
      if (name && !PREDEFINED_LOWER.includes(name.toLowerCase()) && !this.resourceRegistry.includes(name)) {
        this.resourceRegistry.push(name)
      }
    }
    const districts = this.gameStateManager.cityDistrictData?.districts || []
    for (const d of districts) {
      if (d.producedResource) reg(d.producedResource)
      if (d.secondProducedResource) reg(d.secondProducedResource)
      for (const r of (d.consumedResources || [])) reg(r)
    }
    for (const tDP of (this.terrainDistrictPlots || [])) {
      if (tDP.producedResource) reg(tDP.producedResource)
      for (const r of (tDP.consumedResources || [])) reg(r)
    }
    // Every god's Worship service is selectable/consumable even before any Religious
    // district actually produces it (see addGod) — not derivable from district scans
    // alone, so re-register it here too or it silently drops on every reload.
    for (const god of (this.gods || [])) {
      if (god.name) reg(`Worship of ${god.name}`)
    }
    // Backwards compat: old saves stored on region objects
    const regions = this.gameStateManager.worldTerrainData?.regions || []
    if (!(this.terrainDistrictPlots?.length)) {
      for (const region of regions) {
        if (region.terrainDistrictProducedResource) reg(region.terrainDistrictProducedResource)
        for (const r of (region.terrainDistrictConsumedResources || [])) reg(r)
      }
    }
    for (const trade of this.tradingDestinations) {
      for (const r of [...(trade.buys || []), ...(trade.sells || [])]) reg(r)
    }
  }

  _rebuildFactions(...args) { return this.districtSetup._rebuildFactions(...args) }
}
