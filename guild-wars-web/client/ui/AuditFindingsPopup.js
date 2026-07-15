// Dev-only diagnostic (user-confirmed 2026-07-14, "will be removed in production"): a
// small top-center banner that appears whenever the last auditGroundplane run (see
// SetupPhase._auditAndLogGroundplane, runs after every terrain update) found any
// manifold violation — a HOLE or AREA_OVERLAP, the same two categories
// TerrainRenderer.renderAuditFindings draws as yellow/red lines in Debug mode. Hidden
// whenever the last run was clean, so it's never in the way during normal play.
export default class AuditFindingsPopup {
  constructor() {
    this._el = null
    this._build()
  }

  _build() {
    const el = document.createElement('div')
    el.style.cssText = [
      'position:fixed', 'top:10px', 'left:50%', 'transform:translateX(-50%)', 'z-index:60',
      'background:#3a1010ee', 'border:1px solid #a33', 'border-radius:6px',
      'padding:8px 16px', 'color:#ffdede', 'font:12px/1.4 monospace',
      'pointer-events:none', 'display:none', 'text-align:center', 'white-space:nowrap',
      'box-shadow:0 4px 16px #0008',
    ].join(';')
    document.body.appendChild(el)
    this._el = el
  }

  update(counts, findings) {
    const total = findings?.length || 0
    if (!total) { this._el.style.display = 'none'; return }
    const holes = counts?.HOLE || 0
    const overlaps = counts?.AREA_OVERLAP || 0
    this._el.innerHTML =
      `<b>⚠ Groundplane audit: ${total} finding${total > 1 ? 's' : ''}</b>` +
      `<div style="font-size:10px;margin-top:2px;opacity:0.85">Holes: ${holes} (yellow) &middot; Overlaps: ${overlaps} (red) &mdash; see server/logs/groundplane-audit.log</div>`
    this._el.style.display = 'block'
  }

  hide() {
    this._el.style.display = 'none'
  }
}
