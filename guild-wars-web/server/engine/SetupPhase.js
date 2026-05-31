import TerrainVoronoiGenerator from './voronoi/TerrainVoronoiGenerator.js'
import StreetVoronoiGenerator from './voronoi/StreetVoronoiGenerator.js'
import CityBlockGenerator from './voronoi/CityBlockGenerator.js'
import BuildingTemplateGenerator from './buildings/BuildingTemplateGenerator.js'
import TextureTemplateGenerator from './buildings/TextureTemplateGenerator.js'

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
    this.cityEdgePlacements = []
    this.districtClassAssignments = new Map()
    this.resourceRegistry = []
    this.threats = []
    this.tradingDestinations = []
    this.factions = []
  }

  initialize() {
    this.log = []
    this.terrainPlacements = []
    this.edgePlacements = []
    this.districtTypePlacements = []
    this.cityEdgePlacements = []
    this.districtClassAssignments.clear()
    this.resourceRegistry = []
    this.threats = []
    this.tradingDestinations = []
    this.factions = []
    this.log.push('Initializing Setup Phase...')

    this.worldGenerator = new TerrainVoronoiGenerator()
    const worldData = this.worldGenerator.generate(15, 50, 0)
    this.gameStateManager.worldTerrainData = worldData
    this.log.push(`Generated ${worldData.regions.length} terrain regions`)

    const worldSize = 50
    for (const region of worldData.regions) {
      region.isEdge = this.touchesBoundary(region, worldSize)
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

  assignTerrainToRegion(regionId, terrainType, description = '') {
    const regions = this.gameStateManager.worldTerrainData.regions
    const region = regions.find(r => r.id === regionId)
    if (!region) throw new Error(`Region ${regionId} not found`)
    if (region.assignedType) throw new Error(`Region ${regionId} is already assigned ${region.assignedType}`)

    const EDGE_ONLY_TYPES = ['Desert', 'Mountains', 'Sea']
    if (EDGE_ONLY_TYPES.includes(terrainType) && !region.isEdge) {
      throw new Error(`${terrainType} can only be placed on edge regions`)
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
    this.terrainPlacements.push({ regionId, terrainType, description })
    this.log.push(`Assigned ${terrainType} to region ${regionId}`)

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

    return { ok: true, clearedEdgeIds, log: this.log }
  }

  assignEdgeType(edgeId, edgeType, description = '') {
    const edge = this.gameStateManager.worldTerrainData.edges[edgeId]
    if (!edge) throw new Error(`Edge ${edgeId} not found`)
    if (edge.assignedType) throw new Error(`Edge ${edgeId} is already assigned ${edge.assignedType}`)

    if (edgeType === 'River') {
      const allEdges = this.gameStateManager.worldTerrainData.edges
      const myRegions = new Set([edge.regionA, edge.regionB].filter(r => r != null))
      const myPts = edge.pointIds || []
      const myEndpoints = new Set([myPts[0], myPts[myPts.length - 1]].filter(p => p != null))
      for (const [otherId, other] of Object.entries(allEdges)) {
        if (otherId === edgeId || other.assignedType !== 'River') continue
        const sharesRegion = [other.regionA, other.regionB].some(r => r != null && myRegions.has(r))
        if (!sharesRegion) continue
        const otherPts = other.pointIds || []
        const otherEndpoints = new Set([otherPts[0], otherPts[otherPts.length - 1]].filter(p => p != null))
        const sharesEndpoint = [...myEndpoints].some(p => otherEndpoints.has(p))
        if (!sharesEndpoint) throw new Error('Rivers cannot run alongside each other')
      }
    }

    edge.assignedType = edgeType
    edge.description = description
    this.edgePlacements.push({ edgeId, edgeType, description })
    this.log.push(`Assigned ${edgeType} to edge ${edgeId}`)
    return { ok: true, log: this.log }
  }

  assignDistrictType(districtId, districtType, description = '', producedResource = '', consumedResources = [], residentialClass = null, LeadershipClass = null) {
    const district = this.gameStateManager.cityDistrictData.districts.find(d => d.id === districtId)
    if (!district) throw new Error(`District ${districtId} not found`)
    if (district.assignedType) throw new Error(`District ${districtId} is already assigned`)
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

    if (districtType === 'Market') {
      producedResource = 'Gold'
    }

    if (isLeadership) {
      const existing = this.gameStateManager.cityDistrictData.districts.find(d => d.assignedType === 'Leadership')
      if (existing) throw new Error('City Leadership has already been defined')
      if (!VALID_RULING_BODY_CLASSES.includes(LeadershipClass)) {
        throw new Error(`Invalid Leadership class: ${LeadershipClass}`)
      }
      producedResource = ''
      consumedResources = []
    }

    const normalizedProd = producedResource?.trim().toLowerCase()
    const DUPE_EXEMPT = new Set(['labour', 'gold'])
    if (normalizedProd && !DUPE_EXEMPT.has(normalizedProd)) {
      const conflict = this.gameStateManager.cityDistrictData.districts.find(d =>
        d.id !== districtId && d.producedResource &&
        d.producedResource.trim().toLowerCase() === normalizedProd
      )
      if (conflict) {
        throw new Error(`"${producedResource}" is already produced by another district`)
      }
    }

    const explicitConsumed = (consumedResources || []).map(r => r.trim()).filter(Boolean)
    const isNoble = isResidential && residentialClass === 'Noble'
    if (!isNoble && !isLeadership && !producedResource?.trim()) throw new Error('A district must produce at least one resource')
    if (!isResidential && !isLeadership && explicitConsumed.length < 2) throw new Error('A district must consume at least 2 resources (in addition to Water and Basic Food)')

    district.assignedType = districtType
    district.residentialClass = isResidential ? (residentialClass || null) : null
    district.LeadershipClass = isLeadership ? (LeadershipClass || null) : null
    district.description = description
    district.producedResource = producedResource?.trim() || null
    const IMPLICIT_CONSUMED = isLeadership ? [] : ['Water', 'Basic Food']
    district.consumedResources = [
      ...explicitConsumed,
      ...IMPLICIT_CONSUMED.filter(r => !explicitConsumed.some(e => e.toLowerCase() === r.toLowerCase()))
    ]

    const displayType = isResidential ? `Residential (${residentialClass})` : districtType
    this.districtTypePlacements.push({ districtId, districtType, residentialClass, LeadershipClass, description, producedResource: district.producedResource, consumedResources: district.consumedResources })
    this.log.push(`Assigned ${displayType} to district ${districtId}`)

    const PREDEFINED_LOWER = ['gold', 'water', 'labour', 'basic food']
    if (district.producedResource && !PREDEFINED_LOWER.includes(district.producedResource.toLowerCase())) {
      this._registerResource(district.producedResource)
    }
    for (const r of explicitConsumed) {
      if (!PREDEFINED_LOWER.includes(r.toLowerCase())) this._registerResource(r)
    }

    if (isLeadership) {
      const insertIdx = this.factions.findIndex(f => f.type !== 'leadership')
      const faction = { id: this.factions.length, type: 'leadership', name: 'Leadership', subclass: LeadershipClass || null, districtId }
      if (insertIdx === -1) this.factions.push(faction)
      else this.factions.splice(insertIdx, 0, faction)
    } else {
      this.factions.push({ id: this.factions.length, type: 'district', name: districtType, subclass: residentialClass || null, districtId })
    }

    return { ok: true, resourceRegistry: this.resourceRegistry, factions: this.factions, log: this.log }
  }

  _registerResource(name) {
    if (name && !this.resourceRegistry.includes(name)) {
      this.resourceRegistry.push(name)
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

  addTradingDestination(regionId, description = '') {
    const regions = this.gameStateManager.worldTerrainData.regions
    const region = regions.find(r => r.id === regionId)
    if (!region) throw new Error(`Region ${regionId} not found`)
    if (!region.isEdge) throw new Error('Trading destinations must be placed on edge regions')
    const { path: roadPath, bridges } = this._findRoadPath(regionId)
    const trade = { id: this.tradingDestinations.length, regionId, description, terrainType: region.assignedType, roadPath, bridges }
    this.tradingDestinations.push(trade)
    this.log.push(`Added trade at region ${regionId} with road of ${roadPath.length} regions, ${bridges.length} bridge(s)`)

    this.factions.push({ id: this.factions.length, type: 'trade', name: region.assignedType || 'Region', subclass: null, regionId })

    return { ok: true, tradingDestinations: this.tradingDestinations, trade, factions: this.factions, log: this.log }
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

  assignCityEdgeType(edgeId, edgeType, description = '') {
    const edge = this.gameStateManager.cityDistrictData.edges?.[edgeId]
    if (!edge) throw new Error(`City edge ${edgeId} not found`)
    if (edge.assignedType) throw new Error(`City edge ${edgeId} is already assigned`)

    if (edgeType === 'Docks' && !this._cityEdgeIsNearWater(edgeId)) {
      throw new Error('Docks can only be placed alongside Sea, Lake, or River')
    }

    edge.assignedType = edgeType
    edge.description = description
    this.cityEdgePlacements.push({ edgeId, edgeType, description })
    this.log.push(`Assigned ${edgeType} to city edge ${edgeId}`)
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

  rebuildStreets() {
    const cityData = this.gameStateManager.cityDistrictData
    if (!cityData) throw new Error('No city district data')
    // Reset all user-assigned city edge types so street setup starts fresh
    for (const edge of Object.values(cityData.edges || {})) {
      edge.assignedType = null
    }
    cityData.streetGraph = null
    cityData.plots = []
    this.cityEdgePlacements = []
    this._generateStreetGraph(Date.now())
    this._generateBuildings()
    this._rebuildFactions()
    this.log.push('Streets rebuilt.')
    return { ok: true, log: this.log }
  }

  finishSubdivision() {
    this._generateStreetGraph()
    this._generateBuildings()
    this._rebuildFactions()
    this.currentStep = 'StreetSetup'
    this.log.push('City subdivision complete. Moving to street setup.')
    return { ok: true, log: this.log }
  }

  _generateStreetGraph(epochSeed = 0) {
    const cityData = this.gameStateManager.cityDistrictData
    if (!cityData?.districts?.length) return

    // Auto-assign unassigned districts as Residential (random class, seeded by district id)
    const RESIDENTIAL_CLASSES = ['Slums', 'Middle', 'Noble']
    for (const district of cityData.districts) {
      if (!district.assignedType && !district.isLeadershipDistrict) {
        let s = (district.id * 2654435761) >>> 0
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const cls = RESIDENTIAL_CLASSES[(s >>> 0) % RESIDENTIAL_CLASSES.length]
        district.assignedType = 'Residential'
        district.residentialClass = cls
        district.producedResource = cls !== 'Noble' ? 'Labour' : null
        district.consumedResources = ['Water', 'Basic Food']
        district.description = ''
        this.log.push(`Auto-assigned Residential (${cls}) to district ${district.id}`)
      }
      // Market districts always produce Gold (duplicates permitted)
      if (district.assignedType === 'Market') {
        district.producedResource = 'Gold'
      }
    }

    // Auto-assign all undefined district boundary edges to Mud road
    for (const edge of Object.values(cityData.edges || {})) {
      if (!edge.assignedType) edge.assignedType = 'Mud'
    }

    const gen = new StreetVoronoiGenerator()
    cityData.streetGraph = gen.generate(cityData.districts, cityData.edges, cityData.edgePoints || [], epochSeed)
    this.log.push(`Generated street graph: ${cityData.streetGraph.nodes.length} nodes, ${cityData.streetGraph.edges.length} edges`)
  }

  _generateBuildings() {
    const cityData = this.gameStateManager.cityDistrictData
    if (!cityData?.streetGraph) return
    const result = new CityBlockGenerator().generate(cityData.districts, cityData.streetGraph)
    cityData.blocks = result.blocks
    cityData.plots  = result.plots
    this.log.push(`Generated ${result.blocks.length} blocks, ${result.plots.length} plots`)
  }

  finishStreetSetup() {
    this.currentStep = 'GuildCreation'
    this.log.push('Street setup complete. Moving to guild design.')
    return { ok: true, log: this.log }
  }

  assignTerrainDistrict(regionId, districtType, description = '', producedResource = '', consumedResources = []) {
    const regions = this.gameStateManager.worldTerrainData.regions
    const region = regions.find(r => r.id === regionId)
    if (!region) throw new Error(`Region ${regionId} not found`)
    if (region.terrainDistrict) throw new Error(`Region ${regionId} already has a terrain district`)

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

    region.terrainDistrict = districtType
    region.terrainDistrictDescription = description?.trim() || ''
    region.terrainDistrictProducedResource = producedResource.trim()
    region.terrainDistrictConsumedResources = allConsumed

    const PREDEFINED_LOWER = ['gold', 'water', 'labour', 'basic food']
    if (!PREDEFINED_LOWER.includes(region.terrainDistrictProducedResource.toLowerCase())) {
      this._registerResource(region.terrainDistrictProducedResource)
    }
    for (const r of explicitConsumed) {
      if (!PREDEFINED_LOWER.includes(r.toLowerCase())) this._registerResource(r)
    }

    this.factions.push({ id: this.factions.length, type: 'terrain', name: districtType, subclass: null, regionId })

    this.log.push(`Assigned ${districtType} district to ${region.assignedType} region ${regionId}`)
    return { ok: true, resourceRegistry: this.resourceRegistry, factions: this.factions, log: this.log }
  }

  assignDistrictClass(districtId, districtClass) {
    return this.assignDistrictType(districtId, districtClass)
  }

  createPlayerGuild(guildName, leaderName, leaderClass, secondName, secondClass) {
    if (!guildName || !leaderName) throw new Error('Guild name and leader name are required')
    this.log.push(`Created guild: ${guildName}`)
    this.log.push(`  Leader: ${leaderName} (${leaderClass})`)
    this.log.push(`  Second: ${secondName} (${secondClass})`)
    this.currentStep = 'Complete'
    return { ok: true, log: this.log }
  }

  getLog() { return this.log }

  reset() {
    this.currentStep = 'Terrain'
    this.log = []
    this.selectedRegionId = null
    this.selectedDistrictId = null
    this.terrainPlacements = []
    this.edgePlacements = []
    this.districtTypePlacements = []
    this.cityEdgePlacements = []
    this.districtClassAssignments.clear()
    this.resourceRegistry = []
    this.threats = []
    this.tradingDestinations = []
    this.factions = []
  }

  serialize() {
    return {
      currentStep: this.currentStep,
      terrainPlacements: this.terrainPlacements,
      edgePlacements: this.edgePlacements,
      districtTypePlacements: this.districtTypePlacements,
      cityEdgePlacements: this.cityEdgePlacements,
      districtClassAssignments: Array.from(this.districtClassAssignments.entries()),
      resourceRegistry: this.resourceRegistry,
      threats: this.threats,
      tradingDestinations: this.tradingDestinations,
      factions: this.factions
    }
  }

  deserialize(data) {
    if (data.currentStep) this.currentStep = data.currentStep
    if (data.terrainPlacements) this.terrainPlacements = data.terrainPlacements
    if (data.edgePlacements) this.edgePlacements = data.edgePlacements
    if (data.districtTypePlacements) this.districtTypePlacements = data.districtTypePlacements
    if (data.cityEdgePlacements) this.cityEdgePlacements = data.cityEdgePlacements
    if (data.districtClassAssignments) {
      this.districtClassAssignments = new Map(data.districtClassAssignments)
    }
    // resourceRegistry is session-only; do not restore from save
    if (data.threats) this.threats = data.threats
    if (data.tradingDestinations) this.tradingDestinations = data.tradingDestinations
    // Rebuild factions from source-of-truth region/district/trade data so older saves
    // without faction tracking are automatically reconciled on load.
    this._rebuildFactions()
  }

  _rebuildFactions() {
    this.factions = []
    const regions = this.gameStateManager.worldTerrainData?.regions || []
    const districts = this.gameStateManager.cityDistrictData?.districts || []

    for (const district of districts) {
      if (district.assignedType === 'Leadership') {
        this.factions.push({ id: this.factions.length, type: 'leadership', name: 'Leadership', subclass: district.LeadershipClass || null, districtId: district.id })
      }
    }
    for (const region of regions) {
      if (region.terrainDistrict) {
        this.factions.push({ id: this.factions.length, type: 'terrain', name: region.terrainDistrict, subclass: null, regionId: region.id })
      }
    }
    for (const district of districts) {
      if (district.assignedType && district.assignedType !== 'Leadership') {
        this.factions.push({ id: this.factions.length, type: 'district', name: district.assignedType, subclass: district.residentialClass || null, districtId: district.id })
      }
    }
    for (const trade of this.tradingDestinations) {
      this.factions.push({ id: this.factions.length, type: 'trade', name: trade.terrainType || 'Region', subclass: null, regionId: trade.regionId })
    }
  }
}
