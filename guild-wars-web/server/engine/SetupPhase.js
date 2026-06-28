import TerrainVoronoiGenerator from './CityGenerator/TerrainVoronoiGenerator.js'
import StreetVoronoiGenerator from './CityGenerator/StreetVoronoiGenerator.js'
import CityBlockGenerator, { majorityStreetType, extractOuterGutterPolygon } from './CityGenerator/CityBlockGenerator.js'
import PlotVoronoiGenerator, { markSquareBlocks } from './CityGenerator/PlotVoronoiGenerator.js'
import LandmarkPlacer from './CityGenerator/buildings/LandmarkPlacer.js'
import BuildingTemplateGenerator from './CityGenerator/buildings/BuildingTemplateGenerator.js'
import TextureTemplateGenerator from './CityGenerator/buildings/TextureTemplateGenerator.js'
import { CALC_BLOCKS, CALC_PLOTS } from './pipelineFlags.js'
import { convertTerrainCellsToPlots } from './CityGenerator/TerrainPlotConverter.js'
import { getDistrictConfig, districtConfigKey } from '../../shared/districtConfig.js'
import { generateName } from '../../shared/nameLibrary.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Townhouse probability per district now lives in shared/districtConfig.js
// (DISTRICTS[key].townhouseProb) — every district type builds townhouses (was
// Residential-only), alongside every other per-district-type table.

function _seededRand(seed) {
  let s = ((seed | 0) * 2654435761) >>> 0
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5
  return (s >>> 0) / 0x100000000
}

function markTownhouseBlocks(blocks, plots, districts) {
  const districtById = new Map(districts.map(d => [d.id, d]))
  const plotsByBlock = new Map()
  for (const plot of plots) {
    if (!plotsByBlock.has(plot.blockId)) plotsByBlock.set(plot.blockId, [])
    plotsByBlock.get(plot.blockId).push(plot)
  }
  for (const block of blocks) {
    if (block.blockType === 'square') continue
    const district = districtById.get(block.districtId)
    if (!districtConfigKey(district)) continue   // unassigned/untyped — skip
    const prob = getDistrictConfig(district).townhouseProb
    if (prob <= 0 || _seededRand(block.id * 7919 + 42) >= prob) continue
    block.blockType = 'townhouse'
    for (const plot of (plotsByBlock.get(block.id) || [])) {
      if (plot.blockType === 'square') continue
      plot.blockType = 'townhouse'
      if (_seededRand(plot.id * 13337 + 99) < 0.05) plot.freestanding = true
    }
  }
}

const _dir = dirname(fileURLToPath(import.meta.url))
let _nameLib = null
let _abilityArrays = null

function _loadCharacterData() {
  if (!_nameLib) {
    _nameLib = JSON.parse(readFileSync(join(_dir, '../../resources/RulesConfig/characterNames.json'), 'utf8'))
  }
  if (!_abilityArrays) {
    _abilityArrays = JSON.parse(readFileSync(join(_dir, '../../resources/RulesConfig/abilityScoreSelection.json'), 'utf8')).Options
  }
}

const RACE_WEIGHTS = [
  { race: 'human',    weight: 0.800 },
  { race: 'elf',      weight: 0.050 },
  { race: 'dwarf',    weight: 0.050 },
  { race: 'halfOrc',  weight: 0.034 },
  { race: 'halfling', weight: 0.033 },
  { race: 'gnome',    weight: 0.033 },
]

const RACIAL_MODIFIERS = {
  human:    { str:1, dex:1, con:1, int:1, wis:1, cha:1 },
  elf:      { dex:2, int:1 },
  dwarf:    { con:2, wis:1 },
  halfOrc:  { str:2, con:1 },
  halfling: { dex:2 },
  gnome:    { int:2, con:1 },
}

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha']

function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

function _weightedRace() {
  const r = Math.random()
  let cum = 0
  for (const { race, weight } of RACE_WEIGHTS) {
    cum += weight
    if (r < cum) return race
  }
  return 'human'
}

function _shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function generateRecruits(n) {
  _loadCharacterData()
  return Array.from({ length: n }, () => {
    const race = _weightedRace()
    const names = _nameLib[race]
    const name = `${_pick(names.first)} ${_pick(names.last)}`
    const scores = _shuffle(_pick(_abilityArrays))
    const mods = RACIAL_MODIFIERS[race] || {}
    const abilityScores = {}
    ABILITY_KEYS.forEach((k, i) => {
      abilityScores[k] = Math.min(20, scores[i] + (mods[k] || 0))
    })
    return {
      id: crypto.randomUUID(),
      name,
      race,
      level: 0,
      role: 'recruit',
      abilityScores,
      maxHp: 6,
      currentHp: 6,
    }
  })
}

// Distinct guild colours (by creation order), used by the Influence map overlay.
const GUILD_COLORS = ['#e6453c', '#3c7de6', '#37a85a', '#d9a528', '#9b59d9', '#e67ec2']

export default class SetupPhase {
  constructor(gameStateManager) {
    this.gameStateManager = gameStateManager
    this.currentStep = 'Terrain'
    this.log = []
    this.worldGenerator = null
    this.selectedRegionId = null
    this.selectedDistrictId = null
    this.terrainPlacements = []
    this.edgePlacements = []
    this.districtTypePlacements = []
    this.districtEdgePlacements = []
    this.districtClassAssignments = new Map()
    this.resourceRegistry = []
    this.threats = []
    this.tradingDestinations = []
    this.factions = []
    this.gods = []
    this.magicSystem = null
    this.foreignPowers = []
    this.worldDomains = null
    this.terrainDistrictPlots = []
    this.terrainFeaturePlots = []
  }

  initialize() {
    this.gameStateManager.clear()
    this.log = []
    this.terrainPlacements = []
    this.edgePlacements = []
    this.districtTypePlacements = []
    this.districtEdgePlacements = []
    this.districtClassAssignments.clear()
    this.resourceRegistry = []
    this.threats = []
    this.tradingDestinations = []
    this.factions = []
    this.gods = []
    this.magicSystem = null
    this.foreignPowers = []
    this.worldDomains = null
    this.terrainDistrictPlots = []
    this.terrainFeaturePlots = []
    this.log.push('Initializing Setup Phase...')

    this.worldGenerator = new TerrainVoronoiGenerator()
    const worldData = this.worldGenerator.generate(15, 50, 0)
    this.gameStateManager.worldTerrainData = worldData
    this.log.push(`Generated ${worldData.regions.length} terrain regions`)

    const worldSize = 50
    for (const region of worldData.regions) {
      region.isEdge = this.touchesBoundary(region, worldSize)
      region.isNorthEdge = this.touchesNorthBoundary(region, worldSize)
    }

    const cityRegion = this.findCityRegion(worldData.regions, worldData.fineCells)
    if (cityRegion) {
      cityRegion.assignedType = 'City'
      this.log.push(`Identified city region: Region ${cityRegion.id}`)

      const cityFineCells = worldData.fineCells.filter(c => c.parentRegionId === cityRegion.id)
      const cityData = this.generateCityDistrictData(cityFineCells)
      this.gameStateManager.cityDistrictData = cityData
      this.log.push(`Generated ${cityData.districts.length} city districts`)
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

  // Build city district data (districts + shared edges) from fine cells inside the city region.
  generateCityDistrictData(cityFineCells) {
    const districts = cityFineCells.map((cell, i) => ({
      id: i,
      seedPoint: { x: cell.seedPoint.x, y: cell.seedPoint.y },
      polygon: cell.polygon.map(v => ({ x: v.x, y: v.y })),
      assignedType: null,
      description: ''
    }))

    // Pre-mark the smallest district by area as the Leadership district.
    const polyArea = (poly) => {
      let a = 0; const n = poly.length
      for (let i = 0, j = n - 1; i < n; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y)
      return Math.abs(a) / 2
    }
    let leaderIdx = 0, minArea = Infinity
    for (let i = 0; i < districts.length; i++) {
      const a = polyArea(districts[i].polygon)
      if (a < minArea) { minArea = a; leaderIdx = i }
    }
    districts[leaderIdx].isLeadershipDistrict = true

    // Deduplicate polygon vertices by coordinate so shared borders snap together.
    const eps = 0.001
    const vertexByKey = new Map()
    let nextVId = 0
    const getVertex = (x, y) => {
      const key = `${Math.round(x / eps)},${Math.round(y / eps)}`
      if (!vertexByKey.has(key)) vertexByKey.set(key, { id: nextVId++, x, y })
      return vertexByKey.get(key)
    }

    // Map each polygon segment to the district(s) that contain it.
    const segmentMap = new Map()
    for (let dIdx = 0; dIdx < cityFineCells.length; dIdx++) {
      const poly = cityFineCells[dIdx].polygon
      for (let i = 0; i < poly.length; i++) {
        const va = getVertex(poly[i].x, poly[i].y)
        const vb = getVertex(poly[(i + 1) % poly.length].x, poly[(i + 1) % poly.length].y)
        if (va.id === vb.id) continue
        const lo = Math.min(va.id, vb.id), hi = Math.max(va.id, vb.id)
        const segKey = `${lo}:${hi}`
        if (!segmentMap.has(segKey)) segmentMap.set(segKey, { va, vb, dIdxList: [] })
        segmentMap.get(segKey).dIdxList.push(dIdx)
      }
    }

    // Segments shared by exactly two districts become inner city edges.
    // Segments belonging to one district (outer boundary) also become edges.
    const edgeSegments = new Map()
    const edgeMeta = new Map()
    for (const [, data] of segmentMap) {
      if (data.dIdxList.length === 2) {
        const [dA, dB] = data.dIdxList
        const eA = Math.min(dA, dB), eB = Math.max(dA, dB)
        const edgeKey = `${eA}-${eB}`
        if (!edgeSegments.has(edgeKey)) {
          edgeSegments.set(edgeKey, [])
          edgeMeta.set(edgeKey, { districtA: eA, districtB: eB })
        }
        edgeSegments.get(edgeKey).push({ v1: data.va, v2: data.vb })
      } else if (data.dIdxList.length === 1) {
        const dA = data.dIdxList[0]
        // Group outer segments by district; each connected section becomes one edge.
        // Use a temporary key that will be collapsed into polylines below.
        const edgeKey = `outer-${dA}`
        if (!edgeSegments.has(edgeKey)) {
          edgeSegments.set(edgeKey, [])
          edgeMeta.set(edgeKey, { districtA: dA, districtB: null })
        }
        edgeSegments.get(edgeKey).push({ v1: data.va, v2: data.vb })
      }
    }

    const edges = {}
    const edgePointsMap = new Map()
    let outerEdgeIdx = 0

    for (const [edgeKey, segments] of edgeSegments) {
      const meta = edgeMeta.get(edgeKey)

      if (edgeKey.startsWith('outer-')) {
        // Outer boundary may have multiple disconnected chains per district
        for (const polyline of this._splitIntoChains(segments)) {
          if (polyline.length < 2) continue
          const key = `outer-${outerEdgeIdx++}`
          for (const v of polyline) {
            if (!edgePointsMap.has(v.id)) edgePointsMap.set(v.id, { id: v.id, x: v.x, y: v.y })
          }
          edges[key] = {
            districtA: meta.districtA,
            districtB: null,
            pointIds: polyline.map(v => v.id),
            assignedType: null,
            description: ''
          }
        }
      } else {
        const polyline = this._sortIntoPolyline(segments)
        if (polyline.length < 2) continue
        for (const v of polyline) {
          if (!edgePointsMap.has(v.id)) edgePointsMap.set(v.id, { id: v.id, x: v.x, y: v.y })
        }
        edges[edgeKey] = {
          districtA: meta.districtA,
          districtB: meta.districtB,
          pointIds: polyline.map(v => v.id),
          assignedType: null,
          description: ''
        }
      }
    }

    return {
      districts,
      edges,
      edgePoints: Array.from(edgePointsMap.values())
    }
  }

  _sortIntoPolyline(segments) {
    if (segments.length === 0) return []
    if (segments.length === 1) return [segments[0].v1, segments[0].v2]

    const vertexById = new Map()
    const adj = new Map()
    for (let i = 0; i < segments.length; i++) {
      const { v1, v2 } = segments[i]
      vertexById.set(v1.id, v1)
      vertexById.set(v2.id, v2)
      if (!adj.has(v1.id)) adj.set(v1.id, [])
      if (!adj.has(v2.id)) adj.set(v2.id, [])
      adj.get(v1.id).push({ segIdx: i, otherId: v2.id })
      adj.get(v2.id).push({ segIdx: i, otherId: v1.id })
    }

    let startId = segments[0].v1.id
    for (const [id, links] of adj) {
      if (links.length === 1) { startId = id; break }
    }

    const result = [vertexById.get(startId)]
    const used = new Set()
    let currentId = startId
    while (used.size < segments.length) {
      const links = adj.get(currentId) || []
      let moved = false
      for (const { segIdx, otherId } of links) {
        if (used.has(segIdx)) continue
        used.add(segIdx)
        result.push(vertexById.get(otherId))
        currentId = otherId
        moved = true
        break
      }
      if (!moved) break
    }
    return result
  }

  _splitIntoChains(segments) {
    const remaining = segments.map((s, i) => ({ ...s, _idx: i }))
    const chains = []
    while (remaining.length > 0) {
      const component = [remaining.shift()]
      let grew = true
      while (grew) {
        grew = false
        for (let i = remaining.length - 1; i >= 0; i--) {
          const seg = remaining[i]
          if (component.some(s =>
            s.v1.id === seg.v1.id || s.v1.id === seg.v2.id ||
            s.v2.id === seg.v1.id || s.v2.id === seg.v2.id
          )) {
            component.push(remaining.splice(i, 1)[0])
            grew = true
          }
        }
      }
      chains.push(this._sortIntoPolyline(component))
    }
    return chains
  }

  findCityRegion(regions, fineCells) {
    const fineCellCount = new Map()
    if (fineCells) {
      for (const cell of fineCells) {
        fineCellCount.set(cell.parentRegionId, (fineCellCount.get(cell.parentRegionId) || 0) + 1)
      }
    }
    const centralRegions = regions.filter(r => !this.touchesBoundary(r, 50))
    const pool = centralRegions.length > 0 ? centralRegions : regions
    if (fineCellCount.size > 0) {
      return pool.reduce((a, b) =>
        (fineCellCount.get(a.id) || 0) >= (fineCellCount.get(b.id) || 0) ? a : b
      )
    }
    return pool.reduce((a, b) => a.polygon.length > b.polygon.length ? a : b)
  }

  touchesBoundary(region, worldSize) {
    if (!region.polygon || region.polygon.length === 0) return false
    const eps = 0.5
    const poly = region.polygon
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      if ((a.x < eps && b.x < eps) ||
          (a.x > worldSize - eps && b.x > worldSize - eps) ||
          (a.y < eps && b.y < eps) ||
          (a.y > worldSize - eps && b.y > worldSize - eps)) return true
    }
    return false
  }

  // "North" = the y=0 edge of the 2D map (low Z in 3D, the far side as seen from default camera)
  touchesNorthBoundary(region, worldSize) {
    if (!region.polygon || region.polygon.length === 0) return false
    const eps = 0.5
    const poly = region.polygon
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      if (a.y < eps && b.y < eps) return true
    }
    return false
  }

  assignTerrainToRegion(regionId, terrainType, description = '', name = '') {
    const regions = this.gameStateManager.worldTerrainData.regions
    const region = regions.find(r => r.id === regionId)
    if (!region) throw new Error(`Region ${regionId} not found`)
    if (region.assignedType) throw new Error(`Region ${regionId} is already assigned ${region.assignedType}`)

    const EDGE_ONLY_TYPES = ['Desert', 'Mountains', 'Sea']
    if (EDGE_ONLY_TYPES.includes(terrainType) && !region.isEdge) {
      throw new Error(`${terrainType} can only be placed on edge regions`)
    }
    if (terrainType === 'Ice Sheet' && !region.isNorthEdge) {
      throw new Error('Ice Sheet can only be placed on north-edge regions')
    }

    if (terrainType === 'Sea' || terrainType === 'Lake') {
      const forbidden = terrainType === 'Sea' ? 'Lake' : 'Sea'
      const edges = this.gameStateManager.worldTerrainData.edges
      for (const edge of Object.values(edges)) {
        const otherId = edge.regionA === regionId ? edge.regionB : edge.regionB === regionId ? edge.regionA : null
        if (otherId !== null) {
          const other = regions.find(r => r.id === otherId)
          if (other?.assignedType === forbidden) {
            throw new Error(`${terrainType} cannot be adjacent to ${forbidden}`)
          }
        }
      }
    }

    region.assignedType = terrainType
    region.description = description
    region.name = name?.trim() || ''
    this.terrainPlacements.push({ regionId, terrainType, description, name: region.name })
    this.log.push(`Assigned ${terrainType} to region ${regionId}`)

    // Ice Sheet: auto-assign all adjacent unassigned inter-region edges as Cliffs
    const autoCliffEdgeIds = []
    if (terrainType === 'Ice Sheet') {
      const edges = this.gameStateManager.worldTerrainData.edges
      for (const [edgeId, edge] of Object.entries(edges)) {
        if ((edge.regionA === regionId || edge.regionB === regionId) && !edge.assignedType) {
          edge.assignedType = 'Cliff'
          edge.description = ''
          edge.name = ''
          this.edgePlacements.push({ edgeId, edgeType: 'Cliff', description: '', name: '' })
          this.log.push(`Auto-cliffed edge ${edgeId} (borders Ice Sheet)`)
          autoCliffEdgeIds.push(edgeId)
        }
      }
    }

    const clearedEdgeIds = []
    if (terrainType === 'Lake' || terrainType === 'Sea') {
      const edges = this.gameStateManager.worldTerrainData.edges
      for (const [edgeId, edge] of Object.entries(edges)) {
        if ((edge.regionA === regionId || edge.regionB === regionId) && edge.assignedType === 'River') {
          edge.assignedType = null
          edge.description = ''
          this.edgePlacements = this.edgePlacements.filter(p => p.edgeId !== edgeId)
          this.log.push(`Cleared River from edge ${edgeId} (borders ${terrainType})`)
          clearedEdgeIds.push(edgeId)
        }
      }
    }

    return { ok: true, clearedEdgeIds, autoCliffEdgeIds, log: this.log }
  }

  assignEdgeType(edgeId, edgeType, description = '', name = '') {
    const edge = this.gameStateManager.worldTerrainData.edges[edgeId]
    if (!edge) throw new Error(`Edge ${edgeId} not found`)
    if (edge.assignedType) throw new Error(`Edge ${edgeId} is already assigned ${edge.assignedType}`)

    edge.assignedType = edgeType
    edge.description = description
    edge.name = name?.trim() || ''
    this.edgePlacements.push({ edgeId, edgeType, description, name: edge.name })
    this.log.push(`Assigned ${edgeType} to edge ${edgeId}`)
    return { ok: true, log: this.log }
  }

  // Apply = lock the district in (final). The type may already have been set by
  // previewDistrictType; here we validate resources, commit them, and lock.
  assignDistrictType(districtId, districtType, description = '', producedResource = '', consumedResources = [], residentialClass = null, LeadershipClass = null, secondProducedResource = '', name = '', resourceDefs = []) {
    const district = this.gameStateManager.cityDistrictData.districts.find(d => d.id === districtId)
    if (!district) throw new Error(`District ${districtId} not found`)
    if (district.locked) throw new Error(`District ${districtId} is already locked`)
    if (district.isLeadershipDistrict && districtType !== 'Leadership') throw new Error('This district is reserved for Leadership')
    if (!district.isLeadershipDistrict && districtType === 'Leadership') throw new Error('Leadership can only be assigned to the designated Leadership district')

    const VALID_RESIDENTIAL_CLASSES = ['Slums', 'Middle', 'Noble']
    const VALID_RULING_BODY_CLASSES = ['Monarchy', 'Republic', 'Tyrant', 'Oligarchy', 'Theocracy', 'Anarchist']
    const isResidential = districtType === 'Residential'
    const isLeadership = districtType === 'Leadership'

    if (isResidential) {
      if (!VALID_RESIDENTIAL_CLASSES.includes(residentialClass)) {
        throw new Error(`Invalid residential class: ${residentialClass}`)
      }
      if (residentialClass === 'Slums' || residentialClass === 'Middle') {
        producedResource = 'Labour'
      } else {
        producedResource = ''
      }
    }

    if (isLeadership) {
      const existing = this.gameStateManager.cityDistrictData.districts.find(d => d.id !== districtId && d.assignedType === 'Leadership')
      if (existing) throw new Error('City Leadership has already been defined')
      if (!VALID_RULING_BODY_CLASSES.includes(LeadershipClass)) {
        throw new Error(`Invalid Leadership class: ${LeadershipClass}`)
      }
      producedResource = ''
      consumedResources = []
    }

    const normalizedProd = producedResource?.trim().toLowerCase()
    const normalizedProd2 = secondProducedResource?.trim().toLowerCase()
    const isMarket = districtType === 'Market'
    if (normalizedProd === 'gold' && !isMarket) throw new Error('Gold is produced automatically — choose a different resource or service')
    if (normalizedProd2 === 'gold') throw new Error('Gold is produced automatically — choose a different resource or service')
    if (normalizedProd && normalizedProd2 && normalizedProd === normalizedProd2) throw new Error(`Cannot produce the same resource or service twice: "${producedResource}"`)
    if (normalizedProd2 && districtType !== 'Industry') throw new Error('Only Industry districts can produce a second resource or service')

    // Gold is exempt from uniqueness — multiple Market districts can produce it
    const DUPE_EXEMPT = new Set(['labour', 'gold'])
    const checkDupe = (prod, label) => {
      if (!prod || DUPE_EXEMPT.has(prod)) return
      const conflict = this.gameStateManager.cityDistrictData.districts.find(d =>
        d.id !== districtId && d.producedResource &&
        d.producedResource.trim().toLowerCase() === prod
      )
      if (conflict) throw new Error(`"${label}" is already produced by another district`)
    }
    checkDupe(normalizedProd, producedResource)
    checkDupe(normalizedProd2, secondProducedResource)

    // Store new resource definitions (name, gpValue, ingredients) in the registry
    for (const def of resourceDefs) {
      if (def?.name) this._registerResourceDef(def)
    }

    const explicitConsumed = (consumedResources || []).map(r => r.trim()).filter(Boolean)
    const isNoble = isResidential && residentialClass === 'Noble'
    const hasTwoProductions = !!(normalizedProd && normalizedProd2)
    if (!isNoble && !isLeadership && !normalizedProd) throw new Error('A district must produce at least one resource or service (in addition to Gold)')
    if (!isResidential && !isLeadership && hasTwoProductions && explicitConsumed.length < 5) throw new Error('An Industry district producing 2 resources or services must consume at least 5')
    if (!isResidential && !isLeadership && !hasTwoProductions && explicitConsumed.length < 2) throw new Error('A district must consume at least 2 resources or services (in addition to Water and Basic Food)')

    district.assignedType = districtType
    district.residentialClass = isResidential ? (residentialClass || null) : null
    district.LeadershipClass = isLeadership ? (LeadershipClass || null) : null
    district.description = description
    district.name = name?.trim() || ''
    district.producedResource = producedResource?.trim() || null
    district.secondProducedResource = secondProducedResource?.trim() || null
    const IMPLICIT_CONSUMED = isLeadership ? [] : ['Water', 'Basic Food']
    district.consumedResources = [
      ...explicitConsumed,
      ...IMPLICIT_CONSUMED.filter(r => !explicitConsumed.some(e => e.toLowerCase() === r.toLowerCase()))
    ]

    const displayType = isResidential ? `Residential (${residentialClass})` : districtType
    this.districtTypePlacements.push({ districtId, districtType, residentialClass, LeadershipClass, description, producedResource: district.producedResource, secondProducedResource: district.secondProducedResource, consumedResources: district.consumedResources })
    this.log.push(`Assigned ${displayType} to district ${districtId}`)

    const PREDEFINED_LOWER = ['gold', 'water', 'labour', 'basic food']
    if (district.producedResource && !PREDEFINED_LOWER.includes(district.producedResource.toLowerCase())) {
      this._registerResource(district.producedResource)
    }
    if (district.secondProducedResource && !PREDEFINED_LOWER.includes(district.secondProducedResource.toLowerCase())) {
      this._registerResource(district.secondProducedResource)
    }
    for (const r of explicitConsumed) {
      if (!PREDEFINED_LOWER.includes(r.toLowerCase())) this._registerResource(r)
    }

    if (isLeadership) {
      const insertIdx = this.factions.findIndex(f => f.type !== 'leadership')
      const faction = { id: this.factions.length, health: 70, type:'leadership', typeName: 'Leadership', name: district.name, subclass: LeadershipClass || null, districtId, influence: {}, standing: {} }
      if (insertIdx === -1) this.factions.push(faction)
      else this.factions.splice(insertIdx, 0, faction)
    } else {
      this.factions.push({ id: this.factions.length, health: 70, type:'district', typeName: districtType, name: district.name, subclass: residentialClass || null, districtId, standing: {} })
    }

    // Commit: freeze the street seed, lock the district, and regenerate.
    if (district.streetSeed == null) district.streetSeed = district.id
    district.locked = true
    this.generateForLocked()
    this._removeAbsorbedDistrictEdgePlacements()

    return { ok: true, resourceRegistry: this.resourceRegistry, factions: this.factions, log: this.log }
  }

  // Provisionally set a district's type/class (no resource validation, no lock) and
  // generate its preview streets/plots/buildings. Called when the player picks a type
  // so streets appear immediately, before they fill in resources or click Apply.
  previewDistrictType(districtId, districtType, residentialClass = null, LeadershipClass = null) {
    const district = this.gameStateManager.cityDistrictData?.districts?.find(d => d.id === districtId)
    if (!district) throw new Error(`District ${districtId} not found`)
    if (district.locked) throw new Error(`District ${districtId} is locked`)
    if (district.isLeadershipDistrict && districtType !== 'Leadership') throw new Error('This district is reserved for Leadership')
    if (!district.isLeadershipDistrict && districtType === 'Leadership') throw new Error('Leadership can only be assigned to the designated Leadership district')

    const isResidential = districtType === 'Residential'
    const isLeadership = districtType === 'Leadership'
    district.assignedType = districtType
    district.residentialClass = isResidential ? (residentialClass || null) : null
    district.LeadershipClass = isLeadership ? (LeadershipClass || null) : null
    if (district.streetSeed == null) district.streetSeed = district.id
    this.generateForLocked(districtId)
    this.log.push(`Previewed ${districtType} on district ${districtId}`)
    return { ok: true, log: this.log }
  }

  _registerResource(name) {
    if (name && !this.resourceRegistry.includes(name)) {
      this.resourceRegistry.push(name)
    }
  }

  _registerResourceDef({ name, gpValue, ingredients }) {
    this._registerResource(name)
    if (!this.resourceDefinitions) this.resourceDefinitions = {}
    const key = name.trim().toLowerCase()
    if (!this.resourceDefinitions[key]) {
      this.resourceDefinitions[key] = { name: name.trim(), gpValue: Number(gpValue) || 0, ingredients: ingredients || [] }
    }
  }

  addThreat(regionId, description = '', name = '') {
    const regions = this.gameStateManager.worldTerrainData.regions
    const region = regions.find(r => r.id === regionId)
    if (!region) throw new Error(`Region ${regionId} not found`)
    if (!region.isEdge) throw new Error('Threats must be placed on edge regions')
    if (!name?.trim()) throw new Error('A threat must have a name')
    const threat = { id: this.threats.length, regionId, name: name.trim(), description, terrainType: region.assignedType }
    this.threats.push(threat)
    this.log.push(`Added threat "${name.trim()}" at region ${regionId} (${region.assignedType})`)
    return { ok: true, threats: this.threats, log: this.log }
  }

  addTradingDestination(regionId, description = '', name = '', buys = [], sells = []) {
    const regions = this.gameStateManager.worldTerrainData.regions
    const region = regions.find(r => r.id === regionId)
    if (!region) throw new Error(`Region ${regionId} not found`)
    if (!region.isEdge) throw new Error('Trading destinations must be placed on edge regions')

    const tradeName = (name || '').trim()
    if (!tradeName) throw new Error('A trade route name is required')
    const clean = (arr) => [...new Set((arr || []).map(r => (r || '').trim()).filter(Boolean))].slice(0, 3)
    const cleanBuys = clean(buys), cleanSells = clean(sells)
    if (cleanBuys.length < 1) throw new Error('Select at least one resource to buy')
    if (cleanSells.length < 1) throw new Error('Select at least one resource to sell')

    const { path: roadPath, bridges } = this._findRoadPath(regionId)
    const trade = { id: this.tradingDestinations.length, regionId, name: tradeName, description, terrainType: region.assignedType, roadPath, bridges, buys: cleanBuys, sells: cleanSells }
    this.tradingDestinations.push(trade)
    this.log.push(`Added trade '${tradeName}' at region ${regionId}: buys [${cleanBuys.join(', ')}], sells [${cleanSells.join(', ')}]`)

    // Register any newly-defined resources.
    const PREDEFINED_LOWER = ['gold', 'water', 'labour', 'basic food']
    for (const r of [...cleanBuys, ...cleanSells]) {
      if (!PREDEFINED_LOWER.includes(r.toLowerCase())) this._registerResource(r)
    }

    this.factions.push({ id: this.factions.length, health: 70, type:'trade', typeName: region.assignedType || 'Trade Route', name: tradeName, subclass: null, regionId, standing: {} })

    return { ok: true, tradingDestinations: this.tradingDestinations, trade, factions: this.factions, resourceRegistry: this.resourceRegistry, log: this.log }
  }

  _findRoadPath(startRegionId) {
    const regions = this.gameStateManager.worldTerrainData.regions
    const edges = this.gameStateManager.worldTerrainData.edges
    const cityRegion = regions.find(r => r.assignedType === 'City')
    if (!cityRegion) return { path: [startRegionId], bridges: [] }

    // Build adjacency map: regionId → [{neighborId, edgeType}]
    const adj = new Map()
    for (const edge of Object.values(edges)) {
      if (edge.regionA == null || edge.regionB == null) continue
      if (edge.assignedType === 'Cliff') continue  // cliffs block roads
      if (!adj.has(edge.regionA)) adj.set(edge.regionA, [])
      if (!adj.has(edge.regionB)) adj.set(edge.regionB, [])
      adj.get(edge.regionA).push({ id: edge.regionB, edgeType: edge.assignedType })
      adj.get(edge.regionB).push({ id: edge.regionA, edgeType: edge.assignedType })
    }

    const regionMap = new Map(regions.map(r => [r.id, r]))
    const BLOCKED = new Set(['Mountains', 'Swamp'])
    // BFS: state = [regionId, path, bridges[]]
    const queue = [[startRegionId, [startRegionId], []]]
    const visited = new Set([startRegionId])

    while (queue.length > 0) {
      const [curr, path, bridges] = queue.shift()
      if (curr === cityRegion.id) return { path, bridges }
      for (const { id: next, edgeType } of (adj.get(curr) || [])) {
        if (visited.has(next)) continue
        visited.add(next)
        const nextRegion = regionMap.get(next)
        if (!nextRegion || BLOCKED.has(nextRegion.assignedType)) continue
        const newPath = [...path, next]
        const newBridges = edgeType === 'River'
          ? [...bridges, { fromRegionId: curr, toRegionId: next }]
          : bridges
        if (next === cityRegion.id) return { path: newPath, bridges: newBridges }
        queue.push([next, newPath, newBridges])
      }
    }
    return { path: [startRegionId], bridges: [] }
  }

  // Centreline waypoints of a trade road, following the same fine-cell BFS the
  // client uses to draw the rendered (red) trade road, so the street road matches
  // it exactly. Returns [{x,y}] (off-map destination → near the city) or null.
  _tradeRoadWaypoints(roadPath) {
    const wt = this.gameStateManager.worldTerrainData
    const fineCells = wt?.fineCells || []
    const W = wt?.worldSize ?? 50
    if (!roadPath || roadPath.length < 2 || fineCells.length === 0) return null

    const pathSet = new Set(roadPath)
    const cityRegionId = roadPath[roadPath.length - 1]
    const cellsByRegion = new Map()
    for (const cell of fineCells) {
      if (!cellsByRegion.has(cell.parentRegionId)) cellsByRegion.set(cell.parentRegionId, [])
      cellsByRegion.get(cell.parentRegionId).push(cell)
    }

    const pathCells = []
    for (const regionId of roadPath) for (const cell of (cellsByRegion.get(regionId) || [])) pathCells.push(cell)
    if (pathCells.length === 0) return null
    const cellMap = new Map(pathCells.map(c => [c.id, c]))

    // Adjacency: fine cells sharing a (quantised) polygon vertex are neighbours.
    const adj = new Map(), vertToCells = new Map()
    for (const cell of pathCells) {
      for (const v of (cell.polygon || [])) {
        const key = `${Math.round(v.x * 20)},${Math.round(v.y * 20)}`
        if (!vertToCells.has(key)) vertToCells.set(key, [])
        vertToCells.get(key).push(cell.id)
      }
    }
    for (const [, ids] of vertToCells) {
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j]
        if (!adj.has(a)) adj.set(a, new Set())
        if (!adj.has(b)) adj.set(b, new Set())
        adj.get(a).add(b); adj.get(b).add(a)
      }
    }

    const edgeCells = cellsByRegion.get(roadPath[0]) || []
    if (edgeCells.length === 0) return null
    let startCell = edgeCells[0], minBoundDist = Infinity
    for (const cell of edgeCells) {
      const { x, y } = cell.seedPoint
      const d = Math.min(x, W - x, y, W - y)
      if (d < minBoundDist) { minBoundDist = d; startCell = cell }
    }

    const cityIds = new Set((cellsByRegion.get(cityRegionId) || []).map(c => c.id))
    const queue = [[startCell.id, [startCell.id]]]
    const visited = new Set([startCell.id])
    let fineCellPath = null
    while (queue.length > 0) {
      const [curr, currPath] = queue.shift()
      if (cityIds.has(curr)) { fineCellPath = currPath; break }
      for (const next of (adj.get(curr) || [])) {
        if (visited.has(next)) continue
        const nextCell = cellMap.get(next)
        if (!nextCell || !pathSet.has(nextCell.parentRegionId)) continue
        visited.add(next)
        queue.push([next, [...currPath, next]])
      }
    }
    if (!fineCellPath || fineCellPath.length < 2) return null

    const waypoints = []
    for (let i = 0; i < fineCellPath.length - 1; i++) {
      const cell = cellMap.get(fineCellPath[i])
      if (cell) waypoints.push({ x: cell.seedPoint.x, y: cell.seedPoint.y })
    }
    const cityCell = cellMap.get(fineCellPath[fineCellPath.length - 1])
    if (cityCell && waypoints.length > 0) {
      const last = waypoints[waypoints.length - 1]
      waypoints.push({ x: (last.x + cityCell.seedPoint.x) / 2, y: (last.y + cityCell.seedPoint.y) / 2 })
    }
    return waypoints.length >= 2 ? waypoints : null
  }

  assignCityEdgeType(edgeId, edgeType, description = '', name = '') {
    const edge = this.gameStateManager.cityDistrictData.edges?.[edgeId]
    if (!edge) throw new Error(`City edge ${edgeId} not found`)
    if (edge.assignedType) throw new Error(`City edge ${edgeId} is already assigned`)

    if (edgeType === 'Docks' && !this._cityEdgeIsNearWater(edgeId)) {
      throw new Error('Docks can only be placed alongside Sea, Lake, or River')
    }

    edge.assignedType = edgeType
    edge.description = description
    edge.name = name?.trim() || ''
    this.districtEdgePlacements.push({ edgeId, edgeType, description, name: edge.name })
    this.log.push(`Assigned ${edgeType} to city edge ${edgeId}`)
    // Regenerate streets for any already-typed adjacent districts so the
    // boundary polyline is stamped with the correct type (Stone for Wall, etc.)
    // before the client tries to build the wall/canal mesh.
    this.generateForLocked()
    return { ok: true, log: this.log }
  }

  _cityEdgeIsNearWater(edgeId) {
    const cityData    = this.gameStateManager.cityDistrictData
    const terrainData = this.gameStateManager.worldTerrainData
    const edge = cityData.edges?.[edgeId]
    if (!edge?.pointIds?.length) return false

    const cityPtMap = new Map((cityData.edgePoints || []).map(p => [p.id, p]))
    const pts = edge.pointIds.map(id => cityPtMap.get(id)).filter(Boolean)
    if (pts.length === 0) return false

    const terrPtMap = new Map((terrainData.edgePoints || []).map(p => [p.id, p]))
    const THRESHOLD = 1.0

    for (const region of (terrainData.regions || [])) {
      if (region.assignedType !== 'Sea' && region.assignedType !== 'Lake') continue
      const poly = region.polygon
      for (const pt of pts) {
        if (this._ptInPoly(pt.x, pt.y, poly)) return true
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length]
          if (this._segDist(pt.x, pt.y, a.x, a.y, b.x, b.y) < THRESHOLD) return true
        }
      }
    }

    for (const terrEdge of Object.values(terrainData.edges || {})) {
      if (terrEdge.assignedType !== 'River') continue
      const rPts = (terrEdge.pointIds || []).map(id => terrPtMap.get(id)).filter(Boolean)
      for (const pt of pts) {
        for (let i = 0; i < rPts.length - 1; i++) {
          if (this._segDist(pt.x, pt.y, rPts[i].x, rPts[i].y, rPts[i+1].x, rPts[i+1].y) < THRESHOLD) return true
        }
      }
    }

    return false
  }

  _ptInPoly(x, y, polygon) {
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y
      const xj = polygon[j].x, yj = polygon[j].y
      if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi) / (yj - yi) + xi))
        inside = !inside
    }
    return inside
  }

  _segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1
    const lenSq = dx * dx + dy * dy
    if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2)
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
    return Math.sqrt((px - x1 - t * dx) ** 2 + (py - y1 - t * dy) ** 2)
  }

  finishTerrain() {
    const regions = this.gameStateManager.worldTerrainData.regions
    for (const region of regions) {
      if (!region.assignedType) {
        region.assignedType = 'Plains'
        region.description = ''
        this.terrainPlacements.push({ regionId: region.id, terrainType: 'Plains', description: '' })
        this.log.push(`Auto-assigned Plains to region ${region.id}`)
      }
    }
    this.currentStep = 'CitySubdivision'
    this.log.push('Terrain placement complete. Moving to city subdivision.')
    return { ok: true, log: this.log }
  }

  // Regenerate the committed city geometry over all LOCKED districts, plus an
  // optional in-preview district (typed but not yet locked). Districts outside this
  // set contribute no streets, so their shared boundaries stay deferred until they
  // are locked too. Stable per-district seeds keep locked interiors unchanged.
  generateForLocked(previewDistrictId = null, isFinal = false) {
    const t0 = performance.now()
    const cityData = this.gameStateManager.cityDistrictData
    if (!cityData?.districts?.length) return
    // Generate over every TYPED district (locked or in preview). `locked` governs
    // immutability (no reseed/retype), not graph membership; untyped districts are
    // absent, so their shared boundaries stay deferred until they're typed.
    const subset = cityData.districts.filter(d => d.assignedType || d.id === previewDistrictId)
    if (!subset.length) {
      cityData.streetGraph = null
      cityData.blocks = []
      cityData.plots = []
      return
    }
    this._generateStreetGraph(subset, 0, isFinal)
    this._generateBuildings()
    console.log(`[perf] generateForLocked: ${(performance.now()-t0).toFixed(1)}ms (${subset.length}/${cityData.districts.length} districts typed, final=${isFinal})`)
  }

  // Remove districtEdgePlacements entries whose boundary junctions now exist in the
  // street graph — i.e., at least one adjacent district has been typed and generated.
  _removeAbsorbedDistrictEdgePlacements() {
    const cityData = this.gameStateManager.cityDistrictData
    const typedIds = new Set((cityData?.districts || []).filter(d => d.assignedType && d.locked).map(d => d.id))
    this.districtEdgePlacements = this.districtEdgePlacements.filter(entry => {
      const edge = cityData?.edges?.[entry.edgeId]
      if (!edge) return false
      // Keep entry only while neither adjacent district has been locked yet
      return !typedIds.has(edge.districtA) && !typedIds.has(edge.districtB)
    })
  }

  // Reseed a not-yet-locked district's interior streets, then regenerate.
  regenerateDistrict(districtId) {
    const cityData = this.gameStateManager.cityDistrictData
    const district = cityData?.districts?.find(d => d.id === districtId)
    if (!district) throw new Error(`District ${districtId} not found`)
    if (district.locked) throw new Error(`District ${districtId} is locked`)
    if (!district.assignedType) throw new Error(`District ${districtId} has no type yet`)
    let s = ((district.streetSeed ?? district.id) * 2654435761) >>> 0
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    district.streetSeed = s >>> 0
    this.generateForLocked(districtId)
    this.log.push(`Regenerated streets for district ${districtId}`)
    return { ok: true, log: this.log }
  }

  // Discard a provisional (previewed, not-yet-locked) district — clear its type/seed
  // so it returns to a blank district polygon, and regenerate without it. Locked
  // districts are final and never reverted.
  revertDistrict(districtId) {
    const cityData = this.gameStateManager.cityDistrictData
    const district = cityData?.districts?.find(d => d.id === districtId)
    if (!district) throw new Error(`District ${districtId} not found`)
    if (district.locked) return { ok: true, log: this.log }
    district.assignedType = null
    district.residentialClass = null
    district.LeadershipClass = null
    district.producedResource = null
    district.secondProducedResource = null
    district.consumedResources = []
    district.streetSeed = null
    district.description = ''
    this.generateForLocked()
    this.log.push(`Reverted district ${districtId} to blank`)
    return { ok: true, log: this.log }
  }

  // The full set of player-selectable district types (excludes Leadership, which is
  // reserved to the one designated Leadership district) — matches DistrictTypePanel.js's
  // selectable list on the client exactly.
  static ALL_DISTRICT_TYPES = ['Residential', 'Market', 'Religious', 'Military', 'Magical', 'Entertainment', 'Industry']

  // Seeded Fisher-Yates — deterministic per city (not re-rolled if finishSubdivision
  // were somehow invoked twice), unlike Math.random().
  static _shuffleSeeded(arr, seed) {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
      let s = (((seed + i * 104729) >>> 0) * 2654435761) >>> 0
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      const j = (s >>> 0) % (i + 1)
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }

  // Advancing to Guild Creation: auto-assign + lock any still-untyped districts, then
  // finalize the whole-city geometry. Auto-assigned types are spread across every
  // selectable district type (not just Residential) — districts left blank by the
  // player are handed out from a shuffled queue of whichever types the city doesn't
  // have yet, so a small city heavily favours getting one of each type represented;
  // once every type is covered, any further blanks fall back to uniform-random.
  // Resource production/consumption for non-Residential/Leadership auto-assignments use
  // placeholder values for now (real per-type balancing is a separate pass).
  finishSubdivision() {
    const cityData = this.gameStateManager.cityDistrictData
    const RESIDENTIAL_CLASSES = ['Slums', 'Middle', 'Noble']
    const districts = cityData?.districts || []

    const usedTypes = new Set(districts.filter(d => d.assignedType && d.assignedType !== 'Leadership').map(d => d.assignedType))
    const missingTypes = SetupPhase.ALL_DISTRICT_TYPES.filter(t => !usedTypes.has(t))
    const typeQueue = SetupPhase._shuffleSeeded(missingTypes, 1337)

    for (const district of districts) {
      if (!district.assignedType && district.isLeadershipDistrict) {
        // The Leadership district defaults to a Monarchy if left untyped.
        district.assignedType = 'Leadership'
        district.LeadershipClass = 'Monarchy'
        district.producedResource = null
        district.secondProducedResource = null
        district.consumedResources = []
        district.description = ''
        district.name = generateName('Leadership', 'Monarchy')
        this.log.push(`Auto-assigned Leadership (Monarchy) to district ${district.id}`)
      } else if (!district.assignedType && !district.isLeadershipDistrict) {
        // Prefer a still-missing type (heavy coverage bias); once the queue is empty
        // every type is already represented somewhere in the city, so fall back to a
        // uniform-random pick among all of them.
        let districtType
        if (typeQueue.length) {
          districtType = typeQueue.shift()
        } else {
          let s = (district.id * 2654435761) >>> 0
          s ^= s << 13; s ^= s >>> 17; s ^= s << 5
          districtType = SetupPhase.ALL_DISTRICT_TYPES[(s >>> 0) % SetupPhase.ALL_DISTRICT_TYPES.length]
        }
        usedTypes.add(districtType)

        if (districtType === 'Residential') {
          let s = (district.id * 2654435761) >>> 0
          s ^= s << 13; s ^= s >>> 17; s ^= s << 5
          const cls = RESIDENTIAL_CLASSES[(s >>> 0) % RESIDENTIAL_CLASSES.length]
          district.assignedType = 'Residential'
          district.residentialClass = cls
          district.producedResource = cls !== 'Noble' ? 'Labour' : null
          district.secondProducedResource = null
          district.consumedResources = ['Water', 'Basic Food']
          district.description = ''
          district.name = generateName('Residential', cls)
          this.log.push(`Auto-assigned Residential (${cls}) to district ${district.id}`)
        } else {
          district.assignedType = districtType
          district.residentialClass = null
          district.LeadershipClass = null
          district.producedResource = `Placeholder Good ${district.id}`
          district.secondProducedResource = null
          district.consumedResources = [`Placeholder Input ${district.id}A`, `Placeholder Input ${district.id}B`, 'Water', 'Basic Food']
          district.description = ''
          district.name = generateName('district', districtType)
          this.log.push(`Auto-assigned ${districtType} (placeholder resources) to district ${district.id}`)
        }
      }
      if (district.streetSeed == null) district.streetSeed = district.id
      district.locked = true
    }
    this.generateForLocked()
    this._rebuildFactions()
    this.currentStep = 'GuildCreation'
    this.log.push('City subdivision complete. Moving to guild creation.')
    return { ok: true, log: this.log }
  }

  // Generate the street graph over `districts` (a subset of the city's districts).
  // Trade routes are placeholder-only during District Setup; pass isFinal=true at
  // completion so they are clipped to the city interior and added as Mud roads.
  _generateStreetGraph(districts, epochSeed = 0, isFinal = false) {
    const t0 = performance.now()
    const cityData = this.gameStateManager.cityDistrictData
    if (!cityData?.districts?.length || !districts?.length) return

    // Market districts always produce Gold (normalisation; harmless if already set).
    for (const d of districts) {
      if (d.assignedType === 'Market') d.producedResource = 'Gold'
    }

    // NOTE: city edges are intentionally left unassigned here. The generator already
    // treats a null edge type as the default (betterStreetType) boundary road, and
    // mutating edge.assignedType would mark every district edge as "assigned" —
    // making it non-selectable and breaking edge editing throughout District Setup.

    const tradeRoutes = []
    if (isFinal) {
      for (const trade of this.tradingDestinations || []) {
        const wp = this._tradeRoadWaypoints(trade.roadPath || [])
        if (wp) tradeRoutes.push(wp)
      }
    }

    const MAX_TOPOLOGY_RETRIES = 3
    let streetGraph = null
    for (let attempt = 0; attempt <= MAX_TOPOLOGY_RETRIES; attempt++) {
      const gen = new StreetVoronoiGenerator()
      streetGraph = gen.generate(districts, cityData.edges, cityData.edgePoints || [], epochSeed, tradeRoutes)
      const issues = streetGraph.topologyIssues
      if (!issues || issues.crossings === 0) break

      if (attempt === MAX_TOPOLOGY_RETRIES) {
        console.error(`[street-graph] Topology unrecoverable after ${MAX_TOPOLOGY_RETRIES} retries — ${issues.crossings} crossing(s) remain. Gutter generation may be incorrect.`)
        break
      }

      // Increment seeds for non-locked districts involved in crossings.
      // Locked district seeds are fixed — if all involved districts are locked we cannot
      // fix the crossings by reseeding; the error above will fire on the final attempt.
      const affectedIds = issues.affectedDistrictIds ?? new Set()
      let reseeded = false
      for (const d of districts) {
        if (!affectedIds.has(d.id) || d.locked) continue
        let s = ((d.streetSeed ?? d.id) * 2654435761) >>> 0
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        d.streetSeed = s >>> 0
        reseeded = true
        console.log(`[street-graph] Crossing in district ${d.id} — reseeding (attempt ${attempt + 1}/${MAX_TOPOLOGY_RETRIES})`)
      }
      if (!reseeded) {
        console.error(`[street-graph] Crossing involves only locked districts [${[...affectedIds].join(', ')}] — cannot reseed. Gutter generation may be incorrect.`)
        break
      }
    }
    cityData.streetGraph = streetGraph
    console.log(`[perf]   streets: ${(performance.now()-t0).toFixed(1)}ms (${districts.length} districts → ${cityData.streetGraph.junctions.length} junctions, ${cityData.streetGraph.edges?.length ?? '?'} edges)`)
    this.log.push(`Generated street graph over ${districts.length} district(s): ${cityData.streetGraph.junctions.length} junctions, ${tradeRoutes.length} trade road(s) (final=${isFinal})`)
  }

  _generateBuildings() {
    const t0 = performance.now()
    const cityData = this.gameStateManager.cityDistrictData
    if (!cityData?.streetGraph) return
    cityData.landmarkBuildings = []
    if (!CALC_BLOCKS) {
      cityData.blocks = []
      cityData.plots  = []
      this.log.push('Block calculation disabled (pipelineFlags.CALC_BLOCKS)')
      return
    }

    const tBlocks = performance.now()
    const { blocks, roadEdges } = new CityBlockGenerator().generate(cityData.districts, cityData.streetGraph)
    cityData.blocks = blocks
    console.log(`[perf]   blocks: ${(performance.now()-tBlocks).toFixed(1)}ms (${blocks.length} blocks)`)

    // Mark City squares, then place Landmarks on their (joined) clusters BEFORE plots,
    // so plot generation can drop the ground beneath each Landmark (ADR-0005).
    const tLandmarks = performance.now()
    markSquareBlocks(blocks, cityData.districts)
    const { landmarkBuildings, footprints } = new LandmarkPlacer().generate(blocks, cityData.districts)
    cityData.landmarkBuildings = landmarkBuildings
    const squareCount = blocks.filter(b => b.blockType === 'square').length
    console.log(`[perf]   landmarks: ${(performance.now()-tLandmarks).toFixed(1)}ms (${landmarkBuildings.length} landmarks, ${squareCount} squares)`)

    // City squares are paved, walkable extensions of the street network — record
    // them on the street graph so they can be rendered in the street pass and
    // traversed by pathfinding (across the square, not around it). Each square
    // carries the road edges it borders, which form its connectivity to streets.
    cityData.streetGraph.squares = blocks
      .filter(b => b.blockType === 'square')
      .map(b => ({
        blockId: b.id,
        districtId: b.districtId,
        polygon: b.blockCorners,
        streetType: majorityStreetType(b.streetEdges),
        streetEdges: b.streetEdges,
      }))

    if (!CALC_PLOTS) {
      cityData.plots = []
      this.log.push(`Generated ${blocks.length} blocks, ${landmarkBuildings.length} landmarks (plot calculation disabled)`)
      return
    }

    const tPlots = performance.now()
    const junctions = cityData.streetGraph?.junctions || []
    const { plots } = new PlotVoronoiGenerator().generate(blocks, cityData.districts, junctions, roadEdges, footprints)
    cityData.plots = plots
    markTownhouseBlocks(blocks, cityData.plots, cityData.districts)
    const townhouseCount = blocks.filter(b => b.blockType === 'townhouse').length
    console.log(`[perf]   plots: ${(performance.now()-tPlots).toFixed(1)}ms (${plots.length} plots, ${townhouseCount} townhouse blocks)`)

    // Convert world terrain fine cells to plot objects, clipped to the city gutter boundary.
    const tTerrain = performance.now()
    const outerGutterPoly = extractOuterGutterPolygon(blocks)
    const wt = this.gameStateManager.worldTerrainData
    const terrainFineCells = wt?.fineCells || []
    const tradeRoadWaypoints = (this.tradingDestinations || [])
      .map(td => this._tradeRoadWaypoints(td.roadPath || []))
      .filter(Boolean)
    cityData.terrainPlots = convertTerrainCellsToPlots(terrainFineCells, outerGutterPoly, tradeRoadWaypoints, wt?.regions || [])
    console.log(`[perf]   terrain plots: ${(performance.now()-tTerrain).toFixed(1)}ms (${cityData.terrainPlots.length} plots)`)

    console.log(`[perf]   _generateBuildings total: ${(performance.now()-t0).toFixed(1)}ms`)
    this.log.push(`Generated ${blocks.length} blocks, ${plots.length} plots, ${landmarkBuildings.length} landmarks, ${cityData.streetGraph.squares.length} squares, ${cityData.terrainPlots.length} terrain plots`)
  }

  // Re-derive terrain plots from the current world fine cells — run on save-load so
  // that saved terrain plots always reflect the latest conversion code.
  regenerateTerrainPlots() {
    const cityData = this.gameStateManager.cityDistrictData
    if (!cityData?.blocks?.length) return 0
    const wt = this.gameStateManager.worldTerrainData
    const terrainFineCells = wt?.fineCells || []
    if (!terrainFineCells.length) return 0
    const outerGutterPoly = extractOuterGutterPolygon(cityData.blocks)
    const tradeRoadWaypoints = (this.tradingDestinations || [])
      .map(td => this._tradeRoadWaypoints(td.roadPath || []))
      .filter(Boolean)
    cityData.terrainPlots = convertTerrainCellsToPlots(terrainFineCells, outerGutterPoly, tradeRoadWaypoints, wt?.regions || [])
    return cityData.terrainPlots.length
  }

  assignTerrainDistrict(regionId, plotId, districtType, description = '', producedResource = '', consumedResources = [], name = '', resourceDefs = []) {
    const regions = this.gameStateManager.worldTerrainData.regions
    const region = regions.find(r => r.id === regionId)
    if (!region) throw new Error(`Region ${regionId} not found`)
    if (plotId && this.terrainDistrictPlots.find(p => p.plotId === plotId)) {
      throw new Error(`Plot ${plotId} already has a terrain district`)
    }

    const VALID = { Forest: 'Forestry', Hills: 'Mining', Plains: 'Agriculture', Lake: 'Fishing', Sea: 'Fishing' }
    if (!VALID[region.assignedType]) throw new Error(`Cannot add a district to ${region.assignedType} regions`)
    if (VALID[region.assignedType] !== districtType) {
      throw new Error(`${region.assignedType} regions only support ${VALID[region.assignedType]} districts`)
    }

    const explicitConsumed = (consumedResources || []).map(r => r.trim()).filter(Boolean)
    if (!producedResource?.trim()) throw new Error('A district must produce at least one resource')
    if (explicitConsumed.length < 2) throw new Error('A district must consume at least 2 resources (in addition to Water and Basic Food)')

    const IMPLICIT_CONSUMED = ['Water', 'Basic Food']
    const allConsumed = [
      ...explicitConsumed,
      ...IMPLICIT_CONSUMED.filter(r => !explicitConsumed.some(e => e.toLowerCase() === r.toLowerCase()))
    ]

    const districtName = name?.trim() || ''
    const producedTrimmed = producedResource.trim()

    this.terrainDistrictPlots.push({
      plotId,
      regionId,
      districtType,
      description: description?.trim() || '',
      name: districtName,
      producedResource: producedTrimmed,
      consumedResources: allConsumed
    })

    const PREDEFINED_LOWER = ['gold', 'water', 'labour', 'basic food']
    if (!PREDEFINED_LOWER.includes(producedTrimmed.toLowerCase())) {
      this._registerResource(producedTrimmed)
    }
    for (const r of explicitConsumed) {
      if (!PREDEFINED_LOWER.includes(r.toLowerCase())) this._registerResource(r)
    }
    for (const def of resourceDefs) {
      if (def?.name) this._registerResourceDef(def)
    }

    this.factions.push({ id: this.factions.length, health: 70, type:'terrain', typeName: districtType, name: districtName, subclass: null, plotId, regionId, producedResource: producedTrimmed })

    this.log.push(`Assigned ${districtType} district to plot ${plotId} in ${region.assignedType} region ${regionId}`)
    return { ok: true, resourceRegistry: this.resourceRegistry, factions: this.factions, log: this.log }
  }

  assignDistrictClass(districtId, districtClass) {
    return this.assignDistrictType(districtId, districtClass)
  }

  // Build the player's Guild: starting Gold, a colour, a Headquarters (optional at creation),
  // an Influence map (50 with every faction, +20 for the HQ district's faction), and 5
  // auto-generated recruits. Ties the Guild to the acting Seat when one is given.
  createPlayerGuild({ name, headquarters = null, seatId = null }) {
    const gsm = this.gameStateManager
    const id = `guild-${gsm.guilds.size + 1}`
    const guild = {
      id,
      seatId,
      name: name?.trim() || '',
      nameLocked: false,
      color: GUILD_COLORS[gsm.guilds.size % GUILD_COLORS.length],
      headquarters: this._resolveHeadquarters(headquarters),
      influence: {},
      standing: {},
      traits: [],
      tokens: { guild: 2, character: 3, round: 2 },
      resources: { Gold: 200 },   // Rules.md: each guild starts with 200gp
      characters: generateRecruits(5),
    }
    this._finalizeLeadershipInfluence()
    this._initFactionStandings()
    this._initGuildRelations(guild)
    gsm.addGuild(guild)
    this.currentStep = 'Complete'
    this.log.push(`Created guild${guild.name ? ` "${guild.name}"` : ''}${guild.headquarters ? ` (HQ in district ${guild.headquarters.districtId})` : ''}`)
    return { ok: true, guild, log: this.log }
  }

  // Set (or update) a guild's headquarters and recalculate HQ influence/standing.
  // Called when the player picks their HQ after guild creation.
  setGuildHeadquarters(guildId, hq) {
    const gsm = this.gameStateManager
    const guild = [...gsm.guilds.values()].find(g => g.id === guildId)
    if (!guild) throw new Error(`Guild ${guildId} not found`)
    const resolved = this._resolveHeadquarters(hq)
    guild.headquarters = resolved
    if (resolved?.districtId != null) {
      const hqFaction = this.factions.find(x => x.type === 'district' && x.districtId === resolved.districtId)
                     ?? this.factions.find(x => x.type === 'leadership' && x.districtId === resolved.districtId)
      if (hqFaction) {
        guild.standing[hqFaction.id] = Math.min(100, (guild.standing[hqFaction.id] ?? 50) + 20)
        const lf = this._leadershipFaction()
        const leadershipBase = lf?.influence?.[hqFaction.id] ?? 60
        const otherTotal = [...gsm.guilds.values()]
          .filter(g => g.id !== guild.id)
          .reduce((sum, g) => sum + (g.influence[hqFaction.id] ?? 0), 0)
        guild.influence[hqFaction.id] = Math.min(30, Math.max(0, 100 - leadershipBase - otherTotal))
      }
    }
    this.log.push(`Set headquarters for guild ${guildId}`)
    return { ok: true, guild, log: this.log }
  }

  // Resolve an HQ choice { kind:'plot'|'landmark', refId } to { kind, refId, districtId }.
  _resolveHeadquarters(hq) {
    if (!hq || hq.refId == null) return null
    const cd = this.gameStateManager.cityDistrictData || {}
    let districtId = null
    if (hq.kind === 'plot') {
      districtId = (cd.plots || []).find(p => p.id === hq.refId)?.districtId ?? null
    } else if (hq.kind === 'landmark') {
      districtId = (cd.landmarkBuildings || [])[hq.refId]?.districtId ?? null
    }
    return { kind: hq.kind, refId: hq.refId, districtId }
  }

  _leadershipFaction() {
    return this.factions.find(f => f.type === 'leadership') ?? null
  }

  // Populate Leadership's influence field (60 over all district/leadership factions).
  // Safe to call multiple times — idempotent.
  _finalizeLeadershipInfluence() {
    const lf = this._leadershipFaction()
    if (!lf) return
    for (const f of this.factions) {
      if (f.type === 'trade') continue  // Leadership has no influence over trade routes
      lf.influence[f.id] = 60
    }
  }

  // Populate symmetric standing between all faction pairs. Default 50. Idempotent.
  _initFactionStandings() {
    for (const fa of this.factions) {
      for (const fb of this.factions) {
        if (fa.id === fb.id) continue
        if (fa.standing[fb.id] == null) fa.standing[fb.id] = 50
      }
    }
  }

  // Influence 0 with every faction, Standing 50. +30 influence (soft-capped) and +20 standing for HQ district faction.
  _initGuildRelations(guild) {
    const gsm = this.gameStateManager
    for (const f of this.factions) {
      guild.influence[f.id] = 0
      guild.standing[f.id] = 50
    }
    const hqDistrict = guild.headquarters?.districtId
    if (hqDistrict != null) {
      const hqFaction = this.factions.find(x => x.type === 'district' && x.districtId === hqDistrict)
                     ?? this.factions.find(x => x.type === 'leadership' && x.districtId === hqDistrict)
      if (hqFaction) {
        // Standing: flat +20, no cap issue
        guild.standing[hqFaction.id] = Math.min(100, 50 + 20)
        // Influence: soft cap — remaining pool split evenly with other guild claimants
        const lf = this._leadershipFaction()
        const leadershipBase = lf?.influence?.[hqFaction.id] ?? 60
        const otherGuildTotal = [...gsm.guilds.values()]
          .filter(g => g.id !== guild.id)
          .reduce((sum, g) => sum + (g.influence[hqFaction.id] ?? 0), 0)
        const remaining = Math.max(0, 100 - leadershipBase - otherGuildTotal)
        guild.influence[hqFaction.id] = Math.min(30, remaining)
      }
    }
  }

  // Linear faction production scaling. `base` is TBD until per-turn Upkeep exists.
  static producedAmount(base, health) { return base * (health / 100) }

  getLog() { return this.log }

  reset() {
    this.currentStep = 'Terrain'
    this.log = []
    this.selectedRegionId = null
    this.selectedDistrictId = null
    this.terrainPlacements = []
    this.edgePlacements = []
    this.districtTypePlacements = []
    this.districtEdgePlacements = []
    this.districtClassAssignments.clear()
    this.resourceRegistry = []
    this.threats = []
    this.tradingDestinations = []
    this.factions = []
    this.gods = []
    this.magicSystem = null
    this.foreignPowers = []
    this.worldDomains = null
    this.terrainDistrictPlots = []
    this.terrainFeaturePlots = []
  }

  serialize() {
    return {
      currentStep: this.currentStep,
      terrainPlacements: this.terrainPlacements,
      edgePlacements: this.edgePlacements,
      districtTypePlacements: this.districtTypePlacements,
      districtEdgePlacements: this.districtEdgePlacements,
      districtClassAssignments: Array.from(this.districtClassAssignments.entries()),
      resourceRegistry: this.resourceRegistry,
      threats: this.threats,
      tradingDestinations: this.tradingDestinations,
      factions: this.factions,
      gods: this.gods,
      magicSystem: this.magicSystem,
      foreignPowers: this.foreignPowers,
      worldDomains: this.worldDomains,
      terrainDistrictPlots: this.terrainDistrictPlots,
      terrainFeaturePlots: this.terrainFeaturePlots
    }
  }

  deserialize(data) {
    // Street Setup was folded into City Subdivision; old saves map to Guild Creation.
    if (data.currentStep) this.currentStep = data.currentStep === 'StreetSetup' ? 'GuildCreation' : data.currentStep
    if (data.terrainPlacements) this.terrainPlacements = data.terrainPlacements
    if (data.edgePlacements) this.edgePlacements = data.edgePlacements
    if (data.districtTypePlacements) this.districtTypePlacements = data.districtTypePlacements
    if (data.districtEdgePlacements) this.districtEdgePlacements = data.districtEdgePlacements
    if (data.districtClassAssignments) {
      this.districtClassAssignments = new Map(data.districtClassAssignments)
    }
    if (data.threats) this.threats = data.threats
    if (data.tradingDestinations) this.tradingDestinations = data.tradingDestinations
    this.gods = data.gods ?? []
    this.magicSystem = data.magicSystem ?? null
    this.foreignPowers = data.foreignPowers ?? []
    this.worldDomains = data.worldDomains ?? null
    this.terrainDistrictPlots = data.terrainDistrictPlots ?? []
    // Rebuild derived lists from source-of-truth data so older saves are reconciled on load.
    this._rebuildFactions()
    this._rebuildRegistry()
  }

  addGod({ domains, name, description, seatId }) {
    const god = { id: this.gods.length, domains, name, description, seatId }
    this.gods.push(god)
    return god
  }

  defineMagicSystem({ conceptType, name, description, seatId }) {
    this.magicSystem = { conceptType, name, description, seatId }
    return this.magicSystem
  }

  refineMagicSystem({ name, description }) {
    if (!this.magicSystem) throw new Error('No magic system defined')
    if (name)        this.magicSystem.name        = name
    if (description) this.magicSystem.description = description
    return this.magicSystem
  }

  addForeignPowerThreat({ fpId, name, description }) {
    const fp = this.foreignPowers.find(f => f.id === fpId)
    if (!fp) throw new Error('Foreign power not found')
    const label = (name || fp.name).trim()
    if (!label) throw new Error('A name is required')
    const threat = { id: this.threats.length, foreignPowerId: fpId, name: label, description: description || '', direction: fp.direction, terrainType: 'foreign-power' }
    this.threats.push(threat)
    this.factions.push({ id: this.factions.length, health: 70, type: 'threat', typeName: 'Foreign Threat', name: label, subclass: null, foreignPowerId: fpId, standing: {} })
    this.log.push(`Declared ${fp.name} as threat: "${label}"`)
    return { ok: true, threats: this.threats, factions: this.factions, log: this.log }
  }

  addForeignPowerTrade({ fpId, name, description }) {
    const fp = this.foreignPowers.find(f => f.id === fpId)
    if (!fp) throw new Error('Foreign power not found')
    const label = (name || fp.name).trim()
    if (!label) throw new Error('A name is required')
    const dest = { id: this.tradingDestinations.length, foreignPowerId: fpId, name: label, description: description || '', direction: fp.direction, terrainType: 'foreign-power', buys: [], sells: [] }
    this.tradingDestinations.push(dest)
    this.factions.push({ id: this.factions.length, health: 100, type: 'trade', typeName: 'Foreign Trade', name: label, subclass: null, foreignPowerId: fpId, standing: {} })
    this.log.push(`Defined trade route with ${fp.name}: "${label}"`)
    return { ok: true, tradingDestinations: this.tradingDestinations, factions: this.factions, log: this.log }
  }

  addForeignPower({ direction, name, colour, description, seatId }) {
    for (const fp of this.foreignPowers) {
      const diff = Math.abs(((direction - fp.direction) + 360) % 360)
      const gap  = Math.min(diff, 360 - diff)
      if (gap < 45) return { error: 'Too close to existing foreign power' }
    }
    const fp = { id: this.foreignPowers.length, direction, name, colour, description, seatId }
    this.foreignPowers.push(fp)
    return fp
  }

  _rebuildRegistry() {
    const PREDEFINED_LOWER = ['gold', 'water', 'labour', 'basic food', 'security']
    this.resourceRegistry = []
    const reg = (name) => {
      if (name && !PREDEFINED_LOWER.includes(name.toLowerCase()) && !this.resourceRegistry.includes(name)) {
        this.resourceRegistry.push(name)
      }
    }
    const districts = this.gameStateManager.cityDistrictData?.districts || []
    for (const d of districts) {
      if (d.producedResource) reg(d.producedResource)
      for (const r of (d.consumedResources || [])) reg(r)
    }
    for (const tDP of (this.terrainDistrictPlots || [])) {
      if (tDP.producedResource) reg(tDP.producedResource)
      for (const r of (tDP.consumedResources || [])) reg(r)
    }
    // Backwards compat: old saves stored on region objects
    const regions = this.gameStateManager.worldTerrainData?.regions || []
    if (!(this.terrainDistrictPlots?.length)) {
      for (const region of regions) {
        if (region.terrainDistrictProducedResource) reg(region.terrainDistrictProducedResource)
        for (const r of (region.terrainDistrictConsumedResources || [])) reg(r)
      }
    }
    for (const trade of this.tradingDestinations) {
      for (const r of [...(trade.buys || []), ...(trade.sells || [])]) reg(r)
    }
  }

  _rebuildFactions() {
    this.factions = []
    const regions = this.gameStateManager.worldTerrainData?.regions || []
    const districts = this.gameStateManager.cityDistrictData?.districts || []

    for (const district of districts) {
      if (district.assignedType === 'Leadership') {
        this.factions.push({ id: this.factions.length, health: 70, type:'leadership', typeName: 'Leadership', name: district.name || '', subclass: district.LeadershipClass || null, districtId: district.id, influence: {}, standing: {} })
      }
    }
    if (this.terrainDistrictPlots?.length) {
      for (const tDP of this.terrainDistrictPlots) {
        this.factions.push({ id: this.factions.length, health: 70, type:'terrain', typeName: tDP.districtType, name: tDP.name || '', subclass: null, plotId: tDP.plotId, regionId: tDP.regionId, producedResource: tDP.producedResource || '', standing: {} })
      }
    } else {
      // Backwards compat: old saves stored district on the region object
      for (const region of regions) {
        if (region.terrainDistrict) {
          this.factions.push({ id: this.factions.length, health: 70, type:'terrain', typeName: region.terrainDistrict, name: region.terrainDistrictName || '', subclass: null, regionId: region.id, producedResource: region.terrainDistrictProducedResource || '', standing: {} })
        }
      }
    }
    for (const district of districts) {
      if (district.assignedType && district.assignedType !== 'Leadership') {
        this.factions.push({ id: this.factions.length, health: 70, type:'district', typeName: district.assignedType, name: district.name || '', subclass: district.residentialClass || null, districtId: district.id, standing: {} })
      }
    }
    for (const trade of this.tradingDestinations) {
      const region = regions.find(r => r.id === trade.regionId)
      this.factions.push({ id: this.factions.length, health: 70, type:'trade', typeName: region?.assignedType || 'Trade Route', name: trade.name || '', subclass: null, regionId: trade.regionId, standing: {} })
    }
  }
}
