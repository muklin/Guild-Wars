// Floating debug window — shown only when Shift+D debug mode is active.
// Controls per-layer visibility and perf logging independently.

const LAYERS = [
  { key: 'buildings',       label: 'Buildings' },
  { key: 'blockCenters',    label: 'Block Centre points' },
  { key: 'blockSeeds',      label: 'Block Seeds' },
  { key: 'plotCenters',     label: 'Plot Centre points' },
  { key: 'terrainCenters',  label: 'Terrain Centre points' },
  { key: 'terrainPlotCenters', label: 'Terrain Plot Centre points' },
  { key: 'terrainSeeds',    label: 'Terrain Edge points' },
  { key: 'surfaceCorners',  label: 'Surface Corner points' },
  { key: 'districtCenters', label: 'District Centre points' },
  { key: 'streetSeeds',     label: 'Street Seeds (junctions)' },
]

export default class DebugPanel {
  constructor(renderer) {
    this.renderer = renderer
    this._el = null
    this._perfEnabled = false
    this._build()
  }

  _build() {
    const el = document.createElement('div')
    el.id = 'debug-panel'
    el.style.cssText = [
      'position:fixed', 'bottom:10px', 'left:10px', 'z-index:50',
      'background:#111c', 'border:1px solid #555', 'border-radius:5px',
      'padding:10px 14px', 'color:#eee', 'font:12px/1.6 monospace',
      'min-width:210px', 'pointer-events:auto', 'display:none',
      'box-shadow:0 4px 16px #0008',
    ].join(';')

    const title = document.createElement('div')
    title.textContent = 'DEBUG'
    title.style.cssText = 'font-weight:bold;letter-spacing:2px;color:#fc8;margin-bottom:8px;font-size:11px'
    el.appendChild(title)

    const states = this.renderer.getDebugLayerStates()

    for (const { key, label } of LAYERS) {
      el.appendChild(this._row(label, states[key] ?? true, (on) => {
        this.renderer.setDebugLayer(key, on)
      }))
    }

    const sep = document.createElement('div')
    sep.style.cssText = 'border-top:1px solid #444;margin:7px 0'
    el.appendChild(sep)

    el.appendChild(this._row('Perf logging', this._perfEnabled, (on) => {
      this._perfEnabled = on
      if (typeof window.__setPerfLog === 'function') window.__setPerfLog(on)
    }))

    const sep2 = document.createElement('div')
    sep2.style.cssText = 'border-top:1px solid #444;margin:7px 0'
    el.appendChild(sep2)

    el.appendChild(this._plotDebugRow())

    el.addEventListener('click',     e => e.stopPropagation())
    el.addEventListener('mousedown', e => e.stopPropagation())
    document.body.appendChild(el)
    this._el = el
  }

  _plotDebugRow() {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;align-items:center;gap:5px;padding:2px 0'

    const label = document.createElement('span')
    label.textContent = 'Plot ID'
    label.style.cssText = 'font-size:11px;color:#ccc;flex-shrink:0'

    const input = document.createElement('input')
    input.type = 'number'
    input.placeholder = 'id'
    input.style.cssText = [
      'width:60px', 'background:#222', 'border:1px solid #555', 'border-radius:3px',
      'color:#eee', 'font:11px monospace', 'padding:2px 4px', 'outline:none',
    ].join(';')

    const btn = document.createElement('button')
    btn.textContent = 'Go'
    btn.style.cssText = [
      'background:#2a5', 'border:none', 'border-radius:3px', 'color:#fff',
      'font:11px monospace', 'padding:2px 8px', 'cursor:pointer',
    ].join(';')

    const status = document.createElement('span')
    status.style.cssText = 'font-size:10px;color:#aaa;margin-left:2px'

    const run = () => {
      const id = parseInt(input.value)
      if (isNaN(id)) { status.textContent = '?'; return }
      const msg = this.renderer.debugPlotWings(id)
      status.textContent = msg ?? ''
    }

    btn.addEventListener('click', run)
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run() })

    wrap.appendChild(label)
    wrap.appendChild(input)
    wrap.appendChild(btn)

    const statusRow = document.createElement('div')
    statusRow.style.cssText = 'font-size:10px;color:#aaa;margin-top:1px;min-height:14px'
    statusRow.appendChild(status)

    const container = document.createElement('div')
    container.appendChild(wrap)
    container.appendChild(statusRow)
    return container
  }

  _row(label, initialOn, onChange) {
    const row = document.createElement('label')
    row.style.cssText = 'display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none;padding:1px 0'

    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = initialOn
    cb.style.cssText = 'width:13px;height:13px;cursor:pointer;accent-color:#4ade80'
    cb.addEventListener('change', () => onChange(cb.checked))

    const text = document.createElement('span')
    text.textContent = label
    text.style.cssText = 'font-size:11px;color:#ccc'

    row.appendChild(cb)
    row.appendChild(text)
    return row
  }

  show() { if (this._el) this._el.style.display = 'block' }
  hide() { if (this._el) this._el.style.display = 'none' }

  toggle(on) {
    if (this._el) this._el.style.display = on ? 'block' : 'none'
  }
}
