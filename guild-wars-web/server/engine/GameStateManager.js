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

    // Hierarchical terrain data
    this.worldTerrainData = {
      worldSize: 50,
      regions: [],
      edges: []
    }

    this.cityDistrictData = {
      districts: []
    }

    this.buildingData = {
      buildings: []
    }

    // Track next auto-IDs
    this.nextFactionAutoId = 100
  }

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
      worldTerrainData: this.worldTerrainData,
      cityDistrictData: this.cityDistrictData,
      buildingData: this.buildingData,
      nextFactionAutoId: this.nextFactionAutoId
    }
  }

  deserialize(data) {
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
    this.worldTerrainData = data.worldTerrainData || this.worldTerrainData
    this.cityDistrictData = data.cityDistrictData || this.cityDistrictData
    this.buildingData = data.buildingData || this.buildingData
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
    this.currentRound = 1
    this.currentPhase = 'Setup'
    this.cityLeader = null
    this.successionMethod = null
    this.worldTerrainData = {
      worldSize: 50,
      regions: [],
      edges: []
    }
    this.cityDistrictData = {
      districts: []
    }
    this.buildingData = {
      buildings: []
    }
    this.nextFactionAutoId = 100
  }
}
