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
    // Terrain placement
    this.eventBus.on('REGION_CLICKED', (regionId) => {
      this.selectedRegionId = regionId
      console.log('Region selected:', regionId)
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

    this.eventBus.on('TERRAIN_COMPLETE', async () => {
      try {
        const response = await GameAPI.finishTerrain()
        if (response.ok) {
          this.gameState = response
          this.uiManager.showSetupPhase('CitySubdivision')
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
