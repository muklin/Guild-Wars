import config from '../config.js'

export default class GameAPI {
  static async request(endpoint, method = 'GET', body = null) {
    try {
      const headers = {}
      if (config.seatKey) headers['X-Seat-Key'] = config.seatKey
      const options = { method, headers }
      if (body) {
        headers['Content-Type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      const response = await fetch(`${config.apiBase}/api${endpoint}`, options)
      const data = await response.json()
      return data
    } catch (error) {
      console.error(`API request failed: ${endpoint}`, error)
      throw error
    }
  }

  // Join a game at the configured server, claiming a seat under `name`.
  // Returns the join payload ({ seatKey, seatId, state }); caller persists the key.
  static async join(name) {
    return this.request('/join', 'POST', { name })
  }

  static async getState() {
    return this.request('/state')
  }

  static async setupInit() {
    return this.request('/setup/init', 'POST')
  }

  static async assignTerrain(regionId, terrainType, description = '', name = '') {
    return this.request('/setup/terrain/assign', 'POST', { regionId, terrainType, description, name })
  }

  static async assignEdge(edgeId, edgeType, description = '', name = '') {
    return this.request('/setup/terrain/edge', 'POST', { edgeId, edgeType, description, name })
  }

  static async finishTerrain() {
    return this.request('/setup/terrain/done', 'POST')
  }

  static async addThreat(regionId, description = '', name = '') {
    return this.request('/setup/threat', 'POST', { regionId, description, name })
  }

  static async addTrade(regionId, description = '', name = '', buys = [], sells = []) {
    return this.request('/setup/trade', 'POST', { regionId, description, name, buys, sells })
  }

  static async assignDistrictType(districtId, districtType, description = '', producedResource = '', consumedResources = [], residentialClass = null, LeadershipClass = null, secondProducedResource = '', name = '') {
    return this.request('/setup/city/assign', 'POST', { districtId, districtType, description, name, producedResource, secondProducedResource, consumedResources, residentialClass, LeadershipClass })
  }

  static async assignTerrainDistrict(regionId, districtType, description = '', producedResource = '', consumedResources = [], name = '') {
    return this.request('/setup/terrain-district', 'POST', { regionId, districtType, description, name, producedResource, consumedResources })
  }

  static async assignCityEdge(edgeId, edgeType, description = '', name = '') {
    return this.request('/setup/city/edge', 'POST', { edgeId, edgeType, description, name })
  }

  static async previewDistrictType(districtId, districtType, residentialClass = null, LeadershipClass = null) {
    return this.request('/setup/city/preview', 'POST', { districtId, districtType, residentialClass, LeadershipClass })
  }

  static async regenerateDistrict(districtId) {
    return this.request('/setup/city/regenerate', 'POST', { districtId })
  }

  static async revertDistrict(districtId) {
    return this.request('/setup/city/revert', 'POST', { districtId })
  }

  static async finishSubdivision() {
    return this.request('/setup/subdivision/done', 'POST')
  }

  // Create the player's guild. headquarters = { kind:'plot'|'landmark', refId } | null.
  static async createGuild({ guildName, headquarters }) {
    return this.request('/setup/guild', 'POST', { guildName, headquarters })
  }

  static async setGuildHeadquarters(hq) {
    return this.request('/setup/guild/headquarters', 'POST', { hq })
  }

  static async renameGuild(name) {
    return this.request('/setup/guild/rename', 'POST', { name })
  }

  static async levelUpCharacter(charId, classChoice = null) {
    return this.request('/setup/guild/character/levelup', 'POST', { charId, classChoice })
  }

  static async changeCharacterRole(charId, role) {
    return this.request('/setup/guild/character/role', 'POST', { charId, role })
  }

  static async purchaseGuildTrait(traitId) {
    return this.request('/setup/guild/trait', 'POST', { traitId })
  }

  static async purchaseHQUpgrade(upgradeId) {
    return this.request('/setup/guild/hq-upgrade', 'POST', { upgradeId })
  }

}
