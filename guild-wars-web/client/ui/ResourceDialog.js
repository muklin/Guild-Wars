import { buildCommodityGraph, renderCommodityGraphSVG } from './ValueStreamGraph.js'

const PREDEFINED_CONSUME = ['Labour', 'Gold', 'Security']
// Water + Basic Food are a per-round upkeep cost, not a Recipe ingredient/special input —
// see CONTEXT_ResourcesServices.md's Recipe entry. Never offered as a Commodity choice here.
const ALWAYS_IMPLICIT = ['water', 'basic food']

// Mirrors SetupPhase.js's _dependsOn: does `startNames` transitively reach `needleKey`
// through the ingredient/specialInput graph? Used to keep circular recipes off the menu
// client-side, before the server ever sees the request.
function dependsOn(defs, startNames, needleKey, visited = new Set()) {
  for (const raw of (startNames || [])) {
    if (!raw) continue
    const key = raw.trim().toLowerCase()
    if (key === needleKey) return true
    if (visited.has(key)) continue
    visited.add(key)
    const def = defs?.[key]
    if (!def) continue
    const deps = [...(def.ingredients || []), ...(def.specialInput ? [def.specialInput] : [])]
    if (dependsOn(defs, deps, needleKey, visited)) return true
  }
  return false
}

export default class ResourceDialog {
  constructor({ mode, resourceRegistry = [], resourceDefinitions = {}, usedProduced = [], alreadySelected = [], isMarket = false, disallowServiceType = false, titleOverride = null, onAdd }) {
    this._mode = mode           // 'consumed' | 'produced'
    this._registry = resourceRegistry
    this._defs = resourceDefinitions
    this._usedProduced = usedProduced
    this._alreadySelected = alreadySelected.map(s => s.toLowerCase())
    this._isMarket = isMarket
    this._disallowServiceType = disallowServiceType
    this._titleOverride = titleOverride
    this._onAdd = onAdd
    this._overlay = null
  }

  open() {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:300;display:flex;align-items:center;justify-content:center'
    overlay.addEventListener('click', e => { if (e.target === overlay) this.close() })

    const box = document.createElement('div')
    box.style.cssText = 'background:#111;border:2px solid #444;border-radius:6px;padding:16px;width:340px;max-height:85vh;overflow-y:auto;color:#fff;font-family:Arial;box-sizing:border-box'
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
      if (this._disallowServiceType && this._isServiceName(lower)) continue
      if (this._alreadySelected.includes(lower)) continue
      if (this._mode === 'produced') {
        if (lower === 'gold' && !this._isMarket) continue
        if (this._usedProduced.includes(lower)) continue
      }
      out.push(r)
    }
    return out
  }

  _isServiceName(lowerName) {
    if (lowerName === 'labour' || lowerName === 'security' || lowerName === 'entertainment' ) return true
    return this._defs?.[lowerName]?.type === 'Service'
  }

  // Candidate ingredients for a new Resource/Service's recipe: any existing Commodity
  // (Raw, Resource, or Service) except Water/Basic Food (never a Recipe ingredient) and
  // whatever's already picked.
  _ingredientCandidates(alreadyPicked) {
    const seen = new Set(alreadyPicked.map(n => n.toLowerCase()))
    const out = []
    for (const name of this._registry) {
      const lower = name.toLowerCase()
      if (ALWAYS_IMPLICIT.includes(lower) || seen.has(lower)) continue
      seen.add(lower)
      out.push(name)
    }
    return out
  }

  // Existing resources this new one could be wired into as a 2nd ingredient: Resource/Service
  // defs with exactly 1 ingredient so far, excluding anything the new resource (via its own
  // chosen ingredients) already transitively depends on — that would create a cycle.
  _wiringCandidates(selectedIngredients) {
    return Object.values(this._defs || {})
      .filter(def => def.type !== 'Raw' && (def.ingredients || []).length === 1)
      .filter(def => !dependsOn(this._defs, selectedIngredients, def.name.trim().toLowerCase()))
      .map(def => def.name)
  }

  _worshipOptions(excludeNameLower) {
    return this._registry.filter(n => n.toLowerCase().startsWith('worship of ') && n.toLowerCase() !== excludeNameLower)
  }

  _buildNewForm() {
    const wrap = document.createElement('div')
    wrap.appendChild(this._label('Define New Resource'))

    const nameInp = document.createElement('input')
    nameInp.type = 'text'
    nameInp.placeholder = 'Resource name...'
    nameInp.style.cssText = 'width:100%;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box;margin-bottom:6px'
    wrap.appendChild(nameInp)
    // Reassigned per-render below (Raw vs Resource/Service); one persistent listener here
    // avoids stacking a new handler every time the recipe section is rebuilt.
    this._onNameInput = () => {}
    nameInp.addEventListener('input', () => this._onNameInput())

    // Initial value is mandatory for every player-defined resource, regardless of context.
    const gpRow = document.createElement('div')
    gpRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px'
    const gpLabel = document.createElement('span')
    gpLabel.textContent = 'Initial value:'
    gpLabel.style.cssText = 'font-size:11px;color:#aaa;white-space:nowrap'
    const gpInp = document.createElement('input')
    gpInp.type = 'number'
    gpInp.min = '1'
    gpInp.style.cssText = 'flex:1;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box'
    const gpSuffix = document.createElement('span')
    gpSuffix.textContent = 'Gp'
    gpSuffix.style.cssText = 'font-size:11px;color:#aaa'
    gpRow.appendChild(gpLabel); gpRow.appendChild(gpInp); gpRow.appendChild(gpSuffix)
    wrap.appendChild(gpRow)

    // --- Type: Raw / Resource / Service (every Commodity declares exactly one) ---
    wrap.appendChild(this._label('Type'))
    const typeOptions = this._disallowServiceType ? ['Raw', 'Resource'] : ['Raw', 'Resource', 'Service']
    let type = 'Resource'
    const typeRow = this._chipRow(typeOptions, type, v => { type = v; renderRecipeSection() })
    wrap.appendChild(typeRow.el)

    const recipeSection = document.createElement('div')
    wrap.appendChild(recipeSection)

    // Recipe-authoring state
    let rawSubtype = 'Resource'
    const selectedIngredients = []
    let specialInput = null       // 'Labour' | 'Gold' | 'Worship of <god>'
    let tradeCategory = 'Tradeable'
    let wireTarget = null

    // Live "value stream" preview (TODO.md: show the connected graph during Resource
    // Creation) — overlays the in-progress draft (and, if set, its wiring target) onto the
    // real resourceDefinitions so the preview matches what GuildPanel will render later.
    const graphWrap = document.createElement('div')
    graphWrap.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid #333'
    const renderGraphPreview = () => {
      graphWrap.innerHTML = ''
      const draftName = nameInp.value.trim() || 'New Resource'
      const draftKey = draftName.toLowerCase()
      const virtualDefs = { ...this._defs }
      virtualDefs[draftKey] = {
        name: draftName,
        type,
        ingredients: type === 'Raw' ? [] : [...selectedIngredients],
        specialInput: type === 'Raw' ? null : specialInput
      }
      const roots = [draftName]
      if (wireTarget) {
        const targetKey = wireTarget.trim().toLowerCase()
        const targetDef = this._defs[targetKey]
        if (targetDef) {
          virtualDefs[targetKey] = { ...targetDef, ingredients: [...(targetDef.ingredients || []), draftName] }
          roots.push(wireTarget)
        }
      }
      graphWrap.appendChild(this._label('Value Stream Preview'))
      const { nodes, edges } = buildCommodityGraph(virtualDefs, roots)
      graphWrap.appendChild(renderCommodityGraphSVG(nodes, edges))
    }

    const renderRecipeSection = () => {
      recipeSection.innerHTML = ''
      selectedIngredients.length = 0
      specialInput = null
      wireTarget = null

      if (type === 'Raw') {
        this._onNameInput = () => {}
        const rawRow = this._chipRow(['Food', 'Resource'], rawSubtype, v => { rawSubtype = v })
        recipeSection.appendChild(this._label('Raw sub-type'))
        recipeSection.appendChild(rawRow.el)
        const note = document.createElement('div')
        note.textContent = 'Fixed recipe: Labour + Security. Harvested at a Terrain plot only.'
        note.style.cssText = 'font-size:11px;color:#888;font-style:italic;margin:4px 0 8px'
        recipeSection.appendChild(note)
        renderGraphPreview()
        return
      }

      // Ingredients (1-2, from any existing Commodity except Water/Basic Food)
      recipeSection.appendChild(this._label('Ingredients (1-2)'))
      const ingredientWrap = document.createElement('div')
      ingredientWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px'
      recipeSection.appendChild(ingredientWrap)
      const wiringWrap = document.createElement('div')
      // Reassigned below when mode === 'produced'; a no-op otherwise since the wiring
      // node only exists in that mode. Declared here (not inside the `if`) so the
      // ingredient chip handlers below — defined in this same outer scope — can see it.
      let renderWiring = () => {}

      const renderIngredientChips = () => {
        ingredientWrap.innerHTML = ''
        const candidates = this._ingredientCandidates(selectedIngredients)
        if (!candidates.length && !selectedIngredients.length) {
          const note = document.createElement('div')
          note.textContent = 'No existing Commodities to use as ingredients yet.'
          note.style.cssText = 'font-size:11px;color:#666;font-style:italic'
          ingredientWrap.appendChild(note)
        }
        for (const name of selectedIngredients) {
          const pill = document.createElement('span')
          pill.textContent = `${name} ✕`
          pill.style.cssText = 'background:#2a4a2a;border:1px solid #4a7c59;color:#cfc;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer'
          pill.addEventListener('click', () => {
            selectedIngredients.splice(selectedIngredients.indexOf(name), 1)
            renderIngredientChips(); renderWiring(); renderGraphPreview()
          })
          ingredientWrap.appendChild(pill)
        }
        if (selectedIngredients.length < 2) {
          for (const name of candidates) {
            const chip = document.createElement('button')
            chip.textContent = name
            chip.style.cssText = 'background:#1a1a1a;border:1px solid #444;color:#888;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer'
            chip.addEventListener('click', () => {
              selectedIngredients.push(name)
              renderIngredientChips(); renderWiring(); renderGraphPreview()
            })
            ingredientWrap.appendChild(chip)
          }
        }
      }
      renderIngredientChips()

      // Special input: Labour / Gold / Worship (Worship excluded when defining Worship itself)
      recipeSection.appendChild(this._label('Special input'))
      const nameLower = () => nameInp.value.trim().toLowerCase()
      const specialOptions = () => {
        const opts = ['Labour', 'Gold']
        if (!nameLower().startsWith('worship of ') && this._worshipOptions(nameLower()).length) opts.push('Worship')
        return opts
      }
      const specialWrap = document.createElement('div')
      recipeSection.appendChild(specialWrap)
      const worshipPickWrap = document.createElement('div')
      worshipPickWrap.style.cssText = 'margin:4px 0 8px'
      recipeSection.appendChild(worshipPickWrap)

      const renderWorshipPicker = (selectedLabel) => {
        worshipPickWrap.innerHTML = ''
        if (selectedLabel !== 'Worship') { specialInput = selectedLabel; renderGraphPreview(); return }
        const opts = this._worshipOptions(nameLower())
        if (opts.length === 1) { specialInput = opts[0]; renderGraphPreview(); return }
        const select = document.createElement('select')
        select.style.cssText = 'width:100%;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:3px;padding:3px;font-size:11px'
        for (const g of opts) {
          const o = document.createElement('option'); o.value = g; o.textContent = g
          select.appendChild(o)
        }
        specialInput = opts[0] || null
        select.addEventListener('change', () => { specialInput = select.value; renderGraphPreview() })
        worshipPickWrap.appendChild(select)
        renderGraphPreview()
      }

      const renderSpecialOptions = () => {
        const opts = specialOptions()
        specialWrap.innerHTML = ''
        const row = this._chipRow(opts, opts[0], v => renderWorshipPicker(v))
        specialWrap.appendChild(row.el)
        renderWorshipPicker(opts[0])
      }
      renderSpecialOptions()
      // A single persistent listener (attached once in _buildNewForm) calls whichever
      // render function is currently live — avoids stacking a new listener every time
      // the Type chip is re-clicked and this section is rebuilt.
      this._onNameInput = renderSpecialOptions

      // Service-only: Entertainment vs Tradeable
      if (type === 'Service') {
        recipeSection.appendChild(this._label('Service category'))
        const catRow = this._chipRow(['Tradeable', 'Entertainment'], tradeCategory, v => { tradeCategory = v })
        recipeSection.appendChild(catRow.el)
      }

      // Right-side "used as an ingredient for" node — produced mode only, per the New
      // Resource dialog's optional second edge into an already-existing recipe.
      if (this._mode === 'produced') {
        recipeSection.appendChild(this._label('Used as an ingredient for (optional)'))
        recipeSection.appendChild(wiringWrap)
        renderWiring = () => {
          wiringWrap.innerHTML = ''
          if (wireTarget) {
            const pill = document.createElement('span')
            pill.textContent = `${wireTarget} ✕`
            pill.style.cssText = 'background:#2a3a4a;border:1px solid #4a6a7c;color:#cde;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer'
            pill.addEventListener('click', () => { wireTarget = null; renderWiring(); renderGraphPreview() })
            wiringWrap.appendChild(pill)
            return
          }
          const btn = document.createElement('button')
          btn.textContent = '+ choose existing resource'
          btn.style.cssText = 'background:#1a1a1a;border:1px solid #444;color:#888;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer'
          btn.addEventListener('click', () => {
            const candidates = this._wiringCandidates(selectedIngredients)
            wiringWrap.innerHTML = ''
            if (!candidates.length) {
              const note = document.createElement('div')
              note.textContent = 'No eligible resources (need room for a 2nd ingredient, no circular dependency).'
              note.style.cssText = 'font-size:11px;color:#666;font-style:italic'
              wiringWrap.appendChild(note)
              return
            }
            for (const name of candidates) {
              const chip = document.createElement('button')
              chip.textContent = name
              chip.style.cssText = 'background:#1a1a1a;border:1px solid #444;color:#888;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer;margin:0 4px 4px 0'
              chip.addEventListener('click', () => { wireTarget = name; renderWiring(); renderGraphPreview() })
              wiringWrap.appendChild(chip)
            }
          })
          wiringWrap.appendChild(btn)
        }
        renderWiring()
      }
    }
    renderRecipeSection()
    wrap.appendChild(graphWrap)

    const err = document.createElement('div')
    err.style.cssText = 'font-size:10px;color:#ff6666;margin:6px 0;display:none'
    wrap.appendChild(err)

    const addBtn = document.createElement('button')
    addBtn.textContent = this._titleOverride || (this._mode === 'consumed' ? 'Add Consumed Resource' : 'Add Produced Resource')
    addBtn.style.cssText = 'width:100%;padding:7px;background:#1a3a1a;color:#8f8;border:1px solid #4a7c59;border-radius:3px;cursor:pointer;font-size:12px;font-weight:bold'
    addBtn.addEventListener('click', () => {
      const name = nameInp.value.trim()
      if (!name) { err.textContent = 'Enter a resource name.'; err.style.display = 'block'; return }
      const gpValue = parseFloat(gpInp.value)
      if (!(gpValue > 0)) { err.textContent = 'Enter a GP value greater than 0.'; err.style.display = 'block'; return }

      const result = { name, isNew: true, gpValue, type }
      if (type === 'Raw') {
        result.rawSubtype = rawSubtype
      } else {
        if (selectedIngredients.length < 1) { err.textContent = 'Select at least 1 ingredient.'; err.style.display = 'block'; return }
        if (!specialInput) { err.textContent = 'Choose a special input (Labour, Gold, or Worship).'; err.style.display = 'block'; return }
        result.ingredients = [...selectedIngredients]
        result.specialInput = specialInput
        if (type === 'Service') result.tradeCategory = tradeCategory
        if (wireTarget) result.wireIntoExisting = wireTarget
      }
      this._onAdd(result)
      this.close()
    })
    wrap.appendChild(addBtn)
    return wrap
  }

  // Small pill-toggle "radio group". Returns { el, select(value) } so callers can drive
  // the initial/derived selection without re-clicking.
  _chipRow(options, initial, onChange) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px'
    const chips = []
    const select = (value) => {
      for (const c of chips) {
        const active = c.dataset.value === value
        c.style.background = active ? '#2a4a2a' : '#1a1a1a'
        c.style.borderColor = active ? '#4a7c59' : '#444'
        c.style.color = active ? '#cfc' : '#888'
      }
    }
    for (const opt of options) {
      const chip = document.createElement('button')
      chip.textContent = opt
      chip.dataset.value = opt
      chip.style.cssText = 'background:#1a1a1a;border:1px solid #444;color:#888;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer'
      chip.addEventListener('click', () => { select(opt); onChange(opt) })
      chips.push(chip)
      row.appendChild(chip)
    }
    if (initial) select(initial)
    return { el: row, select }
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
