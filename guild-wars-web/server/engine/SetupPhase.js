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
import GroundplaneAudit from './GroundplaneAudit.js'

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
    this.groundplaneAudit = new GroundplaneAudit(this)
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
  // ── GroundplaneAudit delegates (server/engine/GroundplaneAudit.js) ───────────────
  // River/Cliff/District-Edge pullback, DCEL materialize/parity, groundplane
  // Surface/Region sync, and the audit log now live there — see plan
  // "wondrous-conjuring-wand" Stage 3. Only the methods still called from elsewhere
  // in this file (or, for _recoverGeometryFromSeeds, from server/index.js) get a
  // delegate; every other method that moved is now purely internal to that module.
  _syncDistrictEdgeRegions(...args) { return this.groundplaneAudit._syncDistrictEdgeRegions(...args) }
  _cityEdgeIsNearWater(...args) { return this.groundplaneAudit._cityEdgeIsNearWater(...args) }
  _pullBackPolygon(...args) { return this.groundplaneAudit._pullBackPolygon(...args) }
  _applyRiverCliffPullback(...args) { return this.groundplaneAudit._applyRiverCliffPullback(...args) }
  _riverCliffBoundaryById(...args) { return this.groundplaneAudit._riverCliffBoundaryById(...args) }
  _applyRiverCliffPullbackToTerrainPlots(...args) { return this.groundplaneAudit._applyRiverCliffPullbackToTerrainPlots(...args) }
  _syncGroundplaneSurfaces(...args) { return this.groundplaneAudit._syncGroundplaneSurfaces(...args) }
  _recoverGeometryFromSeeds(...args) { return this.groundplaneAudit._recoverGeometryFromSeeds(...args) }

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
