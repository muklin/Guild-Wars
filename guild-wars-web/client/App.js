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
    this.eventBus.on('CITY_EDGE_TYPE_PREVIEW',(t)    => this._handleCityEdgePreview(t))
    this.eventBus.on('CITY_EDGE_APPLY',       (data) => this._handleCityEdgeApply(data))

    this.eventBus.on('TERRAIN_ACTION_SELECT', ({ action }) => {
      if (action === 'Threat') {
        const dialog = new NameDialog({
          entityKind: 'threat', entityLabel: 'Threat', subType: 'Threat',
          onApply: (name, description) => {
            this.eventBus.emit('TERRAIN_THREAT_APPLY', { name, description })
          },
          onCancel: () => {}
        })
        dialog.open()
        return
      }
      this.pendingTerrainAction = action
      this._refreshDistrictPanel()
    })

    this.eventBus.on('TERRAIN_ACTION_BACK', () => {
      this.pendingTerrainAction = null
      this._refreshDistrictPanel()
    })

    this.eventBus.on('TERRAIN_TRADE_APPLY', async ({ name, description, buys, sells }) => {
      const regionId = this.selectedTerrainRegionId
      if (!regionId) return
      try {
        const response = await GameAPI.addTrade(regionId, description, name, buys, sells)
        if (response.ok) {
          this.tradingDestinations = response.tradingDestinations
          if (response.resourceRegistry) { this.resourceRegistry = response.resourceRegistry; this.uiManager.updateResources(this.resourceRegistry) }
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
          this.uiManager.updateThreats(this.threats)
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

        // Resolve the rendered terrain plot for this raw plot
        const terrainPlot = this.renderer.getTerrainPlotBySourceId(rawPlot.id)
        const plotId = terrainPlot?.id ?? null
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

    this.eventBus.on('TERRAIN_DISTRICT_ASSIGN', async ({ regionId, plotId, districtType, description, producedResource, consumedResources, name, resourceDefs }) => {
      await this._handleTerrainDistrictAssign(regionId, plotId, districtType, description, producedResource, consumedResources, name, resourceDefs)
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
            guild: res.guild, factions: this.factions,
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
      const entered = this.renderer.toggleWalkMode(() => this.uiManager.setWalkMode(false))
      if (entered) this.uiManager.setWalkMode(true)
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
        onApply: async ({ domains, name, description, worldDomains }) => {
          try {
            const res = await GameAPI.createGod({ domains, name, description, worldDomains })
            if (!res.ok) this.uiManager.showError(res.error || 'Failed to add God')
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
  _renderCityGeometry(cityData) {
    if (!cityData) return
    this.renderer.setCityDistrictData(cityData)
    this.renderer.renderStreetGraph(cityData.streetGraph)
    this.renderer.renderGutters(cityData.streetGraph)
    this.renderer.renderBlocks(cityData.blocks)
    this.renderer.renderPlots(cityData.plots, cityData)
    this.renderer.drawBlockCenters(cityData.blocks)
    this.renderer.drawPlotCenters(cityData.plots || [])
    this.renderer.drawStreetSeeds(cityData.streetGraph)
  }

  // ── Terrain region ──────────────────────────────────────────────────────────

  _handleRegionClick(regionId) {
    const region = this.renderer.terrainData?.regions?.find(r => r.id === regionId)
    if (!region) return

    if (this.currentPhase === 'CitySubdivision') {
      const DISTRICT_FOR = { Forest: 'Forestry', Hills: 'Mining', Plains: 'Agriculture', Lake: 'Fishing', Sea: 'Fishing' }
      const canDistrict = !!DISTRICT_FOR[region.assignedType]
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

  async _doFinishSubdivision() {
    try {
      const response = await GameAPI.finishSubdivision()
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
          guild: myGuild, factions: this.factions,
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
        return 'Endpoints must connect to a River, Sea, Lake, Ice Sheet, or the map edge'
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

      // Sea, Lake, or Ice Sheet adjacent to this point
      if (rA?.assignedType === 'Sea'       || rB?.assignedType === 'Sea')       return true
      if (rA?.assignedType === 'Lake'      || rB?.assignedType === 'Lake')      return true
      if (rA?.assignedType === 'Ice Sheet' || rB?.assignedType === 'Ice Sheet') return true
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

    if (district.locked) { this._refreshDistrictPanel(); return }   // locked districts are final

    this._clearCityEdgeSelection()
    this.selectedDistrictId = districtId
    this.pendingDistrictType = district.isLeadershipDistrict ? 'Leadership' : null
    this.pendingResidentialClass = null
    this.pendingLeadershipClass = 'Monarchy'
    this.renderer.selectDistrict(districtId)
    this._refreshDistrictPanel()
    // The Leadership district has its type fixed on selection — generate its preview
    // streets immediately (defaults to a Monarchy until a ruling body is chosen).
    if (this.pendingDistrictType) this._previewDistrictStreets()
  }

  // Discard the selected district if it was previewed but never applied, returning it
  // to a blank district polygon (clears its streets too). Locked districts are final.
  _revertProvisionalDistrict(id = this.selectedDistrictId) {
    if (id === null || id === undefined) return
    const d = this.renderer.cityDistrictData?.districts?.find(x => x.id === id)
    if (!d || !d.assignedType || d.locked) return
    d.assignedType = null; d.residentialClass = null; d.LeadershipClass = null
    d.producedResource = null; d.consumedResources = []; d.streetSeed = null; d.description = ''
    this.renderer.updateDistrictColor(id, null)
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

  async _handleTerrainDistrictAssign(regionId, plotId, districtType, description = '', producedResource = '', consumedResources = [], name = '', resourceDefs = []) {
    try {
      const response = await GameAPI.assignTerrainDistrict(regionId, plotId, districtType, description, producedResource, consumedResources, name, resourceDefs)
      if (response.ok) {
        this.renderer.deselectRegion(regionId)
        this.renderer.clearTerrainPlotSelected()
        this.selectedTerrainRegionId = null
        this.selectedTerrainPlotId = null
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
    this.pendingLeadershipClass = 'Monarchy'
    this.renderer.previewDistrictType(this.selectedDistrictId, districtType)
    this._refreshDistrictPanel()
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
  async _handleDistrictApply({ name, description, producedResource, secondProducedResource, consumedResources, residentialClass, LeadershipClass, resourceDefs = [] }) {
    if (this.selectedDistrictId === null || !this.pendingDistrictType) return
    const districtId = this.selectedDistrictId
    const districtType = this.pendingDistrictType
    try {
      const response = await GameAPI.assignDistrictType(districtId, districtType, description, producedResource, consumedResources, residentialClass, LeadershipClass, secondProducedResource, name, resourceDefs)
      if (response.ok) {
        const district = this.renderer.cityDistrictData?.districts?.find(d => d.id === districtId)
        if (district) {
          district.assignedType = districtType
          district.name = name || ''
          district.residentialClass = residentialClass || null
          district.LeadershipClass = LeadershipClass || null
          district.description = description
          district.producedResource = producedResource || null
          district.consumedResources = consumedResources || []
          district.locked = true
        }
        if (response.resourceRegistry) {
          this.resourceRegistry = response.resourceRegistry
          this.uiManager.updateResources(this.resourceRegistry)
        }
        if (response.factions) { this.factions = response.factions; this.uiManager.updateFactions(this.factions) }
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
      if (response.ok) this._renderCityGeometry(response.cityDistrictData)
      else this.uiManager.showError(response.error)
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
    if (this.selectedTerrainRegionId !== null) {
      const region = this.renderer.terrainData?.regions?.find(r => r.id === this.selectedTerrainRegionId)
      if (region?.vertices?.length) panel.setAnchorPoints(region.vertices)
      else if (region?.seedPoint) panel.setAnchorPoints([{ x: region.seedPoint.x, y: region.seedPoint.y }])
      const plotId = this.selectedTerrainPlotId ?? null
      const hasDistrict = plotId ? (this.factions || []).some(f => f.type === 'terrain' && f.plotId === plotId) : false
      panel.showContext('terrainRegion', {
        regionType: region?.assignedType,
        isEdge: region?.isEdge ?? false,
        hasDistrict,
        pendingAction: this.pendingTerrainAction,
        regionId: this.selectedTerrainRegionId,
        plotId,
        resourceRegistry: this.resourceRegistry,
        usedProducedResources: this._getUsedProducedResources(),
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
        usedProducedResources: this._getUsedProducedResources(),
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
    this.renderer.setTerrainData(
      regions,
      state.worldTerrainData.edges || {},
      state.worldTerrainData.terrainPlots || [],
      state.worldTerrainData.edgePoints || []
    )

    const cityData = state.cityDistrictData
    if (setupStep !== 'Terrain' && cityData?.districts?.length > 0) {
      // Past District Setup → finished grassy-brown ground + hide the City-Edge overlay
      // (the flag makes every renderCityEdges call a no-op, in all render paths).
      const guildPhase = setupStep === 'GuildCreation' || setupStep === 'Complete'
      this.renderer.setCityEdgesHidden(guildPhase)
      this._finalizeTerrainDisplay()
      this.renderer.setCityDistrictData(cityData)
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
    document.querySelector('.fp-stance-popup')?.remove()

    const popup = document.createElement('div')
    popup.className = 'fp-stance-popup'
    popup.style.cssText = [
      'position:fixed', 'z-index:300', 'background:#1a1a1a',
      'border:1px solid #555', 'border-radius:8px', 'padding:14px 18px',
      'font-family:Arial', 'color:#fff', 'width:220px',
      'box-shadow:0 6px 24px rgba(0,0,0,0.8)',
    ].join(';')
    popup.addEventListener('mousedown', e => e.stopPropagation())
    popup.addEventListener('click', e => e.stopPropagation())

    const title = document.createElement('div')
    title.style.cssText = `font-size:13px;font-weight:bold;color:${fp.colour || '#fff'};margin-bottom:4px`
    title.textContent = fp.name
    popup.appendChild(title)

    const sub = document.createElement('div')
    sub.style.cssText = 'font-size:11px;color:#888;margin-bottom:12px'
    sub.textContent = 'Foreign Power'
    popup.appendChild(sub)

    const mkBtn = (label, handler, disabled = false) => {
      const b = document.createElement('button')
      b.textContent = label
      b.style.cssText = [
        'display:block;width:100%;text-align:left;padding:7px 10px',
        'margin-bottom:6px;border-radius:5px;font-size:12px;font-family:Arial',
        disabled ? 'background:#222;border:1px solid #333;color:#555;cursor:not-allowed'
                 : 'background:#2a2a2a;border:1px solid #555;color:#ccc;cursor:pointer',
      ].join(';')
      if (!disabled) b.addEventListener('click', handler)
      return b
    }

    popup.appendChild(mkBtn('Declare as Threat', () => {
      popup.remove()
      const dialog = new NameDialog({
        entityKind: 'threat', entityLabel: fp.name, subType: 'Threat',
        onApply: async (name, description) => {
          try {
            const res = await GameAPI.addForeignPowerThreat({ fpId: fp.id, name, description })
            if (res.ok) {
              if (res.threats) this.threats = res.threats
              if (res.factions) { this.factions = res.factions; this.uiManager.updateFactions(this.factions) }
            } else { this.uiManager.showError(res.error) }
          } catch (e) { this.uiManager.showError(e.message) }
        },
        onCancel: () => {}
      })
      dialog.open()
    }))

    popup.appendChild(mkBtn('Define Trade Route ↗', () => {
      popup.remove()
      const dialog = new NameDialog({
        entityKind: 'trade', entityLabel: fp.name, subType: 'Trade',
        onApply: async (name, description) => {
          try {
            const res = await GameAPI.addForeignPowerTrade({ fpId: fp.id, name, description })
            if (res.ok) {
              if (res.tradingDestinations) { this.tradingDestinations = res.tradingDestinations; this.renderer.renderTrades(this.tradingDestinations, this.renderer.terrainData) }
              if (res.factions) { this.factions = res.factions; this.uiManager.updateFactions(this.factions) }
            } else { this.uiManager.showError(res.error) }
          } catch (e) { this.uiManager.showError(e.message) }
        },
        onCancel: () => {}
      })
      dialog.open()
    }))

    const closeBtn = document.createElement('button')
    closeBtn.textContent = 'Cancel'
    closeBtn.style.cssText = 'background:none;border:none;color:#666;font-size:11px;cursor:pointer;padding:0;font-family:Arial'
    closeBtn.addEventListener('click', () => popup.remove())
    popup.appendChild(closeBtn)

    // Position near the anchor label
    document.body.appendChild(popup)
    const rect = anchorEl.getBoundingClientRect()
    const ph = popup.offsetHeight || 140, pw = popup.offsetWidth || 220
    const left = Math.min(rect.right + 8, window.innerWidth - pw - 8)
    const top  = Math.max(8, Math.min(rect.top, window.innerHeight - ph - 8))
    popup.style.left = left + 'px'
    popup.style.top  = top  + 'px'

    document.addEventListener('click', function dismiss(e) {
      if (!popup.contains(e.target) && e.target !== anchorEl) { popup.remove(); document.removeEventListener('click', dismiss) }
    }, { capture: true, once: false })
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
      if (!this.renderer.restoreCameraState()) this.renderer.focusCameraOn(sp.x, sp.y)
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
        this.threats = []
        this.tradingDestinations = []
        this.factions = []
        this.guilds = []
        this.uiManager.guildPanel?.reset()
        this.uiManager.updateResources([])
        this.uiManager.updateFactions([])
        this.uiManager.updateThreats([])
        this.renderer.clearStreetLayer()
        this.renderer.clearDerivedLayers()
        this.renderer.clearAllDebugObjects()
        this.renderer.setCityDistrictData([])
        this.renderer.setMode('terrain')
        this.renderer.guildSetupActive = false
        this.renderer.setCityEdgesHidden(false)
        this.renderer.setTerrainData(response.regions, response.edges || {}, response.terrainPlots || [], response.edgePoints || [])
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
