---
name: project-material-overhaul
description: Grilled plan for miniature-style material overhaul — lighting, procedural slate/thatch roofs, brick contrast, stone contrast
metadata:
  type: project
---

Goal: make buildings/streets resemble hand-painted tabletop miniatures (reference images in resources/images/).
Visual target: strong directional light, near-black mortar, per-tile convex AO highlight, individual tile/stone identity.

**Priority order (implement in this sequence):**
1. Scene lighting — WorldRenderer.js:167-175 — ambient 0.6→0.15, directional 0.8→2.0. Also sync blockpreview.js:65, gallery.js:33.
2. Slate roof — new procedural shader (roofMaterial.js). Local-space tile grid, staggered ~1.5:1 tiles. Per-tile: random brightness jitter + smoothstep gradient dark-edge→light-center. Near-black mortar. Color per district via new `roofColor` field in districtConfig.js.
3. Brick material — brickMaterial.js — add `roughEdge` param (noise on brick-edge SDF), high-contrast per-brick highlights, near-black mortar.
4. Stone material — stoneMaterial.js + streetMaterial.js — keep Voronoi shape, increase STONE_DARKEN to ~0.75, add convex highlight per stone. Applies to street stone AND wall stone.
5. Thatch/reed procedural — stacked horizontal strand bands, per-band noise displacement, shadow darkening at band overlap edges.

**Architectural decisions locked:**
- `trisMesh(geometry, region, lib.material)`: when region=null, skip regionUV() and use raw vertex UVs (for procedural roof materials)
- districtConfig.js gets new `roofColor` field per district (slate color target)
- Shadow casting on roofs: deferred (shadowMap.enabled stays false for now)
- No cobblestone type yet — brick street gets rough-edge treatment instead
- Normal maps: deferred to future sprint
- Thatch: proper layered strands (not just rough slate)

**Key files:**
- Lighting: client/rendering/WorldRenderer.js:59,167-175
- Roof assignment: client/rendering/utils/BuildingRenderer.js:988-992
- Roof geometry: client/rendering/buildings/ParametricBuilding.js:921-922,1022,933,777
- Brick: client/rendering/buildings/brickMaterial.js
- Stone: client/rendering/buildings/stoneMaterial.js, client/rendering/buildings/streetMaterial.js
- Atlas/parts: client/rendering/buildings/PartLibrary.js, resources/buildingparts/default/manifest.json
- Districts: shared/districtConfig.js

**Why:** User wants miniature tabletop diorama look. Reference images show painted models with dry-brush highlights, dark washes in crevices. Q10 answer was C (overall contrast is main problem), so lighting is step 1.
**How to apply:** Always do lighting fix before validating material changes. Material shaders should be tuned assuming strong directional light (intensity ~2.0) and very low ambient (0.15).
