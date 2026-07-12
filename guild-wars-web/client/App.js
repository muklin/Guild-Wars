import WorldRenderer from './rendering/WorldRenderer.js'
import InputHandler from './input/InputHandler.js'
import UIManager from './ui/UIManager.js'
import GameAPI from './api/GameAPI.js'
import EventBus from './core/EventBus.js'
import { preloadModels } from './rendering/utils/FeatureManager.js'
import LiveSync from './net/LiveSync.js'
import MultiplayerUI from './ui/MultiplayerUI.js'
import EventCardManager from './ui/EventCardManager.js'
import config from './config.js'
import DebugPanel from './ui/DebugPanel.js'
import ForeignPowerDialog from './ui/ForeignPowerDialog.js'
import GodDialog from './ui/GodDialog.js'
import MagicSystemDialog from './ui/MagicSystemDialog.js'
import NameDialog from './ui/NameDialog.js'
import ResourceDialog from './ui/ResourceDialog.js'
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
    this.resourceDefinitions = {}
    this.threats = []
    this.tradingDestinations = []
    this.factions = []
    this.guilds = []
    this.playerCount = 1
    this.currentPhase = null
    this.selectedTerrainRegionId = null
    this.selectedTerrainPlotId = null
    this.pendingTerrainAction = null
    this.pendingResidentialClass = null
    this.pendingLeadershipClass = 'Monarchy'

    this._fpLabelContainer = null
    this._fpLabelEls = []
  }

  async init() {
    try {
      preloadModels()   // warm the shared GLB cache in the background so first render is instant

      this.renderer = new WorldRenderer()
      this.renderer.init()

      this.uiManager = new UIManager(this.eventBus, this.renderer)
      this.uiManager.init()

      this.inputHandler = new InputHandler(this.eventBus)
      this.inputHandler.init(this.renderer)

      this.renderer.addCameraMoveCallback(() => this._updateFPLabelPositions())

      this.debugPanel = new DebugPanel(this.renderer)

      this.setupEventListeners()

      // Networked play: a live-sync channel re-pulls state whenever the server
      // broadcasts, and the connect screen lets the player Join or Play Solo.
      this.eventCardManager = new EventCardManager()
      this.eventCardManager.mount()
      this.liveSync = new LiveSync((event) => this.refreshFromServer(event))
      this.liveSync.connect()
      this.multiplayerUI = new MultiplayerUI(this)
      this.multiplayerUI.mount()
    } catch (error) {
      console.error('Failed to initialize app:', error)
      this.uiManager?.showError('Failed to initialize game')
    }
  }

  setupEventListeners() {
    this.eventBus.on('DEBUG_TOGGLED', (on) => this.debugPanel.toggle(on))

    // --- Terrain phase ---
    this.eventBus.on('REGION_CLICKED',  (regionId) => this._handleRegionClick(regionId))
    this.eventBus.on('PROMOTE_TERRAIN_TO_DISTRICT', ({ plotId, pendingType }) => this._handlePromoteWithType(plotId, pendingType))
    this.eventBus.on('EDGE_CLICKED',    (edge)     => this._handleEdgeClick(edge))

    this.eventBus.on('TERRAIN_TYPE_PREVIEW', (t)    => this._handleTerrainPreview(t))
    this.eventBus.on('TERRAIN_APPLY',        (data) => this._handleTerrainApply(data))
    this.eventBus.on('EDGE_TYPE_PREVIEW',    (t)    => this._handleEdgePreview(t))
    this.eventBus.on('EDGE_APPLY',           (data) => this._handleEdgeApply(data))

    this.eventBus.on('TERRAIN_COMPLETE', async () => {
      await this._doFinishTerrain()
    })

    this.eventBus.on('SUBDIVISION_COMPLETE', async () => {
      await this._doFinishSubdivision()
    })

    // --- City district phase ---
    this.eventBus.on('DISTRICT_CLICKED',      (id)   => this._handleDistrictClick(id))
    this.eventBus.on('CITY_EDGE_CLICKED',     (edge) => this._handleCityEdgeClick(edge))

    this.eventBus.on('DISTRICT_TYPE_PREVIEW',       (t)    => this._handleDistrictPreview(t))
    this.eventBus.on('DISTRICT_RESIDENTIAL_CLASS',  ({ residentialClass }) => {
      this.pendingResidentialClass = residentialClass
      if (this.selectedDistrictId !== null) this.renderer.previewDistrictType(this.selectedDistrictId, residentialClass)
      this._refreshDistrictPanel()
      this._previewDistrictStreets()
    })

    this.eventBus.on('DISTRICT_RULING_BODY_CLASS', ({ LeadershipClass }) => {
      this.pendingLeadershipClass = LeadershipClass
      if (this.selectedDistrictId !== null) this.renderer.previewDistrictType(this.selectedDistrictId, LeadershipClass)
      this._refreshDistrictPanel()
      this._previewDistrictStreets()
    })
    this.eventBus.on('DISTRICT_APPLY',              (data) => this._handleDistrictApply(data))
    this.eventBus.on('DISTRICT_REGENERATE',         ()     => this._handleDistrictRegenerate())
    this.eventBus.on('DISTRICT_SETTINGS_SAVE',      ({ configOverrides }) => this._handleDistrictSettingsSave(configOverrides))
    this.eventBus.on('DISTRICT_SETTINGS_REGENERATE',({ configOverrides }) => this._handleDistrictSettingsRegenerate(configOverrides))
    this.eventBus.on('CITY_EDGE_TYPE_PREVIEW',(t)    => this._handleCityEdgePreview(t))
    this.eventBus.on('CITY_EDGE_APPLY',       (data) => this._handleCityEdgeApply(data))

    this.eventBus.on('TERRAIN_ACTION_SELECT', ({ action }) => {
      if (action === 'Threat') {
        // Apply immediately — Threats on terrain plots don't need a separate naming step.
        this.eventBus.emit('TERRAIN_THREAT_APPLY', { name: '', description: '' })
        return
      }
      this.pendingTerrainAction = action
      this._refreshDistrictPanel()
    })

    this.eventBus.on('TERRAIN_ACTION_BACK', () => {
      this.pendingTerrainAction = null
      this._refreshDistrictPanel()
    })

    this.eventBus.on('TERRAIN_TRADE_APPLY', async ({ name, description, buys, sells, resourceDefs }) => {
      const regionId = this.selectedTerrainRegionId
      if (!regionId) return
      try {
        const response = await GameAPI.addTrade(regionId, description, name, buys, sells, resourceDefs)
        if (response.ok) {
          this.tradingDestinations = response.tradingDestinations
          if (response.resourceRegistry) { this.resourceRegistry = response.resourceRegistry; this.uiManager.updateResources(this.resourceRegistry) }
          if (response.resourceDefinitions) this.resourceDefinitions = response.resourceDefinitions
          if (response.factions) { this.factions = response.factions; this.uiManager.updateFactions(this.factions) }
          this.renderer.renderTrades(this.tradingDestinations, this.renderer.terrainData)
          this.renderer.deselectRegion(regionId)
          this.selectedTerrainRegionId = null
          this.selectedTerrainPlotId = null
          this.pendingTerrainAction = null
          this._refreshDistrictPanel()
        } else { this.uiManager.showError(response.error); this._refreshDistrictPanel() }
      } catch (error) { this.uiManager.showError(error.message); this._refreshDistrictPanel() }
    })

    this.eventBus.on('TERRAIN_THREAT_APPLY', async ({ name, description }) => {
      const regionId = this.selectedTerrainRegionId
      if (!regionId) return
      try {
        const response = await GameAPI.addThreat(regionId, description, name)
        if (response.ok) {
          this.threats = response.threats
          this.renderer.renderThreats(this.threats, this.renderer.terrainData?.regions)
          this.renderer.deselectRegion(regionId)
          this.selectedTerrainRegionId = null
          this.selectedTerrainPlotId = null
          this.pendingTerrainAction = null
          this._refreshDistrictPanel()
        } else { this.uiManager.showError(response.error); this._refreshDistrictPanel() }
      } catch (error) { this.uiManager.showError(error.message); this._refreshDistrictPanel() }
    })

    this.eventBus.on('TERRAIN_PLOT_CLICKED', (rawPlot) => {
      const regions = this.renderer.terrainData?.regions
      if (!regions) return
      const parent = regions.find(r => r.id === rawPlot.parentRegionId)
      if (!parent) return

      if (this.currentPhase === 'CitySubdivision') {
        const DISTRICT_FOR = { Forest: 'Forestry', Hills: 'Mining', Plains: 'Agriculture', Lake: 'Fishing', Sea: 'Fishing' }
        const canDistrict = !!DISTRICT_FOR[parent.assignedType]
        const canThreatTrade = !!parent.isEdge
        if (!canDistrict && !canThreatTrade) return

        // rawPlot.id IS the world-scale worldTerrainData.terrainPlots id (already resolved
        // correctly by TerrainRenderer.getTerrainPlotAtWorldPos) — this is what the server's
        // promotion/eligibility/terrain-district endpoints all key on. Previously this went
        // through getTerrainPlotBySourceId(), which looks up a DIFFERENT id space (the
        // city-scale ground-rendered plot, only populated for plots already converted into
        // the Groundplane near the city) and returned null for any plot outside that set —
        // silently breaking both City Expansion promotion and terrain-district assignment
        // for most external plots.
        const plotId = rawPlot.id ?? null
        const plotHasDistrict = plotId && (this.factions || []).some(f => f.type === 'terrain' && f.plotId === plotId)

        // Toggle deselect if clicking the same plot that's already selected
        if (this.selectedTerrainPlotId !== null && this.selectedTerrainPlotId === plotId) {
          this.renderer.clearTerrainPlotSelected()
          this.renderer.deselectRegion(parent.id)
          this.selectedTerrainRegionId = null
          this.selectedTerrainPlotId = null
          this.pendingTerrainAction = null
          this._refreshDistrictPanel()
          return
        }

        if (this.selectedTerrainRegionId !== null) this.renderer.deselectRegion(this.selectedTerrainRegionId)
        if (this.selectedDistrictId !== null) {
          this._revertProvisionalDistrict(this.selectedDistrictId)
          this.renderer.deselectDistrict(this.selectedDistrictId)
          this.selectedDistrictId = null
          this.pendingDistrictType = null
        }
        this._clearCityEdgeSelection()
        this.selectedTerrainRegionId = parent.id
        this.selectedTerrainPlotId = plotId
        this.pendingTerrainAction = null
        this.renderer.setTerrainPlotSelected(rawPlot.id)
        this._refreshDistrictPanel()
      } else {
        this._handleRegionClick(parent.id)
      }
    })

    this.eventBus.on('TERRAIN_DISTRICT_ASSIGN', async ({ regionId, plotId, districtType, description, producedResource, name, resourceDefs, resourceWiring }) => {
      await this._handleTerrainDistrictAssign(regionId, plotId, districtType, description, producedResource, name, resourceDefs, resourceWiring)
    })

    this.eventBus.on('NEW_GAME', async () => {
      await this.startSetup()
    })

    this.eventBus.on('FACTION_HOVER', (faction) => this.renderer.highlightFaction(faction))
    this.eventBus.on('FACTION_HOVER_END', () => this.renderer.clearFactionHighlight())
    this.eventBus.on('GUILD_FACTION_HOVER', (hq) => this.renderer.setHQHover(hq.kind, hq.refId))
    this.eventBus.on('GUILD_FACTION_HOVER_END', () => this.renderer.clearHQHover())
    this.eventBus.on('GUILD_FACTION_CLICK', (hq) => this.renderer.focusOnHQ(hq))
    this.eventBus.on('GUILD_FACTION_DBLCLICK', () => this.uiManager.guildPanel.toggle())

    // ── Guild setup ──
    // Close the panel and enter pick mode; cursor + hover handled by InputHandler.
    this.eventBus.on('GUILD_HQ_PICK_START', () => {
      this.renderer.hqPickMode = true
      this.renderer.clearHQHover()
      this.uiManager.guildPanel.hide()
    })

    // User clicked a building — capture snapshot, show preview in panel, reopen.
    this.eventBus.on('HQ_PREVIEW', (hq) => {
      const dataUrl = this.renderer.captureHQSnapshot(hq)
      this.uiManager.guildPanel.setHQPreview(hq, dataUrl)
      this.uiManager.guildPanel.show()
    })

    // User clicked Apply — persist to server and confirm.
    this.eventBus.on('HQ_APPLY', async (hq) => {
      this.renderer.hqPickMode = false
      this.renderer.clearHQHover()
      document.body.style.cursor = ''
      try {
        const res = await GameAPI.setGuildHeadquarters(hq)
        if (res.ok && res.guild) {
          this.uiManager.guildPanel.setHeadquarters(hq)
          this.uiManager.guildPanel.setData({ guild: res.guild })
        }
      } catch (e) {
        console.warn('setGuildHeadquarters failed:', e)
      }
    })

    // Panel requesting snapshot re-render after reload (snapshot not persisted).
    this.eventBus.on('HQ_SNAPSHOT_REQUEST', (hq) => {
      const dataUrl = this.renderer.captureHQSnapshot(hq)
      if (dataUrl) this.uiManager.guildPanel.setHQSnapshot(dataUrl)
    })

    // User cancelled pick mode without applying — just close pick mode.
    this.eventBus.on('HQ_PICK_CANCEL', () => {
      this.renderer.hqPickMode = false
      this.renderer.clearHQHover()
      document.body.style.cursor = ''
      this.uiManager.guildPanel.clearHQPreview()
    })
    this.eventBus.on('GUILD_RENAME', async ({ name }) => {
      if (!name?.trim()) return
      try {
        const res = await GameAPI.renameGuild(name.trim())
        if (res.ok) {
          this.guilds = res.guilds || this.guilds
          const g = this._myGuild()
          if (g) { this.uiManager.guildPanel.setData({ guild: g }); this.uiManager.updateGuild(g) }
        }
      } catch { /* silent — rename is best-effort */ }
    })

    this.eventBus.on('GUILD_CREATE', async (data) => {
      if (!data.guildName?.trim()) {
        this.uiManager.showError('Guild name is required'); return
      }
      try {
        const res = await GameAPI.createGuild(data)
        if (res.ok) {
          this.guilds = res.guilds || []
          this.currentPhase = 'Complete'
          this.uiManager.showSetupPhase('Complete')
          this.uiManager.guildPanel.setData({
            guild: res.guild, factions: this.factions, resourceDefinitions: this.resourceDefinitions,
            districts: this.renderer.cityDistrictData?.districts || [],
            tokens: this._myTokens(), playerName: this._myPlayerName(),
          })
          this.uiManager.updateGuild(res.guild)
        } else {
          this.uiManager.showError(res.error || 'Guild creation failed')
        }
      } catch { this.uiManager.showError('Guild creation failed') }
    })
    this.eventBus.on('WALK_MODE_TOGGLED', () => {
      const entered = this.renderer.toggleWalkMode(() => {
        this.uiManager.setWalkMode(false)
        this._updateFPLabels(this.gameState?.foreignPowers || [], this.currentPhase)
      })
      if (entered) {
        this.uiManager.setWalkMode(true)
        // _updateFPLabels' own isWalkMode check hides them — but only takes effect once
        // called; nothing else re-renders labels while walk mode owns the frame loop, so
        // without this the labels from just before entering stay stuck on screen
        // (confirmed live).
        this._updateFPLabels(this.gameState?.foreignPowers || [], this.currentPhase)
      }
    })

    // ── Terrain Setup worldbuilding ──
    this.eventBus.on('ADD_FOREIGN_POWER', () => {
      const dialog = new ForeignPowerDialog({
        existingForeignPowers: this.gameState?.foreignPowers ?? [],
        renderer: this.renderer,
        onApply: async ({ direction, name, colour, description }) => {
          try {
            const res = await GameAPI.createForeignPower({ direction, name, colour, description })
            if (!res.ok) this.uiManager.showError(res.error || 'Failed to add Foreign Power')
          } catch (e) { this.uiManager.showError(e.message) }
        },
        onCancel: () => {}
      })
      dialog.open()
    })

    this.eventBus.on('ADD_GOD', () => {
      const dialog = new GodDialog({
        worldDomains: this.gameState?.worldDomains ?? null,
        usedDomains: (this.gameState?.gods || []).flatMap(g => g.domains || []),
        onApply: async ({ domains, name, description, worldDomains }) => {
          try {
            const res = await GameAPI.createGod({ domains, name, description, worldDomains })
            if (res.ok) {
              // Registers "Worship of <name>" as a Service — update the resource bar
              // immediately rather than waiting for the next live-sync refresh.
              if (res.resourceRegistry) {
                this.resourceRegistry = res.resourceRegistry
                this.uiManager.updateResources(this.resourceRegistry)
              }
              if (res.resourceDefinitions) this.resourceDefinitions = res.resourceDefinitions
            } else this.uiManager.showError(res.error || 'Failed to add God')
          } catch (e) { this.uiManager.showError(e.message) }
        },
        onCancel: () => {}
      })
      dialog.open()
    })

    this.eventBus.on('ADD_MAGIC', () => {
      const dialog = new MagicSystemDialog({
        existingSystem: this.gameState?.magicSystem ?? null,
        onApply: async ({ conceptType, name, description }) => {
          try {
            const res = await GameAPI.defineMagicSystem({ conceptType, name, description })
            if (!res.ok) this.uiManager.showError(res.error || 'Failed to define Magic System')
          } catch (e) { this.uiManager.showError(e.message) }
        },
        onCancel: () => {}
      })
      dialog.open()
    })
  }

  // The local player's guild (their Seat's, or the only one in solo play).
  _myGuild() {
    const guilds = this.guilds || []
    const me = this.gameState?.multiplayer?.meSeatId
    return guilds.find(g => g.seatId != null && g.seatId === me) || guilds[0] || null
  }

  // The local player's current tokens: veto from seat, guild/character/round from guild.
  _myTokens() {
    const mp = this.gameState?.multiplayer
    if (!mp) return null
    const seat = mp.seats?.find(s => (s.seatId ?? s.id) === mp.meSeatId)
    if (!seat) return null
    const guild = this._myGuild()
    return {
      veto:      seat.tokens?.veto        ?? 0,
      guild:     guild?.tokens?.guild     ?? 0,
      character: guild?.tokens?.character ?? 0,
      round:     guild?.tokens?.round     ?? 0,
    }
  }

  // The local player's display name from multiplayer state.
  _myPlayerName() {
    const mp = this.gameState?.multiplayer
    if (!mp) return ''
    const seat = mp.seats?.find(s => (s.seatId ?? s.id) === mp.meSeatId)
    return seat?.name ?? ''
  }


  // Render the city's streets, gutters, blocks, plots, and buildings from a
  // cityDistrictData payload. Used after every per-district assign/regenerate/lock.
  // Landmarks and plots arrive ready from the server (ADR-0005) — just render.
  _renderCityGeometry(cityData, { preserveTerrainPlots = false } = {}) {
    if (!cityData) return
    this.renderer.syncPromotedPlots(cityData)
    this.renderer.setCityDistrictData(cityData)
    this.renderer.renderStreetGraph(cityData.streetGraph)
    this.renderer.renderGutters(cityData.streetGraph)
    this.renderer.renderBlocks(cityData.blocks)
    this.renderer.renderPlots(cityData.plots, cityData, { preserveTerrainPlots })
    this.renderer.drawBlockCenters(cityData.blocks)
    this.renderer.drawPlotCenters(cityData.plots || [])
    this.renderer.drawStreetSeeds(cityData.streetGraph)
  }

  // ── Terrain region ──────────────────────────────────────────────────────────

  _handleRegionClick(regionId) {
    const region = this.renderer.terrainData?.regions?.find(r => r.id === regionId)
    if (!region) return

    if (this.currentPhase === 'CitySubdivision') {
      // Fallback path for clicks that miss every plot mesh (TERRAIN_PLOT_CLICKED handles
      // the normal case, including City Expansion promotion via the district panel).
      const DISTRICT_FOR = { Forest: 'Forestry', Hills: 'Mining', Plains: 'Agriculture', Lake: 'Fishing', Sea: 'Fishing' }
      const canDistrict = !!DISTRICT_FOR[region.assignedType]
      const canThreatTrade = !!region.isEdge
      if (canDistrict || canThreatTrade) this._handleTerrainRegionClick(regionId)
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

  // Promote a terrain plot to a city district with a pre-selected type.
  // No geometry is drawn — just update the district list so the panel can work.
  // Streets/buildings only appear when the user clicks Regenerate Streets or Apply.
  async _handlePromoteWithType(plotId, pendingType) {
    console.log('[App] _handlePromoteWithType', plotId, pendingType)
    try {
      const response = await GameAPI.promoteTerrainPlot(plotId)
      console.log('[App] promoteTerrainPlot response', response)
      if (response.ok) {
        // Update district data silently — only the data reference, no geometry draw.
        // districtRenderer.cityDistrictData lets _refreshDistrictPanel find the polygon
        // for anchor points without triggering any mesh re-renders.
        if (this.renderer.districtRenderer) {
          this.renderer.districtRenderer.cityDistrictData = response.cityDistrictData
        }
        // Hide/un-hover/un-hit-test the source terrain plot immediately — it's now
        // part of a city district, even before the district itself renders.
        this.renderer.syncPromotedPlots(response.cityDistrictData)
        const newId = response.newDistrictId
        if (newId !== undefined) {
          // Clear terrain selection so _refreshDistrictPanel shows the district panel
          this.renderer.clearTerrainPlotSelected?.()
          if (this.selectedTerrainRegionId !== null) this.renderer.deselectRegion(this.selectedTerrainRegionId)
          this.selectedTerrainRegionId = null
          this.selectedTerrainPlotId = null
          this.pendingTerrainAction = null
          this.selectedDistrictId = newId
          this.pendingDistrictType = pendingType
          this.pendingResidentialClass = null
          this.pendingLeadershipClass = 'Monarchy'
          this.renderer.selectDistrict(newId)
          this._refreshDistrictPanel()
        }
      } else this.uiManager.showError(response.error)
    } catch (e) { this.uiManager.showError(e.message) }
  }

  _handleTerrainPreview(terrainType) {
    if (this.selectedRegionId === null) return
    this.pendingTerrainType = terrainType
    this.renderer.previewRegionType(this.selectedRegionId, terrainType)
    this._refreshTerrainPanel()
  }

  async _handleTerrainApply({ name, description }) {
    if (this.selectedRegionId === null || !this.pendingTerrainType) return
    const regionId = this.selectedRegionId
    const terrainType = this.pendingTerrainType
    try {
      const response = await GameAPI.assignTerrain(regionId, terrainType, description, name)
      if (response.ok) {
        const region = this.renderer.terrainData?.regions?.find(r => r.id === regionId)
        if (region) { region.assignedType = terrainType; region.name = name; region.description = description }
        this.renderer.updateRegionColor(regionId, terrainType)
        this.renderer.deselectRegion(regionId)
        this.renderer.clearHover()

        for (const edgeId of response.clearedEdgeIds || []) {
          const edge = this.renderer.terrainData?.edges?.[edgeId]
          if (edge) { edge.assignedType = null; edge.description = '' }
          this.selectedEdgeIds.delete(edgeId)
          this.renderer.deselectEdge(edgeId)
        }
        for (const edgeId of response.autoCliffEdgeIds || []) {
          const edge = this.renderer.terrainData?.edges?.[edgeId]
          if (edge) { edge.assignedType = 'Cliff' }
          this.renderer.updateEdgeColor(edgeId, 'Cliff')
        }

        this.selectedRegionId = null
        this.pendingTerrainType = null
        this._refreshTerrainPanel()
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

  async _doFinishTerrain() {
    try {
      const response = await GameAPI.finishTerrain()
      if (response.ok) {
        this.gameState = response
        this.currentPhase = 'CitySubdivision'
        if (this.selectedRegionId !== null) this.renderer.deselectRegion(this.selectedRegionId)
        this.selectedRegionId = null
        this.pendingTerrainType = null
        this._clearEdgeSelection()
        this.selectedDistrictId = null
        this.pendingDistrictType = null
        this.pendingResidentialClass = null
        this.pendingLeadershipClass = 'Monarchy'
        this.selectedCityEdgeIds.clear()
        this.pendingCityEdgeType = null
        this._refreshTerrainPanel()   // hides the floating panel + closes any open NameDialog
        this._finalizeTerrainDisplay()
        const cityData = response.cityDistrictData || { districts: [], edges: {}, edgePoints: [] }
        this.renderer.setCityDistrictData(cityData)
        this.renderer.setMode('city')
        this.renderer.setFinishedGround(false)   // per-district colours during setup
        this.renderer.drawDistrictCenters(cityData.districts)
        this.uiManager.showSetupPhase('CitySubdivision')
      } else {
        this.uiManager.showError(response.error)
      }
    } catch (error) { this.uiManager.showError(error.message) }
  }

  async _doFinishSubdivision({ skipLeadershipCheck = false } = {}) {
    try {
      const response = await GameAPI.finishSubdivision({ skipLeadershipCheck })

      // No Leadership District assigned — prompt the player.
      // OK = let the game choose; Cancel = dismiss so player can assign manually.
      if (!response.ok && response.needsLeadership) {
        this.uiManager.showConfirm(
          'No Leadership District was defined.\n\nCancel to assign one manually, or click below to let the game choose.',
          'Let the game choose',
          async () => {
            try {
              const r = await GameAPI.autoAssignLeadership()
              if (r.ok) {
                this._renderCityGeometry(r.cityDistrictData, { preserveTerrainPlots: true })
                await this._doFinishSubdivision({ skipLeadershipCheck: true })
              } else this.uiManager.showError(r.error)
            } catch (e) { this.uiManager.showError(e.message) }
          }
        )
        return
      }

      if (response.ok) {
        this.gameState = response
        this.currentPhase = 'GuildCreation'
        this.selectedTerrainRegionId = null
        // Stay in 'city' mode: districts and their generated streets/buildings
        // remain visible together (no separate Street Setup view).
        this.renderer.setMode('city')
        this.renderer.guildSetupActive = true            // disable terrain/edge hover & select
        this.renderer.setCityEdgesHidden(true)           // city is final — no City-Edge overlay
        this.renderer.setFinishedGround(true)            // leaving District Setup → grassy-brown plot bases
        this._renderCityGeometry(response.cityDistrictData)
        if (response.factions) {
          this.factions = response.factions
          this.uiManager.updateFactions(this.factions)
        }
        this.guilds = response.guilds || []
        this.currentPhase = 'Complete'
        this.uiManager.showSetupPhase('Complete')
        const myGuild = this._myGuild()
        this.uiManager.guildPanel.setData({
          guild: myGuild, factions: this.factions, resourceDefinitions: this.resourceDefinitions,
          districts: response.cityDistrictData?.districts || [],
          tokens: this._myTokens(), playerName: this._myPlayerName(),
        })
        this.uiManager.updateGuild(myGuild)
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

  async _handleEdgeApply({ name, description }) {
    if (this.selectedEdgeIds.size === 0 || !this.pendingEdgeType) return
    const edgeIds = [...this.selectedEdgeIds]
    const edgeType = this.pendingEdgeType
    try {
      const response = await GameAPI.assignEdges(edgeIds, edgeType, description, name)
      if (response.ok) {
        for (const edgeId of edgeIds) {
          const edge = this.renderer.terrainData?.edges?.[edgeId]
          if (edge) { edge.assignedType = edgeType; edge.name = name; edge.description = description }
          this.renderer.updateEdgeColor(edgeId, edgeType)
        }
        this._clearEdgeSelection()
        this._refreshTerrainPanel()
      } else {
        this.uiManager.showError(response.error)
        this._refreshTerrainPanel()
      }
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

  _getAdjacentRegions(regionId) {
    const edges = this.renderer.terrainData?.edges || {}
    const regions = this.renderer.terrainData?.regions || []
    const regionMap = new Map(regions.map(r => [r.id, r]))
    const seen = new Set()
    const result = []
    for (const edge of Object.values(edges)) {
      const otherId = edge.regionA === regionId ? edge.regionB : edge.regionB === regionId ? edge.regionA : null
      if (otherId !== null && !seen.has(otherId)) {
        seen.add(otherId)
        const other = regionMap.get(otherId)
        if (other?.assignedType) result.push({ type: other.assignedType, name: other.name || '' })
      }
    }
    return result
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

  _getRiverDisabledReason(selectedEdgeIds) {
    const edges = this.renderer.terrainData?.edges || {}
    const regions = this.renderer.terrainData?.regions || []
    const regionMap = new Map(regions.map(r => [r.id, r]))

    const pointPositions = this.renderer.edgePointsById
    const worldSize = this.renderer.terrainData?.worldSize ?? 50

    for (const edgeId of selectedEdgeIds) {
      const edge = edges[edgeId]
      if (!edge) continue
      const myRegions = new Set([edge.regionA, edge.regionB].filter(r => r != null))
      const pts = edge.pointIds || []
      const myEndpoints = new Set([pts[0], pts[pts.length - 1]].filter(p => p != null))

      // Cannot run alongside a Lake or Sea region (rule 1)
      for (const rId of myRegions) {
        const t = regionMap.get(rId)?.assignedType
        if (t === 'Lake') return 'Cannot flow alongside a Lake'
        if (t === 'Sea')  return 'Cannot flow alongside a Sea'
      }
    }

    // Find free endpoints (appear in only one selected edge)
    const ptCount = new Map()
    for (const edgeId of selectedEdgeIds) {
      const pts = edges[edgeId]?.pointIds || []
      if (pts.length < 2) continue
      const first = pts[0], last = pts[pts.length - 1]
      ptCount.set(first, (ptCount.get(first) || 0) + 1)
      if (last !== first) ptCount.set(last, (ptCount.get(last) || 0) + 1)
    }
    const freeEndpoints = [...ptCount].filter(([, c]) => c === 1).map(([p]) => p)

    for (const ptId of freeEndpoints) {
      if (!this._isValidRiverEndpoint(ptId, selectedEdgeIds, edges, regionMap, pointPositions, worldSize)) {
        return 'Endpoints must connect to a River, Sea, Lake, Ice Sheet, Mountains, or the map edge'
      }
    }

    return null
  }

  _isValidRiverEndpoint(ptId, selectedEdgeIds, edges, regionMap, pointPositions, worldSize) {
    // Map boundary: point coordinates on the world edge
    const pt = pointPositions.get(ptId)
    const eps = 0.5
    if (pt && (pt.x < eps || pt.x > worldSize - eps || pt.y < eps || pt.y > worldSize - eps)) return true

    for (const [edgeId, edge] of Object.entries(edges)) {
      const pts = edge.pointIds || []
      if (pts[0] !== ptId && pts[pts.length - 1] !== ptId) continue

      // Existing River edge at this point (not in selection)
      if (!selectedEdgeIds.has(edgeId) && edge.assignedType === 'River') return true

      const rA = regionMap.get(edge.regionA)
      const rB = regionMap.get(edge.regionB)

      // Sea, Lake, Ice Sheet, or Mountains (a river's source) adjacent to this point
      if (rA?.assignedType === 'Sea'       || rB?.assignedType === 'Sea')       return true
      if (rA?.assignedType === 'Lake'      || rB?.assignedType === 'Lake')      return true
      if (rA?.assignedType === 'Ice Sheet' || rB?.assignedType === 'Ice Sheet') return true
      if (rA?.assignedType === 'Mountains' || rB?.assignedType === 'Mountains') return true
    }
    return false
  }

  _refreshTerrainPanel() {
    const panel = this.uiManager.terrainTypePanel
    if (!panel) return

    if (this.selectedRegionId !== null) {
      const region = this.renderer.terrainData?.regions?.find(r => r.id === this.selectedRegionId)
      if (region?.vertices?.length) panel.setAnchorPoints(region.vertices)
      else if (region?.seedPoint) panel.setAnchorPoints([{ x: region.seedPoint.x, y: region.seedPoint.y }])
      panel.showContext('region', {
        pendingType: this.pendingTerrainType,
        isEdge: region?.isEdge ?? false,
        isNorthEdge: region?.isNorthEdge ?? false,
        adjacentRegions: this._getAdjacentRegions(this.selectedRegionId)
      })
    } else if (this.selectedEdgeIds.size > 0) {
      const edgePts = this._getEdgeWorldPoints()
      if (edgePts.length) panel.setAnchorPoints(edgePts)
      panel.showContext('edge', {
        edgeCount: this.selectedEdgeIds.size,
        pendingType: this.pendingEdgeType,
        adjacentTypes: this._getFirstEdgeAdjacentTypes(),
        riverDisabledReason: this._getRiverDisabledReason(this.selectedEdgeIds)
      })
    } else {
      panel.showContext('none')
    }
  }

  _getEdgeWorldPoints() {
    const pts = []
    for (const edgeId of this.selectedEdgeIds) {
      const edge = this.renderer.terrainData?.edges?.[edgeId]
      for (const ptId of edge?.pointIds || []) {
        const p = this.renderer.edgePointsById.get(ptId)
        if (p) pts.push({ x: p.x, y: p.y })
      }
    }
    return pts
  }

  _getFirstEdgeAdjacentTypes() {
    const firstEdgeId = [...this.selectedEdgeIds][0]
    return firstEdgeId ? this._getEdgeAdjacentTypes(firstEdgeId) : []
  }

  // ── City district ───────────────────────────────────────────────────────────

  _handleDistrictClick(districtId) {
    if (this.currentPhase !== 'CitySubdivision') return
    const district = this.renderer.cityDistrictData?.districts?.find(d => d.id === districtId)
    if (!district) return

    // Clicking the already-selected district toggles it off — reverting it to a blank
    // polygon if it was previewed but never applied.
    if (this.selectedDistrictId === districtId) {
      this._revertProvisionalDistrict(districtId)
      this.renderer.deselectDistrict(districtId)
      this.selectedDistrictId = null
      this.pendingDistrictType = null
      this.pendingResidentialClass = null
      this.pendingLeadershipClass = 'Monarchy'
      this._refreshDistrictPanel()
      return
    }

    // Clicking off the current selection (onto another district): revert the previous
    // one if it was never applied.
    if (this.selectedDistrictId !== null) {
      this._revertProvisionalDistrict(this.selectedDistrictId)
      this.renderer.deselectDistrict(this.selectedDistrictId)
      this.selectedDistrictId = null
    }
    if (this.selectedTerrainRegionId !== null) {
      this.renderer.deselectRegion(this.selectedTerrainRegionId)
      this.selectedTerrainRegionId = null
      this.selectedTerrainPlotId = null
    }

    // Locked districts are final — permanent, no type/resource/regeneration changes —
    // so clicking one shows no dialogue at all. Any previous selection was already
    // cleared above; there's nothing further to select or open here.
    if (district.locked) return

    this._clearCityEdgeSelection()
    this.selectedDistrictId = districtId
    this.pendingDistrictType = null
    this.pendingResidentialClass = null
    this.pendingLeadershipClass = 'Monarchy'
    this.renderer.selectDistrict(districtId)
    this._refreshDistrictPanel()
    // No auto-preview — user clicks Regenerate Streets to see geometry
  }

  // Discard the selected district if it was previewed but never applied, returning it
  // to a blank district polygon (clears its streets too). Locked districts are final.
  _revertProvisionalDistrict(id = this.selectedDistrictId) {
    if (id === null || id === undefined) return
    const d = this.renderer.cityDistrictData?.districts?.find(x => x.id === id)
    if (!d || d.locked) return
    // A promoted-but-unapplied district is abandoned entirely (not just blanked) —
    // it didn't exist before the promotion click, so walking away undoes it fully.
    const isAbandonedPromotion = d.promotedFromPlotId != null
    if (!d.assignedType && !isAbandonedPromotion) return
    if (!isAbandonedPromotion) {
      d.assignedType = null; d.residentialClass = null; d.LeadershipClass = null
      d.producedResource = null; d.consumedResources = []; d.streetSeed = null; d.description = ''
      this.renderer.updateDistrictColor(id, null)
    }
    GameAPI.revertDistrict(id).then(r => { if (r?.ok) this._renderCityGeometry(r.cityDistrictData) }).catch(() => {})
  }

  _handleTerrainRegionClick(regionId) {
    if (this.selectedTerrainRegionId === regionId) {
      this.renderer.deselectRegion(regionId)
      this.selectedTerrainRegionId = null
      this.selectedTerrainPlotId = null
      this.pendingTerrainAction = null
      this._refreshDistrictPanel()
      return
    }
    if (this.selectedTerrainRegionId !== null) this.renderer.deselectRegion(this.selectedTerrainRegionId)
    if (this.selectedDistrictId !== null) {
      this._revertProvisionalDistrict(this.selectedDistrictId)
      this.renderer.deselectDistrict(this.selectedDistrictId)
      this.selectedDistrictId = null
      this.pendingDistrictType = null
    }
    this._clearCityEdgeSelection()
    this.selectedTerrainRegionId = regionId
    this.selectedTerrainPlotId = null
    this.pendingTerrainAction = null
    this.renderer.selectRegion(regionId)
    this._refreshDistrictPanel()
  }

  async _handleTerrainDistrictAssign(regionId, plotId, districtType, description = '', producedResource = '', name = '', resourceDefs = [], resourceWiring = []) {
    try {
      const response = await GameAPI.assignTerrainDistrict(regionId, plotId, districtType, description, producedResource, name, resourceDefs)
      if (response.ok) {
        this.renderer.deselectRegion(regionId)
        this.renderer.clearTerrainPlotSelected()
        this.selectedTerrainRegionId = null
        this.selectedTerrainPlotId = null
        this.pendingTerrainAction = null
        this.renderer.spawnTerrainDistrictFeature(regionId, plotId, districtType)
        if (response.resourceRegistry) {
          this.resourceRegistry = response.resourceRegistry
          this.uiManager.updateResources(this.resourceRegistry)
        }
        if (response.resourceDefinitions) this.resourceDefinitions = response.resourceDefinitions
        if (response.factions) {
          this.factions = response.factions
          this.uiManager.updateFactions(this.factions)
        }
        await this._applyResourceWiring(resourceWiring)
        this._refreshDistrictPanel()
      } else {
        this.uiManager.showError(response.error)
        this._refreshDistrictPanel()
      }
    } catch (error) { this.uiManager.showError(error.message); this._refreshDistrictPanel() }
  }

  // Wires newly-created resources in as an existing resource's 2nd ingredient (the New
  // Resource dialog's "used as an ingredient for" node). Runs after the district that
  // registers the new resource(s) has already been assigned, since the target lookup is
  // server-authoritative and the new resource must exist in resourceDefinitions first.
  async _applyResourceWiring(resourceWiring = []) {
    for (const { resourceName, targetName } of resourceWiring) {
      try {
        const res = await GameAPI.attachIngredientToResource(resourceName, targetName)
        if (res.ok && res.resourceDefinitions) this.resourceDefinitions = res.resourceDefinitions
        else if (!res.ok) this.uiManager.showError(res.error)
      } catch (error) { this.uiManager.showError(error.message) }
    }
  }

  _handleDistrictPreview(districtType) {
    if (this.selectedDistrictId === null) return
    this.pendingDistrictType = districtType
    this.pendingResidentialClass = null
    this.pendingLeadershipClass = 'Monarchy'
    this.renderer.previewDistrictType(this.selectedDistrictId, districtType)
    this._refreshDistrictPanel()
    // Residential needs a class first (_previewDistrictStreets no-ops until one is picked);
    // every other type can preview immediately.
    this._previewDistrictStreets()
  }

  // Provisionally set the selected district's type/class on the server and render the
  // resulting streets/plots/buildings — so the player sees them the moment a type (and,
  // for Residential, a class) is chosen, before filling in resources or clicking Apply.
  async _previewDistrictStreets() {
    const districtId = this.selectedDistrictId
    if (districtId === null || !this.pendingDistrictType) return
    const type = this.pendingDistrictType
    if (type === 'Residential' && !this.pendingResidentialClass) return   // need a class first
    const residentialClass = type === 'Residential' ? this.pendingResidentialClass : null
    const LeadershipClass = type === 'Leadership' ? this.pendingLeadershipClass : null
    try {
      const response = await GameAPI.previewDistrictType(districtId, type, residentialClass, LeadershipClass)
      if (response.ok) {
        const d = this.renderer.cityDistrictData?.districts?.find(x => x.id === districtId)
        if (d) { d.assignedType = type; d.residentialClass = residentialClass; d.LeadershipClass = LeadershipClass }
        this._renderCityGeometry(response.cityDistrictData)
      } else { this.uiManager.showError(response.error) }
    } catch (error) { this.uiManager.showError(error.message) }
  }

  // Apply = lock the district in. Validates + commits resources server-side.
  async _handleDistrictApply({ name, description, producedResource, secondProducedResource, residentialClass, LeadershipClass, resourceDefs = [], resourceWiring = [] }) {
    if (this.selectedDistrictId === null || !this.pendingDistrictType) return
    const districtId = this.selectedDistrictId
    const districtType = this.pendingDistrictType
    try {
      const response = await GameAPI.assignDistrictType(districtId, districtType, description, producedResource, residentialClass, LeadershipClass, secondProducedResource, name, resourceDefs)
      if (response.ok) {
        const district = this.renderer.cityDistrictData?.districts?.find(d => d.id === districtId)
        if (district) {
          district.assignedType = districtType
          district.name = name || ''
          district.residentialClass = residentialClass || null
          district.LeadershipClass = LeadershipClass || null
          district.description = description
          district.producedResource = producedResource || null
          district.locked = true
        }
        if (response.resourceRegistry) {
          this.resourceRegistry = response.resourceRegistry
          this.uiManager.updateResources(this.resourceRegistry)
        }
        if (response.resourceDefinitions) this.resourceDefinitions = response.resourceDefinitions
        if (response.factions) { this.factions = response.factions; this.uiManager.updateFactions(this.factions) }
        await this._applyResourceWiring(resourceWiring)
        this.renderer.updateDistrictColor(districtId, districtType)
        this._renderCityGeometry(response.cityDistrictData)
        if (this.selectedDistrictId !== null) this.renderer.deselectDistrict(this.selectedDistrictId)
        this.selectedDistrictId = null
        this.pendingDistrictType = null
        this.pendingResidentialClass = null
        this.pendingLeadershipClass = 'Monarchy'
        this._refreshDistrictPanel()
      } else {
        this.uiManager.showError(response.error)
        this._refreshDistrictPanel()
      }
    } catch (error) { this.uiManager.showError(error.message); this._refreshDistrictPanel() }
  }

  // Reseed the district being edited; leaves the resources/description form untouched
  // (the panel is intentionally NOT rebuilt).
  async _handleDistrictRegenerate() {
    const districtId = this.selectedDistrictId
    if (districtId === null) return
    try {
      const response = await GameAPI.regenerateDistrict(districtId)
      if (response.ok) this._renderCityGeometry(response.cityDistrictData, { preserveTerrainPlots: true })
      else this.uiManager.showError(response.error)
    } catch (error) { this.uiManager.showError(error.message) }
  }

  // Save district config overrides (from the cog/settings dialog) without regenerating.
  async _handleDistrictSettingsSave(configOverrides) {
    const districtId = this.selectedDistrictId
    if (districtId === null) return
    try {
      const response = await GameAPI.saveDistrictOverrides(districtId, configOverrides)
      if (response.ok) this._refreshDistrictPanel()
      else this.uiManager.showError(response.error)
    } catch (error) { this.uiManager.showError(error.message) }
  }

  // Save overrides AND regenerate streets in one round-trip.
  async _handleDistrictSettingsRegenerate(configOverrides) {
    const districtId = this.selectedDistrictId
    if (districtId === null) return
    try {
      const response = await GameAPI.regenerateDistrict(districtId, configOverrides)
      if (response.ok) {
        this._renderCityGeometry(response.cityDistrictData, { preserveTerrainPlots: true })
        this._refreshDistrictPanel()
      } else this.uiManager.showError(response.error)
    } catch (error) { this.uiManager.showError(error.message) }
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

      if (this.selectedCityEdgeIds.size === 0) {
        if (this.selectedTerrainRegionId !== null) {
          this.renderer.deselectRegion(this.selectedTerrainRegionId)
          this.selectedTerrainRegionId = null
          this.selectedTerrainPlotId = null
          this.pendingTerrainAction = null
        }
        if (this.selectedDistrictId !== null) {
          this._revertProvisionalDistrict(this.selectedDistrictId)
          this.renderer.deselectDistrict(this.selectedDistrictId)
          this.selectedDistrictId = null
          this.pendingDistrictType = null
        }
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

  async _handleCityEdgeApply({ name, description }) {
    if (this.selectedCityEdgeIds.size === 0 || !this.pendingCityEdgeType) return
    const edgeIds = [...this.selectedCityEdgeIds]
    const edgeType = this.pendingCityEdgeType
    try {
      let lastCityData = null
      for (const edgeId of edgeIds) {
        const response = await GameAPI.assignCityEdge(edgeId, edgeType, description, name)
        if (response.ok) {
          if (response.cityDistrictData) {
            lastCityData = response.cityDistrictData
          } else {
            const edge = this.renderer.cityDistrictData?.edges?.[edgeId]
            if (edge) { edge.assignedType = edgeType; edge.name = name; edge.description = description }
            this.renderer.updateCityEdgeColor(edgeId, edgeType)
          }
        } else {
          this.uiManager.showError(response.error)
          this._refreshDistrictPanel()
          return
        }
      }
      if (lastCityData) {
        this._renderCityGeometry(lastCityData)
        // Trigger rise animation for newly-assigned wall/canal edges.
        for (const edgeId of edgeIds) this.renderer.updateCityEdgeColor(edgeId, edgeType)
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
    const fromTerrainDistricts = (this.factions || [])
      .filter(f => f.type === 'terrain' && f.producedResource && f.plotId !== this.selectedTerrainPlotId)
      .map(f => f.producedResource.toLowerCase())
    return [...fromCityDistricts, ...fromTerrainDistricts]
  }

  _refreshDistrictPanel() {
    const panel = this.uiManager.districtTypePanel
    if (!panel) return
    const shared = {
      threats: this.threats,
      tradingDestinations: this.tradingDestinations
    }
    // Exactly one Leadership district is allowed — once any OTHER district already has
    // it, stop offering it in every district-type picker (City Expansion promotion and
    // the district panel alike). Excludes the currently-selected district itself so its
    // own existing Leadership assignment stays visible/editable.
    const allDistricts = this.renderer.cityDistrictData?.districts || []
    const leadershipTaken = (excludeId = null) =>
      allDistricts.some(d => d.assignedType === 'Leadership' && d.id !== excludeId)
    if (this.selectedTerrainRegionId !== null) {
      const region = this.renderer.terrainData?.regions?.find(r => r.id === this.selectedTerrainRegionId)
      if (region?.vertices?.length) panel.setAnchorPoints(region.vertices)
      else if (region?.seedPoint) panel.setAnchorPoints([{ x: region.seedPoint.x, y: region.seedPoint.y }])
      const plotId = this.selectedTerrainPlotId ?? null
      const hasDistrict = plotId ? (this.factions || []).some(f => f.type === 'terrain' && f.plotId === plotId) : false
      // Server-authoritative (ADR-0003) — the eligible-plot-id list is computed and
      // pushed by the server on every district-changing response; the client never
      // re-derives Living Boundary adjacency itself.
      const eligiblePlotIds = this.renderer.cityDistrictData?.eligiblePromotionPlotIds
      const isAdjacentToCity = plotId !== null && !!eligiblePlotIds?.includes(plotId)
      panel.showContext('terrainRegion', {
        regionType: region?.assignedType,
        isEdge: region?.isEdge ?? false,
        hasDistrict,
        pendingAction: this.pendingTerrainAction,
        regionId: this.selectedTerrainRegionId,
        plotId,
        resourceRegistry: this.resourceRegistry,
        resourceDefinitions: this.resourceDefinitions,
        usedProducedResources: this._getUsedProducedResources(),
        isAdjacentToCity,
        leadershipTaken: leadershipTaken(),
        ...shared
      })
      return
    }
    if (this.selectedDistrictId !== null) {
      const district = this.renderer.cityDistrictData?.districts?.find(d => d.id === this.selectedDistrictId)
      const poly = district?.polygon || district?.boundary
      if (poly?.length) panel.setAnchorPoints(poly)
      else if (district?.seedPoint) panel.setAnchorPoints([{ x: district.seedPoint.x, y: district.seedPoint.y }])
      panel.showContext('district', {
        pendingType: this.pendingDistrictType,
        residentialClass: this.pendingResidentialClass,
        LeadershipClass: this.pendingLeadershipClass,
        resourceRegistry: this.resourceRegistry,
        resourceDefinitions: this.resourceDefinitions,
        usedProducedResources: this._getUsedProducedResources(),
        leadershipTaken: leadershipTaken(this.selectedDistrictId),
        configOverrides: district?.configOverrides || {},
        locked: !!district?.locked,
        ...shared
      })
    } else if (this.selectedCityEdgeIds.size > 0) {
      const edgePts = []
      for (const edgeId of this.selectedCityEdgeIds) {
        const edge = this.renderer.cityDistrictData?.edges?.[edgeId]
        for (const ptId of edge?.pointIds || []) {
          const p = this.renderer.cityEdgePointsById.get(ptId)
          if (p) edgePts.push({ x: p.x, y: p.y })
        }
      }
      if (edgePts.length) panel.setAnchorPoints(edgePts)
      const nearWater = [...this.selectedCityEdgeIds].every(id => this._isCityEdgeNearWater(id))
      panel.showContext('cityEdge', {
        edgeCount: this.selectedCityEdgeIds.size,
        pendingType: this.pendingCityEdgeType,
        nearWater,
        ...shared
      })
    } else {
      panel.showContext('none', shared)
    }
  }

  // ── State loading ───────────────────────────────────────────────────────────

  // Solo entry point: load the existing game or start a fresh one. Used by the
  // "Play Solo" button and as the fallback when no networked game exists.
  async startSolo() {
    await this.loadState()
  }

  async loadState() {
    try {
      const state = await GameAPI.getState()
      if (!this._applyState(state)) {
        await this.startSetup()
      }
    } catch (error) {
      console.error('Failed to load state:', error)
      await this.startSetup()
    }
  }

  // Re-pull and re-render from the server without ever auto-initialising a game.
  // Called on every live-sync nudge and after lobby/turn actions. Safe during the
  // Lobby (no world yet) — it just refreshes the multiplayer overlay.
  async refreshFromServer(event = null) {
    try {
      const state = await GameAPI.getState()
      this.multiplayerUI?.update(state.multiplayer, state.setupStep)
      // Solo play (no seat joined) drives rendering through the incremental action
      // handlers, exactly as before — ignore live-sync nudges for rendering.
      if (!config.seatKey) return
      // Show Event Card for this declaration (all players, including the declaring player).
      if (event) this.eventCardManager?.show(event, state.multiplayer?.meSeatId ?? null)
      // Don't clobber an in-progress local edit (a pending selection/form) with a
      // full re-render triggered by our own broadcast. Others (no pending edit) still
      // reconcile live.
      if (this._hasPendingEdit()) return
      this._applyState(state)
    } catch (error) {
      console.error('Refresh failed:', error)
    }
  }

  _hasPendingEdit() {
    return this.selectedRegionId != null ||
           this.selectedDistrictId != null ||
           this.selectedTerrainRegionId != null ||
           this.pendingTerrainAction != null ||
           this.selectedEdgeIds.size > 0 ||
           this.selectedCityEdgeIds.size > 0
  }

  // Render the full game from a state snapshot. Returns true if a world was rendered,
  // false if the snapshot has no terrain yet (Lobby / pre-init) so callers can decide
  // whether to initialise. Idempotent — safe to call on every sync.
  _applyState(state) {
    const regions = state.worldTerrainData?.regions || []
    if (regions.length === 0) return false

    const setupStep = state.setupStep || 'Terrain'
    this.gameState = state
    this.currentPhase = setupStep
    this.uiManager.setPlayerName(this._myPlayerName())
    // The client's copy of the server's Point registry (see GroundPointRegistry.js) —
    // threaded into every renderer setter below so terrain plots/districts resolve their
    // own polygons from pointIds instead of trusting a server-sent .polygon snapshot.
    const pointsById = new Map((state.pointRegistry || []).map(p => [p.id, p]))
    this.renderer.setTerrainData(
      regions,
      state.worldTerrainData.edges || {},
      state.worldTerrainData.terrainPlots || [],
      state.worldTerrainData.edgePoints || [],
      pointsById,
      state.worldTerrainData.riverCliffFaces || []
    )

    const cityData = state.cityDistrictData
    if (setupStep !== 'Terrain' && cityData?.districts?.length > 0) {
      // Past District Setup → finished grassy-brown ground + hide the City-Edge overlay
      // (the flag makes every renderCityEdges call a no-op, in all render paths).
      const guildPhase = setupStep === 'GuildCreation' || setupStep === 'Complete'
      this.renderer.setCityEdgesHidden(guildPhase)
      this._finalizeTerrainDisplay()
      this.renderer.setCityDistrictData(cityData, pointsById)
      // Re-hide any already-promoted (City Expansion) terrain plots' source meshes —
      // setTerrainData above just rebuilt every terrain plot mesh fresh (all visible),
      // and _renderCityGeometry below (which normally does this) only runs when
      // cityData.streetGraph exists, which a promoted-but-not-yet-typed district won't
      // have yet. Without this, such a plot's terrain mesh reappears on every reload/sync.
      this.renderer.syncPromotedPlots(cityData)
      this.renderer.setMode('city')
      this.renderer.setFinishedGround(guildPhase)
      this.renderer.drawDistrictCenters(cityData.districts)
      // Streets/plots/buildings exist for any districts already typed (per-district gen).
      if (cityData.streetGraph) this._renderCityGeometry(cityData)
    } else {
      this.renderer.clearStreetLayer()
      this.renderer.clearDerivedLayers()
      this.renderer.setCityDistrictData([])
      this.renderer.setMode('terrain')
    }

    this.resourceRegistry = state.resourceRegistry || []
    this.uiManager.updateResources(this.resourceRegistry)
    this.resourceDefinitions = state.resourceDefinitions || {}

    if (state.threats) {
      this.threats = state.threats
      this.renderer.renderThreats(this.threats, regions)
    }
    if (state.tradingDestinations) {
      this.tradingDestinations = state.tradingDestinations
      this.renderer.renderTrades(this.tradingDestinations, state.worldTerrainData)
    }
    if (state.factions) {
      this.factions = state.factions
      this.uiManager.updateFactions(this.factions)
    }
    this.renderer.renderForeignPowerBands(state.foreignPowers || [])
    this._updateFPLabels(state.foreignPowers || [], setupStep)
    this.inputHandler.setTerrainData(state)
    this.uiManager.showSetupPhase(setupStep)
    if (setupStep === 'Terrain') this.uiManager.updateTerrainWorldbuildingButtons(state)
    // In Guild Setup the city is final — disable terrain/district-edge hover & select.
    this.renderer.guildSetupActive = (setupStep === 'GuildCreation' || setupStep === 'Complete')
    this.guilds = state.guilds || []
    if (setupStep === 'GuildCreation' || setupStep === 'Complete') {
      this.uiManager.guildPanel.setData({
        guild: this._myGuild(),
        factions: this.factions,
        resourceDefinitions: this.resourceDefinitions,
        districts: state.cityDistrictData?.districts || [],
        tokens: this._myTokens(), playerName: this._myPlayerName(),
      })
      this.uiManager.updateGuild(this._myGuild())
    } else {
      this.uiManager.guildPanel.reset()
    }
    // Focus the camera and announce setup only on the first render — not on every
    // live-sync re-render, which would yank the camera on each remote change.
    if (!this._firstRenderDone) {
      this._firstRenderDone = true
      this._focusCameraOnCity(regions)
      this.eventBus.emit('SETUP_STARTED')
    }
    return true
  }

  // ── Foreign Power DOM labels ────────────────────────────────────────────────

  _ensureFPLabelContainer() {
    if (this._fpLabelContainer) return
    const c = document.createElement('div')
    c.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10'
    document.body.appendChild(c)
    this._fpLabelContainer = c
  }

  _updateFPLabels(foreignPowers, setupStep) {
    this._ensureFPLabelContainer()
    this._fpLabelContainer.innerHTML = ''
    this._fpLabelEls = []
    if (this.renderer.isWalkMode) return   // hide FP labels entirely in walk mode
    if (!foreignPowers?.length) return

    const centers = this.renderer.getFPBandCenters()
    const inDistrictMode = setupStep === 'CitySubdivision'

    for (const fp of foreignPowers) {
      const center = centers.find(c => c.fp.id === fp.id)
      if (!center) continue

      const btn = document.createElement('button')
      btn.textContent = fp.name
      btn.style.cssText = [
        'position:absolute', 'transform:translate(-50%,-50%)',
        `color:${fp.colour || '#fff'}`, 'font:bold 13px Arial',
        'background:rgba(0,0,0,0.55)', `border:1.5px solid ${fp.colour || '#888'}`,
        'border-radius:20px', 'padding:3px 12px', 'white-space:nowrap',
        'text-shadow:0 1px 3px rgba(0,0,0,0.9)',
        inDistrictMode ? 'pointer-events:auto;cursor:pointer' : 'pointer-events:none;cursor:default',
      ].join(';')
      if (inDistrictMode) {
        btn.addEventListener('click', (e) => { e.stopPropagation(); this._openFPStancePopup(fp, btn) })
      }
      this._fpLabelContainer.appendChild(btn)
      this._fpLabelEls.push({ el: btn, worldX: center.worldX, worldY: center.worldY ?? 0, worldZ: center.worldZ })
    }
    this._updateFPLabelPositions()
  }

  _updateFPLabelPositions() {
    for (const { el, worldX, worldY, worldZ } of this._fpLabelEls) {
      const s = this.renderer.worldToScreen(worldX, worldY ?? 0, worldZ)
      el.style.left = s.x + 'px'
      el.style.top  = s.y + 'px'
    }
  }

  _openFPStancePopup(fp, anchorEl) {
    document.querySelector('.fp-stance-dialog')?.remove()

    const overlay = document.createElement('div')
    overlay.className = 'fp-stance-dialog'
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:300;display:flex;align-items:center;justify-content:center;pointer-events:auto'
    overlay.addEventListener('click', e => e.stopPropagation())
    overlay.addEventListener('mousedown', e => e.stopPropagation())

    const box = document.createElement('div')
    box.style.cssText = 'background:#1a1a1a;border:1px solid #555;border-radius:8px;padding:20px 24px;width:380px;font-family:Arial;color:#fff;box-shadow:0 8px 32px rgba(0,0,0,0.8);max-height:90vh;overflow-y:auto;box-sizing:border-box'

    // Title row
    const titleRow = document.createElement('div')
    titleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px'
    const title = document.createElement('div')
    title.style.cssText = `font-size:14px;font-weight:bold;color:${fp.colour || '#ddd'}`
    title.textContent = fp.name
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.style.cssText = 'background:none;border:none;color:#888;font-size:16px;cursor:pointer;padding:0;line-height:1'
    closeBtn.addEventListener('click', () => overlay.remove())
    titleRow.appendChild(title); titleRow.appendChild(closeBtn)
    box.appendChild(titleRow)

    const sectionLabel = (txt) => {
      const d = document.createElement('div')
      d.textContent = txt
      d.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:5px'
      return d
    }

    // Name (pre-populated, editable)
    box.appendChild(sectionLabel('Name'))
    const nameInput = document.createElement('input')
    nameInput.type = 'text'; nameInput.value = fp.name
    nameInput.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;background:#111;border:1px solid #555;border-radius:4px;color:#fff;font-size:13px;font-family:Arial;margin-bottom:12px;outline:none'
    nameInput.addEventListener('click', e => e.stopPropagation()); nameInput.addEventListener('mousedown', e => e.stopPropagation())
    box.appendChild(nameInput)

    // Description (pre-populated, editable)
    box.appendChild(sectionLabel('Description (optional)'))
    const descInput = document.createElement('textarea')
    descInput.value = fp.description || ''; descInput.rows = 2
    descInput.placeholder = 'Describe this foreign power…'
    descInput.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;background:#111;border:1px solid #555;border-radius:4px;color:#ccc;font-size:12px;font-family:Arial;resize:vertical;margin-bottom:14px;outline:none'
    descInput.addEventListener('click', e => e.stopPropagation()); descInput.addEventListener('mousedown', e => e.stopPropagation())
    box.appendChild(descInput)

    // Mode toggle: Threat vs Trade Route
    box.appendChild(sectionLabel('Relationship'))
    const modeRow = document.createElement('div'); modeRow.style.cssText = 'display:flex;gap:6px;margin-bottom:14px'
    let mode = null
    const tradeSection = document.createElement('div')
    const applyBtn = document.createElement('button')
    applyBtn.disabled = true; applyBtn.style.cssText = 'width:100%;padding:9px;background:#2471a3;border:1px solid #4a9bdc;border-radius:6px;color:#fff;font-size:13px;font-weight:bold;cursor:pointer;opacity:0.4'
    applyBtn.textContent = 'Apply'

    const mkModeBtn = (label, m, color, border) => {
      const b = document.createElement('button')
      b.textContent = label
      b.style.cssText = `flex:1;padding:8px 4px;background:#2a2a2a;border:2px solid #444;color:#aaa;cursor:pointer;border-radius:5px;font-size:12px;font-family:Arial`
      b.addEventListener('click', () => {
        modeRow.querySelectorAll('button').forEach(bb => { bb.style.borderColor = '#444'; bb.style.background = '#2a2a2a'; bb.style.color = '#aaa' })
        b.style.borderColor = border; b.style.background = color; b.style.color = '#fff'
        mode = m
        tradeSection.style.display = m === 'trade' ? 'block' : 'none'
        applyBtn.disabled = false; applyBtn.style.opacity = '1'
      })
      return b
    }
    modeRow.appendChild(mkModeBtn('☠ Threat', 'threat', '#3a1010', '#994444'))
    modeRow.appendChild(mkModeBtn('↗ Trade Route', 'trade', '#1a3010', '#449944'))
    box.appendChild(modeRow)

    // Trade Route resource pickers
    tradeSection.style.display = 'none'
    let buys = [], sells = []
    const extendedRegistry = () => {
      const localNew = [...buys, ...sells].filter(r => r.isNew).map(r => r.name)
      return [...(this.resourceRegistry || []), ...localNew.filter(n => !(this.resourceRegistry||[]).some(r => r.toLowerCase() === n.toLowerCase()))]
    }
    // Services can never be sold to a Foreign Power (CONTEXT_ResourcesServices.md) — Labour
    // and Security are Services too, even though (like Gold) they have no resourceDefinitions
    // entry of their own.
    const PREDEFINED_SERVICES = new Set(['labour', 'security'])
    const isService = (name) => {
      const key = name.trim().toLowerCase()
      return PREDEFINED_SERVICES.has(key) || this.resourceDefinitions?.[key]?.type === 'Service'
    }

    const makeGroup = (label, getItems, setItems, otherItems, excludeServices = false) => {
      const sec = document.createElement('div'); sec.style.marginBottom = '10px'
      const lbl = document.createElement('div'); lbl.textContent = label; lbl.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:5px'; sec.appendChild(lbl)
      const pills = document.createElement('div'); pills.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px'; sec.appendChild(pills)

      const addBtn = document.createElement('button')
      addBtn.style.cssText = 'padding:5px 10px;background:#1a2a1a;border:1px solid #3a7a3a;border-radius:3px;color:#8c8;font-size:11px;cursor:pointer'

      const refresh = () => {
        pills.innerHTML = ''
        getItems().forEach(item => {
          const pill = document.createElement('span')
          pill.style.cssText = 'background:#2a3a2a;border:1px solid #4a7a4a;border-radius:12px;padding:2px 8px;font-size:11px;color:#8c8;cursor:pointer'
          pill.textContent = `${item.name} ✕`
          pill.addEventListener('click', () => { setItems(getItems().filter(r => r !== item)); refresh(); renderTradeSection() })
          pills.appendChild(pill)
        })
        addBtn.textContent = `+ Add ${label}`
        addBtn.style.display = getItems().length < 3 ? 'inline-block' : 'none'
      }

      const renderTradeSection = () => {
        const warn = tradeSection.querySelector('.trade-warn')
        if (warn) warn.textContent = ''
      }

      addBtn.addEventListener('click', () => {
        new ResourceDialog({
          mode: 'consumed', titleOverride: label,
          resourceRegistry: excludeServices ? extendedRegistry().filter(n => !isService(n)) : extendedRegistry(),
          resourceDefinitions: this.resourceDefinitions,
          disallowServiceType: excludeServices,
          usedProduced: [],
          alreadySelected: [...getItems(), ...otherItems()].map(r => r.name),
          onAdd: item => { setItems([...getItems(), item]); refresh() }
        }).open()
      })
      sec.appendChild(addBtn)
      refresh()
      return sec
    }

    const buysSection = makeGroup('Buys', () => buys, v => { buys = v }, () => sells, true)
    const sellsSection = makeGroup('Sells', () => sells, v => { sells = v }, () => buys)
    tradeSection.appendChild(buysSection); tradeSection.appendChild(sellsSection)

    const tradeWarn = document.createElement('div')
    tradeWarn.className = 'trade-warn'
    tradeWarn.style.cssText = 'color:#f66;font-size:11px;margin-bottom:6px;min-height:14px'
    tradeSection.appendChild(tradeWarn)
    box.appendChild(tradeSection)

    // Apply
    applyBtn.addEventListener('click', async () => {
      if (!mode) return
      const name = nameInput.value.trim()
      if (!name || name.length < 2) { this.uiManager.showError('Please enter a name (at least 2 characters).'); return }
      const description = descInput.value.trim()
      try {
        if (mode === 'threat') {
          const res = await GameAPI.addForeignPowerThreat({ fpId: fp.id, name, description })
          if (res.ok) {
            if (res.threats) this.threats = res.threats
            if (res.factions) { this.factions = res.factions; this.uiManager.updateFactions(this.factions) }
            overlay.remove()
          } else this.uiManager.showError(res.error)
        } else {
          if (buys.length < 1 || sells.length < 1) { tradeWarn.textContent = 'Select at least one resource to buy and one to sell.'; return }
          const resourceDefs = [...buys, ...sells].filter(r => r.isNew)
          const res = await GameAPI.addForeignPowerTrade({ fpId: fp.id, name, description, buys: buys.map(r => r.name), sells: sells.map(r => r.name), resourceDefs })
          if (res.ok) {
            if (res.tradingDestinations) { this.tradingDestinations = res.tradingDestinations; this.renderer.renderTrades(this.tradingDestinations, this.renderer.terrainData) }
            if (res.factions) { this.factions = res.factions; this.uiManager.updateFactions(this.factions) }
            if (res.resourceRegistry) this.resourceRegistry = res.resourceRegistry
            if (res.resourceDefinitions) this.resourceDefinitions = res.resourceDefinitions
            overlay.remove()
          } else this.uiManager.showError(res.error)
        }
      } catch (e) { this.uiManager.showError(e.message) }
    })
    box.appendChild(applyBtn)

    overlay.appendChild(box)
    document.body.appendChild(overlay)
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
      // "Home" (see CameraController.centerOnMap) always targets the city centre,
      // restored state or not. The actual current camera position/zoom/mode only get
      // the default city-centre framing if there's no saved state from a previous
      // session to restore instead.
      this.renderer.setHomePosition(sp.x, sp.y)
      if (!this.renderer.restoreCameraState()) this.renderer.centerOnMap()
    }
  }

  async startSetup() {
    try {
      const response = await GameAPI.setupInit()
      if (response.ok) {
        this.gameState = response
        this.currentPhase = 'Terrain'
        this.selectedRegionId = null
        this.pendingTerrainType = null
        this.selectedEdgeIds.clear()
        this.pendingEdgeType = null
        this.selectedTerrainRegionId = null
        this.selectedTerrainPlotId = null
        this.pendingTerrainAction = null
        this.selectedDistrictId = null
        this.pendingDistrictType = null
        this.pendingResidentialClass = null
        this.pendingLeadershipClass = 'Monarchy'
        this.selectedCityEdgeIds.clear()
        this.pendingCityEdgeType = null
        this._refreshTerrainPanel()
        this._refreshDistrictPanel()
        this.resourceRegistry = []
        this.resourceDefinitions = {}
        this.threats = []
        this.tradingDestinations = []
        this.factions = []
        this.guilds = []
        this.uiManager.guildPanel?.reset()
        this.uiManager.updateResources([])
        this.uiManager.updateFactions([])
        this.renderer.clearStreetLayer()
        this.renderer.clearDerivedLayers()
        this.renderer.clearAllDebugObjects()
        this.renderer.setCityDistrictData([])
        this.renderer.setMode('terrain')
        this.renderer.guildSetupActive = false
        this.renderer.setCityEdgesHidden(false)
        this.renderer.setTerrainData(response.regions, response.edges || {}, response.terrainPlots || [], response.edgePoints || [], new Map((response.pointRegistry || []).map(p => [p.id, p])), response.riverCliffFaces || [])
        this.inputHandler.setTerrainData(response)
        this.uiManager.showSetupPhase('Terrain')
        // New Game: discard any saved camera view from the previous game first, so
        // _focusCameraOnCity's restoreCameraState() finds nothing and falls through to
        // centerOnMap()'s default (iso mode, North at top) instead of resurrecting
        // wherever the camera was left in the game just discarded.
        this.renderer.clearSavedCameraState()
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
