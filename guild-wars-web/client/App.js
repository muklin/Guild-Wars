import WorldRenderer from './rendering/WorldRenderer.js'
import InputHandler from './rendering/InputHandler.js'
import UIManager from './ui/UIManager.js'
import GameAPI from './api/GameAPI.js'
import EventBus from './core/EventBus.js'

export default class App {
  constructor() {
    this.renderer = null
    this.inputHandler = null
    this.uiManager = null
    this.eventBus = new EventBus()
    this.gameState = null

    // Terrain selection state
    this.selectedRegionId = null
    this.pendingTerrainType = null
    this.selectedEdgeIds = new Set()
    this.pendingEdgeType = null

    // District selection state (Phase 2)
    this.selectedDistrictId = null
    this.pendingDistrictType = null
    this.selectedCityEdgeIds = new Set()
    this.pendingCityEdgeType = null

    this.resourceRegistry = []
    this.threats = []
    this.tradingDestinations = []
    this.factions = []
    this.playerCount = 1
    this.currentPhase = null
    this.selectedTerrainRegionId = null
    this.pendingTerrainAction = null
    this.pendingResidentialClass = null
    this.pendingLeadershipClass = null
  }

  async init() {
    try {
      this.renderer = new WorldRenderer()
      this.renderer.init()

      this.uiManager = new UIManager(this.eventBus, this.renderer)
      this.uiManager.init()

      this.inputHandler = new InputHandler(this.eventBus)
      this.inputHandler.init(this.renderer)

      this.setupEventListeners()
      await this.loadState()
    } catch (error) {
      console.error('Failed to initialize app:', error)
      this.uiManager?.showError('Failed to initialize game')
    }
  }

  setupEventListeners() {
    // --- Terrain phase ---
    this.eventBus.on('REGION_CLICKED',  (regionId) => this._handleRegionClick(regionId))
    this.eventBus.on('EDGE_CLICKED',    (edge)     => this._handleEdgeClick(edge))

    this.eventBus.on('TERRAIN_TYPE_PREVIEW', (t)    => this._handleTerrainPreview(t))
    this.eventBus.on('TERRAIN_APPLY',        (data) => this._handleTerrainApply(data))
    this.eventBus.on('EDGE_TYPE_PREVIEW',    (t)    => this._handleEdgePreview(t))
    this.eventBus.on('EDGE_APPLY',           (data) => this._handleEdgeApply(data))

    this.eventBus.on('TERRAIN_COMPLETE', async () => {
      const customized = this._countCustomizedTerrain()
      if (customized < this.playerCount) {
        this.uiManager.showConfirm(
          `Less than the recommended terrain Types defined (${this.playerCount} per player)`,
          'Continue',
          () => this._doFinishTerrain()
        )
        return
      }
      await this._doFinishTerrain()
    })

    this.eventBus.on('SUBDIVISION_COMPLETE', async () => {
      const assigned = this._countAssignedDistricts()
      if (assigned < this.playerCount) {
        this.uiManager.showConfirm(
          `Only ${assigned} district${assigned !== 1 ? 's' : ''} assigned (minimum ${this.playerCount} per player). Continue anyway?`,
          'Ignore',
          () => this._doFinishSubdivision()
        )
        return
      }
      await this._doFinishSubdivision()
    })

    // --- City district phase ---
    this.eventBus.on('DISTRICT_CLICKED',      (id)   => this._handleDistrictClick(id))
    this.eventBus.on('CITY_EDGE_CLICKED',     (edge) => this._handleCityEdgeClick(edge))

    this.eventBus.on('DISTRICT_TYPE_PREVIEW',       (t)    => this._handleDistrictPreview(t))
    this.eventBus.on('DISTRICT_RESIDENTIAL_CLASS',  ({ residentialClass }) => {
      this.pendingResidentialClass = residentialClass
      if (this.selectedDistrictId !== null) {
        this.renderer.previewDistrictType(this.selectedDistrictId, residentialClass)
      }
      this._refreshDistrictPanel()
    })

    this.eventBus.on('DISTRICT_RULING_BODY_CLASS', ({ LeadershipClass }) => {
      this.pendingLeadershipClass = LeadershipClass
      if (this.selectedDistrictId !== null) {
        this.renderer.previewDistrictType(this.selectedDistrictId, LeadershipClass)
      }
      this._refreshDistrictPanel()
    })
    this.eventBus.on('DISTRICT_APPLY',              (data) => this._handleDistrictApply(data))
    this.eventBus.on('CITY_EDGE_TYPE_PREVIEW',(t)    => this._handleCityEdgePreview(t))
    this.eventBus.on('CITY_EDGE_APPLY',       (data) => this._handleCityEdgeApply(data))

    this.eventBus.on('STREET_SETUP_COMPLETE', async () => {
      try {
        const response = await GameAPI.finishStreetSetup()
        if (response.ok) {
          this.currentPhase = 'GuildCreation'
          this.uiManager.showSetupPhase('GuildCreation')
        } else {
          this.uiManager.showError(response.error)
        }
      } catch (error) { this.uiManager.showError(error.message) }
    })

    this.eventBus.on('TERRAIN_ACTION_SELECT', async ({ action }) => {
      if (action === 'Trade') {
        const regionId = this.selectedTerrainRegionId
        if (!regionId) return
        try {
          const response = await GameAPI.addTrade(regionId, '')
          if (response.ok) {
            this.tradingDestinations = response.tradingDestinations
            if (response.factions) { this.factions = response.factions; this.uiManager.updateFactions(this.factions) }
            this.renderer.renderTrades(this.tradingDestinations, this.renderer.terrainData)
            this.renderer.deselectRegion(regionId)
            this.selectedTerrainRegionId = null
            this.pendingTerrainAction = null
            this._refreshDistrictPanel()
          } else { this.uiManager.showError(response.error) }
        } catch (error) { this.uiManager.showError(error.message) }
      } else {
        this.pendingTerrainAction = action
        this._refreshDistrictPanel()
      }
    })

    this.eventBus.on('TERRAIN_ACTION_BACK', () => {
      this.pendingTerrainAction = null
      this._refreshDistrictPanel()
    })

    this.eventBus.on('TERRAIN_THREAT_APPLY', async ({ name, description }) => {
      const regionId = this.selectedTerrainRegionId
      if (!regionId) return
      try {
        const response = await GameAPI.addThreat(regionId, description, name)
        if (response.ok) {
          this.threats = response.threats
          this.renderer.renderThreats(this.threats, this.renderer.terrainData?.regions)
          this.uiManager.updateThreats(this.threats)
          this.renderer.deselectRegion(regionId)
          this.selectedTerrainRegionId = null
          this.pendingTerrainAction = null
          this._refreshDistrictPanel()
        } else { this.uiManager.showError(response.error); this._refreshDistrictPanel() }
      } catch (error) { this.uiManager.showError(error.message); this._refreshDistrictPanel() }
    })

    this.eventBus.on('TERRAIN_DISTRICT_ASSIGN', async ({ regionId, districtType, description, producedResource, consumedResources }) => {
      await this._handleTerrainDistrictAssign(regionId, districtType, description, producedResource, consumedResources)
    })

    this.eventBus.on('NEW_GAME', async () => {
      await this.startSetup()
    })

    this.eventBus.on('FACTION_HOVER', (faction) => this.renderer.highlightFaction(faction))
    this.eventBus.on('FACTION_HOVER_END', () => this.renderer.clearHover())

    this.eventBus.on('REBUILD_STREETS', async () => {
      try {
        const response = await GameAPI.rebuildStreets()
        if (response.ok) {
          this.selectedCityEdgeIds.clear()
          this.pendingCityEdgeType = null
          if (response.cityDistrictData) this.renderer.setCityDistrictData(response.cityDistrictData)
          this.renderer.renderStreetGraph(response.cityDistrictData?.streetGraph)
          this.renderer.renderBuildings(response.cityDistrictData?.blocks, response.cityDistrictData?.buildings, response.cityDistrictData?.buildingTemplates, response.cityDistrictData?.textureTemplates)
          if (response.factions) { this.factions = response.factions; this.uiManager.updateFactions(this.factions) }
        } else {
          this.uiManager.showError(response.error)
        }
      } catch (error) { this.uiManager.showError(error.message) }
    })
  }

  // ── Terrain region ──────────────────────────────────────────────────────────

  _handleRegionClick(regionId) {
    const region = this.renderer.terrainData?.regions?.find(r => r.id === regionId)
    if (!region) return

    if (this.currentPhase === 'CitySubdivision') {
      const DISTRICT_FOR = { Forest: 'Forestry', Hills: 'Mining', Plains: 'Agriculture', Lake: 'Fishing', Sea: 'Fishing' }
      const canDistrict = !!DISTRICT_FOR[region.assignedType] && !region.terrainDistrict
      const canThreatTrade = !!region.isEdge
      if (canDistrict || canThreatTrade) {
        this._handleTerrainRegionClick(regionId)
      }
      return
    }

    if (region.assignedType) return

    if (this.selectedRegionId === regionId) {
      this.renderer.deselectRegion(regionId)
      this.selectedRegionId = null
      this.pendingTerrainType = null
      this._refreshTerrainPanel()
      return
    }

    if (this.selectedRegionId !== null) this.renderer.deselectRegion(this.selectedRegionId)
    this._clearEdgeSelection()

    this.selectedRegionId = regionId
    this.pendingTerrainType = null
    this.renderer.selectRegion(regionId)
    this._refreshTerrainPanel()
  }

  _handleTerrainPreview(terrainType) {
    if (this.selectedRegionId === null) return
    this.pendingTerrainType = terrainType
    this.renderer.previewRegionType(this.selectedRegionId, terrainType)
    this._refreshTerrainPanel()
  }

  async _handleTerrainApply({ description }) {
    if (this.selectedRegionId === null || !this.pendingTerrainType) return
    const regionId = this.selectedRegionId
    const terrainType = this.pendingTerrainType
    try {
      const response = await GameAPI.assignTerrain(regionId, terrainType, description)
      if (response.ok) {
        const region = this.renderer.terrainData?.regions?.find(r => r.id === regionId)
        if (region) { region.assignedType = terrainType; region.description = description }
        this.renderer.updateRegionColor(regionId, terrainType)

        for (const edgeId of response.clearedEdgeIds || []) {
          const edge = this.renderer.terrainData?.edges?.[edgeId]
          if (edge) { edge.assignedType = null; edge.description = '' }
          this.selectedEdgeIds.delete(edgeId)
          this.renderer.deselectEdge(edgeId)
        }

        this.selectedRegionId = null
        this.pendingTerrainType = null
        this._refreshTerrainPanel()
        this._checkTerrainAutoAdvance()
      } else {
        this.uiManager.showError(response.error)
        this._refreshTerrainPanel()
      }
    } catch (error) { this.uiManager.showError(error.message); this._refreshTerrainPanel() }
  }

  _countCustomizedTerrain() {
    return (this.renderer.terrainData?.regions || []).filter(r => r.assignedType && r.assignedType !== 'City' && r.assignedType !== 'Plains').length
  }

  _countAssignedDistricts() {
    return (this.renderer.cityDistrictData?.districts || []).filter(d => d.assignedType).length
  }

  _checkTerrainAutoAdvance() {
    if (this._countCustomizedTerrain() >= this.playerCount * 2) {
      this.eventBus.emit('TERRAIN_COMPLETE')
    }
  }

  async _doFinishTerrain() {
    try {
      const response = await GameAPI.finishTerrain()
      if (response.ok) {
        this.gameState = response
        this.currentPhase = 'CitySubdivision'
        this.selectedDistrictId = null
        this.pendingDistrictType = null
        this.pendingResidentialClass = null
        this.pendingLeadershipClass = null
        this.selectedCityEdgeIds.clear()
        this.pendingCityEdgeType = null
        this._finalizeTerrainDisplay()
        const cityData = response.cityDistrictData || { districts: [], edges: {}, edgePoints: [] }
        this.renderer.setCityDistrictData(cityData)
        this.renderer.setMode('city')
        this.uiManager.showSetupPhase('CitySubdivision')
      } else {
        this.uiManager.showError(response.error)
      }
    } catch (error) { this.uiManager.showError(error.message) }
  }

  async _doFinishSubdivision() {
    try {
      const response = await GameAPI.finishSubdivision()
      if (response.ok) {
        this.gameState = response
        this.currentPhase = 'StreetSetup'
        this.selectedTerrainRegionId = null
        this.renderer.setMode('streets')
        if (response.cityDistrictData) {
          this.renderer.setCityDistrictData(response.cityDistrictData)
        }
        this.renderer.renderStreetGraph(response.cityDistrictData?.streetGraph)
        this.renderer.renderBuildings(response.cityDistrictData?.blocks, response.cityDistrictData?.buildings, response.cityDistrictData?.buildingTemplates, response.cityDistrictData?.textureTemplates)
        if (response.factions) {
          this.factions = response.factions
          this.uiManager.updateFactions(this.factions)
        }
        this.uiManager.showSetupPhase('StreetSetup')
      } else {
        this.uiManager.showError(response.error)
      }
    } catch (error) { this.uiManager.showError(error.message) }
  }

  // ── Terrain edge ────────────────────────────────────────────────────────────

  _handleEdgeClick(edge) {
    const edgeData = this.renderer.terrainData?.edges?.[edge.id]
    if (edgeData?.assignedType) return

    if (this.selectedEdgeIds.has(edge.id)) {
      this.selectedEdgeIds.delete(edge.id)
      this.renderer.deselectEdge(edge.id)
    } else {
      if (!this._isEdgeConnectedToSelection(edge)) this._clearEdgeSelection()

      if (this.selectedEdgeIds.size === 0 && this.selectedRegionId !== null) {
        this.renderer.deselectRegion(this.selectedRegionId)
        this.selectedRegionId = null
        this.pendingTerrainType = null
      }

      this.selectedEdgeIds.add(edge.id)
      if (this.pendingEdgeType) {
        this.renderer.previewEdgeType(edge.id, this.pendingEdgeType)
      } else {
        this.renderer.selectEdge(edge.id)
      }
    }

    if (this.selectedEdgeIds.size === 0) this.pendingEdgeType = null
    this._refreshTerrainPanel()
  }

  _handleEdgePreview(edgeType) {
    this.pendingEdgeType = edgeType
    for (const edgeId of this.selectedEdgeIds) this.renderer.previewEdgeType(edgeId, edgeType)
    this._refreshTerrainPanel()
  }

  async _handleEdgeApply({ description }) {
    if (this.selectedEdgeIds.size === 0 || !this.pendingEdgeType) return
    const edgeIds = [...this.selectedEdgeIds]
    const edgeType = this.pendingEdgeType
    try {
      for (const edgeId of edgeIds) {
        const response = await GameAPI.assignEdge(edgeId, edgeType, description)
        if (response.ok) {
          const edge = this.renderer.terrainData?.edges?.[edgeId]
          if (edge) { edge.assignedType = edgeType; edge.description = description }
          this.renderer.updateEdgeColor(edgeId, edgeType)
        } else {
          this.uiManager.showError(response.error)
          this._refreshTerrainPanel()
          return
        }
      }
      this._clearEdgeSelection()
      this._refreshTerrainPanel()
    } catch (error) { this.uiManager.showError(error.message); this._refreshTerrainPanel() }
  }

  _isEdgeConnectedToSelection(edge) {
    if (this.selectedEdgeIds.size === 0) return true
    const edges = this.renderer.terrainData?.edges || {}

    const terminalCount = new Map()
    for (const selId of this.selectedEdgeIds) {
      const pts = edges[selId]?.pointIds
      if (!pts?.length) continue
      const first = pts[0], last = pts[pts.length - 1]
      terminalCount.set(first, (terminalCount.get(first) || 0) + 1)
      if (last !== first) terminalCount.set(last, (terminalCount.get(last) || 0) + 1)
    }
    const freeEndpoints = new Set([...terminalCount].filter(([, c]) => c === 1).map(([v]) => v))

    const pts = edge.pointIds
    if (!pts?.length) return false
    return pts.some(pid => freeEndpoints.has(pid))
  }

  _clearEdgeSelection() {
    for (const edgeId of this.selectedEdgeIds) this.renderer.deselectEdge(edgeId)
    this.selectedEdgeIds.clear()
    this.pendingEdgeType = null
  }

  _getAdjacentTypes(regionId) {
    const edges = this.renderer.terrainData?.edges || {}
    const regions = this.renderer.terrainData?.regions || []
    const regionMap = new Map(regions.map(r => [r.id, r]))
    const adjacentTypes = []
    for (const edge of Object.values(edges)) {
      const otherId = edge.regionA === regionId ? edge.regionB : edge.regionB === regionId ? edge.regionA : null
      if (otherId !== null) {
        const other = regionMap.get(otherId)
        if (other?.assignedType) adjacentTypes.push(other.assignedType)
      }
    }
    return adjacentTypes
  }

  _getEdgeAdjacentTypes(edgeId) {
    const edge = this.renderer.terrainData?.edges?.[edgeId]
    if (!edge) return []
    const regions = this.renderer.terrainData?.regions || []
    return [edge.regionA, edge.regionB]
      .filter(id => id != null)
      .map(id => regions.find(r => r.id === id)?.assignedType)
      .filter(Boolean)
  }

  _isParallelToRiver(edgeId) {
    const edges = this.renderer.terrainData?.edges || {}
    const edge = edges[edgeId]
    if (!edge) return false
    const myRegions = new Set([edge.regionA, edge.regionB].filter(r => r != null))
    const pts = edge.pointIds || []
    const myEndpoints = new Set([pts[0], pts[pts.length - 1]].filter(p => p != null))
    for (const [otherId, other] of Object.entries(edges)) {
      if (otherId === edgeId || other.assignedType !== 'River') continue
      const sharesRegion = [other.regionA, other.regionB].some(r => r != null && myRegions.has(r))
      if (!sharesRegion) continue
      const otherPts = other.pointIds || []
      const otherEndpoints = new Set([otherPts[0], otherPts[otherPts.length - 1]].filter(p => p != null))
      const sharesEndpoint = [...myEndpoints].some(p => otherEndpoints.has(p))
      if (!sharesEndpoint) return true
    }
    return false
  }

  _refreshTerrainPanel() {
    if (this.selectedRegionId !== null) {
      const region = this.renderer.terrainData?.regions?.find(r => r.id === this.selectedRegionId)
      this.uiManager.terrainTypePanel?.showContext('region', {
        pendingType: this.pendingTerrainType,
        isEdge: region?.isEdge ?? false,
        adjacentTypes: this._getAdjacentTypes(this.selectedRegionId)
      })
    } else if (this.selectedEdgeIds.size > 0) {
      const firstEdgeId = [...this.selectedEdgeIds][0]
      const riverParallel = [...this.selectedEdgeIds].some(id => this._isParallelToRiver(id))
      this.uiManager.terrainTypePanel?.showContext('edge', {
        edgeCount: this.selectedEdgeIds.size,
        pendingType: this.pendingEdgeType,
        adjacentTypes: firstEdgeId ? this._getEdgeAdjacentTypes(firstEdgeId) : [],
        riverParallel
      })
    } else {
      this.uiManager.terrainTypePanel?.showContext('none')
    }
  }

  // ── City district ───────────────────────────────────────────────────────────

  _handleDistrictClick(districtId) {
    const district = this.renderer.cityDistrictData?.districts?.find(d => d.id === districtId)
    if (!district || district.assignedType) return

    if (this.selectedTerrainRegionId !== null) {
      this.renderer.deselectRegion(this.selectedTerrainRegionId)
      this.selectedTerrainRegionId = null
    }

    if (this.selectedDistrictId === districtId) {
      this.renderer.deselectDistrict(districtId)
      this.selectedDistrictId = null
      this.pendingDistrictType = null
      this.pendingResidentialClass = null
      this.pendingLeadershipClass = null
      this._refreshDistrictPanel()
      return
    }

    if (this.selectedDistrictId !== null) this.renderer.deselectDistrict(this.selectedDistrictId)
    this._clearCityEdgeSelection()

    this.selectedDistrictId = districtId
    this.pendingDistrictType = district.isLeadershipDistrict ? 'Leadership' : null
    this.renderer.selectDistrict(districtId)
    this._refreshDistrictPanel()
  }

  _handleTerrainRegionClick(regionId) {
    if (this.selectedTerrainRegionId === regionId) {
      this.renderer.deselectRegion(regionId)
      this.selectedTerrainRegionId = null
      this.pendingTerrainAction = null
      this._refreshDistrictPanel()
      return
    }
    if (this.selectedTerrainRegionId !== null) this.renderer.deselectRegion(this.selectedTerrainRegionId)
    if (this.selectedDistrictId !== null) {
      this.renderer.deselectDistrict(this.selectedDistrictId)
      this.selectedDistrictId = null
      this.pendingDistrictType = null
    }
    this._clearCityEdgeSelection()
    this.selectedTerrainRegionId = regionId
    this.pendingTerrainAction = null
    this.renderer.selectRegion(regionId)
    this._refreshDistrictPanel()
  }

  async _handleTerrainDistrictAssign(regionId, districtType, description = '', producedResource = '', consumedResources = []) {
    try {
      const response = await GameAPI.assignTerrainDistrict(regionId, districtType, description, producedResource, consumedResources)
      if (response.ok) {
        const region = this.renderer.terrainData?.regions?.find(r => r.id === regionId)
        if (region) {
          region.terrainDistrict = districtType
          region.terrainDistrictProducedResource = producedResource || null
        }
        this.renderer.deselectRegion(regionId)
        this.selectedTerrainRegionId = null
        this.pendingTerrainAction = null
        this.renderer.spawnTerrainDistrictFeature(regionId, districtType)
        if (response.resourceRegistry) {
          this.resourceRegistry = response.resourceRegistry
          this.uiManager.updateResources(this.resourceRegistry)
        }
        if (response.factions) {
          this.factions = response.factions
          this.uiManager.updateFactions(this.factions)
        }
        this._refreshDistrictPanel()
      } else {
        this.uiManager.showError(response.error)
        this._refreshDistrictPanel()
      }
    } catch (error) { this.uiManager.showError(error.message); this._refreshDistrictPanel() }
  }

  _handleDistrictPreview(districtType) {
    if (this.selectedDistrictId === null) return
    this.pendingDistrictType = districtType
    this.pendingResidentialClass = null
    this.pendingLeadershipClass = null
    this.renderer.previewDistrictType(this.selectedDistrictId, districtType)
    this._refreshDistrictPanel()
  }

  async _handleDistrictApply({ description, producedResource, consumedResources, residentialClass, LeadershipClass }) {
    if (this.selectedDistrictId === null || !this.pendingDistrictType) return
    const districtId = this.selectedDistrictId
    const districtType = this.pendingDistrictType
    try {
      const response = await GameAPI.assignDistrictType(districtId, districtType, description, producedResource, consumedResources, residentialClass, LeadershipClass)
      if (response.ok) {
        const district = this.renderer.cityDistrictData?.districts?.find(d => d.id === districtId)
        if (district) {
          district.assignedType = districtType
          district.residentialClass = residentialClass || null
          district.LeadershipClass = LeadershipClass || null
          district.description = description
          district.producedResource = producedResource || null
          district.consumedResources = consumedResources || []
        }
        if (response.resourceRegistry) {
          this.resourceRegistry = response.resourceRegistry
          this.uiManager.updateResources(this.resourceRegistry)
        }
        if (response.factions) { this.factions = response.factions; this.uiManager.updateFactions(this.factions) }
        this.renderer.updateDistrictColor(districtId, districtType)
        this.selectedDistrictId = null
        this.pendingDistrictType = null
        this.pendingResidentialClass = null
        this.pendingLeadershipClass = null
        this._refreshDistrictPanel()
        // DEV: auto-finish after 2 districts assigned
        if (this._countAssignedDistricts() >= 2) {
          this.eventBus.emit('SUBDIVISION_COMPLETE')
          return
        }
      } else {
        this.uiManager.showError(response.error)
        this._refreshDistrictPanel()
      }
    } catch (error) { this.uiManager.showError(error.message); this._refreshDistrictPanel() }
  }

  // ── City edge ───────────────────────────────────────────────────────────────

  _handleCityEdgeClick(edge) {
    const edgeData = this.renderer.cityDistrictData?.edges?.[edge.id]
    if (edgeData?.assignedType) return

    if (this.selectedCityEdgeIds.has(edge.id)) {
      this.selectedCityEdgeIds.delete(edge.id)
      this.renderer.deselectCityEdge(edge.id)
    } else {
      const limit = this.pendingCityEdgeType === 'Docks' ? Infinity : 3
      if (this.selectedCityEdgeIds.size >= limit) return

      if (!this._isCityEdgeConnectedToSelection(edge)) this._clearCityEdgeSelection()

      if (this.selectedCityEdgeIds.size === 0 && this.selectedDistrictId !== null) {
        this.renderer.deselectDistrict(this.selectedDistrictId)
        this.selectedDistrictId = null
        this.pendingDistrictType = null
      }

      this.selectedCityEdgeIds.add(edge.id)
      if (this.pendingCityEdgeType) {
        this.renderer.previewCityEdgeType(edge.id, this.pendingCityEdgeType)
      } else {
        this.renderer.selectCityEdge(edge.id)
      }
    }

    if (this.selectedCityEdgeIds.size === 0) this.pendingCityEdgeType = null
    this._refreshDistrictPanel()
  }

  _handleCityEdgePreview(edgeType) {
    this.pendingCityEdgeType = edgeType
    for (const edgeId of this.selectedCityEdgeIds) {
      const showColor = edgeType !== 'Docks' || this._isCityEdgeNearWater(edgeId)
      this.renderer.previewCityEdgeType(edgeId, showColor ? edgeType : null)
    }
    this._refreshDistrictPanel()
  }

  async _handleCityEdgeApply({ description }) {
    if (this.selectedCityEdgeIds.size === 0 || !this.pendingCityEdgeType) return
    const edgeIds = [...this.selectedCityEdgeIds]
    const edgeType = this.pendingCityEdgeType
    try {
      for (const edgeId of edgeIds) {
        const response = await GameAPI.assignCityEdge(edgeId, edgeType, description)
        if (response.ok) {
          const edge = this.renderer.cityDistrictData?.edges?.[edgeId]
          if (edge) { edge.assignedType = edgeType; edge.description = description }
          this.renderer.updateCityEdgeColor(edgeId, edgeType)
        } else {
          this.uiManager.showError(response.error)
          this._refreshDistrictPanel()
          return
        }
      }
      this._clearCityEdgeSelection()
      this._refreshDistrictPanel()
    } catch (error) { this.uiManager.showError(error.message); this._refreshDistrictPanel() }
  }

  _isCityEdgeConnectedToSelection(edge) {
    if (this.selectedCityEdgeIds.size === 0) return true
    const edges = this.renderer.cityDistrictData?.edges || {}

    const terminalCount = new Map()
    for (const selId of this.selectedCityEdgeIds) {
      const pts = edges[selId]?.pointIds
      if (!pts?.length) continue
      const first = pts[0], last = pts[pts.length - 1]
      terminalCount.set(first, (terminalCount.get(first) || 0) + 1)
      if (last !== first) terminalCount.set(last, (terminalCount.get(last) || 0) + 1)
    }
    const freeEndpoints = new Set([...terminalCount].filter(([, c]) => c === 1).map(([v]) => v))

    const pts = edge.pointIds
    if (!pts?.length) return false
    return pts.some(pid => freeEndpoints.has(pid))
  }

  _clearCityEdgeSelection() {
    for (const edgeId of this.selectedCityEdgeIds) this.renderer.deselectCityEdge(edgeId)
    this.selectedCityEdgeIds.clear()
    this.pendingCityEdgeType = null
  }

  // Returns true if the city edge (by id) is geometrically adjacent to Sea, Lake, or River.
  // City edges share the same 2D coordinate space as terrain regions and edges.
  _isCityEdgeNearWater(edgeId) {
    const cityEdge = this.renderer.cityDistrictData?.edges?.[edgeId]
    if (!cityEdge?.pointIds?.length) return false

    const pts = cityEdge.pointIds
      .map(id => this.renderer.cityEdgePointsById.get(id))
      .filter(Boolean)
    if (pts.length === 0) return false

    const terrainRegions = this.renderer.terrainData?.regions || []
    const terrainEdges   = this.renderer.terrainData?.edges   || {}
    const THRESHOLD = 1.0

    for (const region of terrainRegions) {
      if (region.assignedType !== 'Sea' && region.assignedType !== 'Lake') continue
      for (const pt of pts) {
        if (this.renderer.pointInPolygon(pt.x, pt.y, region.polygon)) return true
        for (let i = 0; i < region.polygon.length; i++) {
          const a = region.polygon[i], b = region.polygon[(i + 1) % region.polygon.length]
          if (this.renderer.distanceToLineSegment(pt.x, pt.y, a.x, a.y, b.x, b.y) < THRESHOLD) return true
        }
      }
    }

    for (const edge of Object.values(terrainEdges)) {
      if (edge.assignedType !== 'River') continue
      const riverPts = (edge.pointIds || [])
        .map(id => this.renderer.edgePointsById.get(id))
        .filter(Boolean)
      for (const cityPt of pts) {
        for (let i = 0; i < riverPts.length - 1; i++) {
          if (this.renderer.distanceToLineSegment(cityPt.x, cityPt.y, riverPts[i].x, riverPts[i].y, riverPts[i+1].x, riverPts[i+1].y) < THRESHOLD) return true
        }
      }
    }

    return false
  }

  _getUsedProducedResources() {
    const fromCityDistricts = (this.renderer.cityDistrictData?.districts || [])
      .filter(d => d.producedResource && d.id !== this.selectedDistrictId)
      .map(d => d.producedResource.toLowerCase())
    const fromTerrainDistricts = (this.renderer.terrainData?.regions || [])
      .filter(r => r.terrainDistrictProducedResource && r.id !== this.selectedTerrainRegionId)
      .map(r => r.terrainDistrictProducedResource.toLowerCase())
    return [...fromCityDistricts, ...fromTerrainDistricts]
  }

  _refreshDistrictPanel() {
    const shared = {
      threats: this.threats,
      tradingDestinations: this.tradingDestinations
    }
    if (this.selectedTerrainRegionId !== null) {
      const region = this.renderer.terrainData?.regions?.find(r => r.id === this.selectedTerrainRegionId)
      this.uiManager.districtTypePanel?.showContext('terrainRegion', {
        regionType: region?.assignedType,
        isEdge: region?.isEdge ?? false,
        hasDistrict: !!region?.terrainDistrict,
        pendingAction: this.pendingTerrainAction,
        regionId: this.selectedTerrainRegionId,
        resourceRegistry: this.resourceRegistry,
        usedProducedResources: this._getUsedProducedResources(),
        ...shared
      })
      return
    }
    if (this.selectedDistrictId !== null) {
      this.uiManager.districtTypePanel?.showContext('district', {
        pendingType: this.pendingDistrictType,
        residentialClass: this.pendingResidentialClass,
        LeadershipClass: this.pendingLeadershipClass,
        resourceRegistry: this.resourceRegistry,
        usedProducedResources: this._getUsedProducedResources(),
        ...shared
      })
    } else if (this.selectedCityEdgeIds.size > 0) {
      const nearWater = [...this.selectedCityEdgeIds].every(id => this._isCityEdgeNearWater(id))
      this.uiManager.districtTypePanel?.showContext('cityEdge', {
        edgeCount: this.selectedCityEdgeIds.size,
        pendingType: this.pendingCityEdgeType,
        nearWater,
        ...shared
      })
    } else {
      this.uiManager.districtTypePanel?.showContext('none', shared)
    }
  }

  // ── State loading ───────────────────────────────────────────────────────────

  async loadState() {
    try {
      const state = await GameAPI.getState()
      const regions = state.worldTerrainData?.regions || []

      if (regions.length > 0) {
        const setupStep = state.setupStep || 'Terrain'
        this.gameState = state
        this.currentPhase = setupStep
        this.renderer.setTerrainData(
          regions,
          state.worldTerrainData.edges || {},
          state.worldTerrainData.fineCells || [],
          state.worldTerrainData.edgePoints || []
        )

        const cityData = state.cityDistrictData
        if (setupStep !== 'Terrain' && cityData?.districts?.length > 0) {
          this._finalizeTerrainDisplay()
          this.renderer.setCityDistrictData(cityData)
          this.renderer.setMode(setupStep === 'StreetSetup' ? 'streets' : 'city')
          if (setupStep === 'StreetSetup' || setupStep === 'GuildCreation' || setupStep === 'Complete') {
            this.renderer.renderStreetGraph(cityData.streetGraph)
            this.renderer.renderBuildings(cityData.blocks, cityData.buildings, cityData.buildingTemplates, cityData.textureTemplates)
          }
        } else {
          this.renderer.clearBuildingLayer()
          this.renderer.clearStreetLayer()
          this.renderer.setCityDistrictData([])
          this.renderer.setMode('terrain')
        }

        // Resource registry is session-only — do not restore from save
        this.resourceRegistry = []
        this.uiManager.updateResources([])

        if (state.threats) {
          this.threats = state.threats
          this.renderer.renderThreats(this.threats, regions)
          this.uiManager.updateThreats(this.threats)
        }
        if (state.tradingDestinations) {
          this.tradingDestinations = state.tradingDestinations
          this.renderer.renderTrades(this.tradingDestinations, state.worldTerrainData)
        }
        if (state.factions) {
          this.factions = state.factions
          this.uiManager.updateFactions(this.factions)
        }
        this.inputHandler.setTerrainData(state)
        this.uiManager.showSetupPhase(setupStep)
        this._focusCameraOnCity(regions)
        this.eventBus.emit('SETUP_STARTED')
        console.log(`Loaded existing game state at phase: ${setupStep}`)
      } else {
        await this.startSetup()
      }
    } catch (error) {
      console.error('Failed to load state:', error)
      await this.startSetup()
    }
  }

  _finalizeTerrainDisplay() {
    for (const region of this.renderer.terrainData?.regions || []) {
      if (!region.assignedType) {
        region.assignedType = 'Plains'
        this.renderer.updateRegionColor(region.id, 'Plains')
      }
    }
    this.renderer.hideUndefinedEdges()
  }

  _focusCameraOnCity(regions) {
    const city = regions?.find(r => r.assignedType === 'City')
    const sp = city?.seedPoint
    if (sp) {
      this.renderer.focusCameraOn(sp.x, sp.y)
      this.renderer.setHomePosition(sp.x, sp.y)
    }
  }

  async startSetup() {
    try {
      const response = await GameAPI.setupInit()
      if (response.ok) {
        this.gameState = response
        this.currentPhase = 'Terrain'
        this.selectedTerrainRegionId = null
        this.pendingTerrainAction = null
        this.selectedDistrictId = null
        this.pendingDistrictType = null
        this.pendingResidentialClass = null
        this.pendingLeadershipClass = null
        this.selectedCityEdgeIds.clear()
        this.pendingCityEdgeType = null
        this.resourceRegistry = []
        this.threats = []
        this.tradingDestinations = []
        this.factions = []
        this.uiManager.updateResources([])
        this.uiManager.updateFactions([])
        this.uiManager.updateThreats([])
        this.renderer.clearStreetLayer()
        this.renderer.clearBuildingLayer()
        this.renderer.setCityDistrictData([])
        this.renderer.setMode('terrain')
        this.renderer.setTerrainData(response.regions, response.edges || {}, response.fineCells || [], response.edgePoints || [])
        this.inputHandler.setTerrainData(response)
        this.uiManager.showSetupPhase('Terrain')
        this._focusCameraOnCity(response.regions)
        this.eventBus.emit('SETUP_STARTED')
      } else {
        throw new Error(response.error)
      }
    } catch (error) {
      console.error('Setup init failed:', error)
      this.uiManager?.showError(error.message)
    }
  }
}
