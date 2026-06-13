## ADR-0009 — suppressedFaces baked into Building Spec by server

Townhouse-style buildings that share a side wall with a neighbour suppress the shared face
(omitting wall panels, interior posts, and roof trim on that face while retaining corner
posts). Which faces to suppress — and up to which floor — depends on the neighbour's roof
height, so the server does a per-district pre-pass to compute all building heights before
emitting any spec.

The alternative was to have the client look up the neighbouring plot's assembled building at
render time and decide suppression locally. That approach would require assembly ordering,
cross-plot communication, and would break the "assembler is a pure function of spec" guarantee
from ADR-0007. Baking `suppressedFaces` into the spec keeps the assembler stateless and makes
suppression reproducible across clients with no coordination.

The `suppressedFaces` field is `Array<{wingIndex, edgeIndex, upToFloor}>` where `edgeIndex`
is the 0-based index into the outer perimeter polygon's edge array and `upToFloor` is the
inclusive floor index below which the face is hidden. An empty array (the current client-only
default) means all faces are rendered.
