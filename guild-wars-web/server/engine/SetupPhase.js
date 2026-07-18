import TerrainVoronoiGenerator, { organicClipCircle, organicOuterClipRadius } from './CityGenerator/TerrainVoronoiGenerator.js'
import StreetVoronoiGenerator from './CityGenerator/StreetVoronoiGenerator.js'
import CityBlockGenerator, { majorityStreetType, gutterRoadEdges } from './CityGenerator/CityBlockGenerator.js'
import PlotVoronoiGenerator, { markSquareBlocks } from './CityGenerator/PlotVoronoiGenerator.js'
import LandmarkPlacer from './CityGenerator/buildings/LandmarkPlacer.js'
import BuildingTemplateGenerator from './CityGenerator/buildings/BuildingTemplateGenerator.js'
import TextureTemplateGenerator from './CityGenerator/buildings/TextureTemplateGenerator.js'
import { CALC_BLOCKS, CALC_PLOTS } from './pipelineFlags.js'
import { convertTerrainCellsToPlots } from './CityGenerator/TerrainPlotConverter.js'
import GroundPointRegistry from './CityGenerator/GroundPointRegistry.js'
import DCEL, { dedupeConsecutiveIds } from './CityGenerator/DCEL.js'
import { computeRiverCliffBoundaries } from './CityGenerator/riverCliffBoundary.js'
import { applyTerrainTypeZEffect, getRegionCornerIds, computeCliffChainSides, propagateFromPoints, CLIFF_Z_RULE, CLIFF_LERP_T, lerp, applyRiverZGradient } from './CityGenerator/TerrainZHeight.js'
import { applyCanalZDelta } from './CityGenerator/DistrictZHeight.js'
import { auditGroundplane } from './CityGenerator/auditGroundplane.js'
import { pip, clipPolygonToSide, polygonCrossesSegment, computeVoronoiCellsHalfPlane, clipToPolygon } from './voronoi/VoronoiUtils.js'
import { getDistrictConfig } from '../../shared/districtConfig.js'
import { generateName } from '../../shared/nameLibrary.js'
import { extractBoundaryChain, boundaryConnectionAt } from '../../shared/boundaryChain.js'
import { readFileSync, mkdirSync, appendFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Attached/Freestanding/Custom Model are no longer decided here. They're rolled
// per-building, client-side, entirely from plot geometry (see ADR-0019 and
// BuildingRenderer.js) — there is no more server-side blockType/'townhouse' pass.

const _dir = dirname(fileURLToPath(import.meta.url))
let _nameLib = null
let _abilityArrays = null

// Terrain types that represent "the edge of the known world" — assigning one of these
// triggers _revealAdjacentHiddenTerrain (reveal+merge adjacent hidden terrain into the
// assigning region). Regions carrying one of these types have plots that legitimately
// extend to the literal world square rather than the organic clip circle (see
// _revealAdjacentHiddenTerrain's own doc comment and _recoverGeometryFromSeeds' use of
// this same list to know which regions to clip which way on reload).
const TERRAIN_REVEAL_TYPES = ['Desert', 'Mountains', 'Sea', 'Ice Sheet']

// Dev-only diagnostic (user-confirmed 2026-07-14, "will be removed in production"):
// every groundplane sync gets audited and appended to a plain log file, so a manifold
// violation (hole/overlap) can be traced back to exactly which terrain update caused it
// without needing to reproduce it live first.
const AUDIT_LOG_PATH = join(_dir, '../logs/groundplane-audit.log')

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

// For each outer boundary street, cast test points perpendicular to the road and use
// pip to find which terrain plot it faces. Records streetEdges on the terrain plot.
// Boundary connections are identified by: has left/right sides AND right is not a
// city district ID (i.e. not a number) — the "!city" condition.
function computeTerrainPlotStreetAdjacency(streetGraph, terrainPlots) {
  if (!terrainPlots.length || !streetGraph?.junctions?.length) return

  const jPos = new Map(streetGraph.junctions.map(j => [j.id, j]))
  const seenRoads = new Set()
  const TEST_DISTS = [0.1, 0.5, 1.0, 2.0, 5.0]

  for (const j of streetGraph.junctions) {
    for (const conn of (j.connections || [])) {
      // Outer boundary: has left/right fields AND right is not a city district ID
      if (conn.left == null || typeof conn.right === 'number') continue
      if (seenRoads.has(conn.roadId)) continue
      seenRoads.add(conn.roadId)

      const jB = jPos.get(conn.toId)
      if (!jB) continue

      const dx = jB.x - j.x, dy = jB.y - j.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < 1e-10) continue

      const ux = dx / len, uy = dy / len
      const mx = (j.x + jB.x) / 2, my = (j.y + jB.y) / 2

      // Both A→B and B→A connections carry identical left/right, so we don't know
      // which perpendicular is outward. Try both — terrain plots are outside the city
      // so only the outward direction will ever match pip.
      // Probe at 0.25, 0.5, 0.75 fractions along the road to handle short roads where
      // the midpoint probe lands in a junction gap rather than a terrain cell.
      const FRACS = [0.25, 0.5, 0.75]
      let foundPlot = null
      outer: for (const frac of FRACS) {
        const px = j.x + frac * (jB.x - j.x), py = j.y + frac * (jB.y - j.y)
        for (const d of TEST_DISTS) {
          for (const [ox, oy] of [[uy, -ux], [-uy, ux]]) {
            const tx = px + ox * d, ty = py + oy * d
            for (const plot of terrainPlots) {
              if (pip(tx, ty, plot.blockCorners)) { foundPlot = plot; break outer }
            }
          }
        }
      }

      if (!foundPlot) continue

      // Closest polygon edge of the terrain plot to the street midpoint (by edge midpoint)
      const corners = foundPlot.blockCorners
      const n = corners.length
      let bestIdx = 0, bestDistSq = Infinity
      for (let i = 0; i < n; i++) {
        const va = corners[i], vb = corners[(i + 1) % n]
        const emx = (va.x + vb.x) / 2, emy = (va.y + vb.y) / 2
        const dsq = (emx - mx) ** 2 + (emy - my) ** 2
        if (dsq < bestDistSq) { bestDistSq = dsq; bestIdx = i }
      }

      foundPlot.streetEdges.push({ index: bestIdx, roadId: conn.roadId, type: conn.type })
    }
  }
}


// Distinct guild colours (by creation order), used by the Influence map overlay.
const GUILD_COLORS = ['#e6453c', '#3c7de6', '#37a85a', '#d9a528', '#9b59d9', '#e67ec2']

export default class SetupPhase {
  constructor(gameStateManager) {
    this.gameStateManager = gameStateManager
    this.currentStep = 'Terrain'
    this.log = []
    // Stateless utility instance (no per-generation state — generateBoundaryEdges,
    // convexHull etc. work standalone) — constructed here, not just inside
    // initialize(), so it's never null after a server restart that loads an existing
    // save instead of calling initialize() fresh. _revealAdjacentHiddenTerrain relies
    // on this being present; before this fix a restart-then-reveal threw
    // "Cannot read properties of null (reading 'convexHull')", silently failing the
    // whole assignment before autoSave/broadcast ever ran (confirmed live 2026-07-12).
    this.worldGenerator = new TerrainVoronoiGenerator()
    this.selectedRegionId = null
    this.selectedDistrictId = null
    this.terrainPlacements = []
    this.edgePlacements = []
    this.districtTypePlacements = []
    this.districtEdgePlacements = []
    this.districtClassAssignments = new Map()
    this.resourceRegistry = []
    this.resourceDefinitions = {}
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

  // Generates the world, then runs auditGroundplane (server/engine/CityGenerator/
  // auditGroundplane.js) against the resulting terrain plots — user-confirmed
  // 2026-07-13, prompted by a live-observed hole in the generated terrain. Only checks
  // HOLE count (not OVERLAP/PINCH/AREA_OVERLAP — those are a separate, not-yet-
  // requested concern): auditGroundplane's own onWorldBoundary check already excludes
  // the map's outer edge from HOLE findings ("exclude the outside edges" — a genuine
  // gap at the edge of the generated world is expected, not a bug), so any remaining
  // HOLE finding is a real interior gap. Retries generation from scratch (fresh
  // registry each time — clearKind('terrain') wipes the failed attempt's points, since
  // nothing else has been built yet this early in initialize()) up to maxAttempts times;
  // ships the last attempt's result with a warning if it never comes back clean rather
  // than hanging New Game indefinitely.
  _generateWorldWithHoleCheck(regionCount, worldSize, mergeDistance, manhattan, maxAttempts = 5) {
    const registry = this.gameStateManager.pointRegistry
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) registry.clearKind('terrain')
      const worldData = this.worldGenerator.generate(regionCount, worldSize, mergeDistance, manhattan, registry)
      // worldData.terrainPlots now holds kept + hidden plots merged (tagged via
      // `.hidden`) — the audit still wants both included, so no filtering here; the
      // id prefix keeps kept/hidden cell ids from colliding, same as the old two-array
      // split did with separate `tp:`/`htp:` prefixes.
      const surfaces = worldData.terrainPlots.map(p => ({
        id: `${p.hidden ? 'htp' : 'tp'}:${p.id}`,
        kind: 'terrain-plot',
        pointIds: p.pointIds
      }))
      const groundplane = { points: registry.toJSON(), surfaces, terrain: { worldSize } }
      const { counts, boundaryEdgeKeys } = auditGroundplane(groundplane)
      if (counts.HOLE === 0) {
        if (attempt > 1) this.log.push(`Terrain generation succeeded on attempt ${attempt} (hole-free)`)
        // User-specified design: compute the map's outer ring of edges ONCE, right here
        // (a hole-free generation's boundaryEdgeKeys IS exactly that ring, nothing else —
        // every other unpaired edge would have shown up as a HOLE finding and failed the
        // check above), and treat it as permanently exempt from HOLE reporting for the
        // rest of the game — every subsequent audit (Cliff/River/Berm splits, District→
        // Street→Block→Plot generation, all wired through _auditAndLogGroundplane) reads
        // this same set, so a genuinely NEW gap near the map edge is no longer masked by
        // onWorldBoundary's radius heuristic (which this replaces as the primary test —
        // see auditGroundplane.js).
        this.gameStateManager.groundplane.outerRingEdgeKeys = boundaryEdgeKeys
        this.log.push(`Outer ring: ${boundaryEdgeKeys.length} boundary edge(s) marked permanently exempt from hole audits`)
        return worldData
      }
      console.warn(`[SetupPhase] Terrain generation attempt ${attempt}/${maxAttempts} has ${counts.HOLE} hole(s) (excluding world boundary) — ${attempt < maxAttempts ? 'retrying' : 'giving up, shipping anyway'}`)
      if (attempt === maxAttempts) {
        this.gameStateManager.groundplane.outerRingEdgeKeys = boundaryEdgeKeys
        return worldData
      }
    }
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
    this.resourceDefinitions = {}
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
    // mergeDistance 0.02 (was 0, user-confirmed 2026-07-14): Step 1.5's
    // mergeNearbyVertices exists specifically to merge near-coincident circumcenters at
    // complex multi-region junctions, but sat permanently disabled (mergeDistance=0)
    // since this call was first written. Root-caused live via a save file: two raw
    // 'terrain' points 0.0114 apart — a genuine near-miss circumcenter pair at a 4+-way
    // junction, never merged — each independently got zLocked by its own Ice Sheet
    // domain pass (slightly different jittered z) and then each independently split by
    // the Cliff pullback, producing a visible 4-point cluster/gap where the user should
    // have seen one clean shared corner. 0.02 comfortably covers that case (and the
    // general class of near-cocircular-circumcenter noise this function's own doc
    // comment describes) while staying far below real inter-point spacing (~1.6 units
    // average at this world's density), so it can't merge two legitimately distinct
    // corners.
    const worldData = this._generateWorldWithHoleCheck(15, 50, 0.02, 0)
    this.gameStateManager.worldTerrainData = worldData
    this.log.push(`Generated ${worldData.regions.length} terrain regions`)

    // region.isEdge already set by the generator (Step 3.7/Step 5's void-adjacency
    // scan — see TerrainVoronoiGenerator.js) — the organic world boundary means "edge"
    // is now a real adjacency fact from generation, not a post-hoc square-touching
    // geometry test. isNorthEdge still needs computing here (a SetupPhase-only
    // gameplay concept, Ice Sheet gating) — see isNorthOfCentre's doc comment for why
    // it's angular now instead of a literal straight-edge test.
    const worldSize = 50
    for (const region of worldData.regions) {
      region.isNorthEdge = region.isEdge && this.isNorthOfCentre(region, worldSize)
    }

    const cityRegion = this.findCityRegion(worldData.regions, worldSize)
    if (cityRegion) {
      cityRegion.assignedType = 'City'
      for (const cell of worldData.terrainPlots || [])
        if (cell.parentRegionId === cityRegion.id) cell.assignedType = 'City'
      this.log.push(`Identified city region: Region ${cityRegion.id}`)

      const cityTerrainPlots = worldData.terrainPlots.filter(c => c.parentRegionId === cityRegion.id)
      const cityData = this.generateCityDistrictData(cityTerrainPlots)
      this.gameStateManager.cityDistrictData = cityData
      this.log.push(`Generated ${cityData.districts.length} city districts`)
    }

    this.currentStep = 'Terrain'
    return {
      step: this.currentStep,
      regions: worldData.regions,
      terrainPlots: worldData.terrainPlots,
      edges: worldData.edges,
      edgePoints: worldData.edgePoints,
      pointRegistry: this.gameStateManager.pointRegistry.toJSON(),
      log: this.log
    }
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

  // City region = whichever region's polygon actually CONTAINS the map's centre point
  // (TODO.md; organic-world plan "federated-baking-dragon") — replaces the old
  // "largest non-edge region by terrain-plot count" heuristic, which existed only
  // because a forced-square world had no other natural notion of "the middle."
  findCityRegion(regions, worldSize = 50) {
    const cx = worldSize / 2, cy = worldSize / 2
    const containing = regions.find(r => r.polygon?.length >= 3 && pip(cx, cy, r.polygon))
    if (containing) return containing
    // Fallback (rare: centre lands exactly on a shared boundary edge, so neither
    // region's polygon strictly contains it) — nearest region by seed distance to
    // centre, keeping the old function's "always returns something" guarantee.
    return regions.reduce((a, b) => {
      const da = (a.seedPoint.x - cx) ** 2 + (a.seedPoint.y - cy) ** 2
      const db = (b.seedPoint.x - cx) ** 2 + (b.seedPoint.y - cy) ** 2
      return da <= db ? a : b
    })
  }

  // "North" = the y=0 side of the map (low Z in 3D, the far side as seen from default
  // camera) — same convention `touchesNorthBoundary` used, but angular now that the
  // world boundary is organic (TerrainVoronoiGenerator's centre-selection) rather than
  // a literal straight edge: qualifies if the bearing from map-centre to the region's
  // seedPoint falls within NORTH_HALF_ANGLE_DEG of due north (0°=north, clockwise).
  // Callers must also check region.isEdge — this only answers "which direction," not
  // "is it actually on the world's outer boundary."
  static NORTH_HALF_ANGLE_DEG = 60

  isNorthOfCentre(region, worldSize) {
    const cx = worldSize / 2, cy = worldSize / 2
    const dx = region.seedPoint.x - cx, dy = region.seedPoint.y - cy
    if (dx === 0 && dy === 0) return false
    const bearing = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360
    return bearing <= SetupPhase.NORTH_HALF_ANGLE_DEG || bearing >= 360 - SetupPhase.NORTH_HALF_ANGLE_DEG
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

    // Ice Sheet and Desert are mutually exclusive world-wide (not just adjacency, unlike
    // Sea/Lake below) — the first one placed anywhere on the map fixes the whole world's
    // climate as "cold" or "hot", ruling out the other for the rest of the game.
    if (terrainType === 'Ice Sheet' || terrainType === 'Desert') {
      const forbidden = terrainType === 'Ice Sheet' ? 'Desert' : 'Ice Sheet'
      if (regions.some(r => r.assignedType === forbidden)) {
        throw new Error(`${terrainType} cannot be placed — ${forbidden} already exists on this map`)
      }
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
    const rawCells = this.gameStateManager.worldTerrainData?.terrainPlots || []
    for (const cell of rawCells)
      if (cell.parentRegionId === region.id) cell.assignedType = terrainType
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

    // Ice Sheet next to Ice Sheet: there are no valid edge types between two Ice Sheets
    // (user-confirmed, plan "rustling-churning-finch" addendum) — clear whatever's
    // there, same as Sea/Lake clearing River above, but ANY assignedType (not just
    // River): the auto-cliff block just above unconditionally Cliffs every unassigned
    // edge touching THIS region, including one that borders an ALREADY-placed Ice
    // Sheet, and it never gets cleared afterwards on its own (only an unassigned edge
    // qualifies for auto-cliffing, so once Cliffed it's permanently skipped by every
    // later Ice Sheet's own auto-cliff pass too) — confirmed live 2026-07-13, "Sea to
    // Sea reconnects after removing the edge, but Ice Sheet to Ice Sheet doesn't."
    if (terrainType === 'Ice Sheet') {
      const edges = this.gameStateManager.worldTerrainData.edges
      for (const [edgeId, edge] of Object.entries(edges)) {
        if (!edge.assignedType) continue
        const otherId = edge.regionA === regionId ? edge.regionB : edge.regionB === regionId ? edge.regionA : null
        if (otherId === null) continue
        const other = regions.find(r => r.id === otherId)
        if (other?.assignedType !== 'Ice Sheet') continue
        edge.assignedType = null
        edge.description = ''
        this.edgePlacements = this.edgePlacements.filter(p => p.edgeId !== edgeId)
        this.log.push(`Cleared ${edgeId}'s edge type — no valid edge type between two Ice Sheets`)
        clearedEdgeIds.push(edgeId)
      }
    }

    // Restored (2026-07-11, after a same-day revert-and-re-revert): pullback runs here
    // again, during Terrain Setup, NOT deferred to District mode. The deferral (tried
    // earlier today) broke District-mode block/plot generation catastrophically: a
    // district's boundary pointIds are only re-adopted from its originating terrain
    // plot's CURRENT pointIds when their lengths match (see _applyRiverCliffPullback's
    // adoption loop) — but a district's own _rawPointIds snapshot is frozen at whatever
    // its pointIds were on its FIRST pullback call ever. With pullback deferred, a
    // district got created (and took that snapshot) from RAW, unsplit terrain geometry;
    // the first real pullback (adding confluence-split vertices) then happened later,
    // permanently mismatching the frozen raw length against the new, larger current
    // length. Adoption failed forever for most districts (confirmed live: "2/9 adopted"),
    // leaving their pointIds — and every edge derived from them, especially the outer
    // city-boundary edges — orphaned, referencing point ids the next pass's clearKind()
    // deletes outright. That's what broke "boundary streets" and left most blocks
    // uncovered (black voids): the face tracer can't close a loop through a boundary
    // edge whose points no longer resolve. The stroke-rendering revert in
    // TerrainRenderer.js (client-side only) already fully solves the ORIGINAL visual
    // complaint (notches in Terrain mode) on its own — the deferral was never actually
    // needed for that, and is unsafe for the reasons above.
    if (autoCliffEdgeIds.length || clearedEdgeIds.length) this._applyRiverCliffPullbackToTerrainPlots()

    // Sea/Mountains/Desert/Ice Sheet represent "the edge of the known world" — reveal
    // and absorb whatever hidden terrain borders this region directly (see
    // _revealAdjacentHiddenTerrain's doc comment).
    let revealedRegionIds = [], newEdgeIds = []
    if (TERRAIN_REVEAL_TYPES.includes(terrainType)) {
      ;({ revealedRegionIds, newEdgeIds } = this._revealAdjacentHiddenTerrain(regionId, terrainType))
    }

    // Terrain z-height (§3/§4 minus Cliff, plan "rustling-churning-finch", ADR-0021):
    // runs on Apply, not on preview/selection — this IS Apply, `region.assignedType`
    // above is the commit point. Deliberately placed AFTER the reveal-hidden-terrain
    // block above, not right after `region.assignedType` is set: Sea/Mountains/Desert/
    // Ice Sheet can absorb hidden terrain plots into this SAME region here, and Sea's
    // whole-domain flatten-and-lock (see applyTerrainTypeZEffect) must see the region's
    // FINAL plot membership, including anything just revealed/absorbed — running earlier
    // would silently miss those plots' points (confirmed live: an edge-of-map Sea left
    // its newly-revealed hidden water unflattened). "Adjust, don't freeze" still holds
    // for every OTHER type: a later-Applied neighbour's own effect can still adjust this
    // region's already-set corners afterward — nothing about this call prevents that,
    // since it only ever touches `.z`, never `.assignedType`.
    // Hidden (generated-but-unrendered) terrain plots are included alongside the kept
    // ones (user-confirmed 2026-07-14, "those terrains are only hidden — they should
    // still be getting height updates resultant of nearby hills etc changes"): a hidden
    // plot's own domain never matches `region.id` (it belongs to a different, hidden
    // region) so the DOMAIN write above is unaffected — this only widens the fine
    // Point/Edge graph propagateFromRegion walks, so a wave from a kept region's Apply
    // can now actually cross into hidden territory instead of stopping dead at the
    // kept/hidden boundary.
    applyTerrainTypeZEffect(
      this.gameStateManager.pointRegistry,
      region,
      getRegionCornerIds(this.gameStateManager.worldTerrainData.edges, regionId),
      this.gameStateManager.worldTerrainData.terrainPlots || [],
      this.gameStateManager.worldTerrainData.regions || []
    )

    return { ok: true, clearedEdgeIds, autoCliffEdgeIds, revealedRegionIds, newEdgeIds, log: this.log }
  }

  // "Which hidden region(s) does this KEPT region border" — replaces the former
  // persisted `wt.hiddenNeighborsByRegion` map with an on-demand query over `wt.edges`,
  // which already carries `regionA`/`regionB` on every edge (kept↔hidden and
  // hidden↔hidden pairs included — generateBoundaryEdges builds the full adjacency
  // graph unconditionally, not just kept-kept). Only ever meaningful for a kept
  // `regionId` (a hidden region never gets an isEdge/reveal concept of its own), same
  // as the removed map's original KEPT-regionA-only bookkeeping.
  _hiddenNeighborsOf(regionId) {
    const wt = this.gameStateManager.worldTerrainData
    const keptSet = new Set(wt.regions.filter(r => !r.hidden).map(r => r.id))
    const found = new Set()
    for (const edge of Object.values(wt.edges)) {
      if (edge.regionA === regionId && !keptSet.has(edge.regionB)) found.add(edge.regionB)
      else if (edge.regionB === regionId && !keptSet.has(edge.regionA)) found.add(edge.regionA)
    }
    return [...found]
  }

  // Sea/Mountains/Desert/Ice Sheet only ever get placed on an `isEdge` region — the
  // organic-world boundary means "edge" is literally "borders hidden (generated but
  // unrendered) terrain" (see TerrainVoronoiGenerator's circle-partition design). For
  // these four types specifically there's no real conceptual boundary between "our"
  // Sea and the Sea beyond it, so instead of leaving that hidden territory dark
  // forever, reveal it and merge it directly into the assigning region — same id,
  // same assignedType, no Terrain Edge needed between the two (they're one region
  // now). The newly-exposed area's own outer edge can, though, newly touch OTHER
  // already-kept regions it didn't border before; those get ordinary new Terrain
  // Edges, same as any other kept-kept boundary. Single ring only — reveals exactly
  // the hidden region(s) directly adjacent to `regionId`, not a cascade into hidden-
  // neighbours-of-hidden-neighbours.
  _revealAdjacentHiddenTerrain(regionId, terrainType) {
    const wt = this.gameStateManager.worldTerrainData
    const hiddenIds = this._hiddenNeighborsOf(regionId)
    if (!hiddenIds?.length) return { revealedRegionIds: [], newEdgeIds: [] }

    const registry = this.gameStateManager.pointRegistry
    const worldSize = wt.worldSize || 50
    // Organic outer-ring clip circle (NEVER the literal world square — user-confirmed
    // 2026-07-14, "I never want these to be square, remove whatever is making it
    // square, and make it never happen") — the exact same clip shape generate()'s Step
    // 5.5 gives every kept plot at generation time (TerrainVoronoiGenerator.js). A
    // literal `[0,worldSize]` square clip was used here before the outer-ring rewrite
    // (2026-07-13) replaced Step 5.5's own square clip with this organic circle; this
    // reveal path was never updated to match, so a revealed plot came out square-cut
    // even though every plot kept from the start never does.
    const outerClipCircle = organicClipCircle(worldSize, 48, organicOuterClipRadius(worldSize))

    // Flip `hidden` in place rather than moving objects between separate arrays —
    // hidden regions/plots already live in wt.regions/wt.terrainPlots (merged, tagged
    // via `.hidden`), so "revealing" them is exactly the one-field update the merge was
    // meant to enable.
    const hiddenIdSet = new Set(hiddenIds)
    const revealedPlots = wt.terrainPlots.filter(p => p.hidden && hiddenIdSet.has(p.parentRegionId))
    for (const p of revealedPlots) p.hidden = false
    for (const r of wt.regions) if (hiddenIdSet.has(r.id)) r.hidden = false

    // Clip each revealed plot to the same organic outer clip circle every kept plot
    // already gets at generation time. Hidden plots already receive this exact clip
    // uniformly with kept ones at generation (Step 5.5), so this is a re-clip against
    // an unchanged polygon in the common case — kept for safety/idempotency rather than
    // because hidden plots are known to still need it.
    //
    // Collect every brand-new (not-yet-id'd) clip vertex across ALL revealed plots
    // FIRST, then dedupe them together in one pass — the exact same technique
    // generate()'s Step 5.5 already uses for this identical situation (user-confirmed
    // 2026-07-14, traced live via a duplicate-coordinate 'terrain' point pair: two
    // adjacent revealed plots whose shared boundary crosses the clip circle each
    // computed their OWN intersection point independently — Sutherland-Hodgman clipping
    // isn't guaranteed to land on the bit-identical point when the same physical
    // crossing is traversed in opposite directions by each plot's own polygon winding —
    // and this loop used to call registry.create() directly per vertex with NO
    // deduplication at all, minting two separate ids for what should be one shared
    // corner. That stray duplicate then persists forever: nothing else in the pipeline
    // ever merges two already-distinct 'terrain' points after the fact, only prevents
    // minting new ones going forward.)
    const revealZ = wt.regions.find(r => r.id === regionId)?.seedPoint?.z ?? 0
    const clippedPlots = []
    const newClipVertices = []
    for (const plot of revealedPlots) {
      const clipped = clipToPolygon(plot.polygon, outerClipCircle)
      if (!clipped) continue
      plot.polygon = clipped
      clippedPlots.push(plot)
      for (const v of clipped) if (v.id === undefined) newClipVertices.push(v)
    }
    // z: the revealing region's current z rather than a hardcoded 0 — Sea/Lake
    // immediately overwrite every domain point's z below regardless (see
    // applyTerrainTypeZEffect), but Mountains/Desert/Ice Sheet only ever write
    // boundary-corner z, so a freshly-minted INTERIOR vertex here would otherwise be
    // stuck at 0 forever (a flat pit inside e.g. a revealed Mountains plot). mintDeduped
    // itself always creates a NEW point at z=0, so that's patched on right after — but
    // ONLY for ids that didn't already exist before this call (reuseExisting can hand
    // back an EXISTING point with a real, already-correct z from elsewhere; overwriting
    // that unconditionally would be a regression, not the fix).
    const existingIdsBefore = new Set(registry.toJSON().map(p => p.id))
    const dedupedClipIds = registry.mintDeduped(newClipVertices, 'terrain', 0.01, { reuseExisting: true })
    newClipVertices.forEach((v, i) => {
      v.id = dedupedClipIds[i]
      if (existingIdsBefore.has(v.id)) return   // reused an existing point — leave its z alone
      const p = registry.get(v.id)
      if (p) p.z = revealZ
    })
    for (const plot of clippedPlots) {
      plot.pointIds = plot.polygon.map(v => v.id)
      plot.parentRegionId = regionId
      plot.assignedType = terrainType
      // No push here — the plot is already resident in wt.terrainPlots (merged array),
      // only its fields are updated in place.
    }

    // Rebuild the revealing region's own merged-hull polygon (click hit-testing
    // fallback only — see generate()'s Step 6 doc comment) now that it includes the
    // newly-merged plots.
    const region = wt.regions.find(r => r.id === regionId)
    const allVerts = []
    for (const p of wt.terrainPlots) {
      if (p.parentRegionId !== regionId) continue
      for (const v of p.polygon) if (isFinite(v.x) && isFinite(v.y)) allVerts.push(v)
    }
    region.polygon = this.worldGenerator.convexHull(allVerts)
    // Staleness bug fix: the hull rebuild above used to update `.polygon` without ever
    // refreshing `.pointIds` to match — every vertex here already carries a real
    // registry id (they come from already-minted plot polygons), so this is a direct
    // map, no fresh minting needed. Mirrors _recoverGeometryFromSeeds's own region-hull
    // refresh (SetupPhase.js, its own `r.pointIds = hull.map(v => v.id)` line).
    region.pointIds = region.polygon.map(v => v.id)

    // Recompute boundary edges fresh over the CURRENT plot set (kept + still-hidden)
    // — the exact same adjacency scan generate() used initially. generateBoundaryEdges
    // now builds the FULL edge graph unconditionally (TerrainVoronoiGenerator.js,
    // 2026-07-13), so an edge between regionId and this hidden neighbour — or between
    // two still-hidden regions — likely already exists in `wt.edges`, but with STALE
    // geometry: hidden plots are never clipped to the world square until revealed
    // (just above), so their pre-generated edge pointIds can reference vertices well
    // outside [0,worldSize]. Refresh any edge whose BOTH sides just became shown
    // (kept) with this fresh post-clip computation — but never touch one the player
    // has already assigned a type to. An edge with at least one side still hidden is
    // stored if missing (keeps the full graph complete for a future reveal) and
    // otherwise left alone.
    // wt.regions now contains hidden regions too (merged, tagged via `.hidden`) — this
    // used to be implicitly kept-only because hidden regions lived in a separate array;
    // an explicit filter now preserves that original meaning.
    const keptSet = new Set(wt.regions.filter(r => !r.hidden).map(r => r.id))
    const raw = this.worldGenerator.generateBoundaryEdges(wt.terrainPlots, keptSet)

    const newEdgeIds = []
    for (const [key, edge] of Object.entries(raw.edges)) {
      const bothShown = keptSet.has(edge.regionA) && keptSet.has(edge.regionB)
      const existing = wt.edges[key]
      if (!existing) {
        wt.edges[key] = edge
        if (bothShown) newEdgeIds.push(key)
      } else if (bothShown && !existing.assignedType) {
        wt.edges[key] = edge
        newEdgeIds.push(key)
      }
    }

    // Only regionId's own adjacency changed (its footprint grew) — every other
    // region's neighbours are unaffected. isEdge is the only per-region bookkeeping
    // still refreshed here; "which hidden regions border regionId" is no longer
    // persisted at all — _hiddenNeighborsOf computes it on demand from wt.edges.
    region.isEdge = raw.regionIdsTouchingVoid.has(regionId)

    this.log.push(`Revealed ${revealedPlots.length} hidden terrain plot(s) (region${hiddenIds.length > 1 ? 's' : ''} ${hiddenIds.join(', ')}) into region ${regionId} (${terrainType}); added ${newEdgeIds.length} new Terrain Edge(s)`)

    return { revealedRegionIds: hiddenIds, newEdgeIds }
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
    // River z-gradient MUST run before the pullback/split below, not after (plan
    // "typed-gliding-leaf", user-confirmed 2026-07-14, "left/right banks of a river must
    // always remain at the same z-height"): the pullback mints each bank corner as its
    // own registry point, snapshotting z from the raw centreline point at THAT moment
    // (_dcelPullbackMaterialize's posFor copies `base.z` unchanged for a River — no
    // per-side differentiation the way Cliff gets). Grading the centreline first, then
    // splitting, means both bank copies snapshot the SAME already-correct z for free —
    // no separate bank-sync step needed. Grading AFTER the split (the original order)
    // would edit the raw point too late: the split copies already exist with their own
    // frozen z, and wouldn't pick up the change until some later, unrelated pullback
    // recompute. Defining a River doesn't itself trigger propagation elsewhere
    // ("adjust, don't freeze"'s one exception) — this only grades the River's OWN path,
    // reading whatever z already exists at each endpoint/crossing right now.
    if (edgeType === 'River') {
      const wt = this.gameStateManager.worldTerrainData
      const cliffPointIds = new Set()
      for (const e of Object.values(wt.edges)) {
        if (e.assignedType === 'Cliff') for (const pid of e.pointIds || []) cliffPointIds.add(pid)
      }
      applyRiverZGradient(this.gameStateManager.pointRegistry, edge, cliffPointIds)
    }
    // Restored (2026-07-11) — see assignTerrainToRegion's matching comment for why
    // deferring this to District mode broke block/plot generation.
    if (edgeType === 'River' || edgeType === 'Cliff') this._applyRiverCliffPullbackToTerrainPlots()
    return { ok: true, log: this.log }
  }

  // Apply = lock the district in (final). The type may already have been set by
  // previewDistrictType; here we validate resources, commit them, and lock.
  assignDistrictType(districtId, districtType, description = '', producedResource = '', residentialClass = null, LeadershipClass = null, secondProducedResource = '', name = '', resourceDefs = []) {
    const district = this.gameStateManager.cityDistrictData.districts.find(d => d.id === districtId)
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
      const existing = this.gameStateManager.cityDistrictData.districts.find(d => d.id !== districtId && d.assignedType === 'Leadership')
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
      const conflict = this.gameStateManager.cityDistrictData.districts.find(d =>
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
    this.districtTypePlacements.push({ districtId, districtType, residentialClass, LeadershipClass, description, producedResource: district.producedResource, secondProducedResource: district.secondProducedResource, consumedResources: district.consumedResources })
    this.log.push(`Assigned ${displayType} to district ${districtId}`)

    const PREDEFINED_LOWER = ['gold', 'water', 'labour', 'basic food']
    if (district.producedResource && !PREDEFINED_LOWER.includes(district.producedResource.toLowerCase())) {
      this._registerResource(district.producedResource)
    }
    if (district.secondProducedResource && !PREDEFINED_LOWER.includes(district.secondProducedResource.toLowerCase())) {
      this._registerResource(district.secondProducedResource)
    }

    if (isLeadership) {
      const insertIdx = this.factions.findIndex(f => f.type !== 'leadership')
      const faction = { id: this.factions.length, health: 70, type:'leadership', typeName: 'Leadership', name: district.name, subclass: LeadershipClass || null, districtId, influence: {}, standing: {} }
      if (insertIdx === -1) this.factions.push(faction)
      else this.factions.splice(insertIdx, 0, faction)
    } else {
      this.factions.push({ id: this.factions.length, health: 70, type:'district', typeName: districtType, name: district.name, subclass: residentialClass || null, districtId, producedResource: district.producedResource || '', secondProducedResource: district.secondProducedResource || '', standing: {} })
    }

    // Commit: freeze the street seed, lock the district, and regenerate.
    if (district.streetSeed == null) district.streetSeed = district.id
    district.locked = true

    // Auto-walling: roll per District Edge adjacent to this newly locked district.
    // The locking district is the initiator — its probability is used regardless of
    // the neighbour's. Pre-existing manual assignments are never overridden.
    this._applyAutoWalling(districtId)

    this.generateForLocked()
    this._removeAbsorbedDistrictEdgePlacements()

    return { ok: true, resourceRegistry: this.resourceRegistry, resourceDefinitions: this.resourceDefinitions, factions: this.factions, log: this.log }
  }

  // Roll per-edge Wall assignment for a newly locked district. Uses the locking
  // district's walledChance (internal edges) and externalWalledChance (outer boundary).
  // Pre-existing assignedType on any edge is always respected — never overridden.
  _applyAutoWalling(districtId) {
    const cityData = this.gameStateManager.cityDistrictData
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
        this.districtEdgePlacements.push({ edgeId, assignedType: 'Wall', districtId })
        this.log.push(`Auto-walled edge ${edgeId} for district ${districtId}`)
      }
    }
  }

  // Provisionally set a district's type/class (no resource validation, no lock) and
  // generate its preview streets/plots/buildings. Called when the player picks a type
  // so streets appear immediately, before they fill in resources or click Apply.
  previewDistrictType(districtId, districtType, residentialClass = null, LeadershipClass = null) {
    const district = this.gameStateManager.cityDistrictData?.districts?.find(d => d.id === districtId)
    if (!district) throw new Error(`District ${districtId} not found`)
    if (district.locked) throw new Error(`District ${districtId} is locked`)

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

  // type: 'Raw' | 'Resource' | 'Service'. Raw items have a fixed recipe (Labour + Security)
  // and never store player-chosen ingredients/specialInput. rawSubtype ('Food'|'Resource')
  // applies only to Raw; tradeCategory ('Entertainment'|'Tradeable') applies only to Service.
  // specialInput is one concrete resource name — 'Labour', 'Gold', or a specific
  // "Worship of <god>" — never Water/Basic Food (those are a separate per-round upkeep,
  // not a Recipe ingredient), and never a Worship value when the Commodity being defined
  // is itself Worship (no self-reference).
  _registerResourceDef({ name, gpValue, ingredients, type, rawSubtype, specialInput, tradeCategory }) {
    if (!this.resourceDefinitions) this.resourceDefinitions = {}
    const key = name.trim().toLowerCase()
    if (this.resourceDefinitions[key]) return // already defined — first write wins

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

    this.resourceDefinitions[key] = def
    this._registerResource(name)
  }

  // Wires an already-registered resource in as an EXISTING target resource's second
  // ingredient (the "used as an ingredient for" node in the New Resource dialog). Only
  // legal when the target currently has exactly 1 ingredient and the addition wouldn't
  // create a circular dependency.
  attachIngredientToResource(resourceName, targetName) {
    const resourceKey = resourceName.trim().toLowerCase()
    const targetKey = targetName.trim().toLowerCase()
    const target = this.resourceDefinitions?.[targetKey]
    if (!target) throw new Error(`"${targetName}" is not a defined resource`)
    if (target.type === 'Raw') throw new Error('Raw resources have a fixed recipe and cannot take an extra ingredient')
    if (!this.resourceDefinitions?.[resourceKey]) throw new Error(`"${resourceName}" is not a defined resource`)
    if (target.ingredients.length !== 1) throw new Error(`"${targetName}" does not have room for a second ingredient`)
    if (target.ingredients.some(i => i.trim().toLowerCase() === resourceKey)) throw new Error(`"${targetName}" already uses "${resourceName}"`)
    if (this._dependsOn([resourceName], targetKey)) throw new Error(`Adding "${resourceName}" to "${targetName}" would create a circular dependency`)
    target.ingredients = [...target.ingredients, resourceName.trim()]
    this.log.push(`Wired "${resourceName}" in as an ingredient of "${targetName}"`)
    return { ok: true, resourceDefinitions: this.resourceDefinitions, log: this.log }
  }

  // Eligible targets for the "used as an ingredient for" node: existing Resource/Service
  // defs with exactly 1 ingredient so far, excluding anything that would create a cycle
  // if `resourceName` were added as their 2nd ingredient.
  getWiringCandidates(resourceName) {
    const resourceKey = resourceName.trim().toLowerCase()
    return Object.values(this.resourceDefinitions || {})
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
      const def = this.resourceDefinitions?.[key]
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
      const def = this.resourceDefinitions?.[raw.trim().toLowerCase()]
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

  addTradingDestination(regionId, description = '', name = '', buys = [], sells = [], resourceDefs = []) {
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

    this.factions.push({ id: this.factions.length, health: 70, type:'trade', typeName: region.assignedType || 'Trade Route', name: tradeName, subclass: null, regionId, standing: {} })

    return { ok: true, tradingDestinations: this.tradingDestinations, trade, factions: this.factions, resourceRegistry: this.resourceRegistry, resourceDefinitions: this.resourceDefinitions, log: this.log }
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

  // Centreline waypoints of a trade road, following the same terrain-plot BFS the
  // client uses to draw the rendered (red) trade road, so the street road matches
  // it exactly. Returns [{x,y}] (off-map destination → near the city) or null.
  _tradeRoadWaypoints(roadPath) {
    const wt = this.gameStateManager.worldTerrainData
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
    // District z-height Stage 4 (plan "typed-gliding-leaf"): Canal lowers its own
    // centreline points directly on the shared registry — some of those ids are also
    // district boundary corners, so Tier 1/2 IDW (StreetVoronoiGenerator/CityBlockGenerator/
    // PlotVoronoiGenerator) picks up the drop automatically on the next regeneration pass,
    // no separate propagation mechanism needed.
    if (edgeType === 'Canal') {
      applyCanalZDelta(this.gameStateManager.pointRegistry, edge.pointIds)
    }
    // Regenerate streets for any already-typed adjacent districts so the
    // boundary polyline is stamped with the correct type (Stone for Wall, etc.)
    // before the client tries to build the wall/canal mesh.
    this.generateForLocked()
    this._syncDistrictEdgeRegions()
    return { ok: true, log: this.log }
  }

  // District Edge→Region conversion (ADR-0020 decisions 4–6, plan Addendum 2 Stage C) —
  // same pattern as _syncLinearFeatureRegions, applied to cityDistrictData.edges
  // (Wall/MainRoad/Canal/Docks) instead of worldTerrainData.edges (River/Cliff).
  // centrelinePointIds is the district Edge's own pointIds — already registry-backed
  // (district polygons/edges resolve through the shared GroundPointRegistry, same as
  // terrain edges — see plan Stage A finding on edgePoints). surfaceIds is populated from
  // _buildDistrictEdgeFaces (see that method) wherever a chain's street-graph junctions
  // resolve cleanly — a chain that's still genuinely pending (fewer than 2 junctions,
  // same as DistrictRenderer's own fallback) simply gets no Surface yet, same
  // recompute-from-pristine philosophy as River/Cliff. This still always records the
  // canonical Region (type, centreline, name/description) so it's queryable/persisted
  // regardless, and reversion (clearing a district edge's type) works the same
  // not-recreated way as linear terrain features, once edge clearing exists for
  // district edges.
  _syncDistrictEdgeRegions() {
    const gp = this.gameStateManager.groundplane
    const cityData = this.gameStateManager.cityDistrictData
    const edges = cityData?.edges
    if (!gp || !edges) return

    const districtEdgeFaces = this._buildDistrictEdgeFaces()
    cityData.districtEdgeFaces = districtEdgeFaces

    const districtEdgeRegions = []
    for (const [edgeKey, edge] of Object.entries(edges)) {
      const t = edge.assignedType
      if (t !== 'Wall' && t !== 'MainRoad' && t !== 'Canal' && t !== 'Docks') {
        delete edge.regionId
        continue
      }
      const regionId = `district-edge:${edgeKey}`
      edge.regionId = regionId
      const surfaces = districtEdgeFaces.filter(f => f.sourceEdgeId === edgeKey)
      for (const f of surfaces) f.regionId = regionId
      districtEdgeRegions.push({
        id: regionId,
        type: t,
        // Canonical Surface ids — `de:` prefix matches _syncGroundplaneSurfaces' record
        // for the same faces.
        surfaceIds: surfaces.map(f => `de:${f.id}`),
        centrelinePointIds: [...(edge.pointIds || [])],
        districtA: edge.districtA,
        districtB: edge.districtB ?? null,
        name: edge.name || '',
        description: edge.description || '',
      })
    }
    gp.regions = [...(gp.regions || []).filter(r => !String(r.id).startsWith('district-edge:')), ...districtEdgeRegions]
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

    // Sea/Lake regions are checked against their actual fine terrain-plot cells, not
    // region.polygon — that's a CONVEX HULL of those cells (see TerrainVoronoiGenerator
    // Step 6), which over-covers any concave stretch of coastline (a bay, inlet, etc.)
    // and can report land segments on the far side of the notch as "near water".
    const waterRegionIds = new Set((terrainData.regions || [])
      .filter(r => r.assignedType === 'Sea' || r.assignedType === 'Lake')
      .map(r => r.id))
    if (waterRegionIds.size) {
      for (const cell of (terrainData.terrainPlots || [])) {
        if (!waterRegionIds.has(cell.parentRegionId)) continue
        const poly = cell.polygon
        if (!poly?.length) continue
        for (const pt of pts) {
          if (this._ptInPoly(pt.x, pt.y, poly)) return true
          for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length]
            if (this._segDist(pt.x, pt.y, a.x, a.y, b.x, b.y) < THRESHOLD) return true
          }
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

  // River and Cliff terrain Edges render as a fixed-thickness polyline CENTRED on the
  // edge (TerrainRenderer: thickness `0.7/3`, kept in sync with
  // _applyRiverCliffPullbackToTerrainPlots's RIVER_CLIFF_HALF_WIDTH — see that
  // constant's doc comment), extending RIVER_CLIFF_HALF_WIDTH into both neighbouring
  // plots' nominal area — so a district's raw Voronoi-cell polygon otherwise reaches
  // past the river bank / cliff face into the rendered water/rock
  // (see Edge, CONTEXT_WorldTerrain.md). Sea/Lake need no pullback — they're already
  // filled region polygons, not a centreline+width polyline.
  //
  // Recomputes each district's polygon fresh from a preserved pristine copy every call
  // (`district._rawPolygon`, set once) rather than insetting in place repeatedly, since
  // this runs on every street-graph (re)generation over the course of District Setup.
  //
  // Pulling back `district.polygon` alone is NOT enough: StreetVoronoiGenerator.generate()
  // builds the actual street-graph boundary nodes for every city edge (inner AND outer)
  // straight from `cityData.edgePoints` (via cityEdge.pointIds), not from district.polygon
  // — district.polygon only seeds the district's own interior micro-Voronoi. Those
  // edgePoints are a separate, shared coordinate set untouched by the inset above, so
  // without also shifting them, blocks/plots/buildings still hug the original
  // (un-pulled-back) boundary regardless of how far district.polygon itself moved. So
  // every vertex displacement computed below is mirrored onto any cityData.edgePoints
  // entry sitting at that same (pristine) coordinate.
  // Inset a single (pristine) polygon by halfWidth along any edge that lies on a
  // River/Cliff terrain segment. Snaps each matched vertex directly to the shared,
  // junction-aware boundary position computed by riverCliffBoundary.js (the SAME
  // computation the on-screen stroke uses, via shared/polylineGeometry.js — see plan
  // "typed-giggling-giraffe") — chosen as LEFT or RIGHT of the chain by whichever is
  // closer to THIS polygon's own centroid (the same "which side is this polygon
  // actually on" test the old _inwardNormal used, just applied to pick between two
  // precomputed canonical positions instead of computing an independent bisector).
  // This guarantees width consistency and correct multi-chain-junction handling BY
  // CONSTRUCTION — every polygon on the same bank of the same chain looks up the exact
  // SAME position, not an independently-computed near-value that then needs
  // reconciling (the old per-vertex group-and-rescale pass this replaces).
  //
  // pointIds: this polygon's own point ids, parallel to poly (exact registry ids — see
  // _riverCliffBoundaryById's doc comment for why exact-id matching replaces the old
  // coordinate-tolerance _matchedRiverCliffEdgeId, which was a confirmed source of
  // T-junction tagging bugs). boundaryById: the Map _riverCliffBoundaryById returns
  // (pointId -> array of {left,right,sourceEdgeId}, one entry per chain incident on
  // that point — a plain interior point has exactly one entry, a junction point has
  // one per incident chain).
  //
  // Falls back to the OLD independent bisector-miter computation (halved on retry) for
  // the rare polygon whose canonical snap would self-intersect ITS OWN local shape (a
  // very small/sliver cell) — same "never ship a broken polygon" guarantee as before
  // this change, just no longer the primary path.
  //
  // edgeMatched[i] (returned) is the sourceEdgeId (worldTerrainData.edges key) of the
  // river/cliff segment edge i (poly[i]->poly[i+1]) lies along, or null — this is what
  // lets a land face's split half-edges later be tagged with which physical river/cliff
  // chain they belong to (see _buildRiverCliffFaces).
  _pullBackPolygon(poly, pointIds, boundaryById, halfWidth, regionId = null) {
    const n = poly.length
    const zeroDeltas = () => new Array(n).fill(null).map(() => ({ dx: 0, dy: 0 }))
    if (n < 3 || boundaryById.size === 0) return { pushed: poly.map(v => ({ x: v.x, y: v.y })), deltas: zeroDeltas(), anyMatch: false, edgeMatched: new Array(n).fill(null) }

    // A land EDGE (not vertex) belongs to whichever chain is common to BOTH its
    // endpoints' candidate lists — determining this per-edge, rather than trusting a
    // single value stored per-vertex, is what correctly disambiguates a junction vertex
    // shared by 2+ chains: each of this polygon's own two edges at that vertex can
    // legitimately belong to a DIFFERENT chain.
    const candidatesAt = pointIds.map(id => boundaryById.get(id) || [])
    const edgeMatched = new Array(n)
    let anyMatch = false
    for (let i = 0; i < n; i++) {
      const aList = candidatesAt[i], bList = candidatesAt[(i + 1) % n]
      let matchId = null
      for (const a of aList) { if (bList.some(b => b.sourceEdgeId === a.sourceEdgeId)) { matchId = a.sourceEdgeId; break } }
      edgeMatched[i] = matchId
      if (matchId != null) anyMatch = true
    }
    if (!anyMatch) return { pushed: poly.map(v => ({ x: v.x, y: v.y })), deltas: zeroDeltas(), anyMatch: false, edgeMatched }

    // The whole-polygon centroid is a poor "which side" reference for a plot that runs
    // alongside a BENDING river for multiple consecutive edges (confirmed live: a
    // 6-vertex plot with 3 consecutive river-matched edges — its centroid gets pulled
    // toward the river-hugging stretch, so some of its own vertices pick the WRONG side
    // inconsistently with its OTHER vertices, producing a self-crossing/looping
    // pullback instead of a clean uniform retreat). Prefer the centroid of vertices
    // whose BOTH adjacent edges are unmatched — the plot's true "bulk", away from any
    // river/cliff run — falling back to vertices with AT LEAST one unmatched edge, then
    // the whole polygon, if that set is empty (a plot fully surrounded by river/cliff
    // edges has no unambiguous "bulk" side to anchor to).
    let refPts = poly.filter((_, i) => edgeMatched[i] == null && edgeMatched[(i - 1 + n) % n] == null)
    if (refPts.length === 0) refPts = poly.filter((_, i) => edgeMatched[i] == null || edgeMatched[(i - 1 + n) % n] == null)
    if (refPts.length === 0) refPts = poly
    let cx = 0, cy = 0
    for (const v of refPts) { cx += v.x; cy += v.y }
    cx /= refPts.length; cy /= refPts.length

    const pushed = poly.map(v => ({ x: v.x, y: v.y }))
    const deltas = zeroDeltas()
    // Per-vertex region-consistent target, where resolved — the fallback below (which
    // only ever triggers for a THIS-polygon-local self-intersection) reads this to keep
    // orienting its own, independently-computed direction toward the SAME side, instead
    // of falling back to a per-polygon centroid heuristic that a neighbouring polygon
    // (which didn't need the fallback) has no reason to agree with.
    const knownChosen = new Array(n).fill(null)
    for (let i = 0; i < n; i++) {
      // A vertex is on the boundary if EITHER adjacent edge matched a chain; use
      // whichever matched (both agreeing, at an interior point of a single chain, is
      // the common case — a genuine 2-different-chains-at-one-vertex corner just picks
      // whichever edge resolved a match first, same as before this fix's scope).
      const chainHere = edgeMatched[i] ?? edgeMatched[(i - 1 + n) % n]
      if (chainHere == null) continue
      const b = candidatesAt[i].find(c => c.sourceEdgeId === chainHere)
      if (!b) continue
      // Prefer the chain-wide, region-anchored side assignment (see
      // _chainSideByRegion's doc comment) over the per-polygon centroid heuristic when
      // available — it's what actually GUARANTEES every plot on the same bank agrees,
      // rather than each plot independently guessing and hoping its neighbours guess
      // the same way. Falls back to the centroid heuristic for any polygon whose own
      // regionId wasn't supplied, doesn't match either of the chain's two regions, or
      // whose chain had a degenerate/unresolvable side assignment.
      const knownSide = (regionId != null && b.sideByRegion) ? b.sideByRegion[regionId] : null
      let chosen
      if (knownSide) {
        chosen = b[knownSide]
        knownChosen[i] = chosen
      } else {
        const dL = (b.left.x - cx) ** 2 + (b.left.y - cy) ** 2
        const dR = (b.right.x - cx) ** 2 + (b.right.y - cy) ** 2
        chosen = dL < dR ? b.left : b.right
      }
      pushed[i].x = chosen.x; pushed[i].y = chosen.y
      deltas[i] = { dx: chosen.x - poly[i].x, dy: chosen.y - poly[i].y }
    }

    if (!this._polygonSelfIntersects(pushed)) return { pushed, deltas, anyMatch, edgeMatched }

    // Fallback: shrink ONLY the vertices actually participating in the self-
    // intersection (see _polygonSelfIntersectingVertices) — every OTHER boundary-
    // adjacent vertex keeps its already-resolved shared-corner position (`pushed`/
    // `deltas` above), the exact same position the neighbouring land polygon and the
    // river/cliff face itself land on. Confirmed live (2026-07-12) that the old
    // behavior — discarding and independently recomputing EVERY boundary-adjacent
    // vertex the moment ANY one of them caused a self-intersection, not just the
    // offending ones — was the direct cause of a whole class of near-miss gaps and
    // area overlaps between this polygon and its neighbours (see the groundplane
    // audit tool). Recomputes the bad-vertex set fresh each retry (off the latest
    // attempt's actual result, not the original), so a vertex that stops being
    // implicated reverts cleanly to its correct shared value instead of staying
    // needlessly shrunk, and a vertex that becomes newly implicated gets included.
    const computeAt = (hw, badVertices) => {
      const p2 = pushed.map(v => ({ x: v.x, y: v.y }))
      const d2 = deltas.map(d => ({ ...d }))
      for (const i of badVertices) {
        const prevMatched = edgeMatched[(i - 1 + n) % n], nextMatched = edgeMatched[i]
        if (!prevMatched && !nextMatched) continue
        // Orient toward this vertex's own region-consistent target (see knownChosen's
        // doc comment above) when one was resolved, instead of the bulk centroid — a
        // neighbouring polygon that DIDN'T need this fallback already committed to that
        // exact side, and only THIS polygon's own local shape is what's forcing a
        // reduced magnitude here, not a disagreement about which side is correct.
        const refX = knownChosen[i] ? knownChosen[i].x : cx, refY = knownChosen[i] ? knownChosen[i].y : cy
        const n1 = prevMatched ? this._inwardNormal(poly[(i - 1 + n) % n], poly[i], refX, refY) : null
        const n2 = nextMatched ? this._inwardNormal(poly[i], poly[(i + 1) % n], refX, refY) : null
        let mx, my
        if (n1 && n2) {
          const bx = n1.nx + n2.nx, by = n1.ny + n2.ny
          const bl = Math.hypot(bx, by)
          if (bl < 1e-6) { mx = n1.nx; my = n1.ny }
          else {
            const s = 1 / Math.max(0.15, (bx * n1.nx + by * n1.ny) / bl)
            mx = (bx / bl) * s; my = (by / bl) * s
          }
        } else {
          const only = n1 ?? n2
          mx = only.nx; my = only.ny
        }
        const prevLen = Math.hypot(poly[i].x - poly[(i - 1 + n) % n].x, poly[i].y - poly[(i - 1 + n) % n].y)
        const nextLen = Math.hypot(poly[(i + 1) % n].x - poly[i].x, poly[(i + 1) % n].y - poly[i].y)
        const effHw = Math.min(hw, 0.5 * Math.min(prevLen, nextLen))
        const dx = mx * effHw, dy = my * effHw
        p2[i].x = poly[i].x + dx; p2[i].y = poly[i].y + dy
        d2[i] = { dx, dy }
      }
      return { pushed: p2, deltas: d2 }
    }
    let hw = halfWidth
    let badVertices = this._polygonSelfIntersectingVertices(pushed)
    let result = computeAt(hw, badVertices)
    let attempts = 0
    while (this._polygonSelfIntersects(result.pushed) && attempts < 8) {
      hw *= 0.5
      badVertices = this._polygonSelfIntersectingVertices(result.pushed)
      result = computeAt(hw, badVertices)
      attempts++
    }
    return { pushed: result.pushed, deltas: result.deltas, anyMatch, edgeMatched }
  }

  // Historically matched PolylineRenderer.js's own default miter-limit ratio (retired —
  // see plan "typed-gliding-leaf" Stage D; miterLimitDist = thickness * 1.5 =
  // (2*halfWidth) * 1.5 = halfWidth * 3) — kept as this pullback's own narrow-angle bevel
  // threshold regardless of what the client stroke renderer does now.
  static MITER_LIMIT_RATIO = 3

  // Precompute the shared, junction-aware LEFT/RIGHT boundary position for every point
  // that's part of ANY River/Cliff terrain edge, keyed by exact point id (see
  // riverCliffBoundary.js/shared/polylineGeometry.js). Exact-id lookup replaces the old
  // coordinate-tolerance matching (_matchedRiverCliffEdgeId/RIVER_CLIFF_MATCH_TOL) for
  // this purpose — confirmed live that terrain plot corners share EXACT registry ids
  // with worldTerrainData.edges[key].pointIds (the fine per-corner chain, not a coarse
  // simplification), so tolerance-based matching was solving a problem that doesn't
  // exist here and was itself a source of bugs (a real-save chain's bank-path
  // extraction silently merging two banks into one, traced to this exact mismatch).
  //
  // Returns Map<pointId, Array<{left,right,sourceEdgeId}>> — an ARRAY per point, not a
  // single object: a junction point (where 2+ River/Cliff chains meet) is a real,
  // common case, and each incident chain has its OWN left/right pair there. A single
  // overwritten entry per point (the original design) silently discarded every chain
  // but whichever was processed last, so a land polygon whose own edge ran along the
  // discarded chain either failed to match at all or snapped to the wrong chain's
  // position entirely — confirmed live as the exact cause of thin spike/fold artifacts
  // clustered at multi-chain junction regions (2026-07-11). _pullBackPolygon picks the
  // right array entry per land-edge by matching sourceEdgeId, not by vertex alone.
  // Single source for every River/Cliff-derived geometry this pass needs — LAND-side
  // snapping (byId, keyed by point id, consumed by _pullBackPolygon) AND the river/
  // cliff FACE ribbons themselves (boundaries, per-chain, consumed by
  // _buildRiverCliffFacesDirect/_buildRiverCliffJunctionCaps) all come from this ONE
  // computeRiverCliffBoundaries call — guaranteeing every corner position agrees
  // byte-for-byte between the land polygons and the river/cliff face that fills the gap
  // between them, by construction, not by a separate reconciliation pass.
  _computeRiverCliffBoundaryData(halfWidth) {
    const terrainData = this.gameStateManager.worldTerrainData
    const registry = this.gameStateManager.pointRegistry
    const edges = {}
    for (const [key, e] of Object.entries(terrainData?.edges || {})) {
      if (e.assignedType === 'River' || e.assignedType === 'Cliff') edges[key] = e
    }
    const byId = new Map()
    if (Object.keys(edges).length === 0) return { byId, boundaries: new Map(), fillsOut: new Map(), edges }
    const fillsOut = new Map()
    const boundaries = computeRiverCliffBoundaries(edges, registry, halfWidth, halfWidth * SetupPhase.MITER_LIMIT_RATIO, fillsOut)
    for (const [chainId, corners] of boundaries) {
      const pts = edges[chainId].pointIds || []
      // Determine, ONCE per chain, which coarse region sits on which canonical side —
      // eliminates the risk of two DIFFERENT plots on the SAME bank (sharing a vertex)
      // independently picking OPPOSITE sides via their own local centroid heuristic,
      // which a per-polygon heuristic can never fully guarantee (confirmed live: an
      // elongated plot hugging a bend disagreeing with its own straight-edged neighbour
      // at their shared corner, producing a self-crossing/looping pullback graph
      // instead of one clean bank — see _chainSideByRegion's doc comment).
      const sideByRegion = this._chainSideByRegion(chainId, corners)
      for (let i = 0; i < pts.length; i++) {
        if (!corners?.[i]) continue
        if (!byId.has(pts[i])) byId.set(pts[i], [])
        byId.get(pts[i]).push({ left: corners[i].left, right: corners[i].right, sourceEdgeId: chainId, sideByRegion })
      }
    }
    return { byId, boundaries, fillsOut, edges }
  }

  _riverCliffBoundaryById(halfWidth) {
    return this._computeRiverCliffBoundaryData(halfWidth).byId
  }

  // For a chain named "${regionA}-${regionB}" (worldTerrainData.edges' own key
  // convention), determine which region sits on 'left' vs 'right' by summing each
  // region's seedPoint's squared distance to EVERY point's left vs right position
  // along the whole chain (not just one point) — robust against local curvature, since
  // a region's seedPoint is always deep inside that region, far from any local-bend
  // ambiguity a single-point or per-polygon-centroid comparison could be thrown off by.
  // Returns { [regionId]: 'left'|'right' }, or null if the key doesn't parse as two
  // known region ids, or if both regions' seeds end up on the SAME side (a degenerate/
  // unexpected geometry — safer to signal "don't trust this" than guess), in which case
  // callers fall back to their own per-polygon heuristic.
  _chainSideByRegion(chainId, corners) {
    const parts = String(chainId).split('-')
    if (parts.length !== 2) return null
    const [ra, rb] = parts.map(Number)
    if (!Number.isFinite(ra) || !Number.isFinite(rb)) return null
    const regions = this.gameStateManager.worldTerrainData?.regions || []
    const regionA = regions.find(r => r.id === ra)
    const regionB = regions.find(r => r.id === rb)
    if (!regionA?.seedPoint || !regionB?.seedPoint) return null
    const sideFor = (seed) => {
      let dL = 0, dR = 0
      for (const c of corners) {
        if (!c) continue
        dL += (c.left.x - seed.x) ** 2 + (c.left.y - seed.y) ** 2
        dR += (c.right.x - seed.x) ** 2 + (c.right.y - seed.y) ** 2
      }
      return dL < dR ? 'left' : 'right'
    }
    const sideA = sideFor(regionA.seedPoint), sideB = sideFor(regionB.seedPoint)
    if (sideA === sideB) return null
    return { [ra]: sideA, [rb]: sideB }
  }

  // Region types that are permanently flat and locked (see TerrainZHeight.js's
  // applyTerrainTypeZEffect — Sea/Lake/Ice Sheet all set zLocked=true on their domain).
  // A Cliff touching one of these must NEVER move that side's z, at all, ever — but the
  // zLocked flag alone can't be trusted to enforce that here: it lives on the ephemeral
  // 'terrain-split' point _applyRiverCliffPullbackToTerrainPlots wipes and re-mints from
  // the pristine RAW ('terrain') point on EVERY pullback recompute (any later Cliff/
  // River/reveal anywhere on the map re-triggers this whole file), and the raw point
  // itself is never the one applyTerrainTypeZEffect actually locks (it locks whichever
  // split copy existed at Apply time — see getRegionDomainPointIds's doc comment: it
  // reads terrainPlots[].pointIds, which are already the post-split ids by the time
  // Ice Sheet's Apply runs). So `base.zLocked` in posFor reads FALSE on every later
  // rebuild even for a genuinely locked Ice Sheet edge, and the cliff delta silently
  // re-applied itself every single time — confirmed live 2026-07-14 ("Ice Sheet edge
  // pushed even further down" after the zLocked-respecting fix, which never actually
  // fired because of this exact gap). The robust fix: key off the REGION's assignedType
  // directly, which is not ephemeral and always known.
  static ALWAYS_LOCKED_TERRAIN_TYPES = new Set(['Sea', 'Lake', 'Ice Sheet'])

  // Cliff z-height (user-confirmed 2026-07-13, "fix cliffs — by definition, joins
  // between significantly different z-heights"; chain-wide-average formula user-
  // confirmed 2026-07-14, plan "typed-gliding-leaf"): for every physically-contiguous
  // run of Cliff-assigned edges, determines which side is HIGH vs LOW and each side's
  // chain-wide target z average (TerrainZHeight.js's computeCliffChainSides), then
  // records {side, targetAvg} against every one of the run's edges' own pointIds.
  // Returns Map<vertexId, Map<regionId, {side, targetAvg}>> — a vertexId maps to a
  // region map rather than a single side because a vertex can be a corner of MULTIPLE
  // Cliff edges (different chains meeting at a point), each with its own two
  // regions/sides. A region whose type is permanently flat/locked (see
  // ALWAYS_LOCKED_TERRAIN_TYPES above) gets NO entry at all — its own side of the split
  // stays at the shared corner's raw z, unconditionally, on every rebuild, not just the
  // first one.
  // Consumed by _dcelPullbackMaterialize's posFor (its z hook) — this only ever decides
  // WHICH side a split copy is on and what it should lerp toward; the lerp itself is
  // applied there.
  _computeCliffSideAtVertex() {
    const wt = this.gameStateManager.worldTerrainData
    const regions = wt?.regions || []
    const regionById = new Map(regions.map(r => [r.id, r]))
    const registry = this.gameStateManager.pointRegistry
    const sidesByEdge = computeCliffChainSides(wt?.edges || {}, wt?.terrainPlots || [], registry, regionById)
    const sideAtVertex = new Map()
    for (const [edgeId, edge] of Object.entries(wt?.edges || {})) {
      if (edge.assignedType !== 'Cliff') continue
      const regionA = regionById.get(edge.regionA), regionB = regionById.get(edge.regionB)
      if (!regionA || !regionB) continue
      const sides = sidesByEdge.get(edgeId)
      if (!sides) continue
      for (const pid of edge.pointIds || []) {
        if (!sideAtVertex.has(pid)) sideAtVertex.set(pid, new Map())
        const m = sideAtVertex.get(pid)
        if (!SetupPhase.ALWAYS_LOCKED_TERRAIN_TYPES.has(regionA.assignedType)) m.set(regionA.id, sides.get(regionA.id))
        if (!SetupPhase.ALWAYS_LOCKED_TERRAIN_TYPES.has(regionB.assignedType)) m.set(regionB.id, sides.get(regionB.id))
      }
    }
    return sideAtVertex
  }

  _inwardNormal(a, b, cx, cy) {
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1
    let nx = -dy / L, ny = dx / L
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny }
    return { nx, ny }
  }

  _polygonSelfIntersects(poly) {
    const n = poly.length
    for (let i = 0; i < n; i++) {
      const a1 = poly[i], a2 = poly[(i + 1) % n]
      for (let j = i + 1; j < n; j++) {
        if (j === i || j === (i + 1) % n || i === (j + 1) % n) continue
        if (this._segmentsProperlyCross(a1, a2, poly[j], poly[(j + 1) % n])) return true
      }
    }
    return false
  }

  // Same crossing scan as _polygonSelfIntersects, but returns WHICH vertex indices
  // participate in at least one crossing (both endpoints of every crossing edge pair)
  // instead of a plain boolean — see _pullBackPolygon's fallback, which uses this to
  // shrink only the vertices actually causing a self-intersection instead of discarding
  // every boundary-adjacent vertex's already-correct shared-corner position.
  _polygonSelfIntersectingVertices(poly) {
    const n = poly.length
    const bad = new Set()
    for (let i = 0; i < n; i++) {
      const a1 = poly[i], a2 = poly[(i + 1) % n]
      for (let j = i + 1; j < n; j++) {
        if (j === i || j === (i + 1) % n || i === (j + 1) % n) continue
        if (this._segmentsProperlyCross(a1, a2, poly[j], poly[(j + 1) % n])) {
          bad.add(i); bad.add((i + 1) % n); bad.add(j); bad.add((j + 1) % n)
        }
      }
    }
    return bad
  }

  _segmentsProperlyCross(p1, p2, p3, p4) {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y
    const denom = d1x * d2y - d1y * d2x
    if (Math.abs(denom) < 1e-12) return false
    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom
    const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9
  }

  // River and Cliff terrain Edges render as a fixed-thickness polyline CENTRED on the
  // edge (TerrainRenderer: thickness `0.7/3`, kept in sync with
  // _applyRiverCliffPullbackToTerrainPlots's RIVER_CLIFF_HALF_WIDTH — see that
  // constant's doc comment), extending RIVER_CLIFF_HALF_WIDTH into both neighbouring
  // plots' nominal area — so a district's raw Voronoi-cell polygon otherwise reaches
  // past the river bank / cliff face into the rendered water/rock
  // (see Edge, CONTEXT_WorldTerrain.md). Sea/Lake need no pullback — they're already
  // filled region polygons, not a centreline+width polyline.
  //
  // Point/Surface model (see GroundPointRegistry.js, plan "typed-giggling-giraffe"): a
  // district's pullback is POINT-SPLITTING, not coordinate-editing. `district._rawPolygon`/
  // `_rawPointIds` (captured once, from the TRUE pristine geometry — never re-captured,
  // never mutated) are recomputed fresh into `district.polygon`/`.pointIds` every call.
  // An untouched vertex keeps its original id (still shares it with every other Surface
  // that also didn't move it). A displaced vertex resolves via
  // registry.getOrCreateSplit(baseId, group, ...) — `group` is the exact {dx,dy} object
  // _computeRiverCliffDeltas resolved for that vertex, and is REFERENCE-shared across
  // every polygon/vertex that landed in the same direction-group at that baseId — so two
  // Surfaces whose corners should move together land on the literal same split point id,
  // by construction, not by coordinate-matching after the fact.
  //
  // Pulling back `district.polygon`/`.pointIds` alone is NOT enough: cityData.edges
  // captured their own snapshot of pointIds at construction time (see
  // generateCityDistrictData / _addPromotedDistrictEdges) and don't automatically follow
  // along when a district's pointIds get rewritten here. Every edge's raw ids are always
  // a contiguous run of its OWNING district's own raw pointIds, so each edge is re-derived
  // by mapping its own raw ids through that same district's rawId->currentId remap built
  // below — landing on the identical split ids the district itself just resolved, with no
  // separate matching step. cityData.edgePoints is then rebuilt as a pure materialized
  // view of whatever cityData.edges/districts currently reference, for consumers not yet
  // reading the point registry directly (StreetVoronoiGenerator — see plan Stage 6).

  // DCEL cutover (plan "typed-giggling-giraffe", migration step 7): shared by both
  // district and terrain-plot pullback. Builds a fresh DCEL every call (never
  // persisted — matches the existing "_rawPolygon, recomputed every call" philosophy),
  // inserts every face from its pristine ids, resolves the river-mouth/multi-bank case
  // via splitVertexGeneral for EVERY no-vote face at an ambiguous vertex (not just a
  // hardcoded 2-total-groups case — see the splice loop's own doc comment for the
  // 2026-07-13 generalization to arbitrary group counts, resolved via true fan
  // adjacency rather than a global group-list guess), then splitVertexSimple for every
  // other corner. Returns one
  // {pointIds, polygon} per input face, parallel to rawPolys/rawIds — note a water
  // face's pointIds can come back LONGER than its raw input if splitVertexGeneral gave
  // it an extra vertex; callers that need a 1:1 remap (only districts do — terrain
  // plots have no dependent edges structure) must build it themselves and can only
  // rely on same-length zipping where isWaterByIndex is false for that face.
  // hasOwnVote (optional, same shape as deltas, see _computeRiverCliffDeltas) — used
  // only to find the confluence splice target (a face with no vote of its own at an
  // ambiguous vertex, not necessarily water); omit for the old water-only behavior.
  //
  // River/Cliff FACE construction (the filled ribbon between two banks) is NOT this
  // function's job anymore — see _buildRiverCliffFacesDirect/_buildRiverCliffJunctionCaps,
  // called separately from _applyRiverCliffPullbackToTerrainPlots. It used to be built
  // HERE by tagging split half-edges and walking the DCEL to reverse-engineer which
  // land faces belonged to which bank (_buildRiverCliffFaces, since removed) — that
  // approach could never reliably distinguish a genuine N-way region-tripoint
  // confluence from an ordinary T-junction tagging gap (plan "typed-giggling-giraffe"
  // Addendum 2 Stage B "KNOWN ISSUE"), and inherited LAND pullback's per-cell effHw
  // clamp, whose magnitude depends on each terrain plot's own local edge length —
  // producing visibly uneven river width wherever tessellation density varied along the
  // chain (confirmed live, 2026-07-12). The direct approach builds each chain's ribbon
  // from ONLY its own polyline + a fixed half-width (see riverCliffBoundary.js), fully
  // independent of terrain-plot geometry or DCEL topology.
  // rawRegionIds/cliffSideAtVertex (Cliff z-height, user-confirmed 2026-07-13): optional
  // — when supplied, every split copy this materializes also gets a differential z if
  // its owning face's region is on the high or low side of a Cliff at that vertex (see
  // _computeCliffSideAtVertex). Omitted entirely by callers that don't need it (there
  // are none left as of this change, but kept optional rather than required since this
  // method's job is the X,Y split — z is a bolt-on, not its core purpose).
  _dcelPullbackMaterialize(rawPolys, rawIds, deltas, ambiguous, splitKind, isWaterByIndex, hasOwnVote = null, rawRegionIds = null, cliffSideAtVertex = null) {
    const registry = this.gameStateManager.pointRegistry
    const dcel = new DCEL(registry)

    const dcelFaces = new Array(rawPolys.length).fill(null)
    const dedupedIdsByFace = new Array(rawPolys.length).fill(null)
    for (let fi = 0; fi < rawPolys.length; fi++) {
      const ids = dedupeConsecutiveIds(rawIds[fi])
      dedupedIdsByFace[fi] = ids
      if (ids.length < 3) continue
      try { dcelFaces[fi] = dcel.insertFace(ids, 'pullback', { water: isWaterByIndex(fi) }) }
      catch (e) { console.warn(`[river-cliff-pullback] insertFace failed for face #${fi}: ${e.message}`) }
    }

    // Cliff z-height: DCEL face id -> owning terrain plot's parentRegionId, so posFor
    // (below) can look up "which side of a Cliff is THIS split copy on" from the face a
    // given outgoing half-edge belongs to.
    const regionIdByFaceId = new Map()
    if (rawRegionIds) {
      for (let fi = 0; fi < rawPolys.length; fi++) {
        if (dcelFaces[fi]) regionIdByFaceId.set(dcelFaces[fi].id, rawRegionIds[fi])
      }
    }
    // Collects {side, heOut} for every split copy that landed on a Cliff's high/low
    // side — heOut.origin isn't the final split id yet at collection time (posFor runs
    // BEFORE splitVertexSimple reassigns it), so this is resolved into real ids only
    // after the whole split loop below finishes. Returned to the caller so it can
    // propagate each side's new height into its own surrounding terrain.
    const cliffSplitEntries = []

    const deltaByFaceVertex = new Map()
    const hasOwnVoteByFaceVertex = new Map()
    const allVertexIds = new Set()
    for (let fi = 0; fi < rawPolys.length; fi++) {
      const face = dcelFaces[fi]
      if (!face) continue
      const ids = rawIds[fi], polyDeltas = deltas[fi], polyOwnVote = hasOwnVote ? hasOwnVote[fi] : null
      for (let vi = 0; vi < ids.length; vi++) {
        deltaByFaceVertex.set(`${face.id},${ids[vi]}`, polyDeltas[vi])
        if (polyOwnVote) hasOwnVoteByFaceVertex.set(`${face.id},${ids[vi]}`, polyOwnVote[vi])
        allVertexIds.add(ids[vi])
      }
    }

    for (const [vertexId, groups] of ambiguous) {
      // EVERY fan face with NO vote of its own at this vertex needs its own splice —
      // not just the first one found. That's the actual structural definition of
      // "ambiguous" from _computeRiverCliffDeltas (a face whose OWN edges at this
      // vertex aren't river/cliff-matched, so its resolved delta only exists because a
      // NEIGHBOUR's vote won the fallback — see hasOwnVote's doc comment;
      // deltaByFaceVertex alone can't distinguish this from an ordinary own-vote face,
      // since the fallback returns a `groups` entry by reference, same as an own-vote
      // face's own group). A water face (Lake/Sea) is the common case — it never has a
      // vote, since its own shoreline edge is deliberately de-typed away from
      // River/Cliff (see assignTerrainToRegion) — but this is NOT water-specific: the
      // identical situation happens at a land-only 3+-region corner (e.g. two
      // Ice-Sheet-auto-cliffed edges meeting), where the THIRD region's own plot at
      // that exact corner has no vote either. Falls back to the water flag alone if
      // hasOwnVote wasn't supplied (older callers), so this stays backward compatible.
      //
      // The fan is re-derived FRESH before every single splice attempt, rather than
      // once up front — splitVertexGeneral mutates the DCEL (inserts a half-edge into
      // the target face's loop), which can invalidate a second no-vote face's stale
      // he.prev/he.twin/he.next references if it were computed before the first splice
      // ran. `attemptedFaceIds` tracks which faces at THIS vertex have already been
      // resolved (successfully or not) so re-deriving the fan doesn't just re-find and
      // re-attempt the same one forever; capped at the fan's own original size, since a
      // vertex can never need more splice attempts than it has incident faces.
      const attemptedFaceIds = new Set()
      let initialFanSize = 0
      try { initialFanSize = dcel.outgoingFan(vertexId).length } catch { continue }
      for (let attempt = 0; attempt < initialFanSize; attempt++) {
        let fan
        try { fan = dcel.outgoingFan(vertexId) } catch { break }
        const spliceHe = fan.find(he => {
          if (attemptedFaceIds.has(he.face)) return false
          const face = dcel.getFace(he.face)
          if (!face) return false
          if (face.water === true) return true
          if (!hasOwnVote) return false
          return hasOwnVoteByFaceVertex.get(`${he.face},${vertexId}`) === false
        })
        if (!spliceHe) break
        attemptedFaceIds.add(spliceHe.face)
        // groupA = this face's fan-PREDECESSOR's own resolved group; groupB = its fan-
        // SUCCESSOR's own resolved group (see DCEL.splitVertexGeneral's doc comment on
        // exactly which fan positions those are: waterHe.prev.twin and waterHe.twin.next
        // respectively). Generalized (2026-07-13) to work at ANY total group count at
        // this vertex, not just exactly 2 — a no-vote face's correct neighbour pair is
        // always its own immediate fan predecessor/successor, regardless of how many
        // OTHER, unrelated groups exist elsewhere around the same vertex. The old
        // `groups.length !== 2` gate meant a no-vote face at a 3+-group vertex (e.g. a
        // Cliff bank, a River bank, and Sea's own no-vote corner all meeting at once)
        // fell through entirely to _computeRiverCliffDeltas' centroid-distance
        // heuristic instead — confirmed live (2026-07-13, "Terrain Plot 28"): a Sea
        // plot's corner landed on the two INNERMOST split points of a 4-point cluster
        // instead of the two points actually flanking its own fan wedge, visibly
        // pushing Sea's polygon into the neighbouring Cliff face's space.
        const heIn = dcel.getHalfEdge(spliceHe.prev)
        const predFaceId = heIn ? dcel.getHalfEdge(heIn.twin)?.face : null
        const predGroup = predFaceId != null ? deltaByFaceVertex.get(`${predFaceId},${vertexId}`) : null
        const heOutTwin = dcel.getHalfEdge(spliceHe.twin)
        const succHe = heOutTwin ? dcel.getHalfEdge(heOutTwin.next) : null
        const succFaceId = succHe ? succHe.face : null
        const succGroup = succFaceId != null ? deltaByFaceVertex.get(`${succFaceId},${vertexId}`) : null
        let groupA = predGroup, groupB = succGroup
        if (!groupA || !groupB) {
          // Couldn't resolve one side via true fan adjacency (edge of a boundary void,
          // or a neighbour with no delta of its own there) — fall back to the old
          // two-groups-in-arbitrary-order behaviour only when there really are exactly
          // 2 groups total; otherwise skip rather than guess.
          if (groups.length === 2) { [groupA, groupB] = groups }
          else continue
        }
        if (groupA === groupB) continue   // this face's own wedge doesn't cross a bank transition — nothing to splice

        // Validate BEFORE splicing: vA/vB sit at the BANKS' pullback offsets, whose
        // magnitude was clamped against the LAND faces' own edge lengths
        // (_pullBackPolygon's effHw) — never against the splice face's own geometry. A
        // small splice face (the live "Plot 79" case: a 3-vertex Lake triangle; the same
        // can happen for a small land corner plot at a confluence) has a mouth wedge
        // smaller than those offsets, so the spliced loop crosses itself — a pure
        // geometric overshoot the fan-order fix above can't prevent. Build the
        // prospective polygon (v replaced by [vA, vB] in the splice face's current loop,
        // matching exactly what splitVertexGeneral's splice produces) and only splice if
        // it stays simple; otherwise fall back to the single-position split already baked
        // into `deltas`, exactly as _pullBackPolygon itself falls back at land corners.
        const baseV = dcel.points.get(vertexId)
        const loopIds = dcel.walkFacePolygon(spliceHe.face)
        const vIdx = loopIds.indexOf(vertexId)
        if (!baseV || vIdx === -1) continue
        const loopPts = loopIds.map(id => { const p = dcel.points.get(id); return p ? { x: p.x, y: p.y } : null })
        if (loopPts.some(p => !p)) continue
        const prospective = [
          ...loopPts.slice(0, vIdx),
          { x: baseV.x + groupA.dx, y: baseV.y + groupA.dy },
          { x: baseV.x + groupB.dx, y: baseV.y + groupB.dy },
          ...loopPts.slice(vIdx + 1),
        ]
        if (this._polygonSelfIntersects(prospective)) {
          console.warn(`[confluence-splice] vertex ${vertexId}: spliced face would self-intersect (bank offsets exceed the face's local wedge) — falling back to single-position split`)
          continue
        }

        try { dcel.splitVertexGeneral(vertexId, spliceHe, groupA, groupB, splitKind) }
        catch (e) { console.warn(`[confluence-splice] splitVertexGeneral failed at vertex ${vertexId}: ${e.message} — falling back to single-position split`) }
      }
    }

    // Every split copy of an already-zLocked base point (Sea/Lake/Ice Sheet) must stay
    // locked too — resolved into real ids and marked after the split loop below, same
    // deferred-resolution reason as cliffSplitEntries.
    const lockedSplitHeOuts = []

    for (const vertexId of allVertexIds) {
      const vertexCliffSides = cliffSideAtVertex?.get(vertexId)
      dcel.splitVertexSimple(
        vertexId,
        (heOut) => {
          const d = deltaByFaceVertex.get(`${heOut.face},${vertexId}`)
          return (!d || (d.dx === 0 && d.dy === 0)) ? null : d
        },
        (group, heOut) => {
          const base = dcel.points.get(vertexId)
          let z = base.z ?? 0
          // Sea/Lake/Ice Sheet's permanent lock must hold here too — enforced by
          // _computeCliffSideAtVertex simply never recording a side for an
          // ALWAYS_LOCKED_TERRAIN_TYPES region (so `side` below comes back null/
          // undefined for it on every rebuild, not just the first), not by trusting
          // base.zLocked — see that constant's doc comment for why the flag itself
          // can't be: it lives on the ephemeral split copy this whole pass wipes and
          // re-mints from the pristine raw point on every later Cliff/River recompute
          // anywhere on the map, so it reads false again next time regardless.
          // base.zLocked is still checked as a second, harmless layer in case it's
          // ever true for some other reason.
          if (vertexCliffSides && !base.zLocked) {
            const regionId = regionIdByFaceId.get(heOut.face)
            const info = regionId != null ? vertexCliffSides.get(regionId) : null
            if (info?.targetAvg != null) {
              z = lerp(base.z ?? 0, info.targetAvg, CLIFF_LERP_T)
              cliffSplitEntries.push({ side: info.side, heOut })
            }
          }
          if (base.zLocked) lockedSplitHeOuts.push(heOut)
          return { x: base.x + group.dx, y: base.y + group.dy, z }
        },
        splitKind
      )
    }

    // Resolve cliffSplitEntries into real ids now — heOut.origin only became the final
    // split-vertex id partway through the splitVertexSimple call above (posFor runs
    // before the reassignment), so this has to happen after every vertex's split loop
    // has fully finished.
    const cliffHighIds = [], cliffLowIds = []
    for (const { side, heOut } of cliffSplitEntries) {
      (side === 'high' ? cliffHighIds : cliffLowIds).push(heOut.origin)
    }
    for (const heOut of lockedSplitHeOuts) {
      const p = registry.get(heOut.origin)
      if (p) p.zLocked = true
    }

    const results = new Array(rawPolys.length).fill(null)
    let matchedCount = 0
    for (let fi = 0; fi < rawPolys.length; fi++) {
      const face = dcelFaces[fi]
      if (!face) continue
      let hes
      try { hes = dcel._faceHalfEdges(face.id) }
      catch (e) { console.warn(`[river-cliff-pullback] face #${fi} walk failed: ${e.message}`); continue }
      const pointIds = hes.map(he => he.origin)
      const polygon = pointIds.map(id => { const p = registry.get(id); return p ? { x: p.x, y: p.y } : null }).filter(Boolean)
      const changed = pointIds.length !== rawIds[fi].length || pointIds.some((id, i) => id !== rawIds[fi][i])
      if (changed) matchedCount++
      results[fi] = { pointIds, polygon }
    }

    return { results, matchedCount, cliffHighIds, cliffLowIds }
  }

  // ADR-0020 Stage C (District Edge face Surfaces) — implemented, see
  // _buildDistrictEdgeFaces for the orchestrator that supplies chainConnections.
  // Contract (see SetupPhase.districtEdgeFaces.test.mjs for the full spec): assemble
  // one closed face polygon for a Wall/MainRoad/Canal/Docks district edge, directly
  // from the gutter offsets StreetVoronoiGenerator.buildJunctions already computed at
  // each junction along that edge's chain — NOT via independent land-polygon pullback
  // (District Edges have no such thing; their width comes from the gutter/Alley
  // geometry itself). Mirrors _buildRiverCliffFaces' own bank-A-then-reversed-bank-B
  // assembly exactly, just from gutter offsets instead of pullback deltas: one side of
  // the chain is every junction's own gutterLeft point in walk order, the other side is
  // every junction's gutterRight point in REVERSE order, closing into one loop.
  //
  // chainConnections: ordered array of {gutterLeft:{x,y}, gutterRight:{x,y}}, one per
  //   junction along the district edge's chain, in walk order (start to end).
  // Returns an ordered array of {x,y} points forming the closed face polygon, or null
  // if the input is degenerate (fewer than 2 junctions).
  _assembleDistrictEdgeFacePoints(chainConnections) {
    if (!chainConnections || chainConnections.length < 2) return null
    const lefts = chainConnections.map(c => ({ x: c.gutterLeft.x, y: c.gutterLeft.y }))
    const rights = chainConnections.map(c => ({ x: c.gutterRight.x, y: c.gutterRight.y }))
    return [...lefts, ...rights.reverse()]
  }

  // For every Wall/MainRoad/Canal/Docks district edge, walk its street-graph boundary
  // chain (extractBoundaryChain, shared/boundaryChain.js — same walk DistrictRenderer
  // already uses client-side to build wall/canal/dock meshes) and assemble a real Face
  // via _assembleDistrictEdgeFacePoints. Mints into the shared registry with
  // reuseExisting so the face shares point ids with whatever CityBlockGenerator._traceFaces
  // already minted at those exact gutter corners — gap-free adjacency with neighbouring
  // blocks, same trick _buildRiverCliffFacesDirect uses against land faces.
  //
  // Orientation note: a chain's two ends walk the SAME physical boundary in opposite
  // local directions, so naively taking "gutterLeft" off whichever connection matches at
  // each junction does NOT stay on one consistent side (StreetVoronoiGenerator.buildJunctions
  // computes gutterLeft/gutterRight relative to THIS junction's own local outgoing
  // direction along that connection, which reverses across the chain). Anchored instead
  // to the district-id pair on each connection (conn.left/conn.right, direction-
  // independent) — the point on districtA's side is always treated as "left", districtB's
  // side always "right", regardless of which connection object or which local direction
  // supplied it.
  _buildDistrictEdgeFaces() {
    const registry = this.gameStateManager.pointRegistry
    const cityData = this.gameStateManager.cityDistrictData
    const streetGraph = cityData?.streetGraph
    const edges = cityData?.edges
    if (!registry || !streetGraph || !edges) return []

    const norm = (v) => (v === 'terrain' ? null : v)
    const built = []
    for (const [edgeKey, edge] of Object.entries(edges)) {
      const t = edge.assignedType
      if (t !== 'Wall' && t !== 'MainRoad' && t !== 'Canal' && t !== 'Docks') continue

      const chain = extractBoundaryChain(streetGraph, edge.districtA, edge.districtB, t)
      if (!chain) continue

      const chainConnections = []
      for (const junction of chain) {
        const conn = boundaryConnectionAt(junction, edge.districtA, edge.districtB, t)
        if (!conn?.gutterLeft || !conn?.gutterRight) { chainConnections.length = 0; break }
        const aSide = norm(conn.left) === edge.districtA ? conn.gutterLeft : conn.gutterRight
        const bSide = norm(conn.left) === edge.districtA ? conn.gutterRight : conn.gutterLeft
        chainConnections.push({ gutterLeft: aSide, gutterRight: bSide })
      }
      if (chainConnections.length < 2) continue

      const loopPts = this._assembleDistrictEdgeFacePoints(chainConnections)
      if (!loopPts || this._polygonSelfIntersects(loopPts)) continue

      const pointIds = registry.mintDeduped(loopPts, 'gutter', 0.01, { reuseExisting: true })
      built.push({ id: edgeKey, sourceEdgeId: edgeKey, assignedType: t, pointIds, polygon: loopPts })
    }
    return built
  }

  // Assemble a real Face for every River/Cliff chain DIRECTLY from the same per-point
  // left/right boundary corners the Terrain-mode stroke already renders (see
  // riverCliffBoundary.js/shared/polylineGeometry.js) — NOT inferred by walking the
  // DCEL and reverse-engineering which land faces belong to which bank (the previous
  // approach, removed: see plan "typed-giggling-giraffe" Addendum 2 Stage B "KNOWN
  // ISSUE" — it could never reliably tell a genuine N-way region-tripoint confluence
  // apart from an ordinary T-junction tagging gap, and inherited the LAND pullback's
  // per-cell effHw clamp, whose magnitude depends on each terrain plot's own local edge
  // length — producing visibly uneven river width wherever tessellation density varied
  // along the chain, confirmed live 2026-07-12). This ribbon is a pure function of the
  // chain's own polyline + a FIXED half-width, entirely independent of terrain-plot
  // geometry, so it's constant-width by construction and handles a map-boundary
  // terminus (a lone end with no junction override — left/right simply cap the strip,
  // "proceed to the edge of the map") and an ordinary 2-way junction (computeJunctionData
  // mitres each incident chain's own corner to the SAME shared point, so two chains'
  // ribbons meet with zero gap — see this method's own confirmation via _polygonSelfIntersects,
  // and _buildRiverCliffJunctionCaps for the rarer beveled 3+-way case) with NO special-
  // casing needed here at all.
  //
  // Every corner position here is byte-identical to whatever position _pullBackPolygon
  // already snapped the adjacent LAND faces' own corners to (both ultimately read the
  // SAME computeRiverCliffBoundaries output — see _computeRiverCliffBoundaryData) — so
  // mintDeduped's reuseExisting finds and reuses those land faces' own split-vertex ids
  // at these exact positions, giving real registry-id sharing (gap-free adjacency by
  // construction) with zero DCEL dependency.
  //
  // boundaries: the Map _computeRiverCliffBoundaryData returned (chainId -> per-point
  // corners). edges: that same call's `edges` (chainId -> the River/Cliff worldTerrainData
  // edge, for assignedType).
  _buildRiverCliffFacesDirect(boundaries, edges) {
    const registry = this.gameStateManager.pointRegistry
    const built = []
    for (const [chainId, corners] of boundaries) {
      const edge = edges[chainId]
      if (!edge) continue
      const ptIds = edge.pointIds || []
      const idxs = []
      let lefts = [], rights = []
      for (let i = 0; i < corners.length; i++) {
        if (!corners[i]) continue
        idxs.push(i)
        lefts.push({ x: corners[i].left.x, y: corners[i].left.y })
        rights.push({ x: corners[i].right.x, y: corners[i].right.y })
      }
      if (lefts.length < 2) continue
      let loopPts = [...lefts, ...[...rights].reverse()]
      if (this._polygonSelfIntersects(loopPts)) {
        // Confirmed live (2026-07-13): a chain can self-intersect at the SAME spot on
        // EVERY pullback pass regardless of surrounding geometry — a fixed, local
        // problem (segments short relative to the fixed half-width), not something
        // more data will resolve. computeEdgeCorners' miterLimitDist bounds a single
        // corner's own spike but doesn't account for TWO nearby corners' offset
        // regions crossing each other across a short segment between them — the same
        // class of bug _pullBackPolygon's own effHw already guards against for land
        // polygons. Rather than drop the whole chain (a black gap — the stroke
        // fallback doesn't exist in District mode), progressively shrink toward the
        // chain's own raw centreline point — the first/last corners are left untouched
        // since those are what neighbouring chains'/land faces' own already-committed
        // corners are matched against (shrinking them would just move the gap to the
        // junction instead of fixing it).
        //
        // Scoped to only the SPECIFIC interior corners actually participating in a
        // crossing (via _polygonSelfIntersectingVertices), recomputed fresh from the
        // pristine, byte-for-byte-matching-the-land-side corner each attempt — not
        // every interior corner uniformly. Confirmed live (2026-07-12) that uniformly
        // shrinking the whole interior was the direct cause of visibly thin
        // River/Cliff ribbons and near-miss gaps against the land faces at every
        // corner along a chain, even ones nowhere near the actual crossing (see the
        // groundplane audit tool) — most of a long chain's corners were never the
        // problem and don't need to move at all.
        const m = idxs.length
        const fullLefts = lefts.slice(), fullRights = rights.slice()
        for (let attempt = 0; attempt < 4 && this._polygonSelfIntersects(loopPts); attempt++) {
          const t = 0.5 ** (attempt + 1)
          const badLoopIdx = this._polygonSelfIntersectingVertices(loopPts)
          lefts = fullLefts.slice(); rights = fullRights.slice()
          for (const idx of badLoopIdx) {
            const k = idx < m ? idx : (2 * m - 1 - idx)
            if (k <= 0 || k >= m - 1) continue
            const raw = registry.get(ptIds[idxs[k]])
            if (!raw) continue
            const c = corners[idxs[k]]
            lefts[k]  = { x: raw.x + (c.left.x  - raw.x) * t, y: raw.y + (c.left.y  - raw.y) * t }
            rights[k] = { x: raw.x + (c.right.x - raw.x) * t, y: raw.y + (c.right.y - raw.y) * t }
          }
          loopPts = [...lefts, ...[...rights].reverse()]
        }
        if (this._polygonSelfIntersects(loopPts)) {
          console.warn(`[river-cliff-face] chain ${chainId}: ribbon still self-intersects after narrowing interior corners — skipped, no face built`)
          continue
        }
        console.warn(`[river-cliff-face] chain ${chainId}: interior corners narrowed to avoid self-intersection (segments short relative to half-width there)`)
      }
      // Small tolerance, not exact equality: guards against float noise between this
      // call and the land faces' own use of the same corner values, without risking a
      // false merge (river/cliff half-width is 0.35 — 0.01 is nowhere near that scale).
      const pointIds = registry.mintDeduped(loopPts, 'terrain-split', 0.01, { reuseExisting: true })
      built.push({ id: chainId, sourceEdgeId: chainId, assignedType: edge.assignedType, pointIds, polygon: loopPts })
    }
    return built
  }

  // Fill the small fan-shaped gap a BEVELED (narrow-angle) 3+-way junction leaves
  // between adjacent chains' ribbons — see computeJunctionData's doc comment: a fully
  // mitered junction needs no cap at all (adjacent ribbons already meet at the exact
  // same point by construction, see _buildRiverCliffFacesDirect), this only ever
  // produces a real, visible polygon at a genuinely narrow-angle corner.
  //
  // fillsOut: the Map _computeRiverCliffBoundaryData returned (ptId -> {boundaryPts,
  // edgeIds, center}). edges: chainId -> worldTerrainData edge, for a cosmetic
  // assignedType pick (this face is typically a near-zero-area sliver; correctness of
  // the surrounding LAND geometry never depends on this choice).
  _buildRiverCliffJunctionCaps(fillsOut, edges) {
    const registry = this.gameStateManager.pointRegistry
    const built = []
    for (const [ptId, data] of fillsOut) {
      const pts = (data.boundaryPts || []).filter(p => p && isFinite(p.x))
      // Drop consecutive near-duplicate points (a fully/partly mitered slot's capPt
      // coincides with its neighbour's) — left as literal duplicates, these would
      // otherwise read as zero-length edges to _polygonSelfIntersects.
      const deduped = []
      for (const p of pts) {
        const last = deduped[deduped.length - 1]
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) deduped.push(p)
      }
      if (deduped.length >= 2 && Math.hypot(deduped[0].x - deduped[deduped.length - 1].x, deduped[0].y - deduped[deduped.length - 1].y) < 1e-6) deduped.pop()
      if (deduped.length < 3) continue   // fully mitered (or degenerate) — nothing to fill
      // computeJunctionData sorts incident edges by atan2 (CCW) and derives each capPt
      // from consecutive (i, i+1) pairs in that order — the opposite winding convention
      // from _buildRiverCliffFacesDirect's ribbons (lefts + reversed-rights). Left as-is,
      // this cap's boundary traverses its shared edge with a neighbouring ribbon in the
      // SAME direction the ribbon already claimed it, instead of the reverse a proper
      // manifold neighbour needs — confirmed live via the groundplane audit (8/8 junction
      // caps on a real map conflicting with their adjacent ribbon at insertFace time,
      // all resolved with zero new conflicts by this single reversal).
      deduped.reverse()
      if (this._polygonSelfIntersects(deduped)) {
        console.warn(`[river-cliff-junction-cap] point ${ptId}: fan-cap polygon self-intersects — skipped`)
        continue
      }
      const firstEdgeId = [...data.edgeIds][0]
      const assignedType = edges[firstEdgeId]?.assignedType || 'River'
      const pointIds = registry.mintDeduped(deduped, 'terrain-split', 0.01, { reuseExisting: true })
      built.push({ id: `junction-${ptId}`, sourceEdgeId: firstEdgeId, assignedType, pointIds, polygon: deduped })
    }
    return built
  }

  // A district's boundary is always a direct copy of its originating terrain plot's own
  // pointIds (see generateCityDistrictData / promoteTerrainPlotToDistrict — both copy
  // directly, never coordinate-matched). This used to independently RE-DERIVE the same
  // river/cliff pullback a second time — its own half-width (0.35 vs terrain plots' then-
  // 0.25), its own _computeRiverCliffDeltas call producing its own {dx,dy} group objects
  // — meaning even a corner shared byte-for-byte with the adjacent world-terrain plot
  // resolved to a DIFFERENT split point, at a DIFFERENT distance, than that plot's own
  // pullback. Confirmed live as a persistent black seam between a district's outer edge
  // and adjacent Lake/Sea terrain. Districts now simply ADOPT whatever their originating
  // terrain plot's own pullback (_applyRiverCliffPullbackToTerrainPlots, run first, right
  // below) already resolved — making a district's inner boundary and the world terrain's
  // fine-cell boundary the SAME geometry by construction, not two independently-tuned
  // heuristics landing close enough. This also removes the redundant double-computation
  // this session's plan Grounding findings flagged from the start.
  _applyRiverCliffPullback(districts) {
    // This used to unconditionally re-run the ENTIRE terrain-plot pullback from
    // scratch on every single call (i.e. every generateForLocked() pass during
    // District Setup, not just once on the Terrain->District transition). River/Cliff
    // assignment is already finalized by the time District Setup runs — terrain plots
    // were already correctly pulled back during Terrain Setup itself (assignEdgeType
    // calls _applyRiverCliffPullbackToTerrainPlots directly, see its call sites) — so
    // that re-run was geometrically a no-op except that registry.clearKind wiped and
    // re-minted every 'terrain-split' point fresh each time, churning their ids even
    // at unchanged coordinates, for no benefit. Removed (2026-07-12, live-confirmed
    // it was purely redundant work, not load-bearing for anything below).
    const wt = this.gameStateManager.worldTerrainData
    const registry = this.gameStateManager.pointRegistry
    const plotById = new Map((wt?.terrainPlots || []).map(p => [p.id, p]))

    for (const d of districts) {
      if (!d._rawPolygon) d._rawPolygon = d.polygon.map(v => ({ x: v.x, y: v.y }))
      if (!d._rawPointIds) d._rawPointIds = [...d.pointIds]
    }

    const remapByDistrict = new Map()
    let matchedDistrictCount = 0
    for (const d of districts) {
      const originId = d.originPlotId ?? d.promotedFromPlotId
      const plot = originId != null ? plotById.get(originId) : null
      if (!plot) {
        console.warn(`[river-cliff-pullback] district ${d.id}: no matching originating terrain plot (origin=${originId}) — pullback skipped for it this pass`)
        continue
      }
      // Re-match by RAW-VERTEX LINEAGE, not array length. A district's own boundary is
      // a direct copy of its origin plot's raw (pre-split) pointIds at promotion time
      // (see this method's original doc comment above _applyRiverCliffPullback), so
      // every id in d._rawPointIds is guaranteed to appear somewhere in the plot's OWN
      // vertex history — but comparing ARRAY LENGTHS to decide "did this still match"
      // is fragile to District Setup's incremental nature: edges get typed River/Cliff
      // one at a time, and a terrain plot's OWN split-vertex count can legitimately
      // grow (a newly-resolved confluence nearby, a new bank split) between the moment
      // a district's snapshot was frozen and any later pass — with the length check,
      // that alone permanently stops the district adopting, even though nothing about
      // ITS OWN corners is actually wrong (confirmed live: a persistent ~50% adoption
      // failure that persisted even after removing the redundant re-pullback above).
      // Instead, resolve the plot's CURRENT points back to whichever raw/base vertex
      // each one traces to (GroundPointRegistry.getOrCreateSplit tags every split
      // point with .baseId; an unsplit 'terrain' point is its own base) and look each
      // of the district's OWN raw ids up in that map individually — robust to the
      // plot's total vertex count changing for reasons unrelated to this district's
      // own corners.
      const currentByBase = new Map()
      for (const id of plot.pointIds) {
        const p = registry.get(id)
        const baseId = p?.baseId ?? id
        if (!currentByBase.has(baseId)) currentByBase.set(baseId, id)
      }
      const newIds = d._rawPointIds.map(rawId => currentByBase.get(rawId))
      if (newIds.length < 3 || newIds.some(id => id == null)) {
        console.warn(`[river-cliff-pullback] district ${d.id}: origin plot ${originId} no longer resolves all raw vertices — pullback skipped for it this pass`)
        continue
      }
      const newPolygon = newIds.map(id => { const p = registry.get(id); return p ? { x: p.x, y: p.y } : null })
      if (newPolygon.some(p => !p)) continue
      const changed = newIds.some((id, i) => id !== d.pointIds[i])
      if (changed) matchedDistrictCount++
      d.pointIds = newIds
      d.polygon = newPolygon
      const remap = new Map()
      for (let i = 0; i < d._rawPointIds.length; i++) remap.set(d._rawPointIds[i], d.pointIds[i])
      remapByDistrict.set(d.id, remap)
    }

    // Re-derive every city edge's pointIds from its owning district's remap (see doc
    // comment above) instead of matching by coordinate.
    const cityData = this.gameStateManager.cityDistrictData
    for (const edge of Object.values(cityData?.edges || {})) {
      if (!edge._rawPointIds) edge._rawPointIds = [...edge.pointIds]
      const remap = remapByDistrict.get(edge.districtA)
      if (!remap) continue
      edge.pointIds = edge._rawPointIds.map(id => remap.has(id) ? remap.get(id) : id)
    }

    this._rebuildEdgePoints(cityData)

    console.log(`[river-cliff-pullback] district(s) adopted from terrain-plot pullback: ${matchedDistrictCount}/${districts.length}`)
  }

  // Rebuild cityData.edgePoints as a pure materialized view: every point id referenced
  // by any district or edge, resolved against the live registry. Purely a transitional
  // convenience for consumers not yet reading gameStateManager.pointRegistry directly
  // (see plan Stage 5/6) — it holds no state of its own and is safe to discard and
  // recompute on every call.
  _rebuildEdgePoints(cityData) {
    if (!cityData) return
    const registry = this.gameStateManager.pointRegistry
    const ids = new Set()
    for (const e of Object.values(cityData.edges || {})) for (const id of (e.pointIds || [])) ids.add(id)
    for (const d of (cityData.districts || [])) for (const id of (d.pointIds || [])) ids.add(id)
    const points = []
    for (const id of ids) {
      const p = registry.get(id)
      if (p) points.push({ id, x: p.x, y: p.y })
    }
    cityData.edgePoints = points
  }

  // DCEL Step 3 (plan "typed-giggling-giraffe"): diagnostic-only parity check between
  // the shipping flat-array pullback path (getOrCreateSplit + a private pointIds/polygon
  // array per Surface) and the new DCEL vertex-split path (splitVertexSimple's
  // materialization: dcel.getOrCreateSplitVertex + reassigning a half-edge's origin).
  // Both consume the EXACT SAME already-computed `deltas` (from _computeRiverCliffDeltas,
  // unchanged) so this only tests whether the two MATERIALIZATION strategies agree, not
  // whether the pullback math itself agrees (that's shared, by construction).
  //
  // Builds a throwaway DCEL over a throwaway registry seeded from a snapshot of the
  // real registry's durable 'terrain' points (same ids, so `rawIds` resolves identically
  // in both), inserts every face, materializes the same deltas, and diffs the resolved
  // polygon against `faces[i].polygon` (already written by the flat-array path). Never
  // mutates real game state — the throwaway registry/DCEL are discarded after logging.
  // Per the plan: only delete the flat-array path once this stays clean on real cities.
  _dcelParityCheck(kind, faces, rawPolys, rawIds, deltas, splitKind) {
    const registry = this.gameStateManager.pointRegistry
    const parityRegistry = new GroundPointRegistry(registry.toJSON().filter(p => p.kind === 'terrain'))
    const dcel = new DCEL(parityRegistry)

    const dcelFaces = new Array(rawPolys.length).fill(null)
    for (let i = 0; i < rawPolys.length; i++) {
      const ids = dedupeConsecutiveIds(rawIds[i])
      if (ids.length < 3 || ids.length !== rawIds[i].length) {
        // A dedup here means this face has a genuinely degenerate (near-zero-length)
        // edge in its own raw geometry — not something this parity check can compare
        // apples-to-apples against the flat-array path's own (undeduped) output, so
        // skip it rather than report a false mismatch.
        continue
      }
      try { dcelFaces[i] = dcel.insertFace(ids, kind, {}) }
      catch (e) { console.warn(`[dcel-parity] ${kind} #${i}: insertFace failed — ${e.message}`) }
    }

    for (let i = 0; i < rawPolys.length; i++) {
      const face = dcelFaces[i]
      if (!face) continue
      const poly = rawPolys[i], ids = rawIds[i], polyDeltas = deltas[i]
      let hes
      try { hes = dcel._faceHalfEdges(face.id) } catch (e) { console.warn(`[dcel-parity] ${kind} #${i}: face walk failed — ${e.message}`); continue }
      for (let j = 0; j < ids.length; j++) {
        const d0 = polyDeltas[j]
        if (d0.dx === 0 && d0.dy === 0) continue
        const split = dcel.getOrCreateSplitVertex(ids[j], d0, poly[j].x + d0.dx, poly[j].y + d0.dy, 0, splitKind)
        hes[j].origin = split.id
      }
    }

    let mismatches = 0
    for (let i = 0; i < rawPolys.length; i++) {
      const face = dcelFaces[i]
      if (!face) continue
      let dcelPoly
      try { dcelPoly = dcel.resolveFacePolygon(face.id) } catch (e) { console.warn(`[dcel-parity] ${kind} #${i}: resolve failed — ${e.message}`); mismatches++; continue }
      const flatPoly = faces[i].polygon
      if (dcelPoly.length !== flatPoly.length) {
        mismatches++
        console.warn(`[dcel-parity] ${kind} #${i}: vertex count mismatch (dcel=${dcelPoly.length}, flat=${flatPoly.length})`)
        continue
      }
      for (let j = 0; j < dcelPoly.length; j++) {
        if (Math.abs(dcelPoly[j].x - flatPoly[j].x) > 1e-9 || Math.abs(dcelPoly[j].y - flatPoly[j].y) > 1e-9) {
          mismatches++
          console.warn(`[dcel-parity] ${kind} #${i} vertex ${j}: dcel=(${dcelPoly[j].x.toFixed(6)},${dcelPoly[j].y.toFixed(6)}) flat=(${flatPoly[j].x.toFixed(6)},${flatPoly[j].y.toFixed(6)})`)
          break
        }
      }
    }
    if (mismatches > 0) console.warn(`[dcel-parity] ${kind}: ${mismatches}/${faces.length} face(s) diverged from the flat-array path`)
    return mismatches
  }

  // Same pullback, applied to the RAW world-terrain plot cells (worldTerrainData.
  // terrainPlots) — the fine cells TerrainRenderer draws directly outside the city (and
  // scatters features like forest trees onto, via cell.polygon). Without this, a plot's
  // polygon reaches all the way to the river/cliff centreline the same way a district's
  // did before _applyRiverCliffPullback existed, so trees/ground render past the bank.
  // Point-splitting (see _applyRiverCliffPullback's doc comment) applies identically
  // here: two neighbouring cells sharing a raw corner (a real shared registry point id
  // since TerrainVoronoiGenerator Step 4/5.5) resolve to the literal same split id when
  // they move together, and independently otherwise — by construction, no snapping pass
  // needed. Terrain plots have no dependent "edges" data structure of their own to keep
  // in sync (world-terrain River/Cliff edges are the input to this pullback, read via
  // _riverCliffSegments() from their own untouched centreline points — they are never
  // themselves pulled back).
  //
  // Shared by both the terrain-plot and district pullback: given a set of RAW (pristine)
  // polygons and the river/cliff segments to pull back from, returns the FINAL per-vertex
  // {dx,dy} displacement for every polygon/vertex, guaranteeing that any two polygons
  // sharing a raw vertex converge on the identical final position.
  //
  // Pass 1: every polygon computes its own miter push independently (cheap — no clipping
  // library, never throws, never produces a degenerate ring). Every non-zero per-vertex
  // displacement becomes a "contribution" recorded at that vertex's PRISTINE coordinate.
  //
  // Contributions at the same coordinate are grouped by DIRECTION, not just coordinate,
  // before averaging. Two neighbours sharing a corner on the SAME bank push in roughly
  // the same direction (averaging smooths their disagreement — this is what an
  // asymmetric-complexity corner between two ordinary land cells needed). Two neighbours
  // directly ACROSS a river share a corner ON the centreline but need to move in OPPOSITE
  // directions, each away from it into its own bank — averaging -0.25 and +0.25 gives
  // exactly 0, silently cancelling the whole pullback (confirmed: a minimal two-square
  // repro with a river between them moved nothing). A simple greedy dot-product split
  // (>=0 joins the group, <0 starts a new one) keeps opposite-bank contributions separate
  // while still averaging same-bank ones.
  //
  // Pass 2: every polygon's FINAL delta per vertex is looked up by POINT ID, not by
  // whether that specific polygon's own edges independently matched — and not by
  // coordinate proximity either (the pre-Point/Surface-refactor version of this grouped
  // by a rounded coordinate key, which needed _snapSharedVertices run first as insurance
  // against float noise between independently-computed copies of "the same" corner; ids
  // are exact, by construction, so that whole apparatus is gone). This is what a
  // vertex-only match test structurally can't do on its own: a Lake/Sea cell's shoreline
  // edge is deliberately de-typed away from River (see assignTerrainToRegion) so it never
  // matches on its own, but its land neighbour's edge — which still touches the river's
  // other, still-typed segments at that same shared vertex — does, and gets pushed. Under
  // a "only apply MY OWN match" rule the Lake cell never follows, leaving a gap where the
  // land retreated but the water didn't. Looking up by id means a polygon with NO
  // contribution of its own still adopts whatever its neighbours computed there — and,
  // critically, callers materializing split registry points from this output (see
  // GroundPointRegistry.getOrCreateSplit) can key directly off the returned {dx,dy}
  // object's own identity as the "side", since every vertex that resolved to the same
  // group here IS the same object, by construction. If a vertex has multiple
  // direction-groups (rare — a genuine multi-bank junction) and this polygon has no delta
  // of its own to disambiguate which side it's on, pick whichever group's direction
  // points furthest into where this polygon's own centroid already is — i.e. the push
  // that's consistent with which side of the river this polygon is on.
  //
  // River-mouth/Sea-Lake junction handling: a vertex with NO own contribution (a Lake/Sea
  // cell whose own shoreline edge is deliberately de-typed, per the comment above) that
  // sees >=2 direction-groups from its neighbours is genuinely ambiguous — the fallback
  // below still picks ONE group (whichever push is most "in front of" this polygon's own
  // centroid) so a caller that only reads `deltas` gets the same lossy single-position
  // behavior as before this comment. `ambiguous` (Map<vertexId, groups[]>) is the
  // additive escape hatch: it records every such vertex's full group list so a caller
  // that CAN represent a topology change (see DCEL.splitVertexGeneral) can give the
  // water Surface an extra vertex — one flush with each bank — instead of gapping
  // against whichever bank the heuristic didn't pick.
  // edgeSourceIds (returned, parallel to rawPolygons/deltas) is per-polygon-per-edge:
  // edgeSourceIds[pi][i] is the sourceEdgeId (worldTerrainData.edges key) edge i of
  // polygon pi lies along, or null. Passed straight through from _pullBackPolygon —
  // consumed by _buildRiverCliffFaces to tag split half-edges with their physical
  // river/cliff chain.
  _computeRiverCliffDeltas(rawPolygons, rawPointIdArrays, boundaryById, halfWidth, rawRegionIds = null) {
    const zeroDeltasFor = (n) => new Array(n).fill(null).map(() => ({ dx: 0, dy: 0 }))
    if (!boundaryById.size) {
      return { deltas: rawPolygons.map(p => zeroDeltasFor(p.length)), anyMatch: rawPolygons.map(() => false), ambiguous: new Map(), edgeSourceIds: rawPolygons.map(p => new Array(p.length).fill(null)) }
    }

    const contribsById = new Map()   // point id -> [{ dx, dy, group }]
    const perPolyContribs = []       // parallel to rawPolygons: per-vertex contribution ref or null
    const anyMatch = []
    const edgeSourceIds = []         // parallel to rawPolygons: per-edge sourceEdgeId or null
    for (let pi = 0; pi < rawPolygons.length; pi++) {
      const poly = rawPolygons[pi]
      const ids = rawPointIdArrays[pi]
      const regionId = rawRegionIds ? rawRegionIds[pi] : null
      const { deltas, anyMatch: matched, edgeMatched } = this._pullBackPolygon(poly, ids, boundaryById, halfWidth, regionId)
      anyMatch.push(matched)
      edgeSourceIds.push(edgeMatched)
      const contribs = new Array(poly.length).fill(null)
      perPolyContribs.push(contribs)
      for (let i = 0; i < poly.length; i++) {
        if (deltas[i].dx === 0 && deltas[i].dy === 0) continue
        const contrib = { dx: deltas[i].dx, dy: deltas[i].dy, group: null }
        contribs[i] = contrib
        const id = ids[i]
        if (!contribsById.has(id)) contribsById.set(id, [])
        contribsById.get(id).push(contrib)
      }
    }

    // Declared here (not after this loop, as it originally was) because this loop is
    // now where EVERY multi-group vertex gets recorded — not just the no-vote-fallback
    // ones the deltas map below used to be the sole populator of. A genuine N-way
    // (N>=3) river/cliff confluence where every incident land face has its OWN vote
    // (no Lake/Sea/no-vote face involved at all — e.g. three River chains meeting at
    // one point) never triggered the old no-vote-only population, so
    // _dcelPullbackMaterialize's confluence-splice loop never even saw it: each face's
    // own corner got moved independently by splitVertexSimple with no connecting
    // geometry ever inserted between them, leaving a topological gap that
    // _buildRiverCliffFaces' bank-path walker sees as a "branch"/"closed loop" anomaly
    // (confirmed live: 13/13 of this map's multi-chain corners are exactly this kind of
    // all-own-vote 3-way confluence, not the water-splice case). Populating `ambiguous`
    // for every 2+-group vertex here (regardless of own-vote status) is what lets a new
    // N-way confluence-face pass in _dcelPullbackMaterialize find them.
    const ambiguous = new Map()
    for (const [vertexId, list] of contribsById) {
      const groups = []
      for (const c of list) {
        const g = groups.find(g => g.members[0].dx * c.dx + g.members[0].dy * c.dy >= 0)
        if (g) g.members.push(c); else groups.push({ members: [c] })
      }
      for (const g of groups) {
        let sx = 0, sy = 0
        for (const m of g.members) { sx += m.dx; sy += m.dy }
        g.avg = { dx: sx / g.members.length, dy: sy / g.members.length }
        for (const m of g.members) m.group = g.avg
      }
      // River/Cliff width consistency: a plain (non-confluence) vertex resolves to
      // exactly 2 groups — one per bank — each independently clamped by
      // _pullBackPolygon's effHw against THAT bank's own local edge lengths (see its
      // doc comment). Two independently-generated Voronoi tessellations on opposite
      // banks have no reason to agree on those lengths, so the two groups' push
      // magnitudes can differ — invisible when the old client stroke rendered at a
      // fixed thickness regardless of these numbers, but directly visible now that the
      // gap between the two banks IS the rendered river/cliff width (confirmed live:
      // visibly uneven width along a river). Rescale the LARGER magnitude down to
      // match the smaller one — this only ever shrinks a push, never grows one past
      // what a bank's own clamp already allowed, so it can't reintroduce the land-face
      // spike effHw exists to prevent. Mutate g.avg in place (not reassign) so every
      // member's `m.group` reference — and any split-vertex memoization already keyed
      // on that reference identity — stays valid.
      if (groups.length === 2) {
        const [gA, gB] = groups
        const magA = Math.hypot(gA.avg.dx, gA.avg.dy)
        const magB = Math.hypot(gB.avg.dx, gB.avg.dy)
        if (magA > 1e-9 && magB > 1e-9 && Math.abs(magA - magB) > 1e-9) {
          const bigger = magA > magB ? gA : gB
          const scale = Math.min(magA, magB) / Math.max(magA, magB)
          bigger.avg.dx *= scale
          bigger.avg.dy *= scale
        }
      }
      if (groups.length >= 2) ambiguous.set(vertexId, groups.map(g => g.avg))
    }

    // hasOwnVote (returned, parallel to deltas): true where THIS polygon's own edge at
    // that vertex was itself river/cliff-matched (contribs[i] truthy) — false wherever
    // the resolved delta only exists because a NEIGHBOUR's vote won the ambiguous
    // fallback below. `deltas` alone can't distinguish these two cases: an ambiguous
    // vertex's fallback returns one of `groups` by reference, the exact same kind of
    // value an own-vote polygon returns — so a caller needing "which face at this
    // vertex has no vote of its own" (see _dcelPullbackMaterialize's confluence splice
    // target search) needs this explicit signal, not a derived one.
    const deltas = rawPolygons.map((poly, pi) => {
      const ids = rawPointIdArrays[pi]
      const contribs = perPolyContribs[pi]
      let ccx = 0, ccy = 0
      for (const v of poly) { ccx += v.x; ccy += v.y }
      ccx /= poly.length; ccy /= poly.length
      return poly.map((v, i) => {
        if (contribs[i]) return contribs[i].group
        const list = contribsById.get(ids[i])
        if (!list?.length) return { dx: 0, dy: 0 }
        const groups = [...new Set(list.map(c => c.group))]
        if (groups.length === 1) return groups[0]
        if (!ambiguous.has(ids[i])) ambiguous.set(ids[i], groups)
        const toCentroid = { x: ccx - v.x, y: ccy - v.y }
        let best = groups[0], bestDot = -Infinity
        for (const g of groups) {
          const dot = g.dx * toCentroid.x + g.dy * toCentroid.y
          if (dot > bestDot) { bestDot = dot; best = g }
        }
        return best
      })
    })
    const hasOwnVote = perPolyContribs.map(contribs => contribs.map(c => !!c))
    return { deltas, anyMatch, ambiguous, edgeSourceIds, hasOwnVote }
  }

  _applyRiverCliffPullbackToTerrainPlots() {
    // Was 0.25 ("purely visual/feature-placement — no block-tracing slop to buffer
    // against"), back when districts computed their OWN independent 0.35 pullback. Then
    // 0.35 once _applyRiverCliffPullback started adopting districts' geometry directly
    // from here (see its doc comment) — that value carried over as districts' own
    // block/plot-tracing clearance margin too. Now 0.35/3, kept in sync with
    // TerrainRenderer's stroke thickness (`0.7/3` — see its doc comment) so the visual
    // stroke exactly covers the pulled-back gap again, same invariant as before (half-
    // width = thickness/2). NOTE: 0.25 was previously too small and caused
    // splitVertexGeneral geometric-overshoot failures (see _computeRiverCliffDeltas's
    // "Re-enabled" comment below) before being bumped to 0.35 — 0.35/3 (~0.117) is
    // smaller still, so watch for that failure mode resurfacing.
    const RIVER_CLIFF_HALF_WIDTH = 0.35 / 3
    const { byId: boundaryById, boundaries, fillsOut, edges: riverCliffEdges } = this._computeRiverCliffBoundaryData(RIVER_CLIFF_HALF_WIDTH)
    // Kept plots only — the pullback/split mutation below stays kept-plots-only,
    // unchanged (see the propagation-graph comment further down for the one place
    // hidden plots ARE deliberately included). terrainPlots/hiddenTerrainPlots merged
    // into one array (tagged via `.hidden`), so this needs an explicit filter now.
    const terrainPlots = (this.gameStateManager.worldTerrainData?.terrainPlots || []).filter(p => !p.hidden)
    const registry = this.gameStateManager.pointRegistry

    // See _applyRiverCliffPullback's matching comment — split points are ephemeral and
    // must be wiped before this pass mints its own, or the registry leaks a full set of
    // orphaned points every call.
    registry.clearKind('terrain-split')

    for (const cell of terrainPlots) {
      if (!cell._rawPolygon) cell._rawPolygon = cell.polygon.map(v => ({ x: v.x, y: v.y }))
      if (!cell._rawPointIds) cell._rawPointIds = [...cell.pointIds]
    }

    const rawPolys = terrainPlots.map(c => c._rawPolygon)
    const rawIds = terrainPlots.map(c => c._rawPointIds)
    const rawRegionIds = terrainPlots.map(c => c.parentRegionId)
    const { deltas, ambiguous, hasOwnVote } = this._computeRiverCliffDeltas(rawPolys, rawIds, boundaryById, RIVER_CLIFF_HALF_WIDTH, rawRegionIds)

    // Re-enabled (Stage B, plan Addendum 2): the second splitVertexGeneral failure —
    // after the fan-ordering fix — was root-caused as geometric overshoot (bank offsets
    // clamped only against LAND edge lengths could exceed a small water face's own
    // mouth wedge, e.g. the live "Plot 79" 3-vertex Lake triangle). The caller in
    // _dcelPullbackMaterialize now validates the prospective spliced polygon for
    // self-intersection BEFORE splicing and falls back to the single-position split
    // when it would break — so enabling this can never produce a worse result than the
    // always-false setting it replaces.
    const isWaterByIndex = (fi) => {
      const t = terrainPlots[fi]?.assignedType
      return t === 'Lake' || t === 'Sea'
    }
    const cliffSideAtVertex = this._computeCliffSideAtVertex()
    const { results, matchedCount, cliffHighIds, cliffLowIds } = this._dcelPullbackMaterialize(rawPolys, rawIds, deltas, ambiguous, 'terrain-split', isWaterByIndex, hasOwnVote, rawRegionIds, cliffSideAtVertex)

    for (let ci = 0; ci < terrainPlots.length; ci++) {
      const result = results[ci]
      if (!result) continue
      terrainPlots[ci].pointIds = result.pointIds
      terrainPlots[ci].polygon = result.polygon
    }

    // Cliff z-height (user-confirmed 2026-07-13, "both sides of the cliff connect to
    // their adjacent terrain"): the split above already gave each side's own corner
    // copies a differential z (posFor, inside _dcelPullbackMaterialize); this blends
    // that new height outward into each side's own surrounding fine terrain, same
    // hop-bounded/Euclidean-falloff shape every other terrain-type effect uses
    // (TerrainZHeight.js's propagateFromPoints), clamped to only ever raise the high
    // side and only ever lower the low side.
    if (cliffHighIds.length || cliffLowIds.length) {
      const targetZById = new Map()
      for (const id of [...cliffHighIds, ...cliffLowIds]) {
        const p = registry.get(id)
        if (p) targetZById.set(id, p.z)
      }
      // Propagation graph includes hidden (generated-but-unrendered) terrain plots too
      // (user-confirmed 2026-07-14, "those terrains are only hidden — they should still
      // be getting height updates") — a hidden plot is real geometry with a real point
      // graph, just not sent to the client; excluding it here meant a Cliff right at the
      // kept/hidden boundary never propagated its z past that boundary at all. Scoped to
      // ONLY these propagateFromPoints calls, not the pullback/split logic above (which
      // stays kept-plots-only, unchanged) — this is a read-only graph-walk, not a
      // geometry mutation, so there's no risk to the DCEL/split machinery from widening
      // it.
      const plotsForPropagation = this.gameStateManager.worldTerrainData?.terrainPlots || []
      if (cliffHighIds.length) propagateFromPoints(registry, plotsForPropagation, cliffHighIds, targetZById, CLIFF_Z_RULE.hopCount, CLIFF_Z_RULE.curve, 'up')
      if (cliffLowIds.length) propagateFromPoints(registry, plotsForPropagation, cliffLowIds, targetZById, CLIFF_Z_RULE.hopCount, CLIFF_Z_RULE.curve, 'down')
    }

    // Real, gap-free filled Faces (see plan "typed-giggling-giraffe" addendum, and
    // _buildRiverCliffFacesDirect's doc comment for why this is now built directly from
    // the chain's own boundary corners instead of inferred from DCEL topology) for
    // every River/Cliff stretch — the client renders these like Lake/Sea
    // (TerrainRenderer.buildRegionMesh) instead of stroking a polyline over the gap,
    // which is what produced the black-spike mismatch bugs. Built AFTER
    // _dcelPullbackMaterialize (above), so mintDeduped's reuseExisting can find and
    // reuse the LAND faces' own split-vertex ids at these exact corner positions. A
    // chain whose ribbon self-intersects (or a junction cap that does) just isn't in
    // this array and falls back to stroke rendering, same as before this change.
    const riverCliffFaces = [
      ...this._buildRiverCliffFacesDirect(boundaries, riverCliffEdges),
      ...this._buildRiverCliffJunctionCaps(fillsOut, riverCliffEdges),
    ]
    if (this.gameStateManager.worldTerrainData) this.gameStateManager.worldTerrainData.riverCliffFaces = riverCliffFaces

    this._syncLinearFeatureRegions(riverCliffFaces)
    this._syncGroundplaneSurfaces()

    console.log(`[river-cliff-pullback] ${boundaryById.size} river/cliff boundary point(s), ${matchedCount}/${terrainPlots.length} terrain plot(s) pulled back (miter, junction-averaged), ${riverCliffFaces.length} river/cliff face(s) built`)
  }

  // Edge→Region conversion (ADR-0020 decisions 4–6, plan Addendum 2 Stage B): every
  // typed linear terrain Edge (River/Cliff) is represented as a canonical Region record
  // in groundplane.regions — a typed group of Surfaces (its face records) PLUS
  // centrelinePointIds, the original Edge's own point ids, stored as the reversal
  // anchor: when the feature is cleared (e.g. glossary rule 1b de-typing a River beside
  // a new Lake), the undefined Edge is reconstructed from them. Rebuilt wholesale on
  // every pullback pass — a cleared Edge's Region simply isn't re-created, no delete
  // logic needed (same recompute-from-pristine philosophy as the pullback itself).
  // The edge record keeps existing as the hover/picking source during setup
  // (getEdgeAtWorldPos is geometric, against these same centreline points) — it gains a
  // regionId back-reference while typed; face records gain regionId forward links.
  _syncLinearFeatureRegions(riverCliffFaces) {
    const gp = this.gameStateManager.groundplane
    const edges = this.gameStateManager.worldTerrainData?.edges
    if (!gp || !edges) return

    const linearRegions = []
    for (const [edgeKey, edge] of Object.entries(edges)) {
      if (edge.assignedType !== 'River' && edge.assignedType !== 'Cliff') {
        delete edge.regionId
        continue
      }
      const regionId = `linear:${edgeKey}`
      edge.regionId = regionId
      const surfaces = (riverCliffFaces || []).filter(f => f.sourceEdgeId === edgeKey)
      for (const f of surfaces) f.regionId = regionId
      linearRegions.push({
        id: regionId,
        type: edge.assignedType,
        // Canonical Surface ids — `rcf:` prefix matches TerrainPlotConverter's
        // synthesized plot ids for the same faces, and _syncGroundplaneSurfaces'
        // Surface records.
        surfaceIds: surfaces.map(f => `rcf:${f.id}`),
        centrelinePointIds: [...(edge.pointIds || [])],
        name: edge.name || '',
        description: edge.description || '',
      })
    }

    // Replace only the linear-feature Regions; other Region kinds (districts, terrain
    // regions — see _syncGroundplaneSurfaces — and future streets) are preserved.
    gp.regions = [...(gp.regions || []).filter(r => !String(r.id).startsWith('linear:')), ...linearRegions]
  }

  // Stage A semantic reorganization (ADR-0020): assemble the canonical
  // groundplane.surfaces list and the terrain-region/district Region records as a
  // synced view over the current collections. Surfaces are single typed cells
  // (ordered Point-id lists); Regions are typed groups of Surfaces carrying the
  // gameplay payload. Until Stage C makes the generators produce these natively,
  // this sync (run after every pullback pass, alongside _syncLinearFeatureRegions)
  // is their single source — rebuilt wholesale, never patched.
  _syncGroundplaneSurfaces() {
    const gp = this.gameStateManager.groundplane
    const wt = this.gameStateManager.worldTerrainData
    if (!gp || !wt) return

    const surfaces = []
    // Hidden (generated-but-unrendered) terrain plots are tagged distinctly (`htp:`) so
    // nothing downstream confuses them for real, interactive kept surfaces — included
    // ONLY so auditGroundplane can see the real geometry bordering a kept plot's outer
    // edge (user-confirmed 2026-07-14, "shouldn't those actually be ok, since they have
    // linked geometry that's hidden"). Without this, every kept-plot edge touching a
    // hidden neighbour read as an unpaired HOLE — a false positive, not a real gap —
    // since the audit only ever saw one side of that boundary. The organic world's own
    // TRUE outer edge (beyond even the hidden ring) still correctly reports as a HOLE:
    // auditGroundplane's onWorldBoundary check already excludes it via the same
    // organicOuterRadius-based radius test used everywhere else, now just measured
    // against the hidden ring's own farther-out rim instead of the kept ring's.
    for (const cell of wt.terrainPlots || []) {
      surfaces.push({
        id: `${cell.hidden ? 'htp' : 'tp'}:${cell.id}`,
        kind: 'terrain-plot',
        type: cell.assignedType ?? null,
        pointIds: [...(cell.pointIds || [])],
      })
    }
    for (const f of wt.riverCliffFaces || []) {
      surfaces.push({
        id: `rcf:${f.id}`,
        kind: 'linear-segment',
        type: f.assignedType,
        pointIds: [...(f.pointIds || [])],
        regionId: f.regionId,
      })
    }
    // District Edge faces (ADR-0020 Stage C — _buildDistrictEdgeFaces): same treatment
    // as riverCliffFaces above, `de:` prefix matching _syncDistrictEdgeRegions'
    // surfaceIds. A chain still genuinely pending (street graph hasn't placed 2+
    // junctions along it yet) simply has no entry here, same fallback as River/Cliff.
    for (const f of this.gameStateManager.cityDistrictData?.districtEdgeFaces || []) {
      surfaces.push({
        id: `de:${f.id}`,
        kind: 'district-edge-face',
        type: f.assignedType,
        pointIds: [...(f.pointIds || [])],
        regionId: f.regionId,
      })
    }
    // Landmark footprints (ADR-0020 Stage C — LandmarkPlacer's own `registry` param):
    // same "omit if not registry-backed" fallback as blocks/plots below. `lm:${index}`
    // matches the existing landmarkBuildings array-index convention already used
    // elsewhere as a stable ref (see hq.refId lookups against this same array).
    ;(this.gameStateManager.cityDistrictData?.landmarkBuildings || []).forEach((lm, i) => {
      if (!lm.pointIds?.length) return
      surfaces.push({ id: `lm:${i}`, kind: 'landmark', type: lm.name ?? null, pointIds: [...lm.pointIds] })
    })
    // Blocks/plots (ADR-0020 Stage C): only present once pointIds are actually
    // registry-backed (CityBlockGenerator/PlotVoronoiGenerator threaded the shared
    // registry through — see their own doc comments) — a block/plot without pointIds
    // (pre-Stage-C caller, or a degenerate case that fell back gracefully) is simply
    // omitted here rather than recorded with a stale/empty point list.
    const cityData = this.gameStateManager.cityDistrictData
    for (const block of cityData?.blocks || []) {
      if (!block.pointIds?.length) continue
      surfaces.push({ id: `blk:${block.id}`, kind: 'block', type: block.blockType ?? null, pointIds: [...block.pointIds] })
    }
    for (const plot of cityData?.plots || []) {
      if (!plot.pointIds?.length || plot.type === 'terrain') continue   // terrain-type plots are the tp:/rcf: surfaces above, not a separate kind
      surfaces.push({ id: `plot:${plot.id}`, kind: 'plot', type: plot.blockType ?? null, pointIds: [...plot.pointIds] })
    }
    gp.surfaces = surfaces

    const otherRegions = []
    for (const r of wt.regions || []) {
      otherRegions.push({
        id: `terrain:${r.id}`,
        type: r.assignedType ?? null,
        surfaceIds: (wt.terrainPlots || []).filter(c => c.parentRegionId === r.id).map(c => `tp:${c.id}`),
        name: r.name || '',
        description: r.description || '',
      })
    }
    for (const d of this.gameStateManager.cityDistrictData?.districts || []) {
      const originId = d.originPlotId ?? d.promotedFromPlotId
      otherRegions.push({
        id: `district:${d.id}`,
        type: d.assignedType ?? null,
        surfaceIds: originId != null ? [`tp:${originId}`] : [],
        name: d.name || '',
        description: d.description || '',
        residentialClass: d.residentialClass,
        LeadershipClass: d.LeadershipClass,
      })
    }
    gp.regions = [
      ...(gp.regions || []).filter(r => {
        const id = String(r.id)
        return !id.startsWith('terrain:') && !id.startsWith('district:')
      }),
      ...otherRegions,
    ]

    this._auditAndLogGroundplane()
  }

  // Dev-only (see AUDIT_LOG_PATH's doc comment): runs auditGroundplane against the
  // just-synced snapshot, stores the result on gameStateManager for the API routes to
  // hand to the client (debug hole/overlap lines + a findings-count popup), and appends
  // a line to the log file regardless of whether anything was found — a clean run is as
  // useful to see in the log as a dirty one, when tracing back which update broke it.
  _auditAndLogGroundplane() {
    const gp = this.gameStateManager.groundplane
    // outerRingEdgeKeys (see _generateWorldWithHoleCheck): the map's outer boundary,
    // computed once on a hole-free New Game and exempt from HOLE reporting ever since —
    // every terrain-topology change (Cliff/River/Berm splits, District→Street→Block→
    // Plot generation) re-audits through this same method, so it's the single place
    // that needs to thread the ring through.
    const snapshot = { points: gp.points.toJSON(), surfaces: gp.surfaces || [], terrain: gp.terrain || {}, outerRingEdgeKeys: gp.outerRingEdgeKeys || null }
    const { counts, findings } = auditGroundplane(snapshot)
    this.gameStateManager.lastAuditCounts = counts
    this.gameStateManager.lastAuditFindings = findings
    try {
      mkdirSync(join(_dir, '../logs'), { recursive: true })
      appendFileSync(AUDIT_LOG_PATH, JSON.stringify({ at: new Date().toISOString(), counts, findings }) + '\n', 'utf8')
    } catch (e) {
      console.warn(`[groundplane-audit] failed to write log: ${e.message}`)
    }
  }

  // Recompute every terrain plot's polygon (and any district's, since a district's
  // polygon is just a copy of its originating terrain-plot cell's — see
  // generateCityDistrictData/promoteTerrainPlotToDistrict) from scratch, straight from
  // the seed points — which nothing ever mutates, unlike the polygon itself. A Voronoi
  // cell's shape is fully determined by its seed relative to every other seed, so this
  // reproduces the true original tessellation exactly, regardless of how many times
  // (or how badly) the stored polygon has since been clipped/pushed.
  //
  // This exists to UNDO a real regression: an earlier version of the server's load
  // sequence cleared _rawPolygon on every restart and re-ran the river/cliff pullback
  // against whatever polygon happened to be currently saved — on a dev box restarting
  // on every file save, that compounded a little more insetting each time, eventually
  // clipping affected cells down to nothing (rendering as empty/black). Seed points were
  // never touched by any of that, so recomputing from them is a full, clean recovery,
  // not a patch on top of the corruption. Safe to call unconditionally on every load —
  // it always derives the same correct answer from the same seeds, no compounding.
  // Point/Surface note: computeVoronoiCellsHalfPlane is a DIFFERENT Voronoi
  // implementation from TerrainVoronoiGenerator, with no vertex-object relationship to
  // the registry's existing 'terrain' points at all — recomputing .polygon here without
  // also re-deriving .pointIds would leave pointIds[i] and polygon[i] pointing at
  // completely different corners (confirmed: an unrelated-vertex-order mismatch, not a
  // small drift), so the NEXT pullback pass would compute deltas against the wrong
  // baseline and scramble affected plots into self-intersecting garbage. Every cell's
  // pointIds are re-derived via registry.mintDeduped(..., reuseExisting: true), which
  // matches each recovered vertex against the EXISTING 'terrain' point nearest it (and
  // self-heals that point's stored x/y to the freshly-recovered — known-correct —
  // position) rather than minting an unrelated fresh set, so ids stay durable across
  // recovery instead of being silently orphaned. Terrain plots are processed BEFORE
  // districts specifically so a district's corners resolve against its own originating
  // plot's just-refreshed points and land on the identical ids, not a coincidentally
  // close new set.
  _recoverGeometryFromSeeds() {
    const wt = this.gameStateManager.worldTerrainData
    const cells = wt?.terrainPlots
    if (!cells?.length) return
    const registry = this.gameStateManager.pointRegistry
    const RECOVERY_TOL = 0.05
    const W = wt.worldSize ?? 50
    // Organic outer clip circle ONLY — NEVER the literal world square (user-confirmed
    // 2026-07-14, "I never want these to be square, remove whatever is making it
    // square, and make it never happen"). A literal `[0,worldSize]` square used to be
    // built here (`worldRect`) purely to bound computeVoronoiCellsHalfPlane's half-plane
    // clip (a real requirement — it needs SOME bounding polygon) — it was never meant to
    // be the FINAL clip shape, but a since-removed exception then also used that same
    // square as the actual final clip for reveal-type regions (Sea/Mountains/Desert/Ice
    // Sheet), re-introducing a square cut on every reload for any region that had hidden
    // terrain revealed into it. Every cell — reveal-type or not — now gets the SAME
    // final clip: the organic outer circle, exactly matching generate()'s Step 5.5 and
    // _revealAdjacentHiddenTerrain's own (now-matching) live-reveal clip.
    const worldRect = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: W }, { x: 0, y: W }]
    // Hidden (organic-world, generated-but-unrendered) plots must be included here too
    // — computeVoronoiCellsHalfPlane has no sentinel-triangulation concept of "a
    // neighbour outside this point set bounds me"; without the hidden seeds acting as
    // real neighbours, every kept cell's half-plane clip only sees OTHER KEPT seeds and
    // the literal square, so it naturally expands to fill the square — visibly
    // reverting the whole map to the old square-clipped look on every load (confirmed
    // live 2026-07-12). `cells = wt.terrainPlots` already contains both kept AND hidden
    // entries (merged, tagged via `.hidden`) — the recovery loop below deliberately
    // recomputes EVERY cell's polygon uniformly, kept or hidden, since hidden plots get
    // the identical clip-circle treatment as kept ones at generation/reveal time; this
    // is what gives hidden geometry a real load-time recovery path (see the loop's own
    // comment below). `worldRect` itself is ONLY ever passed to
    // computeVoronoiCellsHalfPlane below, never used as a final clip target.
    const seeds = cells.map(c => c.seedPoint)
    const recomputed = computeVoronoiCellsHalfPlane(seeds, worldRect)
    // Same organic boundary generate()'s Step 5.5 clips kept plots to, and the same one
    // _revealAdjacentHiddenTerrain now uses for a freshly-revealed plot — even with
    // hidden seeds bounding it, a rim cell can still have residual boundary-effect
    // elongation (sparse real neighbours in one direction); the circle clip trims that
    // exactly like it does on a fresh generation, keeping recovered geometry identical
    // to what a live "New Game" (or a live reveal) would have produced. A revealed
    // region's plots can legitimately reach further out than an ordinary kept plot's own
    // organicClipCircle radius, so this uses the wider organicOuterClipRadius (same
    // radius _revealAdjacentHiddenTerrain's own clip circle uses) for every cell, not
    // the tighter default — a single, always-organic, always-generous clip shape.
    const clipCircle = organicClipCircle(W, 48, organicOuterClipRadius(W))
    const keyOf = (p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`
    const polyBySeedKey = new Map(recomputed.map(r => [keyOf(r.seedPoint), r.polygon]))
    const signedArea = (poly) => {
      let a = 0
      for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y }
      return a
    }
    // computeVoronoiCellsHalfPlane always winds its output opposite to a fresh
    // TerrainVoronoiGenerator polygon — confirmed: every cell from a brand-new
    // generate() has NEGATIVE signed area (150/150, deterministic, never varies).
    // THREE.js backface-culls by default, so a reversed-winding polygon's triangles all
    // face away from the top-down camera: the mesh still builds without error (matching
    // the "Rendered 150/150" log), it's just invisible. Comparing each recomputed ring
    // against whatever was already stored in cell.polygon (an earlier attempt at this)
    // is unreliable once a save has been through a recovery pass from BEFORE this fix
    // existed — that earlier bad pass already flipped some cells, so "matches current
    // storage" preserves their corruption instead of correcting it (confirmed: one real
    // save had 142 correct + 8 still-flipped cells after that approach). Coercing to the
    // fixed, known-correct sign directly fixes every cell regardless of history.
    const coerceWinding = (poly) => (signedArea(poly) > 0 ? [...poly].reverse() : poly)

    // Deliberately NO `if (c.hidden) continue` guard here — `cells` now contains both
    // kept and hidden plots merged together, and this loop recomputes EVERY one of them
    // uniformly. This is what gives hidden (generated-but-unrendered) geometry a real
    // load-time recovery path for the first time: hidden plots already get the exact
    // same clip-circle treatment as kept plots at generation time (Step 5.5) and on
    // reveal (_revealAdjacentHiddenTerrain), so recomputing them via this same seed-
    // based Voronoi math is correct, not just convenient. Do not "fix" this by
    // re-adding a hidden-skip guard — that would silently reintroduce the gap that made
    // GameStateManager.serialize() unable to strip hidden geometry's `.polygon` safely.
    let fixedCells = 0
    for (const c of cells) {
      const poly = polyBySeedKey.get(keyOf(c.seedPoint))
      if (!poly) continue
      const wound = coerceWinding(poly)
      const clipped = clipToPolygon(wound, clipCircle) || wound
      // District z-height (plan "typed-gliding-leaf") surfaced a real data-loss bug here:
      // this recomputed polygon comes from computeVoronoiCellsHalfPlane, which knows
      // nothing about z, and Cliff/River pullback (reapplied separately, AFTER this whole
      // function returns — see server/index.js's auto-load block) means a pulled-back
      // corner can legitimately sit further than RECOVERY_TOL from its own already-correct
      // registry point — mintDeduped's dedup then misses the match and mints a brand-new
      // point at z=0 (its create() default), silently flattening that corner (and, via
      // Tier 1/2 IDW, everything interpolated from it) on every reload. Backfill each new
      // vertex's z from the NEAREST pre-recovery point (c's own OLD pointIds, still valid
      // here — this loop hasn't reassigned them yet) before minting, so a tolerance miss
      // only ever costs X/Y precision, never the z data. mintDeduped itself now also
      // respects v.z instead of hardcoding 0 for a genuinely new point (see its own fix).
      const oldPoints = (c.pointIds || []).map(id => registry.get(id)).filter(Boolean)
      if (oldPoints.length) {
        for (const v of clipped) {
          let best = null, bestD = Infinity
          for (const p of oldPoints) {
            const d = (p.x - v.x) ** 2 + (p.y - v.y) ** 2
            if (d < bestD) { bestD = d; best = p }
          }
          if (best) v.z = best.z
        }
      }
      c.polygon = clipped
      c.pointIds = registry.mintDeduped(c.polygon, 'terrain', RECOVERY_TOL, { reuseExisting: true })
      delete c._rawPolygon
      delete c._rawPointIds
      fixedCells++
    }

    // Refresh coarse region hulls' pointIds/polygon from the just-recovered cells above
    // (Stage D, ADR-0020) — confirmed live (2026-07-16) this is NOT optional: a real
    // save's terrain-plot pointIds churned ~5% (24/455 ids) across a single recovery
    // pass (mintDeduped's reuseExisting missing tolerance on some corners and minting
    // fresh ones instead) — a region.pointIds captured once at original generation and
    // never refreshed would silently drift stale over repeated reloads, exactly the
    // staleness class this whole migration exists to eliminate. Mirrors
    // TerrainVoronoiGenerator's own Step 6 (vertsByRegion bucketing + convexHull), using
    // this.worldGenerator (already instantiated) for the identical hull algorithm.
    // Cell polygon vertices here are plain {x,y,z} (computeVoronoiCellsHalfPlane's
    // output, unlike a fresh generation's registry-linked objects), so pointId is paired
    // on positionally via each cell's own pointIds array before hulling. `wt.regions`
    // now includes former-hidden regions too (merged, tagged via `.hidden`) — this loop
    // refreshes those exactly the same way, no separate handling needed.
    {
      const vertsByRegion = new Map()
      for (const c of cells) {
        // A cell whose seedPoint failed to match polyBySeedKey above (rare) never got
        // c.polygon reassigned this pass — under Stage D's stripped save shape that
        // leaves it undefined (no fallback materialized copy to fall back to), where it
        // used to just be stale-but-present; guard explicitly rather than crash, same
        // "skip, don't fail loudly for a pre-existing rare miss" tolerance the poly
        // lookup above already has.
        if (!c.pointIds?.length || !Array.isArray(c.polygon) || c.polygon.length !== c.pointIds.length) continue
        if (!vertsByRegion.has(c.parentRegionId)) vertsByRegion.set(c.parentRegionId, [])
        const bucket = vertsByRegion.get(c.parentRegionId)
        c.polygon.forEach((v, i) => { if (isFinite(v.x) && isFinite(v.y)) bucket.push({ x: v.x, y: v.y, id: c.pointIds[i] }) })
      }
      for (const r of (wt.regions || [])) {
        const verts = vertsByRegion.get(r.id)
        if (!verts?.length) continue
        const hull = this.worldGenerator.convexHull(verts)
        r.polygon = hull.map(v => ({ x: v.x, y: v.y }))
        r.pointIds = hull.map(v => v.id)
      }
    }

    let fixedDistricts = 0
    const cityData = this.gameStateManager.cityDistrictData
    for (const d of (cityData?.districts || [])) {
      if (!d.seedPoint) continue
      const poly = polyBySeedKey.get(keyOf(d.seedPoint))
      if (!poly) continue
      d.polygon = coerceWinding(poly)
      // Terrain plot cells were already processed above, in the same registry — this
      // resolves against their just-refreshed 'terrain' points, so a district lands on
      // the identical ids as its originating plot, not a coincidentally close new set.
      d.pointIds = registry.mintDeduped(d.polygon, 'terrain', RECOVERY_TOL, { reuseExisting: true })
      delete d._rawPolygon
      delete d._rawPointIds
      fixedDistricts++
    }
    // Also drop cached edge raw-id snapshots so the next pullback re-captures fresh from
    // the (now-reconciled) district pointIds above, instead of remapping through a
    // pre-recovery snapshot that may reference an id mintDeduped just merged away.
    for (const edge of Object.values(cityData?.edges || {})) delete edge._rawPointIds

    // Rebuild cityData.edgePoints straight from the just-reconciled district/edge
    // pointIds (see _rebuildEdgePoints's own doc comment: "safe to discard and recompute
    // on every call"). Replaces a former ~50-line brute-force rotation/reflection search
    // that tried to re-anchor OLD edgePoints coordinates onto the recovered polygon by
    // SHAPE comparison — that workaround existed only because edgePoints had no id
    // lineage back to their owning district corner. It was also provably redundant in
    // the common case: server/index.js's load sequence always calls
    // _applyRiverCliffPullback() (which itself calls _rebuildEdgePoints) immediately
    // after this method returns, whenever any district is typed — silently overwriting
    // whatever the rotation search had just computed. The ONE case that call doesn't
    // cover — a save with districts created but none yet typed (server/index.js's
    // `typedDistricts.length` gate) — still needs edgePoints correct (edge-type
    // assignment/hover doesn't require a typed district), so call it directly here
    // instead of relying on a later, conditional caller.
    this._rebuildEdgePoints(cityData)

    // Re-resolve every .polygon from the registry AFTER every cell and district has
    // gone through mintDeduped above — not before. mintDeduped's "snap the reused point
    // to this call's value" self-healing (see GroundPointRegistry.js) means a shared
    // corner's FINAL registry position is whichever cell/district happened to process it
    // LAST in the loops above; a cell processed earlier keeps its OWN independently-
    // computed .polygon value (computeVoronoiCellsHalfPlane's near-cocircular numerical
    // noise, ~0.01-0.05 units — the same class of discrepancy _recoverGeometryFromSeeds'
    // own doc comment already describes) unless re-resolved here, meaning it would
    // structurally diverge from what its own pointIds now resolve to. Confirmed via the
    // DCEL validation check below (which reads the registry, not this stale .polygon) —
    // this pass is what makes .pointIds and .polygon consistent by construction rather
    // than "close enough", matching every other Surface in this refactor.
    for (const c of cells) if (c.pointIds) c.polygon = registry.resolve(c.pointIds).map(p => ({ x: p.x, y: p.y }))
    for (const d of (cityData?.districts || [])) if (d.pointIds) d.polygon = registry.resolve(d.pointIds).map(p => ({ x: p.x, y: p.y }))

    // DCEL Step 5 validation (see plan "typed-giggling-giraffe", migration step 5):
    // this function is the CONFIRMED root cause of a severe corruption bug earlier this
    // session (recovered polygons whose ids no longer matched their coordinates,
    // scrambling affected plots into self-intersecting garbage on the next pullback
    // pass) — build a throwaway DCEL from every just-reconciled pointIds array as an
    // extra structural safety net beyond the existing mismatch checks: insertFace must
    // succeed (no degenerate/self-crossing edge) and the DCEL's own resolved polygon
    // must match .polygon exactly. Diagnostic only, never mutates real game state.
    this._dcelValidateRecovery('terrain-plot', cells)
    this._dcelValidateRecovery('district', cityData?.districts || [])

    console.log(`[terrain-recovery] recomputed ${fixedCells}/${cells.length} terrain plot polygon(s), ${fixedDistricts} district polygon(s) from seed points`)
  }

  // See _recoverGeometryFromSeeds' call site for context. `faces` must already have
  // fresh, mutually-consistent .polygon/.pointIds (from mintDeduped(reuseExisting:true))
  // — this only checks that those ids form a genuinely valid, self-consistent planar
  // structure (every insertFace succeeds, every resolved polygon matches .polygon
  // exactly), not whether the recovery itself was geometrically correct.
  _dcelValidateRecovery(kind, faces) {
    const registry = this.gameStateManager.pointRegistry
    const parityRegistry = new GroundPointRegistry(registry.toJSON().filter(p => p.kind === 'terrain'))
    const dcel = new DCEL(parityRegistry)
    let bad = 0
    for (const f of faces) {
      if (!f.pointIds || !f.polygon) continue
      const ids = dedupeConsecutiveIds(f.pointIds)
      if (ids.length < 3 || ids.length !== f.pointIds.length) continue   // genuinely degenerate own geometry, not a recovery bug
      let face
      try { face = dcel.insertFace(ids, kind, {}) }
      catch (e) { bad++; console.warn(`[dcel-recovery-check] ${kind} ${f.id}: insertFace failed — ${e.message}`); continue }
      let resolved
      try { resolved = dcel.resolveFacePolygon(face.id) } catch (e) { bad++; console.warn(`[dcel-recovery-check] ${kind} ${f.id}: resolve failed — ${e.message}`); continue }
      if (resolved.length !== f.polygon.length) { bad++; console.warn(`[dcel-recovery-check] ${kind} ${f.id}: vertex count mismatch`); continue }
      for (let i = 0; i < resolved.length; i++) {
        if (Math.abs(resolved[i].x - f.polygon[i].x) > 1e-6 || Math.abs(resolved[i].y - f.polygon[i].y) > 1e-6) {
          bad++
          console.warn(`[dcel-recovery-check] ${kind} ${f.id} vertex ${i}: pointIds resolve to (${resolved[i].x.toFixed(6)},${resolved[i].y.toFixed(6)}) but .polygon says (${f.polygon[i].x.toFixed(6)},${f.polygon[i].y.toFixed(6)})`)
          break
        }
      }
    }
    if (bad > 0) console.warn(`[dcel-recovery-check] ${kind}: ${bad}/${faces.length} face(s) have inconsistent pointIds/polygon after recovery`)
    return bad
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
    // The Terrain→CitySubdivision transition, exactly when River/Cliff assignment is
    // finalized — pull every district back now rather than leaving them at their raw
    // (never-pulled-back) shape until some later, unrelated action happens to call
    // generateForLocked first.
    this.generateForLocked()
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
    // Pull back EVERY district — typed or not — from any river/cliff, unconditionally.
    // This used to only happen for the typed subset below (via _generateStreetGraph),
    // so an untyped district (the normal state through most of District Setup) never
    // got pulled back at all and its cityData.edgePoints were explicitly reset to raw
    // every call. Pure geometry, decoupled from street/block generation (which legitimately
    // stays gated to typed districts — untyped ones shouldn't get interior streets).
    this._applyRiverCliffPullback(cityData.districts)
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

  // Reseed a not-yet-locked district's interior streets, then regenerate. Always rerolls
  // the seed once (that's the point of an explicit "Regenerate Streets" click).
  regenerateDistrict(districtId) {
    const cityData = this.gameStateManager.cityDistrictData
    const district = cityData?.districts?.find(d => d.id === districtId)
    if (!district) throw new Error(`District ${districtId} not found`)
    if (!district.assignedType) throw new Error(`District ${districtId} has no type yet`)
    if (district.locked) throw new Error(`District ${districtId} is already applied and permanent`)

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

    if (district.promotedFromPlotId != null) {
      // Abandoned City Expansion — undo the promotion entirely rather than leaving a
      // blank district behind. The source terrain plot becomes eligible again (see
      // getCityDistrictDataForClient, which re-derives eligiblePromotionPlotIds).
      cityData.districts = cityData.districts.filter(d => d.id !== districtId)
      for (const key of Object.keys(cityData.edges || {})) {
        const edge = cityData.edges[key]
        if (edge.districtA === districtId || edge.districtB === districtId) delete cityData.edges[key]
      }
      this.generateForLocked()
      this.log.push(`Abandoned promotion of district ${districtId} — plot restored`)
      return { ok: true, log: this.log }
    }

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
  // Promote an unassigned, Living-Boundary-adjacent terrain PLOT (a fine Voronoi cell,
  // not its coarse parent Terrain region) into a new city District (City Expansion).
  // The plot's own polygon becomes the district polygon. After promotion the new
  // district is ordinary — it can be assigned any type including Leadership. Terrain
  // elevation is preserved (future Z-height); surface cover will be removed when the
  // district generates buildings.
  promoteTerrainPlotToDistrict(plotId) {
    const wt = this.gameStateManager.worldTerrainData
    const cityData = this.gameStateManager.cityDistrictData

    // Find the fine terrain plot — NOT the coarse merged Terrain region it belongs to.
    const plot = wt?.terrainPlots?.find(p => p.id === plotId)
    if (!plot) throw new Error(`Terrain plot ${plotId} not found`)

    // Only block if this specific plot already has a terrain DISTRICT assignment
    // (Forestry, Agriculture, etc.), tracked separately in terrainDistrictPlots.
    if (this.terrainDistrictPlots?.some(p => p.plotId === plotId)) {
      throw new Error(`Plot ${plotId} already has a terrain district assignment.`)
    }

    // Water, ice, and mountainous terrain can never become a city District.
    if (SetupPhase._isIneligibleTerrainPlot(plot, wt)) {
      throw new Error(`Plot ${plotId} is Lake/Sea/Ice Sheet/Mountains terrain and cannot become a city district.`)
    }

    // Defensive guard against re-promoting an already-promoted plot (e.g. two seats
    // racing on the same plot in multiplayer). The normal UI path can't reach this —
    // getCityDistrictDataForClient() excludes already-promoted plots from
    // eligiblePromotionPlotIds — but the server must not trust client state alone.
    const districts = cityData?.districts || []
    if (districts.some(d => d.promotedFromPlotId === plotId)) {
      throw new Error(`Plot ${plotId} has already been promoted to a city district.`)
    }

    // Must be within the Living Boundary — share a full boundary edge with any district.
    if (!this._isWithinLivingBoundary(plot, districts)) {
      throw new Error('This terrain plot is not adjacent to the city.')
    }

    // Build the new district from the terrain plot's own TRUE pristine geometry — its
    // _rawPolygon/_rawPointIds if the plot has already been through a river/cliff
    // pullback pass, not its current (possibly already-split) polygon/pointIds. Starting
    // from an already-split id here would make the district's own future pullback pass
    // split a split, and would leave the district's cached "raw" base stale forever if
    // the world-level river/cliff that caused the plot's split is later cleared.
    const newId = Math.max(-1, ...districts.map(d => d.id)) + 1
    const rawSourcePolygon = plot._rawPolygon || plot.polygon || plot.vertices || []
    const rawSourceIds = plot._rawPointIds || plot.pointIds || []
    const polygon = rawSourcePolygon.map(v => ({ x: v.x, y: v.y }))
    if (polygon.length < 3) throw new Error('Terrain plot has no usable polygon')

    const newDistrict = {
      id: newId,
      // z adopted from the originating terrain plot's own seedPoint (TODO.md
      // "Groundplane Z-height implementation", plan "rustling-churning-finch",
      // user-confirmed 2026-07-12: "Districts must adopt the City terrain plots'
      // z-heights that spawned them"). The district's boundary corners (pointIds,
      // below) already share the terrain plot's exact registry point ids, so THEIR z
      // is inherited automatically by construction — only seedPoint needed an explicit
      // copy, since it's a bare object, not a shared registry id (see §2).
      seedPoint: plot.seedPoint
        ? { x: plot.seedPoint.x, y: plot.seedPoint.y, z: plot.seedPoint.z ?? 0 }
        : { x: polygon[0].x, y: polygon[0].y, z: 0 },
      polygon,
      pointIds: [...rawSourceIds],
      assignedType: null,
      description: '',
      promotedFromPlotId: plotId,  // record the origin for future Z-height
    }
    districts.push(newDistrict)

    // Add boundary edges between the new district and its city neighbours.
    this._addPromotedDistrictEdges(newDistrict, cityData)

    // Otherwise the new district's polygon sits raw/un-pulled-back until some later,
    // unrelated action happens to call generateForLocked.
    this.generateForLocked()

    this.log.push(`Promoted terrain plot ${plotId} (region ${plot.parentRegionId}) to city district ${newId}`)
    return { ok: true, newDistrictId: newId, log: this.log }
  }

  // Check if a terrain plot shares a full boundary EDGE (two consecutive matching
  // vertices, not just one coincident corner) with any existing city district — this is
  // the Living Boundary rule (CONTEXT_WorldTerrain.md: "sharing an edge"). A single
  // shared vertex (a diagonal/corner touch) does NOT qualify.
  //
  // Compares RAW (pre-river/cliff-pullback) polygons, not the current ones — a River or
  // Cliff pullback deliberately pulls each side's shared corner apart to open the gap
  // the water/rock face fills, so two plots geometrically split by a river never share
  // an exact vertex in their CURRENT polygons even though they're still adjacent in
  // every sense that matters for city growth. Raw geometry is exactly the pre-split
  // shape, so it still has the exact shared vertices regardless of any river between
  // them (confirmed live: city expansion couldn't reach the far bank of a river running
  // through/beside the city). Falls back to the current polygon for a plot/district that
  // hasn't been through a pullback pass yet (no _rawPolygon captured) — identical to the
  // current polygon in that case anyway, so this is never a regression for the
  // no-river-between-them case.
  _isWithinLivingBoundary(plot, districts) {
    const EPS2 = 0.01 * 0.01
    const closeEnough = (p, q) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 < EPS2
    const poly = plot._rawPolygon || plot.polygon || plot.vertices || []
    if (poly.length < 2) return false
    for (let i = 0; i < poly.length; i++) {
      const a1 = poly[i], a2 = poly[(i + 1) % poly.length]
      for (const d of districts) {
        const dPoly = d._rawPolygon || d.polygon || []
        for (let j = 0; j < dPoly.length; j++) {
          const b1 = dPoly[j], b2 = dPoly[(j + 1) % dPoly.length]
          const matches = (closeEnough(a1, b1) && closeEnough(a2, b2)) || (closeEnough(a1, b2) && closeEnough(a2, b1))
          if (matches) return true
        }
      }
    }
    return false
  }

  // Recompute which terrain plots currently qualify for City Expansion (unassigned +
  // within the Living Boundary) and attach the id list to cityDistrictData, then return
  // it. The server is the single authority for this (ADR-0003) — the client reads the
  // list rather than re-deriving adjacency itself. Call sites: every response that sends
  // cityDistrictData to the client.
  getCityDistrictDataForClient() {
    const cityData = this.gameStateManager.cityDistrictData
    if (!cityData) return cityData
    const wt = this.gameStateManager.worldTerrainData
    const districts = cityData.districts || []
    const alreadyPromoted = new Set(districts.filter(d => d.promotedFromPlotId != null).map(d => d.promotedFromPlotId))
    const alreadyTerrainAssigned = new Set((this.terrainDistrictPlots || []).map(p => p.plotId))
    cityData.eligiblePromotionPlotIds = (wt?.terrainPlots || [])
      .filter(p => !alreadyPromoted.has(p.id) && !alreadyTerrainAssigned.has(p.id))
      .filter(p => !SetupPhase._isIneligibleTerrainPlot(p, wt))
      .filter(p => this._isWithinLivingBoundary(p, districts))
      .map(p => p.id)
    // District z-height (plan "typed-gliding-leaf"): district.polygon only carries {x,y}
    // — real z lives on the shared registry Points, addressed via district.pointIds (see
    // DistrictRenderer.setCityDistrictData's resolvePolygon call). Attach a registry
    // snapshot so every city-district client call site can resolve it, the same way
    // terrain routes already attach pointRegistry (server/index.js). A SHALLOW COPY, not
    // a mutation of the live cityData — GameStateManager.serialize() spreads
    // groundplane.city verbatim into the save, so writing this large, fully-derivable
    // field directly onto the live object would duplicate the whole registry into every
    // autosave.
    return { ...cityData, pointRegistry: this.gameStateManager.pointRegistry.toJSON() }
  }

  // Lake, Sea, Ice Sheet, and Mountains terrain can never become a city District — not
  // buildable land. A plot's own assignedType is only ever set to 'City' at Terrain Setup
  // (SetupPhase.js:initialize); its actual terrain type lives on its parent Region.
  static INELIGIBLE_PROMOTION_TERRAIN_TYPES = new Set(['Lake', 'Sea', 'Ice Sheet', 'Mountains'])
  static _isIneligibleTerrainPlot(plot, wt) {
    const region = wt?.regions?.find(r => r.id === plot.parentRegionId)
    return SetupPhase.INELIGIBLE_PROMOTION_TERRAIN_TYPES.has(region?.assignedType)
  }

  // Add District Edges between the newly promoted district and any existing districts
  // that share polygon boundary segments with it. newDistrict.pointIds already carries
  // the real global registry ids (copied straight from the originating terrain plot in
  // promoteTerrainPlotToDistrict), so edge pointIds are read off directly — no
  // coordinate-key resolver needed (the eps=0.01 resolvePointId pass this used to run,
  // and its private edgePoints dedup, are both deleted; see plan §2). StreetVoronoiGenerator
  // skips any city edge with fewer than 2 resolved pointIds, so a promoted district's
  // boundary must carry real point data, not just districtA/districtB references.
  _addPromotedDistrictEdges(newDistrict, cityData) {
    const edges = cityData.edges || (cityData.edges = {})
    const edgePoints = cityData.edgePoints || (cityData.edgePoints = [])
    let edgeIdx = Object.keys(edges).filter(k => k.startsWith('promoted-')).length
    const EPS2 = 0.01 * 0.01
    const close = (p, q) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 < EPS2

    // Classify every boundary SEGMENT of the new district (not just individual vertices):
    // does it coincide with a segment of an existing district (an inner edge), or does it
    // face open terrain (an outer edge, districtB: null)? Mirrors generateCityDistrictData's
    // inner/outer segment split so promoted districts get full-perimeter edge coverage —
    // without it, exterior-facing segments have no edge object at all, so they can never be
    // walled (_applyAutoWalling only iterates existing edges) and StreetVoronoiGenerator
    // never generates a boundary street/gutter there.
    const poly = newDistrict.polygon
    const ids = newDistrict.pointIds
    const n = poly.length

    // Ensure every one of this district's own points is present in cityData.edgePoints —
    // by id, not coordinate proximity, since these ARE the real registry ids already.
    // (cityData.edgePoints itself is a transitional convenience copy for consumers not
    // yet reading the point registry directly — see GroundPointRegistry.js.)
    const edgePointIds = new Set(edgePoints.map(p => p.id))
    for (let i = 0; i < n; i++) {
      if (!edgePointIds.has(ids[i])) {
        edgePoints.push({ id: ids[i], x: poly[i].x, y: poly[i].y })
        edgePointIds.add(ids[i])
      }
    }

    // A promoted district can be adjacent (in the raw, pre-pullback tessellation) to an
    // existing district ACROSS a River/Cliff — the two only "touch" because neither side
    // has been inset from the water yet. Match on the INSET copy instead of the raw one:
    // once each side is properly pulled back off the river/cliff, their segments no
    // longer coincide, so this correctly falls through to the "outer" branch below and
    // each district gets its own independent edge (own Wall, if typed) rather than being
    // merged into one shared inner edge that renders a single wall down the river's
    // centre. Only used for the coincidence test — the actual edge/point data below still
    // uses the raw `poly`, since _applyRiverCliffPullback (run later, once this district
    // is typed) is what actually insets district.polygon and keeps cityData.edgePoints in
    // sync; duplicating that here would double-pull-back this district's own boundary.
    const matchPoly = this._pullBackPolygon(poly, ids, this._riverCliffBoundaryById(0.35), 0.35).pushed

    const segmentNeighbor = new Array(n).fill(null)
    for (let i = 0; i < n; i++) {
      const a1 = matchPoly[i], a2 = matchPoly[(i + 1) % n]
      for (const d of (cityData.districts || [])) {
        if (d.id === newDistrict.id) continue
        const dPoly = d.polygon || []
        for (let j = 0; j < dPoly.length; j++) {
          const b1 = dPoly[j], b2 = dPoly[(j + 1) % dPoly.length]
          if ((close(a1, b1) && close(a2, b2)) || (close(a1, b2) && close(a2, b1))) {
            segmentNeighbor[i] = d.id
            break
          }
        }
        if (segmentNeighbor[i] != null) break
      }
    }

    // Merge consecutive same-neighbor segments into single polyline edges, carrying the
    // real global point ids straight from newDistrict.pointIds — no resolver needed.
    let outerIdx = 0
    let i = 0
    while (i < n) {
      const neighbor = segmentNeighbor[i]
      const start = i
      while (i < n && segmentNeighbor[i] === neighbor) i++
      const runIds = ids.slice(start, i).concat([ids[i % n]])
      if (neighbor != null) {
        const key = `promoted-${edgeIdx++}`
        edges[key] = { districtA: newDistrict.id, districtB: neighbor, pointIds: runIds, assignedType: null, description: '' }
      } else {
        const key = `promoted-outer-${newDistrict.id}-${outerIdx++}`
        edges[key] = { districtA: newDistrict.id, districtB: null, pointIds: runIds, assignedType: null, description: '' }
      }
    }
  }

  // Auto-pick a Leadership district from unapplied city districts and commit it.
  // Called when the player skips the Leadership prompt at finishSubdivision.
  autoAssignLeadership() {
    const cityData = this.gameStateManager.cityDistrictData
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
    this.log.push(`Auto-assigned Leadership (${LeadershipClass}) to district ${target.id}`)
    return { ok: true, districtId: target.id, LeadershipClass, log: this.log }
  }

  finishSubdivision({ skipLeadershipCheck = false } = {}) {
    const cityData = this.gameStateManager.cityDistrictData
    const RESIDENTIAL_CLASSES = ['Slums', 'Middle', 'Noble']
    const districts = cityData?.districts || []

    // Require exactly one Leadership district before finishing. If absent, return early
    // so the client can show the prompt (assign manually, or call autoAssignLeadership).
    if (!skipLeadershipCheck) {
      const hasLeadership = districts.some(d => d.assignedType === 'Leadership')
      if (!hasLeadership) {
        return { ok: false, needsLeadership: true, log: this.log }
      }
    }

    const usedTypes = new Set(districts.filter(d => d.assignedType && d.assignedType !== 'Leadership').map(d => d.assignedType))
    const missingTypes = SetupPhase.ALL_DISTRICT_TYPES.filter(t => !usedTypes.has(t))
    const typeQueue = SetupPhase._shuffleSeeded(missingTypes, 1337)

    for (const district of districts) {
      if (!district.assignedType) {
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
          // Register a real Recipe for the placeholder good so it derives consumption
          // through the same path as a player-defined resource, rather than a hand-rolled
          // consumedResources list that the Type system doesn't otherwise know about.
          const placeholderName = `Placeholder Good ${district.id}`
          this._registerResourceDef({
            name: placeholderName, gpValue: 10, type: 'Resource',
            ingredients: [`Placeholder Input ${district.id}A`, `Placeholder Input ${district.id}B`],
            specialInput: 'Labour'
          })
          district.producedResource = placeholderName
          district.secondProducedResource = null
          const derived = this._deriveConsumption([placeholderName])
          district.consumedResources = [...derived, ...['Water', 'Basic Food'].filter(r => !derived.some(e => e.toLowerCase() === r.toLowerCase()))]
          district.description = ''
          district.name = generateName('district', districtType)
          this.log.push(`Auto-assigned ${districtType} (placeholder resources) to district ${district.id}`)
        }
      }
      if (district.streetSeed == null) district.streetSeed = district.id
    }
    // Generation must succeed before we commit the locked state — if it throws,
    // districts remain unlocked so the player can retry without a broken state.
    this.generateForLocked()
    this._rebuildFactions()
    for (const district of districts) district.locked = true
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

    // River/cliff pullback now runs unconditionally for every district (typed or not)
    // in generateForLocked, this function's only caller, before the subset filtering
    // that produces `districts` here — see Edge, CONTEXT_WorldTerrain.md. No need to
    // repeat it on just this subset.

    const MAX_TOPOLOGY_RETRIES = 3
    let streetGraph = null
    for (let attempt = 0; attempt <= MAX_TOPOLOGY_RETRIES; attempt++) {
      const gen = new StreetVoronoiGenerator()
      streetGraph = gen.generate(districts, cityData.edges, cityData.edgePoints || [], epochSeed, tradeRoutes, this.gameStateManager.pointRegistry)
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
    const { blocks, roadEdges } = new CityBlockGenerator().generate(cityData.districts, cityData.streetGraph, this.gameStateManager.pointRegistry)
    cityData.blocks = blocks
    console.log(`[perf]   blocks: ${(performance.now()-tBlocks).toFixed(1)}ms (${blocks.length} blocks)`)

    // Mark City squares, then place Landmarks on their (joined) clusters BEFORE plots,
    // so plot generation can drop the ground beneath each Landmark (ADR-0005).
    const tLandmarks = performance.now()
    markSquareBlocks(blocks, cityData.districts)
    const { landmarkBuildings, footprints } = new LandmarkPlacer().generate(blocks, cityData.districts, this.gameStateManager.pointRegistry)
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
    const { plots } = new PlotVoronoiGenerator().generate(blocks, cityData.districts, junctions, roadEdges, footprints, this.gameStateManager.pointRegistry)
    cityData.plots = plots
    console.log(`[perf]   plots: ${(performance.now()-tPlots).toFixed(1)}ms (${plots.length} plots)`)

    // Terrain plots: ALWAYS recomputed fresh from the raw world terrain cells — never
    // reused from a previous pass. A district gaining its street graph for the first
    // time, or an existing district edge becoming a Wall/Canal/Docks/MainRoad (changing
    // what the city footprint covers there), both change which raw terrain plots should
    // be excluded (see the parentRegionId filter below — no boolean clipping against the
    // footprint polygon, see plan "typed-giggling-giraffe" ADR-0020 decision 2), and any
    // district (not just the one that just changed) can have terrain plots bordering it
    // that need to react. Recomputing from scratch every time is the only way that
    // doesn't require tracking which districts changed since the last pass.
    const tTerrain = performance.now()
    const wt = this.gameStateManager.worldTerrainData
    const rawTerrainPlots = this._rawSurroundingTerrainPlots()
    const tradeRoadWaypoints = (this.tradingDestinations || [])
      .map(td => this._tradeRoadWaypoints(td.roadPath || []))
      .filter(Boolean)
    const terrainPlots = convertTerrainCellsToPlots(rawTerrainPlots, tradeRoadWaypoints, wt?.regions || [], wt?.riverCliffFaces || [], this.gameStateManager.pointRegistry)
    cityData.plots = [...cityData.plots, ...terrainPlots]
    console.log(`[perf]   terrain plots: ${(performance.now()-tTerrain).toFixed(1)}ms (${terrainPlots.length} plots)`)
    if (terrainPlots.length > 0) {
      for (const edge of (cityData.streetGraph?.edges || []))
        if (edge.right === null) edge.right = 'terrain'
      for (const junction of (cityData.streetGraph?.junctions || [])) {
        if (junction.right === null) junction.right = 'terrain'
        for (const conn of (junction.connections || []))
          if (conn.right === null) conn.right = 'terrain'
      }
      computeTerrainPlotStreetAdjacency(cityData.streetGraph, terrainPlots)
      
    }


    this._syncDistrictEdgeRegions()
    this._syncGroundplaneSurfaces()

    console.log(`[perf]   _generateBuildings total: ${(performance.now()-t0).toFixed(1)}ms`)
    const terrainPlotCount = cityData.plots.filter(p => p.type === 'terrain').length
    this.log.push(`Generated ${blocks.length} blocks, ${plots.length} plots, ${landmarkBuildings.length} landmarks, ${cityData.streetGraph.squares.length} squares, ${terrainPlotCount} terrain plots`)
  }

  // Terrain plots to render as "surrounding countryside" outside the city — excludes
  // both the original City region's plots AND any individually City-Expansion-
  // promoted plot (promoteTerrainPlotToDistrict). A promoted plot becomes a district
  // (its own blocks/plots/buildings) but was never removed from
  // worldTerrainData.terrainPlots itself (by design — other code still needs its raw
  // geometry, e.g. _isWithinLivingBoundary) — without this exclusion its OLD raw
  // terrain-plot Surface kept rendering underneath/around the new district's own
  // content forever (confirmed live 2026-07-12: a district's buildings/streets sitting
  // on top of a visible leftover green terrain fill). Three call sites used to
  // duplicate this filter inline with only the cityRegionId half of it — factored out
  // so the promoted-plot half can't be missed in any of them again.
  _rawSurroundingTerrainPlots() {
    const wt = this.gameStateManager.worldTerrainData
    const cityRegionId = (wt?.regions || []).find(r => r.assignedType === 'City')?.id
    const promotedPlotIds = new Set(
      (this.gameStateManager.cityDistrictData?.districts || [])
        .filter(d => d.promotedFromPlotId != null)
        .map(d => d.promotedFromPlotId)
    )
    return (wt?.terrainPlots || []).filter(p => p.parentRegionId !== cityRegionId && !promotedPlotIds.has(p.id))
  }

  // Re-derive terrain plots from the current world terrain plots — run on save-load so
  // that saved terrain plots always reflect the latest conversion code.
  regenerateTerrainPlots() {
    const cityData = this.gameStateManager.cityDistrictData
    if (!cityData?.blocks?.length) return 0
    const wt = this.gameStateManager.worldTerrainData
    if (!(wt?.terrainPlots?.length)) return 0
    const rawTerrainPlots = this._rawSurroundingTerrainPlots()
    const tradeRoadWaypoints = (this.tradingDestinations || [])
      .map(td => this._tradeRoadWaypoints(td.roadPath || []))
      .filter(Boolean)
    const terrainPlots = convertTerrainCellsToPlots(rawTerrainPlots, tradeRoadWaypoints, wt?.regions || [], wt?.riverCliffFaces || [], this.gameStateManager.pointRegistry)
    cityData.plots = [...(cityData.plots || []).filter(p => p.type !== 'terrain'), ...terrainPlots]
    if (terrainPlots.length > 0) {
      const junctions = cityData.streetGraph?.junctions || []
      const roadEdges = gutterRoadEdges(junctions)
      computeTerrainPlotStreetAdjacency(cityData.streetGraph, terrainPlots)
      
    }
    return terrainPlots.length
  }

  // Re-derive all plots on load: city block plots (from saved blocks + junctions) and
  // terrain plots (from worldTerrainData). Replaces both old saved plot arrays.
  // Returns the total number of plots generated.
  regeneratePlots() {
    const cityData = this.gameStateManager.cityDistrictData
    if (!cityData?.blocks?.length || !cityData?.streetGraph) return 0

    const districts = Array.from(this.gameStateManager.districts.values())
    const blocks    = cityData.blocks
    const junctions = cityData.streetGraph.junctions || []
    const roadEdges = gutterRoadEdges(junctions)

    markSquareBlocks(blocks, districts)
    // Stage D (ADR-0020): resolve blockCorners for square blocks BEFORE the LandmarkPlacer
    // call below — its _clusterSquares needs real coordinates for centroid/area math, and
    // once GameStateManager.serialize() conditionally strips blockCorners (any block with
    // pointIds), a block loaded straight from the save may only have pointIds. Read-only
    // registry.resolve() here, deliberately NOT passing the registry into generate()
    // itself — see the next comment for why that stays forbidden.
    const registry = this.gameStateManager.pointRegistry
    for (const block of blocks) {
      if (block.blockCorners || !block.pointIds?.length) continue
      block.blockCorners = registry.resolve(block.pointIds).map(p => ({ x: p.x, y: p.y, z: p.z }))
    }
    // Deliberately NO registry passed into LandmarkPlacer.generate() (unlike
    // _generateBuildings' own call) — this method re-derives plots on load without
    // touching cityData.landmarkBuildings, which still holds pointIds minted by the
    // ORIGINAL _generateBuildings() pass that produced this save. Passing the registry
    // would clearKind('landmark') and re-mint fresh ids that this call then discards
    // (footprints here is transient, feeding PlotVoronoiGenerator only) — leaving the
    // saved landmarkBuildings[].pointIds dangling against deleted registry points.
    // footprints.polygon (plain {x,y}, no pointIds) is all PlotVoronoiGenerator needs to
    // drop plot cells under each Landmark.
    const { footprints } = new LandmarkPlacer().generate(blocks, districts)
    const { plots } = new PlotVoronoiGenerator().generate(blocks, districts, junctions, roadEdges, footprints, this.gameStateManager.pointRegistry)

    const wt = this.gameStateManager.worldTerrainData
    const rawTerrainPlots = this._rawSurroundingTerrainPlots()
    const tradeRoadWaypoints = (this.tradingDestinations || [])
      .map(td => this._tradeRoadWaypoints(td.roadPath || []))
      .filter(Boolean)
    const terrainPlots = convertTerrainCellsToPlots(rawTerrainPlots, tradeRoadWaypoints, wt?.regions || [], wt?.riverCliffFaces || [], this.gameStateManager.pointRegistry)

    cityData.plots = [...plots, ...terrainPlots]

    if (terrainPlots.length > 0) {
      for (const edge of (cityData.streetGraph?.edges || []))
        if (edge.right === null) edge.right = 'terrain'
      for (const junction of (cityData.streetGraph?.junctions || [])) {
        if (junction.right === null) junction.right = 'terrain'
        for (const conn of (junction.connections || []))
          if (conn.right === null) conn.right = 'terrain'
      }
      computeTerrainPlotStreetAdjacency(cityData.streetGraph, terrainPlots)
      
    }


    return cityData.plots.length
  }

  assignTerrainDistrict(regionId, plotId, districtType, description = '', producedResource = '', name = '', resourceDefs = []) {
    const regions = this.gameStateManager.worldTerrainData.regions
    const region = regions.find(r => r.id === regionId)
    if (!region) throw new Error(`Region ${regionId} not found`)
    if (plotId && this.terrainDistrictPlots.find(p => p.plotId === plotId)) {
      throw new Error(`Plot ${plotId} already has a terrain district`)
    }
    // Mutual exclusivity with City Expansion (CONTEXT_WorldTerrain.md: a plot promoted
    // to a city District is no longer "unassigned" and cannot also become Forestry/etc.).
    const cityDistricts = this.gameStateManager.cityDistrictData?.districts || []
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

    this.terrainDistrictPlots.push({
      plotId,
      regionId,
      districtType,
      description: description?.trim() || '',
      name: districtName,
      producedResource: producedTrimmed,
      consumedResources: allConsumed
    })

    this.factions.push({ id: this.factions.length, health: 70, type:'terrain', typeName: districtType, name: districtName, subclass: null, plotId, regionId, producedResource: producedTrimmed })

    this.log.push(`Assigned ${districtType} district to plot ${plotId} in ${region.assignedType} region ${regionId}`)
    return { ok: true, resourceRegistry: this.resourceRegistry, resourceDefinitions: this.resourceDefinitions, factions: this.factions, log: this.log }
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
      resourceDefinitions: this.resourceDefinitions,
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
    this.resourceDefinitions = data.resourceDefinitions ?? {}
    // Rebuild derived lists from source-of-truth data so older saves are reconciled on load.
    this._rebuildFactions()
    this._rebuildRegistry()
  }

  addGod({ domains, name, description, seatId }) {
    const god = { id: this.gods.length, domains, name, description, seatId }
    this.gods.push(god)
    // Every god gets an associated Worship Service — any district can consume it, but
    // only a Religious district (aligned to this god) can produce it (see assignDistrictType).
    this._registerResource(`Worship of ${name}`)
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

  addForeignPowerTrade({ fpId, name, description, buys = [], sells = [], resourceDefs = [] }) {
    const fp = this.foreignPowers.find(f => f.id === fpId)
    if (!fp) throw new Error('Foreign power not found')
    const label = (name || fp.name).trim()
    if (!label) throw new Error('A name is required')
    // Store new resource definitions (name, gpValue, ingredients) in the registry —
    // same pattern as assignDistrictType/assignTerrainDistrict.
    for (const def of resourceDefs) {
      if (def?.name) this._registerResourceDef(def)
    }
    const dest = { id: this.tradingDestinations.length, foreignPowerId: fpId, name: label, description: description || '', direction: fp.direction, terrainType: 'foreign-power', buys, sells }
    this.tradingDestinations.push(dest)
    this.factions.push({ id: this.factions.length, health: 100, type: 'trade', typeName: 'Foreign Trade', name: label, subclass: null, foreignPowerId: fpId, standing: {} })
    this.log.push(`Defined trade route with ${fp.name}: "${label}"`)
    return { ok: true, tradingDestinations: this.tradingDestinations, factions: this.factions, resourceRegistry: this.resourceRegistry, resourceDefinitions: this.resourceDefinitions, log: this.log }
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
      if (d.secondProducedResource) reg(d.secondProducedResource)
      for (const r of (d.consumedResources || [])) reg(r)
    }
    for (const tDP of (this.terrainDistrictPlots || [])) {
      if (tDP.producedResource) reg(tDP.producedResource)
      for (const r of (tDP.consumedResources || [])) reg(r)
    }
    // Every god's Worship service is selectable/consumable even before any Religious
    // district actually produces it (see addGod) — not derivable from district scans
    // alone, so re-register it here too or it silently drops on every reload.
    for (const god of (this.gods || [])) {
      if (god.name) reg(`Worship of ${god.name}`)
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
        this.factions.push({ id: this.factions.length, health: 70, type:'district', typeName: district.assignedType, name: district.name || '', subclass: district.residentialClass || null, districtId: district.id, producedResource: district.producedResource || '', secondProducedResource: district.secondProducedResource || '', standing: {} })
      }
    }
    for (const trade of this.tradingDestinations) {
      const region = regions.find(r => r.id === trade.regionId)
      this.factions.push({ id: this.factions.length, health: 70, type:'trade', typeName: region?.assignedType || 'Trade Route', name: trade.name || '', subclass: null, regionId: trade.regionId, standing: {} })
    }
  }
}
