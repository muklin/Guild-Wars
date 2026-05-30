# 0001 — Plot Voronoi seeded along street edges, not interior grid

The previous `CityBlockGenerator` seeded plot Voronoi cells from a jittered interior grid. Seeds were placed uniformly across the block interior using `generateGridSeeds()`.

This was replaced with seeding along the **street graph edges** that bound each block. A seed is placed every `lotWidth` units along each bounding edge, with a dead zone of `lotWidth / 2` pulled back from each junction node (degree ≥ 3). Bend nodes (degree 2) have no dead zone.

The grid approach was discarded because it produces Voronoi edges that radiate from block corners, slicing corner land into awkward slivers. Street-edge seeding leaves the corner area unsupported by any nearby seed, so the Voronoi naturally produces larger "corner plots" whose boundaries run parallel to the two adjacent streets — geographically correct and visually clean.

The dead zone only applies to junction nodes (not all corners) because bend nodes are midpoints of a continuous street; pulling back from them would create artificial gaps with no geometric justification.
