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
    this.edgePlacements = []
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
    const cityRegion = this.findCityRegion(worldData.regions, worldData.fineCells)
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
      fineCells: worldData.fineCells,
      edges: worldData.edges,
      edgePoints: worldData.edgePoints,
      log: this.log
    }
  }

  findCityRegion(regions, fineCells) {
    // Count fine cells per merged region — more cells = larger territory
    const fineCellCount = new Map()
    if (fineCells) {
      for (const cell of fineCells) {
        fineCellCount.set(cell.parentRegionId, (fineCellCount.get(cell.parentRegionId) || 0) + 1)
      }
    }
    const centralRegions = regions.filter(r => !this.touchesBoundary(r, 50, fineCells))
    const pool = centralRegions.length > 0 ? centralRegions : regions
    if (fineCellCount.size > 0) {
      return pool.reduce((a, b) =>
        (fineCellCount.get(a.id) || 0) >= (fineCellCount.get(b.id) || 0) ? a : b
      )
    }
    // Fallback for old saves without fine cells
    return pool.reduce((a, b) => a.polygon.length > b.polygon.length ? a : b)
  }

  touchesBoundary(region, worldSize, fineCells) {
    if (fineCells) {
      const regionCells = fineCells.filter(c => c.parentRegionId === region.id)
      if (regionCells.length > 0) {
        const margin = worldSize * 0.1  // 10% of world size
        return regionCells.some(c =>
          c.seedPoint.x < margin || c.seedPoint.x > worldSize - margin ||
          c.seedPoint.y < margin || c.seedPoint.y > worldSize - margin
        )
      }
    }
    // Fallback for old saves without fine cells
    const margin = 0.5
    return region.polygon.some(v =>
      v.x < margin || v.x > (worldSize - margin) ||
      v.y < margin || v.y > (worldSize - margin)
    )
  }

  assignTerrainToRegion(regionId, terrainType, description = '') {
    const region = this.gameStateManager.worldTerrainData.regions.find(r => r.id === regionId)
    if (!region) {
      throw new Error(`Region ${regionId} not found`)
    }

    if (region.assignedType) {
      throw new Error(`Region ${regionId} is already assigned ${region.assignedType}`)
    }

    region.assignedType = terrainType
    region.description = description
    this.terrainPlacements.push({ regionId, terrainType, description })
    this.log.push(`Assigned ${terrainType} to region ${regionId}`)

    return {
      ok: true,
      log: this.log
    }
  }

  assignEdgeType(edgeId, edgeType, description = '') {
    const edge = this.gameStateManager.worldTerrainData.edges[edgeId]
    if (!edge) {
      throw new Error(`Edge ${edgeId} not found`)
    }

    if (edge.assignedType) {
      throw new Error(`Edge ${edgeId} is already assigned ${edge.assignedType}`)
    }

    edge.assignedType = edgeType
    edge.description = description
    this.edgePlacements.push({ edgeId, edgeType, description })
    this.log.push(`Assigned ${edgeType} to edge ${edgeId}`)

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

  serialize() {
    return {
      currentStep: this.currentStep,
      terrainPlacements: this.terrainPlacements,
      edgePlacements: this.edgePlacements,
      districtClassAssignments: Array.from(this.districtClassAssignments.entries())
    }
  }

  deserialize(data) {
    if (data.currentStep) this.currentStep = data.currentStep
    if (data.terrainPlacements) this.terrainPlacements = data.terrainPlacements
    if (data.edgePlacements) this.edgePlacements = data.edgePlacements
    if (data.districtClassAssignments) {
      this.districtClassAssignments = new Map(data.districtClassAssignments)
    }
  }
}
