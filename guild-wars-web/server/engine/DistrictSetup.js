// District type/class/edge assignment, resource wiring, threats/trade, leadership,
// guild/faction bookkeeping, and worldbuilding (Gods/Magic/Foreign Powers) — extracted
// verbatim from SetupPhase.js (see plan "wondrous-conjuring-wand", Stage 3). Same
// this.sp routing pattern as TerrainSetup — see that file's header comment.
//
// Also owns the small standalone character/recruit-generation subsystem
// (generateRecruits and its helpers) — previously module-level code in SetupPhase.js,
// used exclusively by createPlayerGuild (confirmed via a full-file usage scan before
// moving it), so it moves here rather than staying behind as orphaned dead weight.
import StreetVoronoiGenerator from './CityGenerator/StreetVoronoiGenerator.js'
import CityBlockGenerator from './CityGenerator/CityBlockGenerator.js'
import PlotVoronoiGenerator from './CityGenerator/PlotVoronoiGenerator.js'
import { applyCanalZDelta } from './CityGenerator/DistrictZHeight.js'
import { getDistrictConfig } from '../../shared/districtConfig.js'
import { generateName } from '../../shared/nameLibrary.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

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

// Linear faction production scaling. `base` is TBD until per-turn Upkeep exists.
function producedAmount(base, health) { return base * (health / 100) }

export default class DistrictSetup {
  constructor(setupPhase) {
    this.sp = setupPhase
  }

  // Build city district data (districts + shared edges) from terrain plots inside the city region.
  generateCityDistrictData(cityTerrainPlots) {
    // Each district's pointIds is a direct copy of its originating terrain plot's own
    // pointIds — the SAME global registry ids, not a coordinate-matched approximation.
    // This is the concrete "district reuses terrain-plot ids by construction" mechanism
    // the Point/Surface refactor is built around: two districts that were adjacent
    // terrain-plot cells share the identical id at their common corner, guaranteed,
    // with no eps-rounding dedup pass needed (that pass — and the second, independent
    // one _addPromotedDistrictEdges used to run — are both deleted; see plan §2).
    const districts = cityTerrainPlots.map((cell, i) => ({
      id: i,
      // z adopted from the originating terrain plot's own seedPoint (plan "typed-
      // gliding-leaf": District-scale z-height adoption) — same fix already applied to
      // promoteTerrainPlotToDistrict's matching seedPoint copy (see its doc comment):
      // the district's boundary corners (pointIds, below) already share the terrain
      // plot's exact registry point ids, so THEIR z is inherited automatically by
      // construction; only seedPoint needed an explicit copy, since it's a bare object,
      // not a shared registry id.
      seedPoint: { x: cell.seedPoint.x, y: cell.seedPoint.y, z: cell.seedPoint.z ?? 0 },
      polygon: cell.polygon.map(v => ({ x: v.x, y: v.y })),
      pointIds: [...cell.pointIds],
      // Which worldTerrainData.terrainPlots entry this district mirrors — promoted
      // districts already track this via promotedFromPlotId; this is the same concept
      // for the INITIAL batch, letting _applyRiverCliffPullback adopt a district's
      // pullback directly from its terrain plot's own (see that function's doc comment
      // for why: two independently-computed pullbacks of the same physical corner used
      // to leave a visible seam between a district's outer edge and adjacent terrain).
      originPlotId: cell.id,
      assignedType: null,
      description: ''
    }))

    // Map each polygon segment to the district(s) that contain it, keyed on the real
    // global point ids directly — exact equality, no coordinate tolerance.
    const segmentMap = new Map()
    for (let dIdx = 0; dIdx < cityTerrainPlots.length; dIdx++) {
      const poly = cityTerrainPlots[dIdx].polygon
      const ids = cityTerrainPlots[dIdx].pointIds
      for (let i = 0; i < poly.length; i++) {
        const va = { id: ids[i], x: poly[i].x, y: poly[i].y }
        const j = (i + 1) % poly.length
        const vb = { id: ids[j], x: poly[j].x, y: poly[j].y }
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
        for (const polyline of this.sp._splitIntoChains(segments)) {
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
        const polyline = this.sp._sortIntoPolyline(segments)
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

  // Apply = lock the district in (final). The type may already have been set by
  // previewDistrictType; here we validate resources, commit them, and lock.
  assignDistrictType(districtId, districtType, description = '', producedResource = '', residentialClass = null, LeadershipClass = null, secondProducedResource = '', name = '', resourceDefs = []) {
    const district = this.sp.gameStateManager.cityDistrictData.districts.find(d => d.id === districtId)
    if (!district) throw new Error(`District ${districtId} not found`)
    if (district.locked) throw new Error(`District ${districtId} is already locked`)

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
      const existing = this.sp.gameStateManager.cityDistrictData.districts.find(d => d.id !== districtId && d.assignedType === 'Leadership')
      if (existing) throw new Error('City Leadership has already been defined')
      if (!VALID_RULING_BODY_CLASSES.includes(LeadershipClass)) {
        throw new Error(`Invalid Leadership class: ${LeadershipClass}`)
      }
      producedResource = ''
    }

    const normalizedProd = producedResource?.trim().toLowerCase()
    const normalizedProd2 = secondProducedResource?.trim().toLowerCase()
    const isMarket = districtType === 'Market'
    const isReligious = districtType === 'Religious'
    if (normalizedProd === 'gold' && !isMarket) throw new Error('Gold is produced automatically — choose a different resource or service')
    if (normalizedProd2 === 'gold') throw new Error('Gold is produced automatically — choose a different resource or service')
    if (normalizedProd?.startsWith('worship of ') && !isReligious) throw new Error('Only Religious districts can produce Worship')
    if (normalizedProd2?.startsWith('worship of ') && !isReligious) throw new Error('Only Religious districts can produce Worship')
    if (normalizedProd && normalizedProd2 && normalizedProd === normalizedProd2) throw new Error(`Cannot produce the same resource or service twice: "${producedResource}"`)
    if (normalizedProd2 && districtType !== 'Industry') throw new Error('Only Industry districts can produce a second resource or service')

    // Gold is exempt from uniqueness — multiple Market districts can produce it
    const DUPE_EXEMPT = new Set(['labour', 'gold'])
    const checkDupe = (prod, label) => {
      if (!prod || DUPE_EXEMPT.has(prod)) return
      const conflict = this.sp.gameStateManager.cityDistrictData.districts.find(d =>
        d.id !== districtId && d.producedResource &&
        d.producedResource.trim().toLowerCase() === prod
      )
      if (conflict) throw new Error(`"${label}" is already produced by another district`)
    }
    checkDupe(normalizedProd, producedResource)
    checkDupe(normalizedProd2, secondProducedResource)

    // Store new resource definitions (name, gpValue, type, ingredients, specialInput, ...)
    for (const def of resourceDefs) {
      if (def?.name) this._registerResourceDef(def)
    }

    const isNoble = isResidential && residentialClass === 'Noble'
    if (!isNoble && !isLeadership && !normalizedProd) throw new Error('A district must produce at least one resource or service (in addition to Gold)')

    district.assignedType = districtType
    district.residentialClass = isResidential ? (residentialClass || null) : null
    district.LeadershipClass = isLeadership ? (LeadershipClass || null) : null
    district.description = description
    district.name = name?.trim() || ''
    district.producedResource = producedResource?.trim() || null
    district.secondProducedResource = secondProducedResource?.trim() || null

    // Consumption is fully derived from the Recipes of whatever the district produces,
    // plus the always-implicit Water + Basic Food upkeep (a per-round health mechanic —
    // never selectable as a recipe ingredient; see CONTEXT_ResourcesServices.md).
    const derivedConsumed = this._deriveConsumption([district.producedResource, district.secondProducedResource].filter(Boolean))
    const IMPLICIT_CONSUMED = isLeadership ? [] : ['Water', 'Basic Food']
    district.consumedResources = [
      ...derivedConsumed,
      ...IMPLICIT_CONSUMED.filter(r => !derivedConsumed.some(e => e.toLowerCase() === r.toLowerCase()))
    ]

    const displayType = isResidential ? `Residential (${residentialClass})` : districtType
    this.sp.districtTypePlacements.push({ districtId, districtType, residentialClass, LeadershipClass, description, producedResource: district.producedResource, secondProducedResource: district.secondProducedResource, consumedResources: district.consumedResources })
    this.sp.log.push(`Assigned ${displayType} to district ${districtId}`)

    const PREDEFINED_LOWER = ['gold', 'water', 'labour', 'basic food']
    if (district.producedResource && !PREDEFINED_LOWER.includes(district.producedResource.toLowerCase())) {
      this._registerResource(district.producedResource)
    }
    if (district.secondProducedResource && !PREDEFINED_LOWER.includes(district.secondProducedResource.toLowerCase())) {
      this._registerResource(district.secondProducedResource)
    }

    if (isLeadership) {
      const insertIdx = this.sp.factions.findIndex(f => f.type !== 'leadership')
      const faction = { id: this.sp.factions.length, health: 70, type:'leadership', typeName: 'Leadership', name: district.name, subclass: LeadershipClass || null, districtId, influence: {}, standing: {} }
      if (insertIdx === -1) this.sp.factions.push(faction)
      else this.sp.factions.splice(insertIdx, 0, faction)
    } else {
      this.sp.factions.push({ id: this.sp.factions.length, health: 70, type:'district', typeName: districtType, name: district.name, subclass: residentialClass || null, districtId, producedResource: district.producedResource || '', secondProducedResource: district.secondProducedResource || '', standing: {} })
    }

    // Commit: freeze the street seed, lock the district, and regenerate.
    if (district.streetSeed == null) district.streetSeed = district.id
    district.locked = true

    // Auto-walling: roll per District Edge adjacent to this newly locked district.
    // The locking district is the initiator — its probability is used regardless of
    // the neighbour's. Pre-existing manual assignments are never overridden.
    this._applyAutoWalling(districtId)

    this.sp.generateForLocked()
    this.sp._removeAbsorbedDistrictEdgePlacements()

    return { ok: true, resourceRegistry: this.sp.resourceRegistry, resourceDefinitions: this.sp.resourceDefinitions, factions: this.sp.factions, log: this.sp.log }
  }

  // Roll per-edge Wall assignment for a newly locked district. Uses the locking
  // district's walledChance (internal edges) and externalWalledChance (outer boundary).
  // Pre-existing assignedType on any edge is always respected — never overridden.
  _applyAutoWalling(districtId) {
    const cityData = this.sp.gameStateManager.cityDistrictData
    const district = cityData?.districts?.find(d => d.id === districtId)
    if (!district) return
    const cfg = getDistrictConfig(district)
    const walledChance = cfg.walledChance ?? 0
    const externalWalledChance = cfg.externalWalledChance ?? 0
    if (walledChance === 0 && externalWalledChance === 0) return

    const edges = cityData.edges || {}
    // Simple seeded RNG per edge so results are deterministic per street seed.
    let seed = (district.streetSeed ?? district.id) * 1664525 + 1013904223
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xFFFFFFFF }

    for (const [edgeId, edge] of Object.entries(edges)) {
      if (edge.districtA !== districtId && edge.districtB !== districtId) continue
      if (edge.assignedType) continue  // pre-existing manual assignment — never override
      const isExternal = edge.districtB == null
      const chance = isExternal ? externalWalledChance : walledChance
      if (chance <= 0) continue
      if (rng() < chance) {
        edge.assignedType = 'Wall'
        this.sp.districtEdgePlacements.push({ edgeId, assignedType: 'Wall', districtId })
        this.sp.log.push(`Auto-walled edge ${edgeId} for district ${districtId}`)
      }
    }
  }

  // Provisionally set a district's type/class (no resource validation, no lock) and
  // generate its preview streets/plots/buildings. Called when the player picks a type
  // so streets appear immediately, before they fill in resources or click Apply.
  previewDistrictType(districtId, districtType, residentialClass = null, LeadershipClass = null) {
    const district = this.sp.gameStateManager.cityDistrictData?.districts?.find(d => d.id === districtId)
    if (!district) throw new Error(`District ${districtId} not found`)
    if (district.locked) throw new Error(`District ${districtId} is locked`)

    const isResidential = districtType === 'Residential'
    const isLeadership = districtType === 'Leadership'
    district.assignedType = districtType
    district.residentialClass = isResidential ? (residentialClass || null) : null
    district.LeadershipClass = isLeadership ? (LeadershipClass || null) : null
    if (district.streetSeed == null) district.streetSeed = district.id
    this.sp.generateForLocked(districtId)
    this.sp.log.push(`Previewed ${districtType} on district ${districtId}`)
    return { ok: true, log: this.sp.log }
  }

  _registerResource(name) {
    if (name && !this.sp.resourceRegistry.includes(name)) {
      this.sp.resourceRegistry.push(name)
    }
  }

  // type: 'Raw' | 'Resource' | 'Service'. Raw items have a fixed recipe (Labour + Security)
  // and never store player-chosen ingredients/specialInput. rawSubtype ('Food'|'Resource')
  // applies only to Raw; tradeCategory ('Entertainment'|'Tradeable') applies only to Service.
  // specialInput is one concrete resource name — 'Labour', 'Gold', or a specific
  // "Worship of <god>" — never Water/Basic Food (those are a separate per-round upkeep,
  // not a Recipe ingredient), and never a Worship value when the Commodity being defined
  // is itself Worship (no self-reference).
  _registerResourceDef({ name, gpValue, ingredients, type, rawSubtype, specialInput, tradeCategory }) {
    if (!this.sp.resourceDefinitions) this.sp.resourceDefinitions = {}
    const key = name.trim().toLowerCase()
    if (this.sp.resourceDefinitions[key]) return // already defined — first write wins

    const resolvedType = type || 'Resource'
    const isWorship = key.startsWith('worship of ')
    const def = { name: name.trim(), gpValue: Number(gpValue) || 0, type: resolvedType, rawSubtype: null, ingredients: [], specialInput: null, tradeCategory: null }

    if (resolvedType === 'Raw') {
      def.rawSubtype = rawSubtype === 'Food' ? 'Food' : 'Resource'
    } else {
      const cleanIngredients = [...new Set((ingredients || []).map(i => (i || '').trim()).filter(Boolean))].slice(0, 2)
      if (cleanIngredients.length < 1) throw new Error(`"${name}" needs at least 1 ingredient`)
      if (cleanIngredients.some(ing => ['water', 'basic food'].includes(ing.toLowerCase()))) {
        throw new Error('Water and Basic Food are per-round upkeep, not a Recipe ingredient')
      }
      if (cleanIngredients.some(ing => this._dependsOn([ing], key))) {
        throw new Error(`"${name}" cannot use an ingredient that already depends on "${name}"`)
      }
      const input = (specialInput || '').trim()
      const inputLower = input.toLowerCase()
      const isValidSpecial = inputLower === 'labour' || inputLower === 'gold' || inputLower.startsWith('worship of ')
      if (!isValidSpecial) throw new Error(`"${name}" needs a special input of Labour, Gold, or Worship`)
      if (isWorship && inputLower.startsWith('worship of ')) throw new Error('Worship cannot use Worship as its own special input')
      def.ingredients = cleanIngredients
      def.specialInput = input
      if (resolvedType === 'Service') def.tradeCategory = tradeCategory === 'Entertainment' ? 'Entertainment' : 'Tradeable'
    }

    this.sp.resourceDefinitions[key] = def
    this._registerResource(name)
  }

  // Wires an already-registered resource in as an EXISTING target resource's second
  // ingredient (the "used as an ingredient for" node in the New Resource dialog). Only
  // legal when the target currently has exactly 1 ingredient and the addition wouldn't
  // create a circular dependency.
  attachIngredientToResource(resourceName, targetName) {
    const resourceKey = resourceName.trim().toLowerCase()
    const targetKey = targetName.trim().toLowerCase()
    const target = this.sp.resourceDefinitions?.[targetKey]
    if (!target) throw new Error(`"${targetName}" is not a defined resource`)
    if (target.type === 'Raw') throw new Error('Raw resources have a fixed recipe and cannot take an extra ingredient')
    if (!this.sp.resourceDefinitions?.[resourceKey]) throw new Error(`"${resourceName}" is not a defined resource`)
    if (target.ingredients.length !== 1) throw new Error(`"${targetName}" does not have room for a second ingredient`)
    if (target.ingredients.some(i => i.trim().toLowerCase() === resourceKey)) throw new Error(`"${targetName}" already uses "${resourceName}"`)
    if (this._dependsOn([resourceName], targetKey)) throw new Error(`Adding "${resourceName}" to "${targetName}" would create a circular dependency`)
    target.ingredients = [...target.ingredients, resourceName.trim()]
    this.sp.log.push(`Wired "${resourceName}" in as an ingredient of "${targetName}"`)
    return { ok: true, resourceDefinitions: this.sp.resourceDefinitions, log: this.sp.log }
  }

  // Eligible targets for the "used as an ingredient for" node: existing Resource/Service
  // defs with exactly 1 ingredient so far, excluding anything that would create a cycle
  // if `resourceName` were added as their 2nd ingredient.
  getWiringCandidates(resourceName) {
    const resourceKey = resourceName.trim().toLowerCase()
    return Object.values(this.sp.resourceDefinitions || {})
      .filter(def => def.type !== 'Raw' && def.ingredients.length === 1 && def.name.trim().toLowerCase() !== resourceKey)
      .filter(def => !this._dependsOn([resourceName], def.name.trim().toLowerCase()))
      .map(def => def.name)
  }

  // Does `startNames` (a Commodity's ingredients/specialInput, or a candidate list being
  // considered for one) transitively reach `needleKey`? Used to block circular recipes —
  // e.g. before wiring a new resource in as an existing resource's 2nd ingredient, or
  // before letting a new resource pick an ingredient that would loop back to itself.
  _dependsOn(startNames, needleKey, visited = new Set()) {
    for (const raw of (startNames || [])) {
      if (!raw) continue
      const key = raw.trim().toLowerCase()
      if (key === needleKey) return true
      if (visited.has(key)) continue
      visited.add(key)
      const def = this.sp.resourceDefinitions?.[key]
      if (!def) continue
      const deps = [...(def.ingredients || []), ...(def.specialInput ? [def.specialInput] : [])]
      if (this._dependsOn(deps, needleKey, visited)) return true
    }
    return false
  }

  // A district's consumed Resources/Services are fully derived from the Recipes of
  // everything it produces: Raw producers always consume Labour + Security; Resource/Service
  // producers consume their recipe's ingredients plus its chosen special input. Predefined
  // auto-produced items (Gold, Labour) have no resourceDefinitions entry and derive nothing.
  _deriveConsumption(producedNames) {
    const out = []
    const seen = new Set()
    const add = (name) => {
      if (!name) return
      const key = name.trim().toLowerCase()
      if (!seen.has(key)) { seen.add(key); out.push(name) }
    }
    for (const raw of (producedNames || [])) {
      if (!raw) continue
      const def = this.sp.resourceDefinitions?.[raw.trim().toLowerCase()]
      if (!def) continue
      if (def.type === 'Raw') {
        add('Labour'); add('Security')
      } else {
        for (const ing of (def.ingredients || [])) add(ing)
        if (def.specialInput) add(def.specialInput)
      }
    }
    return out
  }

  addThreat(regionId, description = '', name = '') {
    const regions = this.sp.gameStateManager.worldTerrainData.regions
    const region = regions.find(r => r.id === regionId)
    if (!region) throw new Error(`Region ${regionId} not found`)
    if (!region.isEdge) throw new Error('Threats must be placed on edge regions')
    if (!name?.trim()) throw new Error('A threat must have a name')
    const threat = { id: this.sp.threats.length, regionId, name: name.trim(), description, terrainType: region.assignedType }
    this.sp.threats.push(threat)
    this.sp.log.push(`Added threat "${name.trim()}" at region ${regionId} (${region.assignedType})`)
    return { ok: true, threats: this.sp.threats, log: this.sp.log }
  }

  addTradingDestination(regionId, description = '', name = '', buys = [], sells = [], resourceDefs = []) {
    const regions = this.sp.gameStateManager.worldTerrainData.regions
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
    const trade = { id: this.sp.tradingDestinations.length, regionId, name: tradeName, description, terrainType: region.assignedType, roadPath, bridges, buys: cleanBuys, sells: cleanSells }
    this.sp.tradingDestinations.push(trade)
    this.sp.log.push(`Added trade '${tradeName}' at region ${regionId}: buys [${cleanBuys.join(', ')}], sells [${cleanSells.join(', ')}]`)

    // Register any newly-defined resources — with their player-set GP value (decision:
    // every player-defined resource must always have an initial value), same pattern as
    // assignDistrictType/assignTerrainDistrict/addForeignPowerTrade.
    for (const def of resourceDefs) {
      if (def?.name) this._registerResourceDef(def)
    }
    const PREDEFINED_LOWER = ['gold', 'water', 'labour', 'basic food']
    for (const r of [...cleanBuys, ...cleanSells]) {
      if (!PREDEFINED_LOWER.includes(r.toLowerCase())) this._registerResource(r)
    }

    this.sp.factions.push({ id: this.sp.factions.length, health: 70, type:'trade', typeName: region.assignedType || 'Trade Route', name: tradeName, subclass: null, regionId, standing: {} })

    return { ok: true, tradingDestinations: this.sp.tradingDestinations, trade, factions: this.sp.factions, resourceRegistry: this.sp.resourceRegistry, resourceDefinitions: this.sp.resourceDefinitions, log: this.sp.log }
  }

  _findRoadPath(startRegionId) {
    const regions = this.sp.gameStateManager.worldTerrainData.regions
    const edges = this.sp.gameStateManager.worldTerrainData.edges
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

  // Centreline waypoints of a trade road, following the same terrain-plot BFS the
  // client uses to draw the rendered (red) trade road, so the street road matches
  // it exactly. Returns [{x,y}] (off-map destination → near the city) or null.
  _tradeRoadWaypoints(roadPath) {
    const wt = this.sp.gameStateManager.worldTerrainData
    const terrainPlots = wt?.terrainPlots || []
    const W = wt?.worldSize ?? 50
    if (!roadPath || roadPath.length < 2 || terrainPlots.length === 0) return null

    const pathSet = new Set(roadPath)
    const cityRegionId = roadPath[roadPath.length - 1]
    const cellsByRegion = new Map()
    for (const cell of terrainPlots) {
      if (!cellsByRegion.has(cell.parentRegionId)) cellsByRegion.set(cell.parentRegionId, [])
      cellsByRegion.get(cell.parentRegionId).push(cell)
    }

    const pathCells = []
    for (const regionId of roadPath) for (const cell of (cellsByRegion.get(regionId) || [])) pathCells.push(cell)
    if (pathCells.length === 0) return null
    const cellMap = new Map(pathCells.map(c => [c.id, c]))

    // Adjacency: terrain plots sharing a (quantised) polygon vertex are neighbours.
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
    let terrainPlotPath = null
    while (queue.length > 0) {
      const [curr, currPath] = queue.shift()
      if (cityIds.has(curr)) { terrainPlotPath = currPath; break }
      for (const next of (adj.get(curr) || [])) {
        if (visited.has(next)) continue
        const nextCell = cellMap.get(next)
        if (!nextCell || !pathSet.has(nextCell.parentRegionId)) continue
        visited.add(next)
        queue.push([next, [...currPath, next]])
      }
    }
    if (!terrainPlotPath || terrainPlotPath.length < 2) return null

    const waypoints = []
    for (let i = 0; i < terrainPlotPath.length - 1; i++) {
      const cell = cellMap.get(terrainPlotPath[i])
      if (cell) waypoints.push({ x: cell.seedPoint.x, y: cell.seedPoint.y })
    }
    const cityCell = cellMap.get(terrainPlotPath[terrainPlotPath.length - 1])
    if (cityCell && waypoints.length > 0) {
      const last = waypoints[waypoints.length - 1]
      waypoints.push({ x: (last.x + cityCell.seedPoint.x) / 2, y: (last.y + cityCell.seedPoint.y) / 2 })
    }
    return waypoints.length >= 2 ? waypoints : null
  }

  assignCityEdgeType(edgeId, edgeType, description = '', name = '') {
    const edge = this.sp.gameStateManager.cityDistrictData.edges?.[edgeId]
    if (!edge) throw new Error(`City edge ${edgeId} not found`)
    if (edge.assignedType) throw new Error(`City edge ${edgeId} is already assigned`)

    if (edgeType === 'Docks' && !this.sp._cityEdgeIsNearWater(edgeId)) {
      throw new Error('Docks can only be placed alongside Sea, Lake, or River')
    }

    edge.assignedType = edgeType
    edge.description = description
    edge.name = name?.trim() || ''
    this.sp.districtEdgePlacements.push({ edgeId, edgeType, description, name: edge.name })
    this.sp.log.push(`Assigned ${edgeType} to city edge ${edgeId}`)
    // District z-height Stage 4 (plan "typed-gliding-leaf"): Canal lowers its own
    // centreline points directly on the shared registry — some of those ids are also
    // district boundary corners, so Tier 1/2 IDW (StreetVoronoiGenerator/CityBlockGenerator/
    // PlotVoronoiGenerator) picks up the drop automatically on the next regeneration pass,
    // no separate propagation mechanism needed.
    if (edgeType === 'Canal') {
      applyCanalZDelta(this.sp.gameStateManager.pointRegistry, edge.pointIds)
    }
    // Regenerate streets for any already-typed adjacent districts so the
    // boundary polyline is stamped with the correct type (Stone for Wall, etc.)
    // before the client tries to build the wall/canal mesh.
    this.sp.generateForLocked()
    this.sp._syncDistrictEdgeRegions()
    return { ok: true, log: this.sp.log }
  }

  // Auto-pick a Leadership district from unapplied city districts and commit it.
  // Called when the player skips the Leadership prompt at finishSubdivision.
  autoAssignLeadership() {
    const cityData = this.sp.gameStateManager.cityDistrictData
    const districts = cityData?.districts || []
    const unapplied = districts.filter(d => !d.assignedType)
    if (!unapplied.length) throw new Error('No unapplied districts available to assign Leadership')
    // Pick deterministically by lowest id (stable across reloads).
    const target = unapplied.reduce((a, b) => a.id < b.id ? a : b)
    const VALID_RULING_BODY_CLASSES = ['Monarchy', 'Republic', 'Tyrant', 'Oligarchy', 'Theocracy', 'Anarchist']
    let s = (target.id * 2654435761) >>> 0; s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    const LeadershipClass = VALID_RULING_BODY_CLASSES[(s >>> 0) % VALID_RULING_BODY_CLASSES.length]
    target.assignedType = 'Leadership'
    target.LeadershipClass = LeadershipClass
    target.producedResource = null
    target.secondProducedResource = null
    target.consumedResources = []
    target.description = ''
    target.name = generateName('Leadership', LeadershipClass)
    if (target.streetSeed == null) target.streetSeed = target.id
    this.sp.log.push(`Auto-assigned Leadership (${LeadershipClass}) to district ${target.id}`)
    return { ok: true, districtId: target.id, LeadershipClass, log: this.sp.log }
  }

  assignTerrainDistrict(regionId, plotId, districtType, description = '', producedResource = '', name = '', resourceDefs = []) {
    const regions = this.sp.gameStateManager.worldTerrainData.regions
    const region = regions.find(r => r.id === regionId)
    if (!region) throw new Error(`Region ${regionId} not found`)
    if (plotId && this.sp.terrainDistrictPlots.find(p => p.plotId === plotId)) {
      throw new Error(`Plot ${plotId} already has a terrain district`)
    }
    // Mutual exclusivity with City Expansion (CONTEXT_WorldTerrain.md: a plot promoted
    // to a city District is no longer "unassigned" and cannot also become Forestry/etc.).
    const cityDistricts = this.sp.gameStateManager.cityDistrictData?.districts || []
    if (plotId && cityDistricts.some(d => d.promotedFromPlotId === plotId)) {
      throw new Error(`Plot ${plotId} has already been promoted to a city district.`)
    }

    const VALID = { Forest: 'Forestry', Hills: 'Mining', Plains: 'Agriculture', Lake: 'Fishing', Sea: 'Fishing' }
    if (!VALID[region.assignedType]) throw new Error(`Cannot add a district to ${region.assignedType} regions`)
    if (VALID[region.assignedType] !== districtType) {
      throw new Error(`${region.assignedType} regions only support ${VALID[region.assignedType]} districts`)
    }

    if (!producedResource?.trim()) throw new Error('A district must produce at least one resource')

    const districtName = name?.trim() || ''
    const producedTrimmed = producedResource.trim()

    // Store new resource definitions first so consumption can be derived from them below.
    for (const def of resourceDefs) {
      if (def?.name) this._registerResourceDef(def)
    }

    const PREDEFINED_LOWER = ['gold', 'water', 'labour', 'basic food']
    if (!PREDEFINED_LOWER.includes(producedTrimmed.toLowerCase())) {
      this._registerResource(producedTrimmed)
    }

    // Consumption is fully derived from the Recipe of what's produced, plus the
    // always-implicit Water + Basic Food upkeep (see assignDistrictType for the same rule).
    const derivedConsumed = this._deriveConsumption([producedTrimmed])
    const IMPLICIT_CONSUMED = ['Water', 'Basic Food']
    const allConsumed = [
      ...derivedConsumed,
      ...IMPLICIT_CONSUMED.filter(r => !derivedConsumed.some(e => e.toLowerCase() === r.toLowerCase()))
    ]

    this.sp.terrainDistrictPlots.push({
      plotId,
      regionId,
      districtType,
      description: description?.trim() || '',
      name: districtName,
      producedResource: producedTrimmed,
      consumedResources: allConsumed
    })

    this.sp.factions.push({ id: this.sp.factions.length, health: 70, type:'terrain', typeName: districtType, name: districtName, subclass: null, plotId, regionId, producedResource: producedTrimmed })

    this.sp.log.push(`Assigned ${districtType} district to plot ${plotId} in ${region.assignedType} region ${regionId}`)
    return { ok: true, resourceRegistry: this.sp.resourceRegistry, resourceDefinitions: this.sp.resourceDefinitions, factions: this.sp.factions, log: this.sp.log }
  }

  assignDistrictClass(districtId, districtClass) {
    return this.assignDistrictType(districtId, districtClass)
  }

  // Build the player's Guild: starting Gold, a colour, a Headquarters (optional at creation),
  // an Influence map (50 with every faction, +20 for the HQ district's faction), and 5
  // auto-generated recruits. Ties the Guild to the acting Seat when one is given.
  createPlayerGuild({ name, headquarters = null, seatId = null }) {
    const gsm = this.sp.gameStateManager
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
    this.sp.currentStep = 'Complete'
    this.sp.log.push(`Created guild${guild.name ? ` "${guild.name}"` : ''}${guild.headquarters ? ` (HQ in district ${guild.headquarters.districtId})` : ''}`)
    return { ok: true, guild, log: this.sp.log }
  }

  // Set (or update) a guild's headquarters and recalculate HQ influence/standing.
  // Called when the player picks their HQ after guild creation.
  setGuildHeadquarters(guildId, hq) {
    const gsm = this.sp.gameStateManager
    const guild = [...gsm.guilds.values()].find(g => g.id === guildId)
    if (!guild) throw new Error(`Guild ${guildId} not found`)
    const resolved = this._resolveHeadquarters(hq)
    guild.headquarters = resolved
    if (resolved?.districtId != null) {
      const hqFaction = this.sp.factions.find(x => x.type === 'district' && x.districtId === resolved.districtId)
                     ?? this.sp.factions.find(x => x.type === 'leadership' && x.districtId === resolved.districtId)
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
    this.sp.log.push(`Set headquarters for guild ${guildId}`)
    return { ok: true, guild, log: this.sp.log }
  }

  // Resolve an HQ choice { kind:'plot'|'landmark', refId } to { kind, refId, districtId }.
  _resolveHeadquarters(hq) {
    if (!hq || hq.refId == null) return null
    const cd = this.sp.gameStateManager.cityDistrictData || {}
    let districtId = null
    if (hq.kind === 'plot') {
      districtId = (cd.plots || []).find(p => p.id === hq.refId)?.districtId ?? null
    } else if (hq.kind === 'landmark') {
      districtId = (cd.landmarkBuildings || [])[hq.refId]?.districtId ?? null
    }
    return { kind: hq.kind, refId: hq.refId, districtId }
  }

  _leadershipFaction() {
    return this.sp.factions.find(f => f.type === 'leadership') ?? null
  }

  // Populate Leadership's influence field (60 over all district/leadership factions).
  // Safe to call multiple times — idempotent.
  _finalizeLeadershipInfluence() {
    const lf = this._leadershipFaction()
    if (!lf) return
    for (const f of this.sp.factions) {
      if (f.type === 'trade') continue  // Leadership has no influence over trade routes
      lf.influence[f.id] = 60
    }
  }

  // Populate symmetric standing between all faction pairs. Default 50. Idempotent.
  _initFactionStandings() {
    for (const fa of this.sp.factions) {
      for (const fb of this.sp.factions) {
        if (fa.id === fb.id) continue
        if (fa.standing[fb.id] == null) fa.standing[fb.id] = 50
      }
    }
  }

  // Influence 0 with every faction, Standing 50. +30 influence (soft-capped) and +20 standing for HQ district faction.
  _initGuildRelations(guild) {
    const gsm = this.sp.gameStateManager
    for (const f of this.sp.factions) {
      guild.influence[f.id] = 0
      guild.standing[f.id] = 50
    }
    const hqDistrict = guild.headquarters?.districtId
    if (hqDistrict != null) {
      const hqFaction = this.sp.factions.find(x => x.type === 'district' && x.districtId === hqDistrict)
                     ?? this.sp.factions.find(x => x.type === 'leadership' && x.districtId === hqDistrict)
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

  _rebuildFactions() {
    this.sp.factions = []
    const regions = this.sp.gameStateManager.worldTerrainData?.regions || []
    const districts = this.sp.gameStateManager.cityDistrictData?.districts || []

    for (const district of districts) {
      if (district.assignedType === 'Leadership') {
        this.sp.factions.push({ id: this.sp.factions.length, health: 70, type:'leadership', typeName: 'Leadership', name: district.name || '', subclass: district.LeadershipClass || null, districtId: district.id, influence: {}, standing: {} })
      }
    }
    if (this.sp.terrainDistrictPlots?.length) {
      for (const tDP of this.sp.terrainDistrictPlots) {
        this.sp.factions.push({ id: this.sp.factions.length, health: 70, type:'terrain', typeName: tDP.districtType, name: tDP.name || '', subclass: null, plotId: tDP.plotId, regionId: tDP.regionId, producedResource: tDP.producedResource || '', standing: {} })
      }
    } else {
      // Backwards compat: old saves stored district on the region object
      for (const region of regions) {
        if (region.terrainDistrict) {
          this.sp.factions.push({ id: this.sp.factions.length, health: 70, type:'terrain', typeName: region.terrainDistrict, name: region.terrainDistrictName || '', subclass: null, regionId: region.id, producedResource: region.terrainDistrictProducedResource || '', standing: {} })
        }
      }
    }
    for (const district of districts) {
      if (district.assignedType && district.assignedType !== 'Leadership') {
        this.sp.factions.push({ id: this.sp.factions.length, health: 70, type:'district', typeName: district.assignedType, name: district.name || '', subclass: district.residentialClass || null, districtId: district.id, producedResource: district.producedResource || '', secondProducedResource: district.secondProducedResource || '', standing: {} })
      }
    }
    for (const trade of this.sp.tradingDestinations) {
      const region = regions.find(r => r.id === trade.regionId)
      this.sp.factions.push({ id: this.sp.factions.length, health: 70, type:'trade', typeName: region?.assignedType || 'Trade Route', name: trade.name || '', subclass: null, regionId: trade.regionId, standing: {} })
    }
  }

  addGod({ domains, name, description, seatId }) {
    const god = { id: this.sp.gods.length, domains, name, description, seatId }
    this.sp.gods.push(god)
    // Every god gets an associated Worship Service — any district can consume it, but
    // only a Religious district (aligned to this god) can produce it (see assignDistrictType).
    this._registerResource(`Worship of ${name}`)
    return god
  }

  defineMagicSystem({ conceptType, name, description, seatId }) {
    this.sp.magicSystem = { conceptType, name, description, seatId }
    return this.sp.magicSystem
  }

  refineMagicSystem({ name, description }) {
    if (!this.sp.magicSystem) throw new Error('No magic system defined')
    if (name)        this.sp.magicSystem.name        = name
    if (description) this.sp.magicSystem.description = description
    return this.sp.magicSystem
  }

  addForeignPowerThreat({ fpId, name, description }) {
    const fp = this.sp.foreignPowers.find(f => f.id === fpId)
    if (!fp) throw new Error('Foreign power not found')
    const label = (name || fp.name).trim()
    if (!label) throw new Error('A name is required')
    const threat = { id: this.sp.threats.length, foreignPowerId: fpId, name: label, description: description || '', direction: fp.direction, terrainType: 'foreign-power' }
    this.sp.threats.push(threat)
    this.sp.factions.push({ id: this.sp.factions.length, health: 70, type: 'threat', typeName: 'Foreign Threat', name: label, subclass: null, foreignPowerId: fpId, standing: {} })
    this.sp.log.push(`Declared ${fp.name} as threat: "${label}"`)
    return { ok: true, threats: this.sp.threats, factions: this.sp.factions, log: this.sp.log }
  }

  addForeignPowerTrade({ fpId, name, description, buys = [], sells = [], resourceDefs = [] }) {
    const fp = this.sp.foreignPowers.find(f => f.id === fpId)
    if (!fp) throw new Error('Foreign power not found')
    const label = (name || fp.name).trim()
    if (!label) throw new Error('A name is required')
    // Store new resource definitions (name, gpValue, ingredients) in the registry —
    // same pattern as assignDistrictType/assignTerrainDistrict.
    for (const def of resourceDefs) {
      if (def?.name) this._registerResourceDef(def)
    }
    const dest = { id: this.sp.tradingDestinations.length, foreignPowerId: fpId, name: label, description: description || '', direction: fp.direction, terrainType: 'foreign-power', buys, sells }
    this.sp.tradingDestinations.push(dest)
    this.sp.factions.push({ id: this.sp.factions.length, health: 100, type: 'trade', typeName: 'Foreign Trade', name: label, subclass: null, foreignPowerId: fpId, standing: {} })
    this.sp.log.push(`Defined trade route with ${fp.name}: "${label}"`)
    return { ok: true, tradingDestinations: this.sp.tradingDestinations, factions: this.sp.factions, resourceRegistry: this.sp.resourceRegistry, resourceDefinitions: this.sp.resourceDefinitions, log: this.sp.log }
  }

  addForeignPower({ direction, name, colour, description, seatId }) {
    for (const fp of this.sp.foreignPowers) {
      const diff = Math.abs(((direction - fp.direction) + 360) % 360)
      const gap  = Math.min(diff, 360 - diff)
      if (gap < 45) return { error: 'Too close to existing foreign power' }
    }
    const fp = { id: this.sp.foreignPowers.length, direction, name, colour, description, seatId }
    this.sp.foreignPowers.push(fp)
    return fp
  }
}
