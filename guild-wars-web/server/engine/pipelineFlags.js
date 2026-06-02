// Per-stage gates for the city generation pipeline.
// Streets are always calculated. Each later stage depends on the previous one,
// so enabling CALC_PLOTS without CALC_BLOCKS / CALC_GUTTERS is a no-op.
export const CALC_GUTTERS = true   // Phase 2+
export const CALC_BLOCKS  = false  // Phase 3+
export const CALC_PLOTS   = false  // Phase 4
