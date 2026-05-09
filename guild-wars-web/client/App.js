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

    // District selection (Phase 2)
    this.selectedDistrictId = null
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
    this.eventBus.on('REGION_CLICKED', (regionId) => this._handleRegionClick(regionId))
    this.eventBus.on('EDGE_CLICKED', (edge) => this._handleEdgeClick(edge))
    this.eventBus.on('DISTRICT_CLICKED', (districtId) => this._handleDistrictClick(districtId))

    this.eventBus.on('TERRAIN_TYPE_PREVIEW', (terrainType) => this._handleTerrainPreview(terrainType))
    this.eventBus.on('TERRAIN_APPLY', (data) => this._handleTerrainApply(data))

    this.eventBus.on('EDGE_TYPE_PREVIEW', (edgeType) => this._handleEdgePreview(edgeType))
    this.eventBus.on('EDGE_APPLY', (data) => this._handleEdgeApply(data))

    this.eventBus.on('DISTRICT_CLASS_ASSIGNED', async (data) => {
      if (!this.selectedDistrictId) return
      try {
        const response = await GameAPI.assignDistrictClass(this.selectedDistrictId, data.districtClass)
        if (response.ok) {
          this.gameState = response
          this.renderer.updateDistrictColor(this.selectedDistrictId, data.districtClass)
          this.selectedDistrictId = null
        } else {
          this.uiManager.showError(response.error)
        }
      } catch (error) {
        this.uiManager.showError(error.message)
      }
    })

    this.eventBus.on('TERRAIN_COMPLETE', async () => {
      try {
        const response = await GameAPI.finishTerrain()
        if (response.ok) {
          this.gameState = response
          this.renderer.setCityDistrictData(response.districts || [])
          this.uiManager.showSetupPhase('CitySubdivision')
        } else {
          this.uiManager.showError(response.error)
        }
      } catch (error) {
        this.uiManager.showError(error.message)
      }
    })

    this.eventBus.on('SUBDIVISION_COMPLETE', async () => {
      try {
        const response = await GameAPI.finishSubdivision()
        if (response.ok) {
          this.gameState = response
          this.uiManager.showSetupPhase('StreetSetup')
        } else {
          this.uiManager.showError(response.error)
        }
      } catch (error) {
        this.uiManager.showError(error.message)
      }
    })

    this.eventBus.on('STREET_SETUP_COMPLETE', async () => {
      try {
        const response = await GameAPI.finishStreetSetup()
        if (response.ok) {
          this.uiManager.showSetupPhase('GuildCreation')
        } else {
          this.uiManager.showError(response.error)
        }
      } catch (error) {
        this.uiManager.showError(error.message)
      }
    })

    this.eventBus.on('NEW_GAME', async () => {
      await this.startSetup()
    })
  }

  _handleRegionClick(regionId) {
    const region = this.gameState?.worldTerrainData?.regions?.find(r => r.id === regionId)
    if (!region || region.assignedType) return

    if (this.selectedRegionId === regionId) {
      this.renderer.deselectRegion(regionId)
      this.selectedRegionId = null
      this.pendingTerrainType = null
      this._refreshTerrainPanel()
      return
    }

    if (this.selectedRegionId !== null) {
      this.renderer.deselectRegion(this.selectedRegionId)
    }
    this._clearEdgeSelection()

    this.selectedRegionId = regionId
    this.pendingTerrainType = null
    this.renderer.selectRegion(regionId)
    this._refreshTerrainPanel()
  }

  _handleEdgeClick(edge) {
    if (this.selectedEdgeIds.has(edge.id)) {
      this.selectedEdgeIds.delete(edge.id)
      this.renderer.deselectEdge(edge.id)
    } else {
      if (!this._isEdgeConnectedToSelection(edge)) return

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

    if (this.selectedEdgeIds.size === 0) {
      this.pendingEdgeType = null
      this._refreshTerrainPanel()
    } else {
      this._refreshTerrainPanel()
    }
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
        const region = this.gameState?.worldTerrainData?.regions?.find(r => r.id === regionId)
        if (region) { region.assignedType = terrainType; region.description = description }
        this.renderer.updateRegionColor(regionId, terrainType)
        this.selectedRegionId = null
        this.pendingTerrainType = null
        this._refreshTerrainPanel()
      } else {
        this.uiManager.showError(response.error)
      }
    } catch (error) {
      this.uiManager.showError(error.message)
    }
  }

  _handleEdgePreview(edgeType) {
    this.pendingEdgeType = edgeType
    for (const edgeId of this.selectedEdgeIds) {
      this.renderer.previewEdgeType(edgeId, edgeType)
    }
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
          const edge = this.gameState?.worldTerrainData?.edges?.[edgeId]
          if (edge) { edge.assignedType = edgeType; edge.description = description }
          this.renderer.updateEdgeColor(edgeId, edgeType)
        } else {
          this.uiManager.showError(response.error)
          return
        }
      }
      this._clearEdgeSelection()
      this._refreshTerrainPanel()
    } catch (error) {
      this.uiManager.showError(error.message)
    }
  }

  _handleDistrictClick(districtId) {
    this.selectedDistrictId = districtId
    this.selectedRegionId = null
    this._clearEdgeSelection()
  }

  _isEdgeConnectedToSelection(edge) {
    if (this.selectedEdgeIds.size === 0) return true
    const edges = this.gameState?.worldTerrainData?.edges || {}
    for (const selId of this.selectedEdgeIds) {
      const selEdge = edges[selId]
      if (!selEdge) continue
      if (edge.pointIds?.some(pid => selEdge.pointIds?.includes(pid))) return true
    }
    return false
  }

  _clearEdgeSelection() {
    for (const edgeId of this.selectedEdgeIds) {
      this.renderer.deselectEdge(edgeId)
    }
    this.selectedEdgeIds.clear()
    this.pendingEdgeType = null
  }

  _getAdjacentTypes(regionId) {
    const edges = this.gameState?.worldTerrainData?.edges || {}
    const regions = this.gameState?.worldTerrainData?.regions || []
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
    const edge = this.gameState?.worldTerrainData?.edges?.[edgeId]
    if (!edge) return []
    const regions = this.gameState?.worldTerrainData?.regions || []
    return [edge.regionA, edge.regionB]
      .filter(id => id != null)
      .map(id => regions.find(r => r.id === id)?.assignedType)
      .filter(Boolean)
  }

  _refreshTerrainPanel() {
    if (this.selectedRegionId !== null) {
      const region = this.gameState?.worldTerrainData?.regions?.find(r => r.id === this.selectedRegionId)
      this.uiManager.terrainTypePanel?.showContext('region', {
        pendingType: this.pendingTerrainType,
        isEdge: region?.isEdge ?? false,
        adjacentTypes: this._getAdjacentTypes(this.selectedRegionId)
      })
    } else if (this.selectedEdgeIds.size > 0) {
      const firstEdgeId = [...this.selectedEdgeIds][0]
      this.uiManager.terrainTypePanel?.showContext('edge', {
        edgeCount: this.selectedEdgeIds.size,
        pendingType: this.pendingEdgeType,
        adjacentTypes: firstEdgeId ? this._getEdgeAdjacentTypes(firstEdgeId) : []
      })
    } else {
      this.uiManager.terrainTypePanel?.showContext('none')
    }
  }

  async loadState() {
    try {
      const state = await GameAPI.getState()
      const regions = state.worldTerrainData?.regions || []

      if (regions.length > 0) {
        const setupStep = state.setupStep || 'Terrain'
        this.gameState = state
        this.renderer.setTerrainData(regions, state.worldTerrainData.edges || {}, state.worldTerrainData.fineCells || [], state.worldTerrainData.edgePoints || [])

        if (setupStep !== 'Terrain') {
          const districts = state.cityDistrictData?.districts || []
          if (districts.length > 0) {
            this.renderer.setCityDistrictData(districts)
          }
        } else {
          this.renderer.setCityDistrictData([])
        }

        this.inputHandler.setTerrainData(state)
        this.uiManager.showSetupPhase(setupStep)
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

  async startSetup() {
    try {
      const response = await GameAPI.setupInit()
      if (response.ok) {
        this.gameState = response
        this.renderer.setCityDistrictData([])
        this.renderer.setTerrainData(response.regions, response.edges || {}, response.fineCells || [], response.edgePoints || [])
        this.inputHandler.setTerrainData(response)
        this.uiManager.showSetupPhase('Terrain')
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
