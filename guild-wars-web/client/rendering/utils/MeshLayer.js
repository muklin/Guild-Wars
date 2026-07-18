import { disposeMesh } from './renderUtils.js'

// Single owner of the "dispose GPU resources, then unlink from the scene" pairing that
// was previously hand-rolled at 30+ call sites across TerrainRenderer/GroundRenderer/
// DistrictRenderer (see disposeMesh's own doc comment for why the pairing matters —
// skipping either half either leaks GPU memory or leaves a stale mesh visible).
// Operates on each renderer's own existing Array/Map mesh-tracking collections rather
// than replacing them: those collections are read elsewhere (hover lookups, pickable-
// mesh gathering, size checks) far more often than they're disposed, so swapping their
// type would mean reproducing Array/Map's own API on a new class across every call site,
// not just the disposal ones. Disposal was the one operation actually duplicated —
// that's what this module owns.

// Dispose + scene.remove a single mesh (or Group). No-op on null/undefined, matching
// disposeMesh's own no-op-on-falsy contract.
export function disposeOne(scene, mesh) {
  if (!mesh) return
  disposeMesh(mesh)
  scene.remove(mesh)
}

// Dispose + remove every mesh in an Array or Map, then empty it in place so callers keep
// their existing `this.xMeshes` reference (no reassignment needed at call sites).
export function disposeAll(scene, collection) {
  for (const mesh of collection.values ? collection.values() : collection) {
    disposeOne(scene, mesh)
  }
  if (collection.clear) collection.clear()
  else collection.length = 0
}
