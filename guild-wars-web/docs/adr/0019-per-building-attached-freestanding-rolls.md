## ADR-0019 — Per-building Attached/Freestanding/Custom Model rolls, fully client-side

Building variety used to be decided per **block**: `markTownhouseBlocks` (server-side,
`SetupPhase.js`) rolled each block against `DISTRICTS[key].townhouseProb` (hardcoded to `1.0`
everywhere, i.e. dead in practice), stamped `block.blockType = 'townhouse'` onto every plot in
it, then rolled a flat, non-configurable 5% per plot for `plot.freestanding` (a GLB gap-filler,
now called Custom Model). `BuildingRenderer.js` branched on `plot.blockType === 'townhouse'`
to choose between the multi-edge wing pipeline (`_spawnTownhouse`) and a single-box parametric
fallback (`_spawnParametric`'s non-townhouse branch) that, with `townhouseProb` pinned at 1.0,
was effectively unreachable.

This is replaced with two independent per-building rolls, both client-side and seeded from the
plot (no server round-trip, no `blockType`, no `townhouseProb`):

1. **Custom Model vs Parametric** — district-configurable `customModelChance`.
2. **Attached vs Freestanding** (Parametric buildings only) — district-configurable
   `freestandingChance`. Attached buildings sit flush on every street edge and are eligible for
   party-wall suppression against equally-tall Attached neighbours; Freestanding buildings sit
   back from every edge by a seeded gap (`style.frontSetback` to 15% of that edge's frontage)
   and never suppress a face. Both run through the *same* wing-list footprint pipeline
   (formerly `_spawnTownhouse`, townhouse-specific in name only) — a Freestanding plot with two
   street edges gets independently-split wings on both, exactly like an Attached one, just
   pulled back and never suppressed. The old single-box fallback is retired entirely.

`freestandingChance` defaults are seeded from each district's existing `streetType` (Stone →
100%, Brick → 30%, Mud/other → 5%) as a starting point, hand-written per district rather than
derived, since these are expected to be re-tuned per district during testing.

This was already possible without a server trip — `_suppressPartyWalls` and model selection
were already client-side seeded rolls (see amendment to ADR-0008) — so moving the last two
block/plot-level decisions client-side removes a whole server pass (`markTownhouseBlocks`) and
two plot fields (`blockType`, the old `freestanding`) for no loss of determinism. The trade-off
is minor: a stat counter (`SetupPhase.js` townhouse count) and the `blockpreview.js` dev shim
lose their source fields and need updating alongside.
