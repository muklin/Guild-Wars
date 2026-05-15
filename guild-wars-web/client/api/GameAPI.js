export default class GameAPI {
  static async request(endpoint, method = 'GET', body = null) {
    try {
      const options = { method }
      if (body) {
        options.headers = { 'Content-Type': 'application/json' }
        options.body = JSON.stringify(body)
      }
      const response = await fetch(`/api${endpoint}`, options)
      const data = await response.json()
      return data
    } catch (error) {
      console.error(`API request failed: ${endpoint}`, error)
      throw error
    }
  }

  static async getState() {
    return this.request('/state')
  }

  static async setupInit() {
    return this.request('/setup/init', 'POST')
  }

  static async assignTerrain(regionId, terrainType, description = '') {
    return this.request('/setup/terrain/assign', 'POST', { regionId, terrainType, description })
  }

  static async assignEdge(edgeId, edgeType, description = '') {
    return this.request('/setup/terrain/edge', 'POST', { edgeId, edgeType, description })
  }

  static async finishTerrain() {
    return this.request('/setup/terrain/done', 'POST')
  }

  static async addThreat(regionId, description = '', name = '') {
    return this.request('/setup/threat', 'POST', { regionId, description, name })
  }

  static async addTrade(regionId, description = '') {
    return this.request('/setup/trade', 'POST', { regionId, description })
  }

  static async assignDistrictClass(districtId, districtClass) {
    return this.request('/setup/subdivision/assign', 'POST', { districtId, districtClass })
  }

  static async assignDistrictType(districtId, districtType, description = '', producedResource = '', consumedResources = [], residentialClass = null, LeadershipClass = null) {
    return this.request('/setup/city/assign', 'POST', { districtId, districtType, description, producedResource, consumedResources, residentialClass, LeadershipClass })
  }

  static async assignTerrainDistrict(regionId, districtType, description = '', producedResource = '', consumedResources = []) {
    return this.request('/setup/terrain-district', 'POST', { regionId, districtType, description, producedResource, consumedResources })
  }

  static async assignCityEdge(edgeId, edgeType, description = '') {
    return this.request('/setup/city/edge', 'POST', { edgeId, edgeType, description })
  }

  static async finishSubdivision() {
    return this.request('/setup/subdivision/done', 'POST')
  }

  static async finishStreetSetup() {
    return this.request('/setup/streetsetup/done', 'POST')
  }

  static async placeDistrict(formData) {
    return this.request('/setup/district', 'POST', formData)
  }

  static async passDistrictTurn() {
    return this.request('/setup/district/pass', 'POST')
  }

  static async placeHQ(districtId) {
    return this.request('/setup/hq', 'POST', { districtId })
  }

  static async createGuild(guildData) {
    return this.request('/setup/guild', 'POST', guildData)
  }

  static async submitAction(actionData) {
    return this.request('/action', 'POST', actionData)
  }

  static async finishPlanning() {
    return this.request('/planning/done', 'POST')
  }

  static async getPhaseInfo() {
    return this.request('/phase')
  }
}
