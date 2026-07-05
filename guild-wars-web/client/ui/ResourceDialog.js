const PREDEFINED_CONSUME = ['Labour', 'Gold', 'Security']
const ALWAYS_IMPLICIT = ['water', 'basic food']

export default class ResourceDialog {
  constructor({ mode, resourceRegistry = [], usedProduced = [], alreadySelected = [], isMarket = false, showSpec = true, titleOverride = null, consumedResources = [], onAdd }) {
    this._mode = mode           // 'consumed' | 'produced'
    this._registry = resourceRegistry
    this._usedProduced = usedProduced
    this._alreadySelected = alreadySelected.map(s => s.toLowerCase())
    this._isMarket = isMarket
    // Every player-defined new resource must always get an initial GP value — that part
    // is unconditional below regardless of showSpec. showSpec now only gates the
    // (produced-only) ingredients section, which trade routes ('consumed' mode) never
    // show anyway since that's also gated on _mode === 'produced'.
    this._showSpec = showSpec
    this._titleOverride = titleOverride
    this._consumedResources = consumedResources  // names available as ingredient candidates
    this._onAdd = onAdd
    this._overlay = null
  }

  open() {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:300;display:flex;align-items:center;justify-content:center'
    overlay.addEventListener('click', e => { if (e.target === overlay) this.close() })

    const box = document.createElement('div')
    box.style.cssText = 'background:#111;border:2px solid #444;border-radius:6px;padding:16px;width:320px;max-height:80vh;overflow-y:auto;color:#fff;font-family:Arial;box-sizing:border-box'
    box.addEventListener('click', e => e.stopPropagation())

    const titleRow = document.createElement('div')
    titleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px'
    const titleText = document.createElement('div')
    titleText.textContent = this._titleOverride || (this._mode === 'consumed' ? 'Add Consumed Resource' : 'Add Produced Resource')
    titleText.style.cssText = 'font-size:13px;font-weight:bold'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.style.cssText = 'background:none;border:none;color:#aaa;cursor:pointer;font-size:14px;line-height:1'
    closeBtn.addEventListener('click', () => this.close())
    titleRow.appendChild(titleText)
    titleRow.appendChild(closeBtn)
    box.appendChild(titleRow)

    const existing = this._buildExistingList()
    if (existing) {
      box.appendChild(existing)
      const divider = document.createElement('div')
      divider.style.cssText = 'border-top:1px solid #333;margin:10px 0;text-align:center;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px'
      divider.textContent = 'or define new'
      box.appendChild(divider)
    }

    box.appendChild(this._buildNewForm())
    overlay.appendChild(box)
    document.body.appendChild(overlay)
    this._overlay = overlay
  }

  _buildExistingList() {
    const available = this._availableResources()
    if (!available.length) return null

    const wrap = document.createElement('div')
    wrap.appendChild(this._label('Existing Resources'))

    const list = document.createElement('div')
    list.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;max-height:110px;overflow-y:auto;margin-bottom:4px'
    for (const r of available) {
      const chip = document.createElement('button')
      chip.textContent = r
      chip.style.cssText = 'background:#1a2a1a;border:1px solid #4a7c59;color:#cfc;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer;white-space:nowrap'
      chip.addEventListener('mouseenter', () => { chip.style.background = '#2a4a2a' })
      chip.addEventListener('mouseleave', () => { chip.style.background = '#1a2a1a' })
      chip.addEventListener('click', () => { this._onAdd({ name: r }); this.close() })
      list.appendChild(chip)
    }
    wrap.appendChild(list)
    return wrap
  }

  _availableResources() {
    const seen = new Set()
    const all = [...PREDEFINED_CONSUME, ...this._registry]
    const out = []
    for (const r of all) {
      const lower = r.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      if (ALWAYS_IMPLICIT.includes(lower)) continue
      if (this._alreadySelected.includes(lower)) continue
      if (this._mode === 'produced') {
        if (lower === 'gold' && !this._isMarket) continue
        if (this._usedProduced.includes(lower)) continue
      }
      out.push(r)
    }
    return out
  }

  _buildNewForm() {
    const wrap = document.createElement('div')
    wrap.appendChild(this._label('Define New Resource'))

    const nameInp = document.createElement('input')
    nameInp.type = 'text'
    nameInp.placeholder = 'Resource name...'
    nameInp.style.cssText = 'width:100%;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box;margin-bottom:6px'
    wrap.appendChild(nameInp)

    // Initial value is mandatory for every player-defined resource, regardless of
    // context (trade routes included) — not gated by showSpec.
    const gpRow = document.createElement('div')
    gpRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px'
    const gpLabel = document.createElement('span')
    gpLabel.textContent = 'Initial value:'
    gpLabel.style.cssText = 'font-size:11px;color:#aaa;white-space:nowrap'
    const gpInp = document.createElement('input')
    gpInp.type = 'number'
    gpInp.min = '1'
    gpInp.placeholder = ''
    gpInp.style.cssText = 'flex:1;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box'
    const gpSuffix = document.createElement('span')
    gpSuffix.textContent = 'Gp'
    gpSuffix.style.cssText = 'font-size:11px;color:#aaa'
    gpRow.appendChild(gpLabel); gpRow.appendChild(gpInp); gpRow.appendChild(gpSuffix)
    wrap.appendChild(gpRow)

    const selectedIngredients = new Set()
    if (this._showSpec && this._mode === 'produced') {
      wrap.appendChild(this._label('Ingredients (select at least 1)'))
      const candidates = this._consumedResources
      if (candidates.length === 0) {
        const note = document.createElement('div')
        note.textContent = 'Add consumed resources first to define ingredients.'
        note.style.cssText = 'font-size:11px;color:#666;font-style:italic;margin-bottom:8px'
        wrap.appendChild(note)
      } else {
        const chipWrap = document.createElement('div')
        chipWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px'
        for (const name of candidates) {
          const chip = document.createElement('button')
          chip.textContent = name
          chip.style.cssText = 'background:#1a1a1a;border:1px solid #444;color:#888;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer'
          chip.addEventListener('click', () => {
            if (selectedIngredients.has(name)) {
              selectedIngredients.delete(name)
              chip.style.background = '#1a1a1a'
              chip.style.borderColor = '#444'
              chip.style.color = '#888'
            } else {
              selectedIngredients.add(name)
              chip.style.background = '#2a4a2a'
              chip.style.borderColor = '#4a7c59'
              chip.style.color = '#cfc'
            }
          })
          chipWrap.appendChild(chip)
        }
        wrap.appendChild(chipWrap)
      }
    }

    const err = document.createElement('div')
    err.style.cssText = 'font-size:10px;color:#ff6666;margin-bottom:6px;display:none'
    wrap.appendChild(err)

    const addBtn = document.createElement('button')
    addBtn.textContent = this._titleOverride || (this._mode === 'consumed' ? 'Add Consumed Resource' : 'Add Produced Resource')
    addBtn.style.cssText = 'width:100%;padding:7px;background:#1a3a1a;color:#8f8;border:1px solid #4a7c59;border-radius:3px;cursor:pointer;font-size:12px;font-weight:bold'
    addBtn.addEventListener('click', () => {
      const name = nameInp.value.trim()
      if (!name) { err.textContent = 'Enter a resource name.'; err.style.display = 'block'; return }
      const gpValue = parseFloat(gpInp.value)
      if (!(gpValue > 0)) { err.textContent = 'Enter a GP value greater than 0.'; err.style.display = 'block'; return }
      const result = { name, isNew: true, gpValue }
      if (this._showSpec && this._mode === 'produced') {
        if (this._consumedResources.length > 0 && selectedIngredients.size === 0) {
          err.textContent = 'Select at least 1 ingredient.'
          err.style.display = 'block'
          return
        }
        result.ingredients = [...selectedIngredients]
      }
      this._onAdd(result)
      this.close()
    })
    wrap.appendChild(addBtn)
    return wrap
  }

  _label(text) {
    const el = document.createElement('div')
    el.textContent = text
    el.style.cssText = 'font-size:10px;color:#777;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;margin-top:2px'
    return el
  }

  close() {
    if (this._overlay) { this._overlay.remove(); this._overlay = null }
  }
}
