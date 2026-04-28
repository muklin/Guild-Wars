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
    this.selectedRegionId = null
    this.selectedEdgeId = null
    this.selectedDistrictId = null
    this.selectedTerrainType = null
  }

  async init() {
    try {
      // Initialize Three.js renderer
      this.renderer = new WorldRenderer()
      this.renderer.init()

      // Initialize UI
      this.uiManager = new UIManager(this.eventBus, this.renderer)
      this.uiManager.init()

      // Initialize input handling
      this.inputHandler = new InputHandler(this.eventBus)
      this.inputHandler.init(this.renderer)

      // Setup event listeners
      this.setupEventListeners()

      // Fetch initial state and start setup
      await this.startSetup()
    } catch (error) {
      console.error('Failed to initialize app:', error)
      this.uiManager?.showError('Failed to initialize game')
    }
  }

  setupEventListeners() {
    // Terrain and edge placement
    this.eventBus.on('REGION_CLICKED', (regionId) => {
      this.selectedRegionId = regionId
      this.selectedEdgeId = null
      console.log('Region selected:', regionId)
    })

    this.eventBus.on('EDGE_CLICKED', (edge) => {
      this.selectedEdgeId = edge.id
      this.selectedRegionId = null
      console.log('Edge selected:', edge.id)
    })

    this.eventBus.on('DISTRICT_CLICKED', (districtId) => {
      this.selectedDistrictId = districtId
      this.selectedRegionId = null
      this.selectedEdgeId = null
      console.log('District selected:', districtId)
    })

    this.eventBus.on('TERRAIN_ASSIGNED', async (data) => {
      if (!this.selectedRegionId) {
        this.uiManager.showError('Please select a region first')
        return
      }

      try {
        const response = await GameAPI.assignTerrain(this.selectedRegionId, data.terrainType)
        if (response.ok) {
          this.gameState = response
          this.renderer.updateRegionColor(this.selectedRegionId, data.terrainType)
          this.uiManager.showSuccess(`Assigned ${data.terrainType} to region ${this.selectedRegionId}`)
          this.selectedRegionId = null
        } else {
          this.uiManager.showError(response.error)
        }
      } catch (error) {
        this.uiManager.showError(error.message)
      }
    })

    this.eventBus.on('EDGE_ASSIGNED', async (data) => {
      if (!this.selectedEdgeId) {
        this.uiManager.showError('Please select an edge first')
        return
      }

      try {
        const response = await GameAPI.assignEdge(this.selectedEdgeId, data.edgeType)
        if (response.ok) {
          this.gameState = response
          this.renderer.updateEdgeColor(this.selectedEdgeId, data.edgeType)
          this.uiManager.showSuccess(`Assigned ${data.edgeType} to edge ${this.selectedEdgeId}`)
          this.selectedEdgeId = null
        } else {
          this.uiManager.showError(response.error)
        }
      } catch (error) {
        this.uiManager.showError(error.message)
      }
    })

    this.eventBus.on('DISTRICT_CLASS_ASSIGNED', async (data) => {
      if (!this.selectedDistrictId) {
        this.uiManager.showError('Please select a district first')
        return
      }

      try {
        const response = await GameAPI.assignDistrictClass(this.selectedDistrictId, data.districtClass)
        if (response.ok) {
          this.gameState = response
          this.renderer.updateDistrictColor(this.selectedDistrictId, data.districtClass)
          this.uiManager.showSuccess(`Assigned ${data.districtClass} to district ${this.selectedDistrictId}`)
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
          this.uiManager.showSetupPhase('GuildCreation')
        } else {
          this.uiManager.showError(response.error)
        }
      } catch (error) {
        this.uiManager.showError(error.message)
      }
    })
  }

  async startSetup() {
    try {
      const response = await GameAPI.setupInit()
      if (response.ok) {
        this.gameState = response
        this.renderer.setTerrainData(response.regions, response.edges || {})
        if (response.districts) {
          this.renderer.setCityDistrictData(response.districts)
        }
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
