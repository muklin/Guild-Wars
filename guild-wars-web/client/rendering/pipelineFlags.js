// Per-stage rendering gates. Independent of server CALC_* flags so an earlier
// stage's visuals can be hidden while it's still being computed for the next
// stage's sake.
export const RENDER_STREETS = true
export const RENDER_GUTTERS = true   // Phase 2
export const RENDER_BLOCKS  = false  // Phase 3
export const RENDER_PLOTS   = false  // Phase 4
