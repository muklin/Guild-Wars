import GroundPointRegistry from './CityGenerator/GroundPointRegistry.js'

export default class GameStateManager {
  constructor() {
    this.guilds = new Map()
    this.districts = new Map()
    this.factions = new Map()
    this.threats = []
    this.tradingDestinations = []

    this.currentRound = 1
    this.currentPhase = 'Setup'
    this.cityLeader = null
    this.successionMethod = null

    // The unified Groundplane — the single container for all ground geometry (see
    // ADR-0020, plan "typed-giggling-giraffe" Addendum 2). `points` is the ONE point
    // registry (the only positional store); `terrain` and `city` are the current
    // terrain-scale and city-scale collections, converging toward the target
    // {points, surfaces, regions, edges} shape across migration Stages A–D.
    // worldTerrainData/cityDistrictData/pointRegistry remain as accessor aliases below
    // so the hundreds of existing call sites (server + client snapshot consumers) keep
    // working unchanged during the migration.
    this.groundplane = {
      points: new GroundPointRegistry(),
      terrain: {
        worldSize: 50,
        regions: [],
        edges: []
      },
      city: {
        districts: [],
        blocks: [],
        plots: []
      },
      // Canonical Surface records (ADR-0020: a Surface is a single typed groundplane
      // cell, an ordered Point-id list). Assembled by
      // SetupPhase._syncGroundplaneSurfaces as a synced view over the current
      // terrain-plot and river/cliff-face collections; Stage C makes generators
      // produce these natively.
      surfaces: [],
      // Canonical Region records (ADR-0020: a Region is a typed group of Surfaces).
      // Occupants: linear features (River/Cliff — Edge→Region conversion, storing
      // centrelinePointIds as the reversal anchor per decision 5), terrain regions,
      // and districts (gameplay payload lives here). Rebuilt wholesale on every
      // pullback pass, so cleared features vanish naturally.
      regions: [],
      // The map's outer ring of edges (plan "typed-gliding-leaf" hole-audit design,
      // user-specified): computed ONCE, right after a hole-free New Game generation
      // (SetupPhase._generateWorldWithHoleCheck), then permanently exempt from HOLE
      // findings for the rest of the game — every subsequent audit
      // (_auditAndLogGroundplane) reads this same set. Array of `edgeKey(id,id)`
      // strings (see auditGroundplane.js); 'terrain' point ids are durable, so these
      // stay valid for the life of the save.
      outerRingEdgeKeys: [],
    }

    // Per-building persistent data keyed by `${kind}:${refId}` (e.g. "plot:plot-5").
    // Upgrades live here so they stay with the building when a guild vacates.
    this.buildingData = {}

    // Track next auto-IDs
    this.nextFactionAutoId = 100
  }

  // ── Groundplane accessor aliases (migration-period compatibility, ADR-0020) ──
  // Getter/setter pairs rather than plain fields so wholesale reassignment at any
  // call site (e.g. SetupPhase's `worldTerrainData = worldData`, clear(), load)
  // updates the ONE canonical groundplane container instead of silently detaching
  // an alias from it.
  get pointRegistry() { return this.groundplane.points }
  set pointRegistry(v) { this.groundplane.points = v }
  get worldTerrainData() { return this.groundplane.terrain }
  set worldTerrainData(v) { this.groundplane.terrain = v }
  get cityDistrictData() { return this.groundplane.city }
  set cityDistrictData(v) { this.groundplane.city = v }

  // Guild management
  addGuild(guild) {
    this.guilds.set(guild.id, guild)
    return guild
  }

  getGuild(guildId) {
    return this.guilds.get(guildId)
  }

  getAllGuilds() {
    return Array.from(this.guilds.values())
  }

  // District management
  addDistrict(district) {
    this.districts.set(district.id, district)
    return district
  }

  getDistrict(districtId) {
    return this.districts.get(districtId)
  }

  getAllDistricts() {
    return Array.from(this.districts.values())
  }

  // Faction management
  addFaction(faction) {
    if (!faction.id) {
      faction.id = this.nextFactionAutoId++
    }
    this.factions.set(faction.id, faction)
    return faction
  }

  getFaction(factionId) {
    return this.factions.get(factionId)
  }

  getAllFactions() {
    return Array.from(this.factions.values())
  }

  // Threat management
  addThreat(threat) {
    this.threats.push(threat)
    return threat
  }

  // Trading destination management
  addTradingDestination(destination) {
    this.tradingDestinations.push(destination)
    return destination
  }

  // Get full state snapshot for client
  getStateSnapshot() {
    return {
      guilds: Array.from(this.guilds.values()),
      districts: Array.from(this.districts.values()),
      factions: Array.from(this.factions.values()),
      threats: this.threats,
      tradingDestinations: this.tradingDestinations,
      currentRound: this.currentRound,
      currentPhase: this.currentPhase,
      pointRegistry: this.pointRegistry.toJSON(),
      worldTerrainData: this.worldTerrainData,
      cityDistrictData: this.cityDistrictData
    }
  }

  // Serialize for save/load
  serialize() {
    return {
      guilds: Array.from(this.guilds.values()),
      districts: Array.from(this.districts.values()),
      factions: Array.from(this.factions.values()),
      threats: this.threats,
      tradingDestinations: this.tradingDestinations,
      currentRound: this.currentRound,
      currentPhase: this.currentPhase,
      cityLeader: this.cityLeader,
      successionMethod: this.successionMethod,
      // The unified Groundplane container (ADR-0020) — replaces the former top-level
      // pointRegistry/worldTerrainData/cityDistrictData keys. deserialize() still
      // reads the old keys for pre-migration saves.
      groundplane: {
        points: this.groundplane.points.toJSON(),
        terrain: this.groundplane.terrain,
        city: this.groundplane.city ? {
          ...this.groundplane.city,
          plots: undefined   // re-derived on load via regeneratePlots(); not saved
        } : this.groundplane.city,
        surfaces: this.groundplane.surfaces,
        regions: this.groundplane.regions,
        outerRingEdgeKeys: this.groundplane.outerRingEdgeKeys,
      },
      buildingData: this.buildingData,
      nextFactionAutoId: this.nextFactionAutoId
    }
  }

  deserialize(data) {
    // New saves nest all ground geometry under `groundplane` (ADR-0020); older saves
    // carry the three legacy top-level keys. Accept both.
    const gp = data.groundplane
    // Reconstruct the point registry before anything that references it by id.
    this.pointRegistry = new GroundPointRegistry((gp ? gp.points : data.pointRegistry) || [])
    if (data.guilds) {
      data.guilds.forEach(g => this.addGuild(g))
    }
    if (data.districts) {
      data.districts.forEach(d => this.addDistrict(d))
    }
    if (data.factions) {
      data.factions.forEach(f => this.addFaction(f))
    }
    if (data.threats) {
      this.threats = data.threats
    }
    if (data.tradingDestinations) {
      this.tradingDestinations = data.tradingDestinations
    }
    this.currentRound = data.currentRound || 1
    this.currentPhase = data.currentPhase || 'Setup'
    this.cityLeader = data.cityLeader
    this.successionMethod = data.successionMethod
    this.worldTerrainData = (gp ? gp.terrain : data.worldTerrainData) || this.worldTerrainData
    this.cityDistrictData = (gp ? gp.city : data.cityDistrictData) || this.cityDistrictData
    this.groundplane.surfaces = gp?.surfaces || []
    this.groundplane.regions = gp?.regions || []
    this.groundplane.outerRingEdgeKeys = gp?.outerRingEdgeKeys || []
    if (data.buildingData) this.buildingData = data.buildingData
    if (data.nextFactionAutoId) {
      this.nextFactionAutoId = data.nextFactionAutoId
    } else {
      const ids = Array.from(this.factions.keys())
      this.nextFactionAutoId = ids.length > 0 ? Math.max(...ids) + 1 : 100
    }
  }

  clear() {
    this.guilds.clear()
    this.districts.clear()
    this.factions.clear()
    this.threats = []
    this.tradingDestinations = []
    this.buildingData = {}
    this.currentRound = 1
    this.currentPhase = 'Setup'
    this.cityLeader = null
    this.successionMethod = null
    this.pointRegistry = new GroundPointRegistry()
    this.worldTerrainData = {
      worldSize: 50,
      regions: [],
      edges: []
    }
    this.cityDistrictData = {
      districts: [],
      blocks: [],
      plots: []
    }
    this.groundplane.surfaces = []
    this.groundplane.regions = []
    this.groundplane.outerRingEdgeKeys = []
    this.nextFactionAutoId = 100
  }
}
