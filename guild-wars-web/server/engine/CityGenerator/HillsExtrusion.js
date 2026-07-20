// Hills solid extrusion — Stage 1 of the "extrude + subdivide" feature (plan
// "shimmering-wondering-flurry", user-confirmed 2026-07-20). Layered ON TOP of
// TERRAIN_TYPE_Z_RULES.Hills' existing smooth per-vertex delta (TerrainZHeight.js) —
// that gives a gentle region-wide slope; this gives every one of the region's terrain
// plots a real extruded shape.
//
// Corrected 2026-07-20 (user-clarified after the first attempt didn't match): this is
// EVERY PLOT extruded INDIVIDUALLY, not the region extruded as one connected group.
// "Extrude creates faces along the outside edges of the faces being extruded — a square
// extruded upwards becomes a cube with an open bottom." Applied per-plot, not per-
// region: each plot's own polygon moves up to become its new top, dragging a new wall
// quad behind it along EVERY one of its own edges — including edges shared with another
// Hills plot right next to it, which is what gives Stage 1 alone its boxy, separately-
// stepped-block look (matching the reference Blender screenshots) rather than one
// smooth continuous raised region. There is no "boundary vs interior" distinction and
// no ring-chaining needed at all, unlike the first (reverted) attempt — every plot's
// own corners always get their own fresh raised twin, full stop. Stage 2 (a Catmull-
// Clark subdivision pass, not yet implemented) is what welds the separate blocks back
// into one continuous, organic hill — see the plan file for the full design.

export const HILLS_EXTRUDE_HEIGHT = 2 / 3

// Extrudes one Hills region: every one of its plots gets its own new raised top
// (duplicate corners, NOT shared with neighbouring plots — a genuine "individual faces"
// extrude, so two adjacent Hills plots each get their OWN top copy of their shared
// corner, not one merged point) and a wall quad along every one of its own edges.
// Mutates each affected plot's `pointIds`/`polygon` in `terrainPlots` (reassigned to the
// new raised-top ids/positions — this IS the plot's new top surface going forward) and
// the registry (mints the new top points; the ORIGINAL corners are left completely
// untouched, still exactly where every neighbouring plot — Hills or not — already
// expects them, so nothing outside this region's own plots ever needs to change).
// Returns the new wall face array ({id, sourceRegionId, assignedType, pointIds,
// polygon}, same shape as _buildRiverCliffFacesDirect's output) — caller appends it to
// worldTerrainData.hillsWallFaces. The bottom is deliberately left open (no cap face) —
// per the user's own definition of extrude above.
export function extrudeHillsRegion(registry, region, terrainPlots) {
  const plots = terrainPlots.filter(p => p.parentRegionId === region.id && !p.hidden)
  console.log(`[hills-diag] region ${region.id}: ${plots.length} plot(s) (of ${terrainPlots.length} total terrain plots)`)
  if (!plots.length) return []

  const faces = []
  let faceCounter = 0

  for (const plot of plots) {
    const ids = plot.pointIds
    if (!ids || ids.length < 3) continue

    // Each corner gets its OWN raised twin, keyed per-PLOT (not just per-point) — an
    // "individual faces" extrude duplicates every corner per face, even one shared with
    // an immediate neighbour, rather than moving one shared point for both. getOrCreateSplit
    // is still the right primitive (memoized per (baseId, side) so re-running this same
    // plot's own loop below never mints a second copy of the same corner), just keyed
    // by this plot's own id as the "side" so a DIFFERENT plot sharing the same original
    // corner mints its own separate copy instead of reusing this one.
    const topIds = new Array(ids.length)
    for (let i = 0; i < ids.length; i++) {
      const base = registry.get(ids[i])
      if (!base) { topIds[i] = null; continue }
      const top = registry.getOrCreateSplit(ids[i], `hills-top:${plot.id}`, base.x, base.y, (base.z ?? 0) + HILLS_EXTRUDE_HEIGHT, 'hills-extrude')
      topIds[i] = top.id
    }
    if (topIds.some(id => id == null)) continue

    // Wall quad for every edge of this plot's OWN polygon — bottom-a/bottom-b are the
    // ORIGINAL (untouched) points, top-a/top-b are this plot's own new raised twins.
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length]
      const aTop = topIds[i], bTop = topIds[(i + 1) % ids.length]
      const pointIds = [a, b, bTop, aTop]
      const polygon = registry.resolve(pointIds).map(p => ({ x: p.x, y: p.y, z: p.z }))
      if (polygon.length < 4) continue
      faces.push({ id: `hf:${region.id}:${faceCounter++}`, sourceRegionId: region.id, assignedType: 'Hills', pointIds, polygon })
    }

    // The plot's own top surface: reassign to the new raised points — this is the
    // plot's new rendered top going forward, same array/shape it always had.
    plot.pointIds = topIds
    plot.polygon = registry.resolve(topIds).map(p => ({ x: p.x, y: p.y, z: p.z }))
  }

  console.log(`[hills-diag] region ${region.id}: extrusion complete, ${plots.length} plot(s) individually extruded, ${faces.length} wall face(s) built`)
  return faces
}
