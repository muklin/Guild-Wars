import * as THREE from 'three'
import EdgeLineRenderer from './utils/EdgeLineRenderer.js'
import FeatureManager from './utils/FeatureManager.js'
import { pointInPolygon, distanceToLineSegment, clipPolygonToBox, triangulatePolygon, resolvePolygon, posHash } from './utils/renderUtils.js'
import { disposeOne, disposeAll } from './utils/MeshLayer.js'

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
    this._terrainCenterMeshes = []   // red spheres at (coarse) region seed points
    this._terrainVertexMeshes = []   // green boxes at polygon vertices
    this._terrainPlotCenterMeshes = []   // orange spheres at raw terrain PLOT (fine cell) seed points
    this._surfaceCornerMeshes = []   // magenta diamonds at every distinct terrain-plot/river-cliff-face Surface corner (post-pullback, exact registry ids)
    this._auditFindingLines = []   // yellow (HOLE) / red (AREA_OVERLAP) lines from the last auditGroundplane run — dev-only, see renderAuditFindings

    this._terrainCentersVisible = true
    this._terrainSeedsVisible   = true
    this._terrainPlotCentersVisible = true
    // Default OFF (2026-07-13, per explicit request) — every terrain plot corner is a
    // LOT of markers (150 cells × ~6 corners each, largely overlapping neighbours'
    // corners at shared edges) and would otherwise clutter the view by default.
    this._surfaceCornersVisible = false

    this.terrainData = null
    this.worldSize = 50
    this.edgePointsById = new Map()
    this._groundFlattened = false   // tracked so a freshly-built EdgeLineRenderer can sync immediately — see renderEdges
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
    for (const m of this._terrainPlotCenterMeshes) m.visible = show && this._terrainPlotCentersVisible
    for (const m of this._surfaceCornerMeshes) m.visible = show && this._surfaceCornersVisible
    for (const m of this._auditFindingLines) m.visible = show
  }

  setTerrainCentersVisible(on) {
    this._terrainCentersVisible = on
    for (const m of this._terrainCenterMeshes) m.visible = this.showDebug && on
  }

  setTerrainSeedsVisible(on) {
    this._terrainSeedsVisible = on
    for (const m of this._terrainVertexMeshes) m.visible = this.showDebug && on
  }

  setTerrainPlotCentersVisible(on) {
    this._terrainPlotCentersVisible = on
    for (const m of this._terrainPlotCenterMeshes) m.visible = this.showDebug && on
  }

  setSurfaceCornersVisible(on) {
    this._surfaceCornersVisible = on
    for (const m of this._surfaceCornerMeshes) m.visible = this.showDebug && on
  }

  clearDebugObjects() {
    this._clearDebugGroup(this._terrainCenterMeshes)
    this._clearDebugGroup(this._terrainVertexMeshes)
    this._clearDebugGroup(this._terrainPlotCenterMeshes)
    this._clearDebugGroup(this._surfaceCornerMeshes)
    this._clearDebugGroup(this._auditFindingLines)
    disposeAll(this.scene, this.debugObjects)
  }

  _clearDebugGroup(arr) {
    const toRemove = new Set(arr)
    disposeAll(this.scene, arr)
    this.debugObjects = this.debugObjects.filter(o => !toRemove.has(o))
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

  // Deterministic jittered color for ONE terrain plot's OWN corner geometry —
  // recomputed from (assignedType, cell.polygon) via the exact same formula/seed
  // buildRegionMesh used when first creating this plot's mesh, rather than cached
  // per-session state. This is what makes every restore-to-normal path (hover/select
  // clear) land back on exactly the color the mesh was created with: recomputed
  // fresh each time, so it's identical after any number of hovers and identical
  // between any two users looking at the same plot (see TODO.md).
  _terrainPlotColor(cell) {
    const parent = this.terrainData?.regions?.find(r => r.id === cell.parentRegionId)
    return this._jitteredColorFor(parent?.assignedType, cell.polygon)
  }

  _jitteredColorFor(assignedType, polygon) {
    const base = TERRAIN_COLORS.get(assignedType) || TERRAIN_COLORS.unassigned
    return this._jitterColor(base, this._polySeed(polygon))
  }

  _restoreTerrainPlotColor(cellId) {
    const cell = this.terrainData?.terrainPlots?.find(c => c.id === cellId)
    const base = cell ? this._terrainPlotColor(cell) : 0x888888
    const mesh = this.terrainPlotMeshes.get(cellId)
    if (mesh?.material) {
      mesh.material.color.setHex(base)
      mesh.material.emissive?.setHex(base)
      mesh.material.emissiveIntensity = 0.2
    }
  }

  // Region-wide counterpart to _restoreTerrainPlotColor: every plot in the region gets
  // ITS OWN deterministic jitter back (not one shared flat color) unless the region is
  // currently selected (solid white) or a debug-mode pre-hover color was captured for
  // it (see setRegionHover) — same three-way precedence clearHover's region branch and
  // deselectRegion both need, so it lives here once instead of twice.
  _restoreRegionColors(regionId) {
    const isSelected = this.selectedRegionId === regionId
    const cellIds = this.regionTerrainPlots.get(regionId) || []
    for (const cellId of cellIds) {
      const mesh = this.terrainPlotMeshes.get(cellId)
      if (!mesh?.material) continue
      let color
      if (isSelected) color = 0xffffff
      else if (this.showDebug && this._debugPreHoverColors.has(cellId)) color = this._debugPreHoverColors.get(cellId)
      else {
        const cell = this.terrainData?.terrainPlots?.find(c => c.id === cellId)
        color = cell ? this._terrainPlotColor(cell) : this._regionBaseColor(regionId)
      }
      mesh.material.color.setHex(color)
      mesh.material.emissive?.setHex(color)
      mesh.material.emissiveIntensity = 0.2
      this._debugPreHoverColors.delete(cellId)
    }
    if (cellIds.length === 0) {
      const rm = this.regionMeshes.get(regionId)
      if (rm?.material) {
        const key = 'region_' + regionId
        let color
        if (isSelected) color = 0xffffff
        else if (this.showDebug && this._debugPreHoverColors.has(key)) color = this._debugPreHoverColors.get(key)
        else {
          const region = this.terrainData?.regions?.find(r => r.id === regionId)
          color = region ? this._jitteredColorFor(region.assignedType, region.polygon) : this._regionBaseColor(regionId)
        }
        rm.material.color.setHex(color)
        rm.material.emissive?.setHex(color)
        rm.material.emissiveIntensity = 0.2
        this._debugPreHoverColors.delete(key)
      }
    }
  }

  clearHover() {
    if (this.hoveredTerrainPlotId !== null) {
      // Don't wipe the selected-cell's white highlight when clearing hover
      if (this.hoveredTerrainPlotId !== this.selectedTerrainPlotId) {
        const cell = this.terrainData?.terrainPlots?.find(c => c.id === this.hoveredTerrainPlotId)
        const baseColor = cell ? this._terrainPlotColor(cell) : 0x888888
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
      this._restoreRegionColors(this.hoveredRegionId)
      this.hoveredRegionId = null
    }
    if (this.hoveredEdgeId !== null) {
      this.terrainPolylines?.resetEdgeColor(this.hoveredEdgeId)
      this.hoveredEdgeId = null
    }
    if (this._hoveredPathEdgeIds?.size) {
      for (const id of this._hoveredPathEdgeIds) this.terrainPolylines?.resetEdgeColor(id)
      this._hoveredPathEdgeIds = null
    }
    this._pathHoverTargetId = null
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
  // this array and keeps stroke-rendering via EdgeLineRenderer, unchanged.
  // Hidden (generated-but-unrendered) regions/terrainPlots (outer-ring rewrite,
  // 2026-07-13; merged into `regions`/`terrainPlots` rather than kept as separate
  // arrays as of the hidden-terrain-merge refactor) — stored on terrainData for a
  // future "discover foreign lands" reveal, but currently inert — hover/click hit
  // tests, renderEdges' "is this edge shown" gate, and renderTerrain all explicitly
  // filter out `.hidden` entries, so the hidden ring stays invisible/non-interactive
  // until that feature exists.
  setTerrainData(regions, edges, terrainPlots, edgePoints, pointsById, riverCliffFaces = []) {
    this.clearMarkers()
    console.log('setTerrainData called with', regions.length, 'regions,', Object.keys(edges || {}).length, 'edges,', (terrainPlots || []).length, 'terrain plots,', (edgePoints || []).length, 'edge points,', riverCliffFaces.length, 'river/cliff faces')
    // District z-height (plan "typed-gliding-leaf") surfaced the same gap here as
    // DistrictRenderer's cityEdgePointsById had: edgePoints is a plain {id,x,y}
    // convenience copy (see e.g. TerrainVoronoiGenerator's edge-point construction) —
    // real z lives on the same shared registry ids, resolved through pointsById. Without
    // this, every terrain edge (River/Cliff strokes, hover/select highlight) rendered
    // flat regardless of the terrain relief underneath it — "very often on new game,
    // Terrain edges are not correctly zheight set".
    this.edgePointsById = new Map((edgePoints || []).map(p => {
      const z = pointsById?.get(p.id)?.z
      return [p.id, z != null ? { ...p, z } : p]
    }))
    this._pointsById = pointsById || this._pointsById
    if (pointsById) {
      for (const cell of (terrainPlots || [])) {
        cell.polygon = resolvePolygon(cell.pointIds, pointsById) ?? cell.polygon
      }
      for (const face of riverCliffFaces) {
        face.polygon = resolvePolygon(face.pointIds, pointsById) ?? face.polygon
      }
      // Coarse region hulls (Stage D, ADR-0020): TerrainVoronoiGenerator now mints
      // region.pointIds straight from the same registry-linked vertices its convexHull
      // reorders — resolve through the registry here too, same as terrainPlots/
      // riverCliffFaces above, instead of trusting the server's materialized convenience
      // copy. Falls back to the copy when pointIds is missing (e.g. an old save from
      // before this field existed). One loop covers kept + hidden regions alike — both
      // now live in the same `regions` array (tagged via `.hidden`).
      for (const region of (regions || [])) {
        region.polygon = resolvePolygon(region.pointIds, pointsById) ?? region.polygon
      }
    }
    this.terrainData = { regions, edges: edges || {}, terrainPlots: terrainPlots || [], riverCliffFaces }
    this.renderTerrain(regions, terrainPlots || [])
    // Re-enabled in Terrain mode itself (plan "typed-gliding-leaf", user-confirmed
    // 2026-07-14 — the bank-path/confluence artifacts that motivated the 2026-07-11
    // revert are fixed): River/Cliff now render as filled DCEL faces during Terrain
    // Setup too, not just District mode. renderEdges (below) filters out any edge that
    // has a matching face by sourceEdgeId, so the stroke overlay and the fill never
    // double-render the same edge.
    this.renderRiverCliffFaces(riverCliffFaces)
    this.drawVoronoiCenters(regions)
    this.drawTerrainPlotCenters(terrainPlots)
    this.drawSurfaceCorners(terrainPlots, riverCliffFaces)
    if (edges && Object.keys(edges).length > 0) {
      this.renderEdges(edges)
    }
  }

  // Filled meshes for River/Cliff DCEL faces — reuses buildRegionMesh unchanged (it's
  // already generic over any {polygon, assignedType} shape; this is exactly what
  // already renders Lake/Sea).
  renderRiverCliffFaces(faces) {
    this.riverCliffFaceMeshes ??= new Map()
    disposeAll(this.scene, this.riverCliffFaceMeshes)
    for (const face of faces || []) {
      const mesh = this.buildRegionMesh(face)
      if (!mesh) continue
      this.scene.add(mesh)
      this.riverCliffFaceMeshes.set(face.id, mesh)
    }
  }

  renderTerrain(regions, terrainPlots) {
    disposeAll(this.scene, this.regionMeshes)
    disposeAll(this.scene, this.terrainPlotMeshes)
    this.regionTerrainPlots.clear()

    // regions/terrainPlots now carry hidden (generated-but-unrendered) entries merged
    // in, tagged via `.hidden` — filter them out here rather than relying on their
    // absence from the array, since presence-based exclusion no longer holds.
    regions = regions.filter(r => !r.hidden)
    terrainPlots = (terrainPlots || []).filter(p => !p.hidden)

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

    // Outer ring rewrite (user-confirmed 2026-07-13): this used to clip to the literal
    // [0,worldSize] square. That never trimmed anything for the inner ring (its own
    // clip circle — TerrainVoronoiGenerator's organicClipCircle — stays safely inside
    // this square with margin to spare), so it silently did nothing and nobody noticed.
    // But the outer ring's clip circle (outerRadius+margin) legitimately extends PAST
    // this square on every cardinal side, so this square clip was re-truncating already
    // circle-clipped outer-ring polygons back down to the square — visually flattening
    // the outer ring into a chamfered-square/"circled square" shape and defeating the
    // whole point of the organic outer clip circle. Confirmed live 2026-07-13 (user
    // screenshot showed straight edges + cut corners, the square-∩-circle signature).
    // Widened generously so it only ever catches genuinely-unbounded/sentinel-influenced
    // artefacts (sentinels sit at worldSize*3 — see generateRawVoronoi), never legitimate
    // outer-ring geometry (max extent ~1.15×worldSize from the origin corner).
    const clipMargin = this.worldSize
    const polygon = clipPolygonToBox(region.polygon, -clipMargin, this.worldSize + clipMargin, -clipMargin, this.worldSize + clipMargin)
    if (polygon.length < 3) return null

    // Mesh relief (TODO.md "Groundplane Z-height implementation", plan "rustling-
    // churning-finch"): Three.js Y is the vertical axis, so a vertex's data-model `z`
    // becomes its mesh Y. `v.z` is already resolved for terrain-plot/river-cliff-face
    // callers (setTerrainData runs every polygon through resolvePolygon); a bare
    // {x,y,id} vertex (the coarse-hull fallback path, or a clip-synthesized boundary
    // point with no id) falls back to a _pointsById lookup, then 0.
    const vertices = []
    for (const v of polygon) {
      const z = v.z ?? this._pointsById?.get(v.id)?.z ?? 0
      vertices.push(v.x || 0, z, v.y || 0)
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
      // Real per-vertex height, kept for top-down flatten/unflatten (see
      // setGroundFlattened) — Top-down mode reinstates the floor-scroll clip plane,
      // which only makes sense against a flat world (user-confirmed 2026-07-13); the
      // real relief comes back the moment you leave top-down.
      geometry.userData.realY = vertices.filter((_, i) => i % 3 === 1)
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
    if (active) {
      this.terrainPolylines?.dispose()
      // Build river/cliff faces right away at the transition — the gated call in
      // setTerrainData (see its doc comment) only fires on the NEXT full sync, which
      // would otherwise leave District mode showing nothing for River/Cliff for one
      // frame/sync gap right after Terrain Setup finishes.
      this.renderRiverCliffFaces(this.terrainData?.riverCliffFaces || [])
    }
  }

  renderEdges(edges) {
    if (this._cityModeActive) return
    // Thin hover/select line only — a real filled DCEL face (renderRiverCliffFaces)
    // now covers any edge whose River/Cliff face could be built (plan "typed-gliding-
    // leaf"); this stroke is only ever needed for an UNASSIGNED edge's hover/click-select
    // affordance during Terrain Setup, or a rare assigned edge whose face couldn't be
    // built (confluence, etc — falls back to stroke, same as before this change).
    if (!this.terrainPolylines) {
      this.terrainPolylines = new EdgeLineRenderer(this.scene, { y: 0.06 })
      // Ordering fix (user-confirmed 2026-07-14, "still not visible from above, selected
      // or not"): setGroundFlattened(true) may already have run BEFORE this instance
      // existed (top-down toggled before any edge was ever rendered this session) — that
      // call silently no-op'd on a null `this.terrainPolylines` and is otherwise never
      // retried, so a freshly-built instance would default to unflattened (_flattened
      // starts false) forever, even while genuinely in top-down mode right now.
      this.terrainPolylines.setFlattened(this._groundFlattened)
    }
    // Sea/Lake <-> Sea/Lake edges are never worth showing: River and Cliff (the only
    // assignable types) don't make sense between two water regions, and the raw region
    // boundary just cuts an ugly, meaningless line across what reads as one continuous
    // body of water.
    const WATER_TYPES = new Set(['Sea', 'Lake'])
    // Kept regions only — regions/terrainPlots now carry hidden entries merged in
    // (tagged via `.hidden`), so "is this edge shown" must filter explicitly instead of
    // relying on hidden regions being absent from the array.
    const regionsById = new Map((this.terrainData?.regions || []).filter(r => !r.hidden).map(r => [r.id, r]))
    const isWaterWaterEdge = (edge) => {
      const a = regionsById.get(edge.regionA), b = regionsById.get(edge.regionB)
      return !!a && !!b && WATER_TYPES.has(a.assignedType) && WATER_TYPES.has(b.assignedType)
    }
    // generateBoundaryEdges now builds the FULL edge graph, including edges touching
    // (or between) still-hidden organic-world regions — "shown" is this downstream
    // check, not a generation-time gate (see TerrainVoronoiGenerator.js's doc comment).
    const isShown = (edge) => regionsById.has(edge.regionA) && regionsById.has(edge.regionB)
    // An edge with a matching filled River/Cliff face (by sourceEdgeId) is fully covered
    // by that face already — stroking it too would double-render the same boundary.
    const facedEdgeIds = new Set((this.terrainData?.riverCliffFaces || []).map(f => f.sourceEdgeId))
    const visibleEdges = Object.fromEntries(Object.entries(edges).filter(([id, edge]) => isShown(edge) && !isWaterWaterEdge(edge) && !facedEdgeIds.has(id)))
    console.log(`Rendering ${Object.keys(visibleEdges).length} edges (${Object.keys(edges).length - Object.keys(visibleEdges).length} hidden-region/Sea-Lake/faced edges excluded)`)
    // Prefer the registry-backed pointsById (real z, TODO.md "Groundplane Z-height
    // implementation") over edgePointsById (a materialized {id,x,y} snapshot with no z,
    // predating this session) — same underlying terrain point ids either way, so this is
    // a strict upgrade, not a behavior change for x/y.
    this.terrainPolylines.render(
      visibleEdges,
      this._pointsById || this.edgePointsById,
      (edge) => edge.assignedType ? TERRAIN_COLORS.get(edge.assignedType) : TERRAIN_COLORS.unassigned
    )
    console.log(`Successfully created ${this.edgeMeshes.size} edge meshes`)
  }

  get edgeMeshes()     { return this.terrainPolylines?.edgeMeshes     ?? new Map() }
  get junctionMeshes() { return this.terrainPolylines?.junctionMeshes ?? new Map() }

  // EdgeLineRenderer has no junction fill meshes (unlike the retired PolylineRenderer's
  // mitred-strip junction disks) — a plain THREE.Line per edge is all there is to hide.
  hideUndefinedEdges() {
    const edges = this.terrainData?.edges || {}
    for (const [edgeId, edge] of Object.entries(edges)) {
      if (!edge.assignedType) {
        const mesh = this.terrainPolylines?._edgeMeshes?.get(edgeId)
        if (mesh) mesh.visible = false
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
    this._restoreRegionColors(regionId)
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

  // Real raycast targets for InputHandler.screenToWorld (TODO.md "Groundplane Z-height
  // implementation", plan "rustling-churning-finch"): the fine terrain-plot meshes are
  // the only ones with real per-vertex height right now (buildRegionMesh) — prefer them;
  // fall back to the coarse region-hull meshes (still flat) for the rare fallback-render
  // path (setTerrainData's `else` branch, no terrainPlots data).
  getPickableMeshes() {
    if (this.terrainPlotMeshes.size) return [...this.terrainPlotMeshes.values()].filter(m => m.visible)
    return [...this.regionMeshes.values()].filter(m => m.visible)
  }

  // Top-down mode reinstates the floor-scroll clip plane (user-confirmed 2026-07-13),
  // which only behaves correctly against a flat world — every ground-fill mesh's Y
  // channel gets swapped between its real per-vertex height (geometry.userData.realY,
  // stashed at build time) and flat 0, in place, no rebuild. Reversible: leaving
  // top-down restores the real relief from the same stashed array.
  setGroundFlattened(flat) {
    this._groundFlattened = flat
    const apply = (mesh) => {
      const geo = mesh?.geometry
      const realY = geo?.userData?.realY
      if (!realY) return
      const pos = geo.attributes.position
      for (let i = 0; i < realY.length; i++) pos.array[i * 3 + 1] = flat ? 0 : realY[i]
      pos.needsUpdate = true
      geo.computeVertexNormals()
    }
    this.terrainPlotMeshes.forEach(apply)
    this.regionMeshes.forEach(apply)
    this.riverCliffFaceMeshes?.forEach(apply)
    this.terrainPolylines?.setFlattened(flat)
    // Audit-finding lines (renderAuditFindings) — same realY stash, but no
    // computeVertexNormals (a THREE.Line has no faces to shade). Exactly 0 when flat,
    // not the +0.15 build-time offset — see EdgeLineRenderer.setFlattened's matching
    // comment: top-down's floor-scroll clip plane sits just above GROUND_Y by default
    // (~0.045 world units), so any nonzero flattened offset risks getting clipped.
    for (const line of this._auditFindingLines) {
      const geo = line.geometry
      const realY = geo?.userData?.realY
      if (!realY) continue
      const pos = geo.attributes.position
      for (let i = 0; i < realY.length; i++) pos.array[i * 3 + 1] = flat ? 0 : realY[i]
      pos.needsUpdate = true
    }
  }

  // Debug-point markers (spheres/boxes, position-based rather than per-vertex
  // geometry) — fixed 2026-07-13: these were never flattened, so top-down mode's now-
  // active floor-scroll clip plane (calibrated for a flat world) silently clipped every
  // marker sitting at its real, un-flattened elevation, making the whole debug layer
  // disappear. Same realY/flatY stash-and-swap pattern as setGroundFlattened, just on
  // mesh.position.y directly instead of a geometry buffer.
  setDebugMarkersFlattened(flat) {
    const apply = (mesh) => {
      const u = mesh?.userData
      if (!u || u.realY == null) return
      mesh.position.y = flat ? (u.flatY ?? 0) : u.realY
    }
    this._terrainCenterMeshes.forEach(apply)
    this._terrainVertexMeshes.forEach(apply)
    this._terrainPlotCenterMeshes.forEach(apply)
    this._surfaceCornerMeshes.forEach(apply)
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

  // Top-down z readout (TODO.md "Groundplane Z-height implementation", plan "rustling-
  // churning-finch"): "project a ray at the mouse pointer, return the z-height of the
  // first polygon intersected" — every ground-plane polygon still renders flat at Y=0
  // (z-height rendering/displacement isn't implemented yet), so a real 3-D raycast
  // against the rendered mesh would just hit Y=0 everywhere. This is the equivalent
  // query against the DATA model instead: find which terrain plot's polygon contains
  // the point (screenToWorld's existing flat-plane ray already gives worldX/worldY —
  // "first polygon intersected" IS "the plot containing this XZ point" while every
  // polygon sits at the same render height), then average that polygon's own corner z
  // values (already resolved with real z via resolvePolygon in setTerrainData).
  getZHeightAtWorldPos(worldX, worldY) {
    const cell = this.getTerrainPlotAtWorldPos(worldX, worldY)
    if (!cell?.polygon?.length) return null
    let sum = 0, n = 0
    for (const p of cell.polygon) { if (isFinite(p.z)) { sum += p.z; n++ } }
    return n ? sum / n : null
  }

  // `_pathAnchorEdgeId` (set via setEdgePathAnchor, App.js's "last selected edge") turns
  // hover from a single-edge highlight into a shortest-path highlight from that anchor to
  // whatever's hovered — the new interaction model (plan-adjacent, user-confirmed
  // 2026-07-14): once an edge is selected, hovering another edge previews the whole
  // chain a click would add, instead of requiring the user to click every edge in it.
  setEdgeHover(edgeId) {
    if (this._pathAnchorEdgeId != null && this._pathAnchorEdgeId !== edgeId) {
      if (this._pathHoverTargetId === edgeId) return   // no-op guard, same as the plain-hover branch below
      const path = this.getShortestEdgePath(this._pathAnchorEdgeId, edgeId)
      // Only one thing may be hovered at a time (user-confirmed 2026-07-14) — clearHover()
      // FIRST, unconditionally, so a region/terrain-plot hover left over from a moment
      // ago (or the previous path highlight) never lingers alongside the new one.
      this.clearHover()
      this._pathHoverTargetId = edgeId
      this._setHoveredEdgePath(path && path.length ? path : [edgeId])
      return
    }
    if (this.hoveredEdgeId === edgeId && this.hoveredRegionId === null && !this._hoveredPathEdgeIds?.size) return
    this.clearHover()
    if (this.terrainData?.edges?.[edgeId]?.assignedType) return
    this.hoveredEdgeId = edgeId
    this.terrainPolylines?.setEdgeColor(edgeId, 0xffffff)
  }

  // Highlights every edge in `edgeIds` (already-assigned edges are skipped — they have
  // no selectable stroke/line left to highlight once a River/Cliff face covers them).
  // Always called right after clearHover() (see setEdgeHover), so there is never a stale
  // previous path to diff against here — every call paints onto a clean slate.
  _setHoveredEdgePath(edgeIds) {
    const next = new Set(edgeIds.filter(id => !this.terrainData?.edges?.[id]?.assignedType))
    for (const id of next) this.terrainPolylines?.setEdgeColor(id, 0xffffff)
    this._hoveredPathEdgeIds = next
  }

  // Called by App.js whenever the "last selected edge" changes (null when no edge is
  // currently selected) — the anchor setEdgeHover measures a shortest path FROM.
  setEdgePathAnchor(edgeId) {
    this._pathAnchorEdgeId = edgeId
  }

  // Every edge sharing an endpoint pointId (first/last of its own pointIds chain) with
  // `edge` — same connectivity notion App.js's _isEdgeConnectedToSelection already uses.
  _edgeEndpoints(edge) {
    const ids = edge?.pointIds || []
    if (!ids.length) return []
    return ids.length === 1 ? [ids[0]] : [ids[0], ids[ids.length - 1]]
  }

  _edgeLength(edge) {
    const pts = (edge?.pointIds || []).map(id => this._pointsById?.get(id) || this.edgePointsById.get(id)).filter(Boolean)
    let len = 0
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    return len
  }

  // Map<edgeId, Set<edgeId>> — two edges are adjacent if they share an endpoint point.
  _buildEdgeAdjacency() {
    const edges = this.terrainData?.edges || {}
    const byEndpoint = new Map()
    for (const [id, edge] of Object.entries(edges)) {
      for (const pid of this._edgeEndpoints(edge)) {
        if (!byEndpoint.has(pid)) byEndpoint.set(pid, [])
        byEndpoint.get(pid).push(id)
      }
    }
    const adj = new Map()
    for (const ids of byEndpoint.values()) {
      for (const a of ids) {
        if (!adj.has(a)) adj.set(a, new Set())
        for (const b of ids) if (b !== a) adj.get(a).add(b)
      }
    }
    return adj
  }

  // Dijkstra shortest path (by cumulative real-world edge length, not hop count) over the
  // edge-adjacency graph. Returns an ordered array of edgeIds from fromId to toId
  // INCLUSIVE, or null if unreachable or either id doesn't exist.
  getShortestEdgePath(fromId, toId) {
    const edges = this.terrainData?.edges || {}
    if (!edges[fromId] || !edges[toId]) return null
    if (fromId === toId) return [fromId]
    const adj = this._buildEdgeAdjacency()
    const dist = new Map([[fromId, 0]])
    const prev = new Map()
    const visited = new Set()
    while (true) {
      let u = null, best = Infinity
      for (const [id, d] of dist) { if (!visited.has(id) && d < best) { best = d; u = id } }
      if (u === null || u === toId) break
      visited.add(u)
      for (const v of adj.get(u) || []) {
        if (visited.has(v)) continue
        const nd = best + this._edgeLength(edges[v])
        if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u) }
      }
    }
    if (!dist.has(toId)) return null
    const path = [toId]
    let cur = toId
    while (cur !== fromId) {
      cur = prev.get(cur)
      if (cur === undefined) return null
      path.push(cur)
    }
    return path.reverse()
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
    this._restoreRegionColors(id)
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
    disposeAll(this.scene, this.threatMeshes)
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
    disposeAll(this.scene, this.tradeMeshes)
    disposeAll(this.scene, this.roadMeshes)
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
    disposeAll(this.scene, this.roadMeshes)
  }

  clearMarkers() {
    disposeAll(this.scene, this.threatMeshes)
    disposeAll(this.scene, this.tradeMeshes)
    disposeAll(this.scene, this.roadMeshes)
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
      if (mesh) { disposeOne(this.scene, mesh); this.terrainPlotMeshes.delete(cellId) }
    }
    this.regionTerrainPlots.delete(cityRegion.id)
    const regionMesh = this.regionMeshes.get(cityRegion.id)
    if (regionMesh) { disposeOne(this.scene, regionMesh); this.regionMeshes.delete(cityRegion.id) }
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
        if (mesh) { disposeOne(this.scene, mesh); this.terrainPlotMeshes.delete(cellId) }
      }
      this.regionTerrainPlots.delete(regionId)
    }
    // GroundRenderer takes over river/cliff face rendering too, from this point on (see
    // TerrainPlotConverter's riverCliffFaces param) — retire these meshes the same way
    // terrain-plot fills above are retired, or the two would double-render.
    if (this.riverCliffFaceMeshes) disposeAll(this.scene, this.riverCliffFaceMeshes)
  }

  // ── Hit testing ─────────────────────────────────────────────────────────────

  getRegionAtWorldPos(worldX, worldY) {
    if (!this.terrainData) return null
    // Kept only — regions/terrainPlots now carry hidden entries merged in (tagged via
    // `.hidden`); a hidden plot/region must stay non-interactive, same as before the
    // merge when it simply wasn't present in these arrays at all.
    const terrainPlots = (this.terrainData.terrainPlots || []).filter(p => !p.hidden)
    const keptRegions = this.terrainData.regions.filter(r => !r.hidden)
    if (terrainPlots.length > 0) {
      const regionMap = new Map(keptRegions.map(r => [r.id, r]))
      for (const cell of terrainPlots) {
        if (cell.polygon && pointInPolygon(worldX, worldY, cell.polygon)) {
          return regionMap.get(cell.parentRegionId) || null
        }
      }
      return null
    }
    for (const region of keptRegions) {
      if (pointInPolygon(worldX, worldY, region.polygon)) return region
    }
    return null
  }

  getEdgeAtWorldPos(worldX, worldY) {
    if (!this.terrainData || !this.terrainData.edges) return null
    // 1.5x the old 0.25 base (user-confirmed 2026-07-14: edges were too easy to miss on
    // hover — a slightly-off cursor position fell through to the terrain-plot/region hit
    // test instead, leaving the wrong thing highlighted right up until a click, whose
    // position happened to land back inside the old, narrower threshold).
    const threshold = 0.375 * 1.5
    let closestEdge = null
    let closestDistance = threshold
    // Same "both sides shown" gate as renderEdges — this hit-test scans
    // terrainData.edges directly (proximity-based, not mesh raycasting), so it isn't
    // automatically covered by renderEdges' filtering. Filter out `.hidden` regions
    // explicitly — they're merged into terrainData.regions now, not absent from it.
    const regionsById = new Map((this.terrainData?.regions || []).filter(r => !r.hidden).map(r => [r.id, r]))
    for (const edgeId in this.terrainData.edges) {
      const edge = this.terrainData.edges[edgeId]
      if (!regionsById.has(edge.regionA) || !regionsById.has(edge.regionB)) continue
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

  // Hoverable hit-test for the green vertex boxes drawVoronoiCenters renders — one per
  // region-polygon vertex, i.e. every terrain edge point, not just corners shared by
  // 2+ regions (see the relaxed regionIds.length check below; a map-boundary vertex
  // legitimately belongs to only ONE region's polygon and used to be silently
  // unhoverable despite being rendered — confirmed live, 2026-07-13). Respects the
  // "Terrain Edge Points" debug-layer checkbox (_terrainSeedsVisible), same as every
  // other mesh-backed debug hit-test, even though this one is a data scan rather than a
  // mesh iteration (the dedup-by-coordinate + regionIds/vertexIndices grouping this
  // already does is worth keeping over a flat per-mesh lookup).
  getTerrainCornerAtWorldPos(worldX, worldY, threshold = 0.5) {
    if (!this.showDebug || !this._terrainSeedsVisible) return null
    if (!this.terrainData || !this.terrainData.regions) return null
    const cornerMap = new Map()
    for (let i = 0; i < this.terrainData.regions.length; i++) {
      const region = this.terrainData.regions[i]
      region.polygon.forEach((vertex, vertexIndex) => {
        const key = `${vertex.x.toFixed(4)},${vertex.y.toFixed(4)}`
        if (!cornerMap.has(key)) {
          // region.polygon is the coarse convex-hull copy sent as-is from the server
          // ({x,y,id}, not run through resolvePolygon) — resolve z from the registry
          // copy ourselves rather than leaving it undefined.
          const z = this._pointsById?.get(vertex.id)?.z ?? 0
          cornerMap.set(key, { point: { ...vertex, z }, regionIds: [], vertexIndices: [] })
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

  // depthTest:false + a high renderOrder so these markers always draw on top of the
  // (opaque) terrain/district fills regardless of Y-offset/z-fighting — confirmed live
  // (2026-07-12) that terrain centre points were rendering but visually swallowed by
  // whatever fill happened to be layered above them at Y=0.1; every other debug marker
  // in this codebase (block/plot centres, GroundRenderer.js) already gets away with a
  // plain depth-tested mesh only because it's never actually tested against a same-Y
  // opaque neighbour in practice — belt-and-suspenders here since terrain centres sit
  // over the densest, most contended fill layer (raw Voronoi cells + river/cliff faces).
  _debugMarkerMaterial(color) {
    return new THREE.MeshBasicMaterial({ color, depthTest: false })
  }

  drawVoronoiCenters(regions) {
    this._clearDebugGroup(this._terrainCenterMeshes)
    this._clearDebugGroup(this._terrainVertexMeshes)

    const seedGeo = new THREE.SphereGeometry(0.075, 8, 8)
    const seedMat = this._debugMarkerMaterial(0xff0000)
    regions.forEach(region => {
      const seed = new THREE.Mesh(seedGeo, seedMat)
      seed.position.set(region.seedPoint.x, (region.seedPoint.z ?? 0) + 0.1, region.seedPoint.y)
      seed.renderOrder = 999
      seed.userData = { kind: 'terrainCenter', id: region.id, regionId: region.id, assignedType: region.assignedType, x: region.seedPoint.x, y: region.seedPoint.y, z: region.seedPoint.z ?? 0, realY: (region.seedPoint.z ?? 0) + 0.1, flatY: 0.1 }
      seed.visible = this.showDebug && this._terrainCentersVisible
      this.scene.add(seed)
      this.debugObjects.push(seed)
      this._terrainCenterMeshes.push(seed)
    })

    const vertGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05)
    const vertMat = this._debugMarkerMaterial(0x00ff00)
    regions.forEach(region => {
      region.polygon.forEach(vertex => {
        const vert = new THREE.Mesh(vertGeo, vertMat)
        const vz = this._pointsById?.get(vertex.id)?.z ?? 0
        vert.position.set(vertex.x, vz + 0.1, vertex.y)
        vert.renderOrder = 999
        vert.userData = { realY: vz + 0.1, flatY: 0.1 }
        vert.visible = this.showDebug && this._terrainSeedsVisible
        this.scene.add(vert)
        this.debugObjects.push(vert)
        this._terrainVertexMeshes.push(vert)
      })
    })
  }

  // Fine terrain PLOT (raw Voronoi cell, ~150 per map) centre points — distinct from
  // drawVoronoiCenters' COARSE region seeds (~15 merged regions). Added (2026-07-12) so
  // individual terrain-plot ids/positions can be read off directly in-game (hover — see
  // WorldRenderer.getTerrainPlotCenterAtWorldPos/InputHandler) instead of guessing them
  // from a screenshot, for diagnosing river/cliff chain-id-specific pullback bugs.
  drawTerrainPlotCenters(terrainPlots) {
    this._clearDebugGroup(this._terrainPlotCenterMeshes)
    const geo = new THREE.SphereGeometry(0.045, 6, 6)
    const mat = this._debugMarkerMaterial(0xff9900)
    for (const cell of (terrainPlots || [])) {
      if (!cell.seedPoint) continue
      const m = new THREE.Mesh(geo, mat)
      m.position.set(cell.seedPoint.x, (cell.seedPoint.z ?? 0) + 0.1, cell.seedPoint.y)
      m.renderOrder = 999
      m.userData = { kind: 'terrainPlotCenter', id: cell.id, parentRegionId: cell.parentRegionId, assignedType: cell.assignedType, x: cell.seedPoint.x, y: cell.seedPoint.y, z: cell.seedPoint.z ?? 0, realY: (cell.seedPoint.z ?? 0) + 0.1, flatY: 0.1 }
      m.visible = this.showDebug && this._terrainPlotCentersVisible
      this.scene.add(m)
      this.debugObjects.push(m)
      this._terrainPlotCenterMeshes.push(m)
    }
  }

  getTerrainPlotCenterAtWorldPos(worldX, worldY, threshold = 0.08) {
    const thrSq = threshold * threshold
    for (const m of this._terrainPlotCenterMeshes) {
      if (!m.visible) continue
      const dx = worldX - m.position.x, dy = worldY - m.position.z
      if (dx * dx + dy * dy < thrSq) return m.userData
    }
    return null
  }

  // Mesh-based hit test against the COARSE region centre markers (see drawVoronoiCenters)
  // — distinct from getTerrainSeedAtWorldPos, which does its own data-based scan over
  // this.terrainData.regions for Terrain mode's dedicated hover and returns a different
  // shape ({regionId, position}); this one returns the mesh's userData directly
  // ({kind, id, regionId, assignedType, x, y}), matching getTerrainPlotCenterAtWorldPos
  // so city-mode's debug dot dispatch (InputHandler) can treat both uniformly.
  getTerrainCenterAtWorldPos(worldX, worldY, threshold = 0.12) {
    const thrSq = threshold * threshold
    for (const m of this._terrainCenterMeshes) {
      if (!m.visible) continue
      const dx = worldX - m.position.x, dy = worldY - m.position.z
      if (dx * dx + dy * dy < thrSq) return m.userData
    }
    return null
  }

  // Every distinct Surface CORNER currently in play — terrain-plot polygons (post-
  // pullback) and river/cliff face ribbons — deduped by exact registry point id (not
  // coordinate tolerance, matching this whole debugging pass's "use verbatim ids"
  // direction), one marker per id regardless of how many Surfaces share it. Added
  // (2026-07-13) specifically so a self-intersecting/degenerate chain's actual, exact
  // corner positions and ids can be read off directly in-game (see
  // _buildRiverCliffFacesDirect's self-intersection warnings, which name a chain id but
  // not its individual corner ids/positions). Off by default — see _surfaceCornersVisible.
  drawSurfaceCorners(terrainPlots, riverCliffFaces) {
    this._clearDebugGroup(this._surfaceCornerMeshes)
    const geo = new THREE.OctahedronGeometry(0.04, 0)
    const plotMat = this._debugMarkerMaterial(0xff00ff)
    const faceMat = this._debugMarkerMaterial(0x00ffff)
    const seen = new Set()
    const addCorners = (surfaces, mat, kindLabel) => {
      for (const s of (surfaces || [])) {
        const ids = s.pointIds, poly = s.polygon
        if (!ids?.length || !poly?.length || ids.length !== poly.length) continue
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]
          if (id == null || seen.has(id)) continue
          seen.add(id)
          const v = poly[i]
          if (!v || !isFinite(v.x) || !isFinite(v.y)) continue
          const m = new THREE.Mesh(geo, mat)
          m.position.set(v.x, (v.z ?? 0) + 0.12, v.y)
          m.renderOrder = 999
          m.userData = { kind: 'surfaceCorner', id, sourceKind: kindLabel, x: v.x, y: v.y, z: v.z ?? 0, realY: (v.z ?? 0) + 0.12, flatY: 0.12 }
          m.visible = this.showDebug && this._surfaceCornersVisible
          this.scene.add(m)
          this.debugObjects.push(m)
          this._surfaceCornerMeshes.push(m)
        }
      }
    }
    addCorners(terrainPlots, plotMat, 'terrainPlot')
    addCorners(riverCliffFaces, faceMat, 'riverCliffFace')
  }

  // Dev-only (user-confirmed 2026-07-14, "will be removed in production"): visualizes
  // the last auditGroundplane run's findings — a yellow line across every HOLE (an
  // unpaired directed edge; `origin`/`other` are the two endpoints, real z resolved via
  // pointsById when available) and a red outline around every Surface flagged in an
  // AREA_OVERLAP finding (resolved from the CURRENT terrainPlots/riverCliffFaces by id
  // — the finding itself carries no geometry, only the two surface ids). Always
  // rebuilds from scratch; only ever called with the LATEST findings for the current
  // terrainData, so there's nothing to diff.
  renderAuditFindings(findings) {
    this._clearDebugGroup(this._auditFindingLines)
    // Plain THREE.Line — same defect EdgeLineRenderer was rewritten to avoid earlier
    // this session (2026-07-14, "make these lines thicker"): linewidth is silently
    // ignored on ANGLE/D3D and most desktop GL contexts, so a thin debug line can never
    // actually be made thicker this way. HOLE findings are the one category that's
    // actually actionable (AREA_OVERLAP's closed-loop outline stays a thin THREE.Line —
    // less critical, not asked for) — real ribbon-mesh quads instead, wide and red
    // (user-specified 2026-07-15), same per-segment-quad technique as EdgeLineRenderer.
    const HOLE_THICKNESS = 0.3
    const mkLine = (pts, color) => {
      if (pts.length < 2) return
      const vecs = pts.map(p => new THREE.Vector3(p.x, (p.z ?? 0) + 0.15, p.y))
      const geometry = new THREE.BufferGeometry().setFromPoints(vecs)
      geometry.userData.realY = vecs.map(v => v.y)
      // Ordering fix, same as EdgeLineRenderer's matching one: if already in top-down
      // mode (this._groundFlattened) at the moment findings come in, build flat
      // immediately — exactly 0, not the +0.15 build offset, so it isn't silently
      // clipped by the floor-scroll plane until the next unrelated top-down toggle
      // happens to re-sync it via setGroundFlattened.
      if (this._groundFlattened) {
        const pos = geometry.attributes.position
        for (let i = 0; i < vecs.length; i++) pos.array[i * 3 + 1] = 0
      }
      const material = new THREE.LineBasicMaterial({ color, depthTest: false })
      const line = new THREE.Line(geometry, material)
      line.renderOrder = 999
      line.visible = this.showDebug
      this.scene.add(line)
      this.debugObjects.push(line)
      this._auditFindingLines.push(line)
    }
    const mkHoleRibbon = (pts) => {
      if (pts.length < 2) return
      const halfW = HOLE_THICKNESS / 2
      const verts = [], realY = []
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1]
        const dx = b.x - a.x, dy = b.y - a.y
        const len = Math.hypot(dx, dy)
        if (len === 0) continue
        const px = (-dy / len) * halfW, py = (dx / len) * halfW
        const ay = (a.z ?? 0) + 0.15, by = (b.z ?? 0) + 0.15
        verts.push(a.x - px, ay, a.y - py, a.x + px, ay, a.y + py, b.x + px, by, b.y + py, b.x - px, by, b.y - py)
        realY.push(ay, ay, by, by)
      }
      if (!verts.length) return
      const idx = []
      for (let base = 0; base < verts.length / 3; base += 4) idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      const geometry = new THREE.BufferGeometry()
      const posArray = new Float32Array(verts)
      geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3))
      geometry.setIndex(idx)
      geometry.userData.realY = realY
      if (this._groundFlattened) for (let i = 0; i < realY.length; i++) posArray[i * 3 + 1] = 0
      const material = new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide, depthTest: false })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.renderOrder = 999
      mesh.visible = this.showDebug
      this.scene.add(mesh)
      this.debugObjects.push(mesh)
      this._auditFindingLines.push(mesh)
    }

    const surfaceById = new Map()
    for (const cell of (this.terrainData?.terrainPlots || [])) surfaceById.set(`tp:${cell.id}`, cell.polygon)
    for (const face of (this.terrainData?.riverCliffFaces || [])) surfaceById.set(`rcf:${face.id}`, face.polygon)

    for (const f of findings || []) {
      if (f.category === 'HOLE') {
        if (!f.origin || !f.other) continue
        const oz = this._pointsById?.get(f.originId)?.z ?? 0
        const ez = this._pointsById?.get(f.otherId)?.z ?? 0
        mkHoleRibbon([{ ...f.origin, z: oz }, { ...f.other, z: ez }])
      } else if (f.category === 'AREA_OVERLAP') {
        for (const id of [f.surfaceId, f.conflictSurfaceId]) {
          const poly = surfaceById.get(id)
          if (!poly?.length) continue
          mkLine([...poly, poly[0]], 0xff2222)
        }
      }
    }
  }

  getSurfaceCornerAtWorldPos(worldX, worldY, threshold = 0.06) {
    const thrSq = threshold * threshold
    for (const m of this._surfaceCornerMeshes) {
      if (!m.visible) continue
      const dx = worldX - m.position.x, dy = worldY - m.position.z
      if (dx * dx + dy * dy < thrSq) return m.userData
    }
    return null
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
