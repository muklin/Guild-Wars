import * as THREE from 'three'
import PolylineRenderer from './utils/PolylineRenderer.js'
import FeatureManager from './utils/FeatureManager.js'
import { pointInPolygon, distanceToLineSegment, clipPolygonToBox, triangulatePolygon, resolvePolygon, posHash } from './utils/renderUtils.js'

const TERRAIN_COLORS = {
  City:          0x808080,
  Plains:        0xb2de69,
  Desert:        0xedca72,
  Mountains:     0x8d8d8d,
  Forest:        0x218c21,
  Lake:          0x1a5abf,
  Sea:           0x0e6e6c,
  Hills:         0x699B4F,
  Swamp:         0x4a6b4a,
  'Ice Sheet':   0xf4f8ff,
  unassigned:    0xb8a680,
  Cliff:         0xaaaaaa,
  River:         0x1a5abf,   // same as Lake — a river is the same water, just flowing
  get(type) {
    return this[type] ?? null
  }
}

export default class TerrainRenderer {
  constructor(scene) {
    this.scene = scene
    this.showDebug = false
    this.debugObjects = []
    this._terrainCenterMeshes = []   // red spheres at region seed points
    this._terrainVertexMeshes = []   // green boxes at polygon vertices

    this._terrainCentersVisible = true
    this._terrainSeedsVisible   = true

    this.terrainData = null
    this.worldSize = 50
    this.edgePointsById = new Map()
    // Once true (see setCityModeActive), the raw River/Cliff/unassigned terrain-edge
    // STROKE overlay (this.terrainPolylines) is a Terrain-Setup-only concept and never
    // renders again — District mode shows only the filled river/cliff DCEL faces (see
    // renderRiverCliffFaces) plus GroundRenderer's own district geometry. Without this,
    // the stroke overlay was never torn down on the terrain->city mode transition and
    // stayed visible underneath/alongside the new fills, showing through as black
    // slivers at every seam (confirmed live).
    this._cityModeActive = false

    this.regionMeshes = new Map()
    this.terrainPlotMeshes = new Map()
    this.regionTerrainPlots = new Map()
    this.terrainPolylines = null

    this.threatMeshes = []
    this.tradeMeshes = []
    this.roadMeshes = []

    this.featureManager = new FeatureManager(scene)
    this.spawnedFeatureRegions = new Map()
    this.spawnedFeaturePlots = new Set()   // plot ids that already have a terrain-district feature (e.g. fields)

    this._fpBandMeshes  = []
    this._fpBandCenters = []  // [{fp, worldX, worldZ}] for DOM label positioning

    this.hoveredRegionId = null
    this.hoveredEdgeId = null
    this.hoveredTerrainPlotId = null
    this.selectedRegionId = null
    this.selectedTerrainPlotId = null
    this._debugPreHoverColors = new Map()

    // Plots currently the source of a promoted (City Expansion) city district — hidden
    // and excluded from hit-testing while promoted; reversible if the promotion is undone.
    this.promotedPlotIds = new Set()
  }

  // Hide/show terrain plot meshes and keep them out of getTerrainPlotAtWorldPos hit-testing
  // while they're the source of a promoted city district. Reversible: ids removed from the
  // set (promotion abandoned/reverted) become visible and clickable again.
  setPromotedPlotIds(ids) {
    for (const id of this.promotedPlotIds) {
      if (!ids.has(id)) {
        const mesh = this.terrainPlotMeshes.get(id)
        if (mesh) mesh.visible = true
      }
    }
    for (const id of ids) {
      if (!this.promotedPlotIds.has(id)) {
        const mesh = this.terrainPlotMeshes.get(id)
        if (mesh) mesh.visible = false
      }
    }
    this.promotedPlotIds = ids
  }

  setDebugVisible(show) {
    this.showDebug = show
    for (const m of this._terrainCenterMeshes) m.visible = show && this._terrainCentersVisible
    for (const m of this._terrainVertexMeshes) m.visible = show && this._terrainSeedsVisible
  }

  setTerrainCentersVisible(on) {
    this._terrainCentersVisible = on
    for (const m of this._terrainCenterMeshes) m.visible = this.showDebug && on
  }

  setTerrainSeedsVisible(on) {
    this._terrainSeedsVisible = on
    for (const m of this._terrainVertexMeshes) m.visible = this.showDebug && on
  }

  clearDebugObjects() {
    this._clearDebugGroup(this._terrainCenterMeshes)
    this._clearDebugGroup(this._terrainVertexMeshes)
    for (const obj of this.debugObjects) this.scene.remove(obj)
    this.debugObjects = []
  }

  _clearDebugGroup(arr) {
    for (const obj of arr) this.scene.remove(obj)
    const toRemove = new Set(arr)
    this.debugObjects = this.debugObjects.filter(o => !toRemove.has(o))
    arr.length = 0
  }

  setTerrainPlotSelected(cellId) {
    if (this.selectedTerrainPlotId !== null && this.selectedTerrainPlotId !== cellId) {
      this._restoreTerrainPlotColor(this.selectedTerrainPlotId)
    }
    this.selectedTerrainPlotId = cellId
    const mesh = this.terrainPlotMeshes.get(cellId)
    if (mesh?.material) {
      mesh.material.color.setHex(0xffffff)
      mesh.material.emissive?.setHex(0xffffff)
      mesh.material.emissiveIntensity = 0.5
    }
  }

  clearTerrainPlotSelected() {
    if (this.selectedTerrainPlotId === null) return
    this._restoreTerrainPlotColor(this.selectedTerrainPlotId)
    this.selectedTerrainPlotId = null
  }

  _restoreTerrainPlotColor(cellId) {
    const cell = this.terrainData?.terrainPlots?.find(c => c.id === cellId)
    const base = cell ? this._regionBaseColor(cell.parentRegionId) : 0x888888
    const mesh = this.terrainPlotMeshes.get(cellId)
    if (mesh?.material) {
      mesh.material.color.setHex(base)
      mesh.material.emissive?.setHex(base)
      mesh.material.emissiveIntensity = 0.2
    }
  }

  clearHover() {
    if (this.hoveredTerrainPlotId !== null) {
      // Don't wipe the selected-cell's white highlight when clearing hover
      if (this.hoveredTerrainPlotId !== this.selectedTerrainPlotId) {
        const cell = this.terrainData?.terrainPlots?.find(c => c.id === this.hoveredTerrainPlotId)
        const baseColor = cell ? this._regionBaseColor(cell.parentRegionId) : 0x888888
        const mesh = this.terrainPlotMeshes.get(this.hoveredTerrainPlotId)
        if (mesh?.material) {
          mesh.material.color.setHex(baseColor)
          mesh.material.emissive?.setHex(baseColor)
          mesh.material.emissiveIntensity = 0.2
        }
      }
      this.hoveredTerrainPlotId = null
    }
    if (this.hoveredRegionId !== null) {
      const isSelected = this.selectedRegionId === this.hoveredRegionId
      const baseColor = isSelected ? 0xffffff : this._regionBaseColor(this.hoveredRegionId)
      const cellIds = this.regionTerrainPlots.get(this.hoveredRegionId) || []
      for (const cellId of cellIds) {
        const mesh = this.terrainPlotMeshes.get(cellId)
        if (mesh?.material) {
          const restoreColor = this.showDebug ? (this._debugPreHoverColors.get(cellId) ?? baseColor) : baseColor
          mesh.material.color.setHex(restoreColor)
          mesh.material.emissive?.setHex(restoreColor)
          mesh.material.emissiveIntensity = 0.2
          this._debugPreHoverColors.delete(cellId)
        }
      }
      if (cellIds.length === 0) {
        const rm = this.regionMeshes.get(this.hoveredRegionId)
        if (rm?.material) {
          const key = 'region_' + this.hoveredRegionId
          const restoreColor = this.showDebug ? (this._debugPreHoverColors.get(key) ?? baseColor) : baseColor
          rm.material.color.setHex(restoreColor)
          rm.material.emissive?.setHex(restoreColor)
          rm.material.emissiveIntensity = 0.2
          this._debugPreHoverColors.delete(key)
        }
      }
      this.hoveredRegionId = null
    }
    if (this.hoveredEdgeId !== null) {
      const mesh = this.edgeMeshes.get(this.hoveredEdgeId)
      if (mesh?.material?.emissiveIntensity !== undefined) mesh.material.emissiveIntensity = 0.5
      this.hoveredEdgeId = null
    }
  }

  // ── Terrain data ────────────────────────────────────────────────────────────

  // `pointsById` (Map<id, {x,y,z}>) is the client's copy of the server's Point registry
  // (see GroundPointRegistry.js) — when provided, every terrain plot's polygon is
  // resolved fresh from its own pointIds instead of trusting the server's `.polygon`
  // convenience copy, so the client's ground truth is the registry, not a snapshot that
  // could in principle drift from it. Falls back to the sent `.polygon` when a plot has
  // no pointIds or pointsById isn't available yet (e.g. an older save mid-migration).
  // riverCliffFaces: [{id, sourceEdgeId, assignedType, pointIds, polygon}] — real,
  // gap-free DCEL faces for River/Cliff stretches (see SetupPhase._buildRiverCliffFaces,
  // plan "typed-giggling-giraffe" addendum). Rendered as filled meshes exactly like
  // Lake/Sea (buildRegionMesh), replacing the stroked-polyline overlay for whichever
  // edges got a face — a chain that couldn't be built (confluence, etc) simply isn't in
  // this array and keeps stroke-rendering via PolylineRenderer, unchanged.
  setTerrainData(regions, edges, terrainPlots, edgePoints, pointsById, riverCliffFaces = []) {
    this.clearMarkers()
    console.log('setTerrainData called with', regions.length, 'regions,', Object.keys(edges || {}).length, 'edges,', (terrainPlots || []).length, 'terrain plots,', (edgePoints || []).length, 'edge points,', riverCliffFaces.length, 'river/cliff faces')
    this.edgePointsById = new Map((edgePoints || []).map(p => [p.id, p]))
    if (pointsById) {
      for (const cell of (terrainPlots || [])) {
        cell.polygon = resolvePolygon(cell.pointIds, pointsById) ?? cell.polygon
      }
      for (const face of riverCliffFaces) {
        face.polygon = resolvePolygon(face.pointIds, pointsById) ?? face.polygon
      }
    }
    this.terrainData = { regions, edges: edges || {}, terrainPlots: terrainPlots || [], riverCliffFaces }
    this.renderTerrain(regions, terrainPlots || [])
    // Reverted (2026-07-11): Terrain Setup mode's EDGE OVERLAY (renderEdges, below) goes
    // back to stroke rendering for every River/Cliff edge instead of skipping the ones
    // covered by a filled DCEL face — the face pipeline still has unresolved visual
    // artifacts at bends/confluences (see plan "typed-giggling-giraffe" Addendum 2 Stage
    // B notes) that the fixed-width stroke has always simply painted over. That revert
    // is scoped to the stroke overlay only; the filled faces themselves are still built
    // here so District mode (which tears down the stroke overlay entirely via
    // setCityModeActive) has something to show for River/Cliff before GroundRenderer's
    // own district-plot fill takes over (see deleteNonCityTerrainPlots, which retires
    // these meshes the moment that handoff happens — a restored call here was
    // accidentally dropped in the same edit that reverted the stroke overlay, leaving a
    // gap where River/Cliff rendered as nothing at all during District Setup, before any
    // district had a street graph).
    this.renderRiverCliffFaces(riverCliffFaces)
    this.drawVoronoiCenters(regions)
    if (edges && Object.keys(edges).length > 0) {
      this.renderEdges(edges)
    }
  }

  // Filled meshes for River/Cliff DCEL faces — reuses buildRegionMesh unchanged (it's
  // already generic over any {polygon, assignedType} shape; this is exactly what
  // already renders Lake/Sea).
  renderRiverCliffFaces(faces) {
    this.riverCliffFaceMeshes ??= new Map()
    this.riverCliffFaceMeshes.forEach(mesh => this.scene.remove(mesh))
    this.riverCliffFaceMeshes.clear()
    for (const face of faces || []) {
      const mesh = this.buildRegionMesh(face)
      if (!mesh) continue
      this.scene.add(mesh)
      this.riverCliffFaceMeshes.set(face.id, mesh)
    }
  }

  renderTerrain(regions, terrainPlots) {
    this.regionMeshes.forEach(mesh => this.scene.remove(mesh))
    this.regionMeshes.clear()
    this.terrainPlotMeshes.forEach(mesh => this.scene.remove(mesh))
    this.terrainPlotMeshes.clear()
    this.regionTerrainPlots.clear()

    if (terrainPlots && terrainPlots.length > 0) {
      const regionMap = new Map(regions.map(r => [r.id, r]))
      let count = 0
      for (const cell of terrainPlots) {
        const parent = regionMap.get(cell.parentRegionId)
        const mesh = this.buildRegionMesh({ ...cell, assignedType: parent?.assignedType ?? null })
        if (mesh) {
          this.scene.add(mesh)
          this.terrainPlotMeshes.set(cell.id, mesh)
          if (!this.regionTerrainPlots.has(cell.parentRegionId)) {
            this.regionTerrainPlots.set(cell.parentRegionId, [])
          }
          this.regionTerrainPlots.get(cell.parentRegionId).push(cell.id)
          count++
        }
      }
      console.log(`Rendered ${count}/${terrainPlots.length} terrain plots across ${this.regionTerrainPlots.size} merged regions`)
      // Re-apply promoted-plot suppression to the freshly rebuilt meshes.
      for (const id of this.promotedPlotIds) {
        const mesh = this.terrainPlotMeshes.get(id)
        if (mesh) mesh.visible = false
      }
      for (const region of regions) {
        if (region.assignedType === 'Forest') this._spawnFeatureForRegion('forest', region.id)
      }
    } else {
      let successCount = 0
      regions.forEach(region => {
        const mesh = this.buildRegionMesh(region)
        if (mesh) {
          this.scene.add(mesh)
          this.regionMeshes.set(region.id, mesh)
          successCount++
        }
      })
      console.log(`Rendered ${successCount}/${regions.length} merged region meshes (fallback)`)
    }
  }

  buildRegionMesh(region) {
    if (!region.polygon || region.polygon.length < 3) {
      console.warn(`Region ${region.id} has invalid polygon:`, region.polygon)
      return null
    }

    const polygon = clipPolygonToBox(region.polygon, 0, this.worldSize, 0, this.worldSize)
    if (polygon.length < 3) return null

    const vertices = []
    for (const v of polygon) {
      vertices.push(v.x || 0, 0, v.y || 0)
    }
    if (vertices.some(v => !isFinite(v))) {
      console.warn(`Region ${region.id} has non-finite vertices after clip`)
      return null
    }

    // Ear-clipping, not a fan from the centroid — River/Cliff pullback routinely clips a
    // concave notch into a terrain-plot polygon, and a centroid fan renders those wrong
    // (missing/inverted triangles wherever the centroid can't "see" an edge — confirmed
    // affecting hundreds of cells per generated world, not a rare corner case).
    const ears = triangulatePolygon(polygon)
    const triangles = []
    for (const [a, b, c] of ears) triangles.push(a, b, c)

    if (triangles.length === 0) return null

    let geometry
    try {
      geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3))
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(triangles), 1))
      geometry.computeVertexNormals()
      geometry.computeBoundingBox()
    } catch (e) {
      console.error(`Error creating geometry for region ${region.id}:`, e)
      return null
    }

    // Jittered per-polygon, same formula/seed as GroundRenderer's terrain-plot fill
    // (_jitterColor/_polySeed there) — once District Setup hands a cell's rendering off
    // to GroundRenderer (see deleteNonCityTerrainPlots), the SAME cell polygon
    // (TerrainPlotConverter copies cell.polygon into plot.blockCorners unchanged) is
    // re-colored by that identical formula, so the handoff produces no visible color
    // change. Computed from the pre-clip polygon (region.polygon) to match
    // GroundRenderer, which never clips.
    const baseColor = TERRAIN_COLORS.get(region.assignedType) || TERRAIN_COLORS.unassigned
    const color = this._jitterColor(baseColor, this._polySeed(region.polygon))
    // DoubleSide: every other renderer in this codebase (DistrictRenderer, GroundRenderer)
    // already renders this way — this was the one mesh left culling backfaces, so any
    // wrong-winding polygon (several found this session, from different sources) went
    // fully invisible instead of just rendering. See the winding-order fixes in
    // SetupPhase.js for why a cell's winding can't be guaranteed at every call site.
    const material = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.6,
      metalness: 0,
      emissive: color,
      emissiveIntensity: 0.2,
      side: THREE.DoubleSide
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData = { regionId: region.id }
    return mesh
  }

  // Identical formula to GroundRenderer's own _rand/_polySeed/_jitterColor — kept as an
  // exact duplicate (not a shared import) so the two renderers' output matches bit-for-
  // bit on the same polygon/seed without coupling them structurally; see buildRegionMesh's
  // doc comment for why that match matters (seamless Terrain→District handoff).
  _rand(seed) {
    let s = (seed * 2654435761) >>> 0
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 0x100000000
  }

  _polySeed(poly) {
    if (!poly?.length) return 0
    let cx = 0, cy = 0
    for (const v of poly) { cx += v.x; cy += v.y }
    return posHash(cx / poly.length, cy / poly.length)
  }

  _jitterColor(hex, seed) {
    const ch = (shift, i) => {
      const v = (hex >> shift) & 255
      const f = 0.95 + this._rand(seed * 31 + i) * 0.10
      return Math.max(0, Math.min(255, Math.round(v * f)))
    }
    return (ch(16, 1) << 16) | (ch(8, 2) << 8) | ch(0, 3)
  }

  // Once city/district mode is active, this whole overlay stays dark permanently — see
  // _cityModeActive's doc comment. setTerrainData still gets called on every subsequent
  // sync while in that mode (it's unconditional in App.js), so this guard is what stops
  // it from silently re-creating the stroke meshes setCityModeActive just tore down.
  setCityModeActive(active) {
    this._cityModeActive = active
    if (active) this.terrainPolylines?.dispose()
  }

  renderEdges(edges) {
    if (this._cityModeActive) return
    if (!this.terrainPolylines) {
      // thickness 0.7 -> half-width 0.35, matching SetupPhase.js's RIVER_CLIFF_HALF_WIDTH
      // exactly (that's what the land pullback now snaps to, via riverCliffBoundary.js's
      // shared geometry) — was 0.5 (half-width 0.25) from when terrain-mode stroking was
      // purely visual and pullback used its own, then-separate 0.25. Left mismatched
      // after RIVER_CLIFF_HALF_WIDTH was bumped to 0.35 for district-adoption (see that
      // constant's doc comment) — confirmed live as a constant ~0.1 gap between the
      // stroke's edge and the pulled-back land, i.e. the land was already agreeing with
      // the true river width, only the stroke was too narrow to reach it.
      this.terrainPolylines = new PolylineRenderer(this.scene, { thickness: 0.7, stripY: 0.01, priorityColor: TERRAIN_COLORS.River })
    }
    // Reverted (2026-07-11): every edge strokes, including River/Cliff — see
    // setTerrainData's matching comment for why the filled-face pass was dropped for
    // Terrain mode specifically.
    // Sea/Lake <-> Sea/Lake edges are never worth showing: River and Cliff (the only
    // assignable types) don't make sense between two water regions, and the raw region
    // boundary just cuts an ugly, meaningless line across what reads as one continuous
    // body of water.
    const WATER_TYPES = new Set(['Sea', 'Lake'])
    const regionsById = new Map((this.terrainData?.regions || []).map(r => [r.id, r]))
    const isWaterWaterEdge = (edge) => {
      const a = regionsById.get(edge.regionA), b = regionsById.get(edge.regionB)
      return !!a && !!b && WATER_TYPES.has(a.assignedType) && WATER_TYPES.has(b.assignedType)
    }
    const visibleEdges = Object.fromEntries(Object.entries(edges).filter(([, edge]) => !isWaterWaterEdge(edge)))
    console.log(`Rendering ${Object.keys(visibleEdges).length} edges (${Object.keys(edges).length - Object.keys(visibleEdges).length} Sea/Lake<->Sea/Lake edges hidden)`)
    this.terrainPolylines.render(
      visibleEdges,
      this.edgePointsById,
      (edge) => edge.assignedType ? TERRAIN_COLORS.get(edge.assignedType) : TERRAIN_COLORS.unassigned
    )
    console.log(`Successfully created ${this.edgeMeshes.size} edge meshes`)
  }

  get edgeMeshes()     { return this.terrainPolylines?.edgeMeshes     ?? new Map() }
  get junctionMeshes() { return this.terrainPolylines?.junctionMeshes ?? new Map() }

  hideUndefinedEdges() {
    const edges = this.terrainData?.edges || {}
    const hiddenEdgeIds = new Set()
    for (const [edgeId, edge] of Object.entries(edges)) {
      if (!edge.assignedType) {
        const mesh = this.terrainPolylines?._edgeMeshes?.get(edgeId)
        if (mesh) mesh.visible = false
        hiddenEdgeIds.add(edgeId)
      }
    }
    if (this.terrainPolylines) {
      for (const [ptId, mesh] of this.terrainPolylines.junctionMeshes) {
        const adjEdgeIds = this.terrainPolylines._junctionEdgeIds.get(ptId) ?? new Set()
        if ([...adjEdgeIds].every(id => hiddenEdgeIds.has(id))) mesh.visible = false
      }
    }
  }

  updateRegionColor(regionId, terrainType) {
    this._applyRegionColor(regionId, TERRAIN_COLORS.get(terrainType) || TERRAIN_COLORS.unassigned)
    if (terrainType === 'Forest') this._spawnFeatureForRegion('forest', regionId)
  }

  selectRegion(regionId) {
    this.clearTerrainPlotSelected()
    this.selectedRegionId = regionId
    this._applyRegionColor(regionId, 0xffffff)
  }

  deselectRegion(regionId) {
    if (this.selectedRegionId === regionId) this.selectedRegionId = null
    if (this.selectedTerrainPlotId !== null) {
      const plot = this.terrainData?.terrainPlots?.find(p => p.id === this.selectedTerrainPlotId)
      if (plot?.parentRegionId === regionId) this.clearTerrainPlotSelected()
    }
    this._applyRegionColor(regionId, this._regionBaseColor(regionId))
  }

  previewRegionType(regionId, terrainType) {
    const color = terrainType ? TERRAIN_COLORS.get(terrainType) : 0xffffff
    this._applyRegionColor(regionId, color)
  }

  selectEdge(edgeId) {
    this.terrainPolylines?.setEdgeColor(edgeId, 0xffffff)
  }

  deselectEdge(edgeId) {
    this.terrainPolylines?.resetEdgeColor(edgeId)
  }

  previewEdgeType(edgeId, edgeType) {
    const color = edgeType ? TERRAIN_COLORS.get(edgeType) : 0xffffff
    this.terrainPolylines?.setEdgeColor(edgeId, color)
  }

  updateEdgeColor(edgeId, terrainType) {
    const color = TERRAIN_COLORS.get(terrainType) || TERRAIN_COLORS.unassigned
    this.terrainPolylines?.updateBaseColor(edgeId, color)
  }

  setRegionHover(regionId) {
    if (this.hoveredRegionId === regionId && this.hoveredEdgeId === null) return
    this.clearHover()

    this.hoveredRegionId = regionId
    const baseColor = this._regionBaseColor(regionId)
    const lightened = new THREE.Color(baseColor).lerp(new THREE.Color(0xffffff), 0.35)
    const lightenedHex = lightened.getHex()

    const cellIds = this.regionTerrainPlots.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.terrainPlotMeshes.get(cellId)
      if (mesh?.material) {
        if (this.showDebug) this._debugPreHoverColors.set(cellId, mesh.material.color.getHex())
        mesh.material.color.setHex(lightenedHex)
        mesh.material.emissive?.setHex(lightenedHex)
        mesh.material.emissiveIntensity = 0.45
      }
    }
    if (cellIds.length === 0) {
      const rm = this.regionMeshes.get(regionId)
      if (rm?.material) {
        if (this.showDebug) this._debugPreHoverColors.set('region_' + regionId, rm.material.color.getHex())
        rm.material.color.setHex(lightenedHex)
        rm.material.emissive?.setHex(lightenedHex)
        rm.material.emissiveIntensity = 0.45
      }
    }
  }

  setTerrainPlotHover(cellId) {
    if (this.hoveredTerrainPlotId === cellId) return
    this.clearHover()
    this.hoveredTerrainPlotId = cellId
    const mesh = this.terrainPlotMeshes.get(cellId)
    if (!mesh?.material) return
    const cell = this.terrainData?.terrainPlots?.find(c => c.id === cellId)
    const baseColor = cell ? this._regionBaseColor(cell.parentRegionId) : 0x888888
    const lightened = new THREE.Color(baseColor).lerp(new THREE.Color(0xffffff), 0.35)
    const lightenedHex = lightened.getHex()
    mesh.material.color.setHex(lightenedHex)
    mesh.material.emissive?.setHex(lightenedHex)
    mesh.material.emissiveIntensity = 0.45
  }

  getTerrainPlotAtWorldPos(worldX, worldY) {
    if (!this.terrainData?.terrainPlots?.length) return null
    for (const cell of this.terrainData.terrainPlots) {
      if (this.promotedPlotIds.has(cell.id)) continue
      if (cell.polygon && pointInPolygon(worldX, worldY, cell.polygon)) return cell
    }
    return null
  }

  setEdgeHover(edgeId) {
    if (this.hoveredEdgeId === edgeId && this.hoveredRegionId === null) return
    this.clearHover()
    if (this.terrainData?.edges?.[edgeId]?.assignedType) return
    this.hoveredEdgeId = edgeId
    const mesh = this.edgeMeshes.get(edgeId)
    if (mesh?.material?.emissiveIntensity !== undefined) mesh.material.emissiveIntensity = 0.9
  }

  // Faction-hover highlight of an off-map region. Uses its OWN state (not
  // hoveredRegionId) so map-hover clearing never wipes it — only clearFactionRegion().
  highlightFactionRegion(regionId) {
    this.clearFactionRegion()
    this._factionRegionId = regionId
    const lightened = new THREE.Color(this._regionBaseColor(regionId)).lerp(new THREE.Color(0xffffff), 0.35).getHex()
    this._paintRegion(regionId, lightened, 0.45)
  }

  clearFactionRegion() {
    if (this._factionRegionId == null) return
    const id = this._factionRegionId
    const base = (this.selectedRegionId === id) ? 0xffffff : this._regionBaseColor(id)
    this._paintRegion(id, base, 0.2)
    this._factionRegionId = null
  }

  _paintRegion(regionId, hex, ei) {
    const cellIds = this.regionTerrainPlots.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.terrainPlotMeshes.get(cellId)
      if (mesh?.material) { mesh.material.color.setHex(hex); mesh.material.emissive?.setHex(hex); mesh.material.emissiveIntensity = ei }
    }
    if (cellIds.length === 0) {
      const rm = this.regionMeshes.get(regionId)
      if (rm?.material) { rm.material.color.setHex(hex); rm.material.emissive?.setHex(hex); rm.material.emissiveIntensity = ei }
    }
  }

  // ── Threats and trades ──────────────────────────────────────────────────────

  renderThreats(threats, regions) {
    this.threatMeshes.forEach(m => this.scene.remove(m))
    this.threatMeshes = []
    if (!threats?.length || !regions) return
    const regionMap = new Map(regions.map(r => [r.id, r]))
    const geo = new THREE.OctahedronGeometry(0.7)
    for (const threat of threats) {
      const region = regionMap.get(threat.regionId)
      if (!region) continue
      const mat = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff2222, emissiveIntensity: 0.6 })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(region.seedPoint.x, 1.8, region.seedPoint.y)
      this.scene.add(mesh)
      this.threatMeshes.push(mesh)
    }
  }

  renderTrades(tradingDestinations, terrainData, featureManager) {
    this.tradeMeshes.forEach(m => this.scene.remove(m))
    this.tradeMeshes = []
    this.roadMeshes.forEach(m => this.scene.remove(m))
    this.roadMeshes = []
    if (!tradingDestinations?.length || !terrainData?.regions) return
    const regionMap = new Map(terrainData.regions.map(r => [r.id, r]))
    const cellsByRegion = new Map()
    for (const cell of (terrainData.terrainPlots || [])) {
      if (!cellsByRegion.has(cell.parentRegionId)) cellsByRegion.set(cell.parentRegionId, [])
      cellsByRegion.get(cell.parentRegionId).push(cell)
    }
    for (const trade of tradingDestinations) {
      let terrainPlotPath = null, cellMap = null
      if (trade.roadPath?.length >= 2) {
        const result = this._buildFineRoadMesh(trade.roadPath, regionMap, cellsByRegion)
        if (result) {
          if (result.mesh) { this.scene.add(result.mesh); this.roadMeshes.push(result.mesh) }
          terrainPlotPath = result.terrainPlotPath
          cellMap = result.cellMap
        }
      }
      for (const bridge of (trade.bridges || [])) {
        if (!terrainPlotPath || !cellMap) continue
        let crossA = null, crossB = null
        for (let i = 0; i < terrainPlotPath.length - 1; i++) {
          const ca = cellMap.get(terrainPlotPath[i])
          const cb = cellMap.get(terrainPlotPath[i + 1])
          if (!ca || !cb) continue
          if (ca.parentRegionId === bridge.fromRegionId && cb.parentRegionId === bridge.toRegionId) { crossA = ca; crossB = cb; break }
          if (ca.parentRegionId === bridge.toRegionId && cb.parentRegionId === bridge.fromRegionId) { crossA = cb; crossB = ca; break }
        }
        if (!crossA || !crossB) continue
        const mx = (crossA.seedPoint.x + crossB.seedPoint.x) / 2
        const mz = (crossA.seedPoint.y + crossB.seedPoint.y) / 2
        const dx = crossB.seedPoint.x - crossA.seedPoint.x
        const dz = crossB.seedPoint.y - crossA.seedPoint.y
        const rotZ = Math.atan2(dz, dx)
        this.featureManager.spawn('bridge', [{ id: bridge.fromRegionId * 10000 + bridge.toRegionId }], { x: mx, z: mz, rotX: Math.PI / 2, rotY: 0, rotZ })
      }
    }
  }

  _buildFineRoadMesh(path, regionMap, cellsByRegion) {
    const W = this.worldSize
    const pathSet = new Set(path)
    const cityRegionId = path[path.length - 1]

    const pathCells = []
    for (const regionId of path) {
      for (const cell of (cellsByRegion.get(regionId) || [])) pathCells.push(cell)
    }
    if (pathCells.length === 0) return null
    const cellMap = new Map(pathCells.map(c => [c.id, c]))

    const adj = new Map()
    const vertToCells = new Map()
    for (const cell of pathCells) {
      for (const v of (cell.polygon || [])) {
        const key = `${Math.round(v.x * 20)},${Math.round(v.y * 20)}`
        if (!vertToCells.has(key)) vertToCells.set(key, [])
        vertToCells.get(key).push(cell.id)
      }
    }
    for (const [, ids] of vertToCells) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i], b = ids[j]
          if (!adj.has(a)) adj.set(a, new Set())
          if (!adj.has(b)) adj.set(b, new Set())
          adj.get(a).add(b)
          adj.get(b).add(a)
        }
      }
    }

    const edgeCells = cellsByRegion.get(path[0]) || []
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

    bfs: while (queue.length > 0) {
      const [curr, currPath] = queue.shift()
      if (cityIds.has(curr)) { terrainPlotPath = currPath; break bfs }
      for (const next of (adj.get(curr) || [])) {
        if (visited.has(next)) continue
        const nextCell = cellMap.get(next)
        if (!nextCell || !pathSet.has(nextCell.parentRegionId)) continue
        visited.add(next)
        queue.push([next, [...currPath, next]])
      }
    }

    if (!terrainPlotPath || terrainPlotPath.length < 2) return null

    // A waypoint is "wet" when its terrain plot belongs to a Sea/Lake region — no road
    // is drawn over water (bridges span the crossing instead).
    const isWater = (cell) => {
      const r = cell && regionMap.get(cell.parentRegionId)
      return !!r && (r.assignedType === 'Sea' || r.assignedType === 'Lake')
    }

    const waypoints = []
    const waterFlags = []
    for (let i = 0; i < terrainPlotPath.length - 1; i++) {
      const cell = cellMap.get(terrainPlotPath[i])
      if (cell) { waypoints.push({ x: cell.seedPoint.x, y: cell.seedPoint.y }); waterFlags.push(isWater(cell)) }
    }
    const cityCell = cellMap.get(terrainPlotPath[terrainPlotPath.length - 1])
    if (cityCell && waypoints.length > 0) {
      const last = waypoints[waypoints.length - 1]
      waypoints.push({
        x: (last.x + cityCell.seedPoint.x) / 2,
        y: (last.y + cityCell.seedPoint.y) / 2
      })
      waterFlags.push(isWater(cityCell))
    }

    if (waypoints.length < 2) return null

    const w0 = waypoints[0], w1 = waypoints[1]
    const dx = w0.x - w1.x, dy = w0.y - w1.y
    const candidates = []
    if (Math.abs(dx) > 1e-9) candidates.push(dx > 0 ? (W - w0.x) / dx : (0 - w0.x) / dx)
    if (Math.abs(dy) > 1e-9) candidates.push(dy > 0 ? (W - w0.y) / dy : (0 - w0.y) / dy)
    const t = Math.min(...candidates.filter(b => b > 1e-9))
    if (isFinite(t)) waypoints[0] = { x: w0.x + t * dx, y: w0.y + t * dy }

    return { mesh: this._buildRoadStripMesh(waypoints, waterFlags), terrainPlotPath, cellMap }
  }

  _buildRoadStripMesh(waypoints, waterFlags = []) {
    const thickness = 0.15
    const allVerts = [], allIdx = []
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (waterFlags[i] || waterFlags[i + 1]) continue   // no road over Sea/Lake cells
      const p1 = waypoints[i], p2 = waypoints[i + 1]
      const dx = p2.x - p1.x, dy = p2.y - p1.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len === 0) continue
      const px = (-dy / len) * (thickness / 2), py = (dx / len) * (thickness / 2)
      const base = allVerts.length / 3
      allVerts.push(
        p1.x - px, 0.04, p1.y - py, p1.x + px, 0.04, p1.y + py,
        p2.x + px, 0.04, p2.y + py, p2.x - px, 0.04, p2.y - py
      )
      allIdx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    if (allVerts.length === 0) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVerts), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(allIdx), 1))
    geometry.computeVertexNormals()
    const color = 0xc8a050
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, emissive: color, emissiveIntensity: 0.3 })
    return new THREE.Mesh(geometry, mat)
  }

  // Remove the terrain-plot trade-road ribbon (the setup-phase preview). In the
  // city phase the trade road is a real street-graph member rendered by
  // StreetRenderer, so the ribbon is cleared to avoid double-rendering the path.
  clearTradeRoadRibbon() {
    this.roadMeshes.forEach(m => this.scene.remove(m))
    this.roadMeshes = []
  }

  clearMarkers() {
    this.threatMeshes.forEach(m => this.scene.remove(m))
    this.threatMeshes = []
    this.tradeMeshes.forEach(m => this.scene.remove(m))
    this.tradeMeshes = []
    this.roadMeshes.forEach(m => this.scene.remove(m))
    this.roadMeshes = []
    this.featureManager?.clear()
    this.spawnedFeatureRegions.clear()
  }

  // A terrain district (Forestry/Mining/Agriculture/Fishing) is assigned to ONE specific
  // fine terrain plot, not its whole parent region (see assignTerrainDistrict, SetupPhase
  // .js) — so its visual feature must anchor to that plot, not scatter across 1-2 random
  // cells of the region (the previous _spawnFieldsForRegion(regionId) behaviour, which
  // could decorate a completely different plot than the one actually assigned).
  spawnTerrainDistrictFeature(regionId, plotId, districtType) {
    if (districtType !== 'Agriculture') return
    if (this.spawnedFeaturePlots.has(plotId)) return
    this.spawnedFeaturePlots.add(plotId)
    const cell = (this.terrainData?.terrainPlots || []).find(p => p.id === plotId)
    if (cell) this.featureManager.spawn('fields', [cell])
  }

  deleteCityTerrainCells() {
    const cityRegion = this.terrainData?.regions?.find(r => r.assignedType === 'City')
    if (!cityRegion) return
    const cellIds = this.regionTerrainPlots.get(cityRegion.id) || []
    for (const cellId of cellIds) {
      const mesh = this.terrainPlotMeshes.get(cellId)
      if (mesh) { this.scene.remove(mesh); this.terrainPlotMeshes.delete(cellId) }
    }
    this.regionTerrainPlots.delete(cityRegion.id)
    const regionMesh = this.regionMeshes.get(cityRegion.id)
    if (regionMesh) { this.scene.remove(regionMesh); this.regionMeshes.delete(cityRegion.id) }
  }

  // Remove all non-city terrain plot meshes — called when ground terrain plots take over
  // rendering of the terrain outside the city with gutter-aligned boundaries.
  deleteNonCityTerrainPlots() {
    const cityRegion = this.terrainData?.regions?.find(r => r.assignedType === 'City')
    const cityRegionId = cityRegion?.id ?? -1
    for (const [regionId, cellIds] of this.regionTerrainPlots) {
      if (regionId === cityRegionId) continue
      for (const cellId of cellIds) {
        const mesh = this.terrainPlotMeshes.get(cellId)
        if (mesh) { this.scene.remove(mesh); this.terrainPlotMeshes.delete(cellId) }
      }
      this.regionTerrainPlots.delete(regionId)
    }
    // GroundRenderer takes over river/cliff face rendering too, from this point on (see
    // TerrainPlotConverter's riverCliffFaces param) — retire these meshes the same way
    // terrain-plot fills above are retired, or the two would double-render.
    this.riverCliffFaceMeshes?.forEach(mesh => this.scene.remove(mesh))
    this.riverCliffFaceMeshes?.clear()
  }

  // ── Hit testing ─────────────────────────────────────────────────────────────

  getRegionAtWorldPos(worldX, worldY) {
    if (!this.terrainData) return null
    const terrainPlots = this.terrainData.terrainPlots
    if (terrainPlots && terrainPlots.length > 0) {
      const regionMap = new Map(this.terrainData.regions.map(r => [r.id, r]))
      for (const cell of terrainPlots) {
        if (cell.polygon && pointInPolygon(worldX, worldY, cell.polygon)) {
          return regionMap.get(cell.parentRegionId) || null
        }
      }
      return null
    }
    for (const region of this.terrainData.regions) {
      if (pointInPolygon(worldX, worldY, region.polygon)) return region
    }
    return null
  }

  getEdgeAtWorldPos(worldX, worldY) {
    if (!this.terrainData || !this.terrainData.edges) return null
    const threshold = 0.375
    let closestEdge = null
    let closestDistance = threshold
    for (const edgeId in this.terrainData.edges) {
      const edge = this.terrainData.edges[edgeId]
      const ids = edge.pointIds
      if (!ids || ids.length < 2) continue
      for (let i = 0; i < ids.length - 1; i++) {
        const p1 = this.edgePointsById.get(ids[i])
        const p2 = this.edgePointsById.get(ids[i + 1])
        if (!p1 || !p2) continue
        const distance = distanceToLineSegment(worldX, worldY, p1.x, p1.y, p2.x, p2.y)
        if (distance < closestDistance) {
          closestDistance = distance
          closestEdge = { ...edge, id: edgeId }
        }
      }
    }
    return closestEdge
  }

  getTerrainCornerAtWorldPos(worldX, worldY, threshold = 0.5) {
    if (!this.terrainData || !this.terrainData.regions) return null
    const cornerMap = new Map()
    for (let i = 0; i < this.terrainData.regions.length; i++) {
      const region = this.terrainData.regions[i]
      region.polygon.forEach((vertex, vertexIndex) => {
        const key = `${vertex.x.toFixed(4)},${vertex.y.toFixed(4)}`
        if (!cornerMap.has(key)) {
          cornerMap.set(key, { point: vertex, regionIds: [], vertexIndices: [] })
        }
        const entry = cornerMap.get(key)
        entry.regionIds.push(i)
        entry.vertexIndices.push(vertexIndex)
      })
    }
    for (const [, data] of cornerMap) {
      const dist = Math.sqrt(Math.pow(worldX - data.point.x, 2) + Math.pow(worldY - data.point.y, 2))
      if (dist < threshold && data.regionIds.length >= 2) return data
    }
    return null
  }

  getTerrainSeedAtWorldPos(worldX, worldY, threshold = 0.5) {
    if (!this.terrainData || !this.terrainData.regions) return null
    for (let i = 0; i < this.terrainData.regions.length; i++) {
      const region = this.terrainData.regions[i]
      const dist = Math.sqrt(Math.pow(worldX - region.seedPoint.x, 2) + Math.pow(worldY - region.seedPoint.y, 2))
      if (dist < threshold) return { regionId: region.id, position: region.seedPoint }
    }
    return null
  }

  // ── Animation update ────────────────────────────────────────────────────────

  update(delta, camera) {
    this.featureManager?.update(delta, camera)
  }

  // ── Debug ───────────────────────────────────────────────────────────────────

  drawVoronoiCenters(regions) {
    this._clearDebugGroup(this._terrainCenterMeshes)
    this._clearDebugGroup(this._terrainVertexMeshes)

    const seedGeo = new THREE.SphereGeometry(0.075, 8, 8)
    const seedMat = new THREE.MeshBasicMaterial({ color: 0xff0000 })
    regions.forEach(region => {
      const seed = new THREE.Mesh(seedGeo, seedMat)
      seed.position.set(region.seedPoint.x, 0.1, region.seedPoint.y)
      seed.userData = { kind: 'terrainCenter', regionId: region.id, assignedType: region.assignedType, x: region.seedPoint.x, y: region.seedPoint.y }
      seed.visible = this.showDebug && this._terrainCentersVisible
      this.scene.add(seed)
      this.debugObjects.push(seed)
      this._terrainCenterMeshes.push(seed)
    })

    const vertGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05)
    const vertMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 })
    regions.forEach(region => {
      region.polygon.forEach(vertex => {
        const vert = new THREE.Mesh(vertGeo, vertMat)
        vert.position.set(vertex.x, 0.1, vertex.y)
        vert.visible = this.showDebug && this._terrainSeedsVisible
        this.scene.add(vert)
        this.debugObjects.push(vert)
        this._terrainVertexMeshes.push(vert)
      })
    })
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _applyRegionColor(regionId, color) {
    const cellIds = this.regionTerrainPlots.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.terrainPlotMeshes.get(cellId)
      if (mesh) { mesh.material.color.setHex(color); mesh.material.emissive?.setHex(color) }
    }
    const rm = this.regionMeshes.get(regionId)
    if (rm) { rm.material.color.setHex(color); rm.material.emissive?.setHex(color) }
  }

  _regionBaseColor(regionId) {
    const region = this.terrainData?.regions?.find(r => r.id === regionId)
    return TERRAIN_COLORS.get(region?.assignedType) || TERRAIN_COLORS.unassigned
  }

  _cellsForRegion(regionId) {
    const cellIds = this.regionTerrainPlots.get(regionId) || []
    const cellMap = new Map((this.terrainData?.terrainPlots || []).map(p => [p.id, p]))
    return cellIds.map(id => cellMap.get(id)).filter(Boolean)
  }

  _spawnFeatureForRegion(featureName, regionId) {
    if (!this.spawnedFeatureRegions.has(regionId)) this.spawnedFeatureRegions.set(regionId, new Set())
    const spawned = this.spawnedFeatureRegions.get(regionId)
    if (spawned.has(featureName)) return
    spawned.add(featureName)
    const cells = this._cellsForRegion(regionId)
    if (cells.length > 0) this.featureManager.spawn(featureName, cells)
  }

  // ── Foreign Power border bands ───────────────────────────────────────────────

  renderForeignPowerBands(foreignPowers) {
    this.clearForeignPowerBands()
    if (!foreignPowers?.length) return
    for (const fp of foreignPowers) {
      const band = this._buildFPBand(fp.direction, fp.colour || '#888888')
      if (band) { this.scene.add(band); this._fpBandMeshes.push(band) }
      const center = this._computeFPBandCenter(fp.direction)
      if (center) this._fpBandCenters.push({ fp, worldX: center.x, worldY: center.y, worldZ: center.z })
    }
  }

  clearForeignPowerBands() {
    for (const m of this._fpBandMeshes) { m.geometry?.dispose(); m.material?.dispose(); this.scene.remove(m) }
    this._fpBandMeshes  = []
    this._fpBandCenters = []
  }

  setFPBandsVisible(visible) {
    for (const m of this._fpBandMeshes) m.visible = visible
  }

  _fpRayBoundary(cx, cy, vx, vy, W) {
    const candidates = []
    if (Math.abs(vx) > 1e-9) {
      const t = vx > 0 ? (W - cx) / vx : -cx / vx
      if (t > 0) {
        const hy = cy + t * vy
        if (hy >= -0.01 && hy <= W + 0.01)
          candidates.push({ t, x: Math.min(W, Math.max(0, cx + t * vx)), y: Math.min(W, Math.max(0, hy)) })
      }
    }
    if (Math.abs(vy) > 1e-9) {
      const t = vy > 0 ? (W - cy) / vy : -cy / vy
      if (t > 0) {
        const hx = cx + t * vx
        if (hx >= -0.01 && hx <= W + 0.01)
          candidates.push({ t, x: Math.min(W, Math.max(0, hx)), y: Math.min(W, Math.max(0, cy + t * vy)) })
      }
    }
    return candidates.length ? candidates.reduce((a, b) => a.t < b.t ? a : b) : null
  }

  // Convert a boundary hit point to a perimeter parameter t ∈ [0, 4W).
  // Perimeter goes clockwise from NW corner: North→East→South→West.
  _perimPosOf(hit, W) {
    const eps = 0.01
    if (hit.y <= eps)     return hit.x                  // North edge
    if (hit.x >= W - eps) return W + hit.y              // East edge
    if (hit.y >= W - eps) return 2 * W + (W - hit.x)    // South edge
    return 3 * W + (W - hit.y)                           // West edge
  }

  // Return {x, y, inX, inY} for a perimeter position t (wraps around 4W).
  // (x,y) is the 2D map point; (inX,inY) is the inward-facing normal.
  _perimPt(t, W) {
    const P = 4 * W
    const T = ((t % P) + P) % P
    if (T < W)       return { x: T,         y: 0,         inX: 0,  inY: 1  }
    if (T < 2 * W)   return { x: W,         y: T - W,     inX: -1, inY: 0  }
    if (T < 3 * W)   return { x: 3 * W - T, y: W,         inX: 0,  inY: -1 }
    return                 { x: 0,          y: 4 * W - T, inX: 1,  inY: 0  }
  }

  _buildFPBand(bearing, colourStr) {
    const W     = this.worldSize, toRad = Math.PI / 180
    const vx    = Math.sin(bearing * toRad), vy = -Math.cos(bearing * toRad)
    const hit   = this._fpRayBoundary(W / 2, W / 2, vx, vy, W)
    if (!hit) return null

    const halfLen = 12    // units along perimeter on each side of bearing point
    const depth   = 1.5  // strip thickness inward from boundary
    const Y       = 4.0  // float height — ShaderMaterial bypasses clip plane so it's visible in top-down
    const N_STRIP = 60   // samples for main strip
    const N_CAP   = 14   // semicircle segments per pill cap

    const hitT = this._perimPosOf(hit, W)
    const t0   = hitT - halfLen
    const t1   = hitT + halfLen

    const verts = [], tris = []
    let vi = 0
    const pushV = (x, z) => { verts.push(x, Y, z); return vi++ }

    // ── Main strip ───────────────────────────────────────────────────────────
    // Sample list = N_STRIP+1 evenly spaced t-values PLUS an exact sample at every map
    // corner (k*W) that falls strictly inside (t0,t1) — enumerated dynamically since a
    // band can wrap either direction (t0 can go negative, t1 can exceed 4W). Inserting a
    // real sample at the corner (instead of interpolating across it and separately
    // patching the resulting wedge with an ad-hoc triangle, which didn't align with the
    // strip's own vertices there and left a visible seam/overlap) lets the SAME quad-
    // building loop below bend cleanly through it once its inner point is mitered.
    const ts = []
    for (let i = 0; i <= N_STRIP; i++) ts.push(t0 + (i / N_STRIP) * (t1 - t0))
    const cornerTs = new Set()
    const kMin = Math.floor(t0 / W) - 1, kMax = Math.ceil(t1 / W) + 1
    for (let k = kMin; k <= kMax; k++) {
      const ct = k * W
      if (ct > t0 + 1e-6 && ct < t1 - 1e-6) cornerTs.add(ct)
    }
    for (const ct of cornerTs) ts.push(ct)
    ts.sort((a, b) => a - b)
    // Dedup samples that landed within noise distance of each other (a corner can fall
    // almost exactly on a regular grid sample).
    const dedupTs = []
    for (const t of ts) {
      if (dedupTs.length && t - dedupTs[dedupTs.length - 1] < 1e-4) continue
      dedupTs.push(t)
    }

    const oIdx = [], iIdx = []
    for (const t of dedupTs) {
      const p = this._perimPt(t, W)
      oIdx.push(pushV(p.x, p.y))
      let ix, iy
      if (cornerTs.has(t)) {
        // Proper bisector miter (same formula as _getMiteredCorners/SetupPhase.
        // _pullBackPolygon) so the inset point clears `depth` from BOTH adjacent edges
        // instead of the plain per-sample offset, which would leave a gap or overlap
        // right at the corner where the inward normal jumps 90°.
        const before = this._perimPt(t - 1e-3, W), after = this._perimPt(t + 1e-3, W)
        const bx = before.inX + after.inX, by = before.inY + after.inY
        const bl = Math.hypot(bx, by)
        if (bl < 1e-6) { ix = before.inX; iy = before.inY }
        else {
          const s = 1 / Math.max(0.15, (bx * before.inX + by * before.inY) / bl)
          ix = (bx / bl) * s; iy = (by / bl) * s
        }
      } else {
        ix = p.inX; iy = p.inY
      }
      iIdx.push(pushV(p.x + ix * depth, p.y + iy * depth))
    }
    for (let i = 0; i < dedupTs.length - 1; i++) {
      const a = oIdx[i], b = iIdx[i], c = oIdx[i + 1], d = iIdx[i + 1]
      tris.push(a, c, b,  b, c, d)
    }

    // ── Pill caps (rounded ends) ─────────────────────────────────────────────
    // sign: -1 = start cap (opens in −t direction), +1 = end cap (+t direction)
    const addCap = (t, sign) => {
      const p  = this._perimPt(t, W)
      const r  = depth / 2
      const cx = p.x + p.inX * r, cz = p.y + p.inY * r   // cap centre
      const tX = p.inY * sign,    tZ = -p.inX * sign       // outward tangent for this end

      const cv  = pushV(cx, cz)
      const arc = []
      for (let j = 0; j <= N_CAP; j++) {
        const a  = (j / N_CAP) * Math.PI
        // angle=0 → outer edge (boundary), angle=π → inner edge
        const ex = Math.cos(a) * (-p.inX) + Math.sin(a) * tX
        const ez = Math.cos(a) * (-p.inY) + Math.sin(a) * tZ
        arc.push(pushV(cx + ex * r, cz + ez * r))
      }
      for (let j = 0; j < N_CAP; j++) tris.push(cv, arc[j], arc[j + 1])
    }
    addCap(t0, -1)
    addCap(t1, +1)

    // ── Geometry + material ──────────────────────────────────────────────────
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1))

    // ShaderMaterial with default clipping:false bypasses the floor-scroll
    // clip plane, keeping the band visible in top-down orthographic mode.
    const color = new THREE.Color(colourStr)
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uOpacity: { value: 0.5 } },
      vertexShader: `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        void main() {
          gl_FragColor = vec4(uColor, uOpacity);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    return new THREE.Mesh(geo, mat)
  }

  _computeFPBandCenter(bearing) {
    const W   = this.worldSize, toRad = Math.PI / 180
    const vx  = Math.sin(bearing * toRad), vy = -Math.cos(bearing * toRad)
    const hit = this._fpRayBoundary(W / 2, W / 2, vx, vy, W)
    if (!hit) return null
    const p = this._perimPt(this._perimPosOf(hit, W), W)
    // Label sits at strip centre: depth/2 = 0.75 inward from boundary
    return { x: hit.x + p.inX * 0.75, y: 4.0, z: hit.y + p.inY * 0.75 }
  }

}
