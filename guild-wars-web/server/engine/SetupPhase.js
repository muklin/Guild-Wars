import MergedVoronoiGenerator from './voronoi/MergedVoronoiGenerator.js'
import CityVoronoiGenerator from './voronoi/CityVoronoiGenerator.js'

export default class SetupPhase {
  constructor(gameStateManager) {
    this.gameStateManager = gameStateManager
    this.currentStep = 'Terrain'
    this.log = []
    this.worldGenerator = null
    this.cityGenerator = null
    this.selectedRegionId = null
    this.selectedDistrictId = null
    this.terrainPlacements = []
    this.districtClassAssignments = new Map()
  }

  initialize() {
    this.log = []
    this.log.push('Initializing Setup Phase...')

    // Generate world terrain using merged Voronoi for better geometry
    this.worldGenerator = new MergedVoronoiGenerator()
    const worldData = this.worldGenerator.generate(15, 50)
    this.gameStateManager.worldTerrainData = worldData
    this.log.push(`Generated ${worldData.regions.length} terrain regions`)

    // Find city region (largest central region)
    const cityRegion = this.findCityRegion(worldData.regions)
    if (cityRegion) {
      cityRegion.assignedType = 'City'
      this.log.push(`Identified city region: Region ${cityRegion.id}`)

      // Generate city districts
      this.cityGenerator = new CityVoronoiGenerator()
      const cityData = this.cityGenerator.generate(cityRegion.polygon, 6)
      this.gameStateManager.cityDistrictData = cityData
      this.log.push(`Subdivided city into ${cityData.districts.length} districts`)
    }

    this.currentStep = 'Terrain'
    return {
      step: this.currentStep,
      regions: worldData.regions,
      edges: worldData.edges,
      log: this.log
    }
  }

  findCityRegion(regions) {
    // Find largest central (non-boundary) region
    const centralRegions = regions.filter(r => !this.touchesBoundary(r, 50))
    if (centralRegions.length === 0) {
      return regions.reduce((a, b) => a.polygon.length > b.polygon.length ? a : b)
    }
    return centralRegions.reduce((a, b) => a.polygon.length > b.polygon.length ? a : b)
  }

  touchesBoundary(region, worldSize) {
    const margin = 0.5
    return region.polygon.some(v =>
      v.x < margin || v.x > (worldSize - margin) ||
      v.z < margin || v.z > (worldSize - margin)
    )
  }

  assignTerrainToRegion(regionId, terrainType) {
    const region = this.gameStateManager.worldTerrainData.regions.find(r => r.id === regionId)
    if (!region) {
      throw new Error(`Region ${regionId} not found`)
    }

    if (region.assignedType) {
      throw new Error(`Region ${regionId} is already assigned ${region.assignedType}`)
    }

    region.assignedType = terrainType
    this.terrainPlacements.push({ regionId, terrainType })
    this.log.push(`Assigned ${terrainType} to region ${regionId}`)

    return {
      ok: true,
      log: this.log
    }
  }

  finishTerrain() {
    this.currentStep = 'CitySubdivision'
    this.log.push('Terrain placement complete. Moving to city subdivision.')
    return {
      ok: true,
      log: this.log
    }
  }

  assignDistrictClass(districtId, districtClass) {
    const district = this.gameStateManager.cityDistrictData.districts.find(d => d.id === districtId)
    if (!district) {
      throw new Error(`District ${districtId} not found`)
    }

    district.class = districtClass
    this.districtClassAssignments.set(districtId, districtClass)
    this.log.push(`Assigned ${districtClass} class to district ${districtId}`)

    return {
      ok: true,
      log: this.log
    }
  }

  finishSubdivision() {
    this.currentStep = 'DistrictSetup'
    this.log.push('City subdivision complete. Moving to district setup.')
    return {
      ok: true,
      log: this.log
    }
  }

  createPlayerGuild(guildName, leaderName, leaderClass, secondName, secondClass) {
    if (!guildName || !leaderName) {
      throw new Error('Guild name and leader name are required')
    }

    this.log.push(`Created guild: ${guildName}`)
    this.log.push(`  Leader: ${leaderName} (${leaderClass})`)
    this.log.push(`  Second: ${secondName} (${secondClass})`)

    this.currentStep = 'Complete'
    return {
      ok: true,
      log: this.log
    }
  }

  getLog() {
    return this.log
  }

  reset() {
    this.currentStep = 'Terrain'
    this.log = []
    this.selectedRegionId = null
    this.selectedDistrictId = null
    this.terrainPlacements = []
    this.districtClassAssignments.clear()
  }
}
