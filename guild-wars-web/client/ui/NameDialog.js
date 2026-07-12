import nameLibrary from './nameLibrary.js'

// Keyboard-mash and trivially meaningless strings to reject.
const BLOCKLIST = new Set([
  'qwe', 'wer', 'ert', 'rty', 'tyu', 'yui', 'uio', 'iop',
  'asd', 'sdf', 'dfg', 'fgh', 'ghj', 'hjk', 'jkl',
  'zxc', 'xcv', 'cvb', 'vbn', 'bnm',
  'qwerty', 'asdf', 'zxcv', 'qwer', 'asdfg', 'zxcvb',
  'abc', 'abcd', 'xyz', 'xyza', '123', '1234', '12345',
  'aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg', 'hhh',
  'iii', 'jjj', 'kkk', 'lll', 'mmm', 'nnn', 'ooo', 'ppp',
  'qqq', 'rrr', 'sss', 'ttt', 'uuu', 'vvv', 'www', 'xxx',
  'yyy', 'zzz', 'test', 'name',
])

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function pickUnique(arr, exclude = []) {
  const pool = arr.filter(x => !exclude.includes(x))
  return pool.length ? pick(pool) : pick(arr)
}

function validateName(raw, optional = false) {
  const val = raw.trim()
  if (!val) return optional ? null : 'Please enter a name.'
  if (/^\d+$/.test(val)) return 'Name cannot be all numbers.'
  const lower = val.toLowerCase().replace(/\s+/g, '')
  if (BLOCKLIST.has(lower)) return 'That doesn\'t look like a real name.'
  const words = val.trim().split(/\s+/)
  if (words.length >= 2) return null
  if (val.trim().length < 3) return 'Name must be at least 3 characters, or 2 words.'
  return null
}

// Generate 4 candidate names for the given entity context.
// entityKind: 'terrain' | 'district' | 'edge' | 'terrainDistrict' | 'cityEdge' | 'threat' | 'trade'
// subType: the specific type string (e.g. 'Forest', 'Market', 'River')
// producedResource: optional string
function generateNames(entityKind, subType, producedResource) {
  const g = nameLibrary.global
  const typePool =
    (entityKind === 'terrain' && nameLibrary.terrain[subType]) ||
    (entityKind === 'district' && nameLibrary.district[subType]) ||
    (entityKind === 'terrainDistrict' && nameLibrary.district[subType]) ||
    (entityKind === 'edge' && nameLibrary.edge[subType]) ||
    null

  const typeNouns = typePool?.nouns || g.terrainSuffixes
  const typeAdjs  = typePool?.adjectives || g.adjectives
  const isDistrict = ['district', 'terrainDistrict', 'threat', 'trade', 'cityEdge'].includes(entityKind)
  const suffixes = isDistrict ? g.districtSuffixes : g.terrainSuffixes

  const used = []

  function name1() {
    // [Adjective] [TypeNoun]
    const adj  = pick(typeAdjs)
    const noun = pick(typeNouns)
    used.push(adj, noun)
    return `${adj} ${noun}`
  }

  function name2() {
    // [TypeNoun] of [DramaticNoun]
    const noun  = pickUnique(typeNouns, used)
    const drama = pick(g.dramaticNouns)
    used.push(noun, drama)
    return `${noun} of ${drama}`
  }

  function name3() {
    // [ProperName] [TypeNoun]
    const proper = pick(g.properNames)
    const noun   = pickUnique(typeNouns, used)
    used.push(proper, noun)
    return `${proper} ${noun}`
  }

  function name4() {
    if (producedResource) {
      // [Resource] [Suffix]
      const suffix = pick(suffixes)
      return `${producedResource} ${suffix}`
    }
    // Terrain/edge/cityEdge entities have no populace, so "Occupation" (Blacksmiths,
    // Farmers, ...) never makes sense for them — fall back to [GlobalAdj] [Suffix]
    // instead, using the same suffix pool as the resource branch above (terrainSuffixes
    // for terrain/edge, districtSuffixes for cityEdge — see `suffixes` above).
    if (entityKind === 'terrain' || entityKind === 'edge' || entityKind === 'cityEdge') {
      const adj    = pickUnique(g.adjectives, used)
      const suffix = pick(suffixes)
      return `${adj} ${suffix}`
    }
    // [GlobalAdj] [Occupation]  (fallback)
    const adj  = pickUnique(g.adjectives, used)
    const occ  = pick(g.occupations)
    return `${adj} ${occ}`
  }

  return [name1(), name2(), name3(), name4()]
}

export function generateGuildNames({ headquartersDistrictType, leaderClass, traits = [], standingsChanged = false }) {
  const g = nameLibrary.global
  const adjs  = [...nameLibrary.guildAdjectives]
  const nouns = [...nameLibrary.guildNouns]

  // Bias pool by context if available
  const districtPool = headquartersDistrictType && nameLibrary.district[headquartersDistrictType]
  const contextAdjs  = districtPool ? [...districtPool.adjectives, ...adjs] : adjs
  const contextNouns = districtPool ? [...districtPool.nouns.map(n => `${n} ${pick(nouns)}`), ...nouns] : nouns

  const used = []
  const names = []

  const patterns = [
    () => { const a = pick(contextAdjs); const n = pick(nouns); used.push(a,n); return `The ${a} ${n}` },
    () => { const a = pickUnique(contextAdjs,used); const n = pickUnique(nouns,used); used.push(a,n); return `${a} ${n}` },
    () => { const p = pick(g.properNames); const n = pickUnique(nouns,used); used.push(p,n); return `${p}'s ${n}` },
    () => { const a = pickUnique(contextAdjs,used); const n = pickUnique(nouns,used); used.push(a,n); return `${a} ${n} ${pick(['Society','Order','Circle','League'])}` },
    () => { const n = pickUnique(nouns,used); const d = pick(g.dramaticNouns); used.push(n,d); return `${n} of ${d}` },
    () => { const a = pickUnique(contextAdjs,used); const n = pickUnique(contextNouns,used); return `The ${a} ${n}` },
  ]

  for (const p of patterns) names.push(p())
  return names
}

// ─── NameDialog ────────────────────────────────────────────────────────────────

export default class NameDialog {
  static closeAll() {
    document.querySelectorAll('.name-dialog-overlay').forEach(el => el.remove())
  }
  constructor({ entityKind, entityLabel, subType, producedResource, onApply, onCancel, prefillName, hideSuggestions, nameOptional }) {
    this.entityKind       = entityKind
    this.entityLabel      = entityLabel || subType || 'Entity'
    this.subType          = subType
    this.producedResource = producedResource
    this.onApply          = onApply
    this.onCancel         = onCancel
    this.prefillName      = prefillName || null
    this.hideSuggestions  = !!hideSuggestions
    this.nameOptional     = !!nameOptional
    this._el              = null
  }

  open() {
    if (this._el) return
    const names = this.hideSuggestions ? [] : generateNames(this.entityKind, this.subType, this.producedResource)
    this._render(names)
  }

  close() {
    if (this._el) { this._el.remove(); this._el = null }
  }

  _render(suggestions) {
    const overlay = document.createElement('div')
    overlay.className = 'name-dialog-overlay'
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.65)',
      'z-index:200', 'display:flex', 'align-items:center', 'justify-content:center',
      'pointer-events:auto',
    ].join(';')
    overlay.addEventListener('click', (e) => e.stopPropagation())
    overlay.addEventListener('mousedown', (e) => e.stopPropagation())

    const box = document.createElement('div')
    box.style.cssText = [
      'background:#1a1a1a', 'border:1px solid #555', 'border-radius:8px',
      'padding:20px 24px', 'width:340px', 'font-family:Arial', 'color:#fff',
      'box-shadow:0 8px 32px rgba(0,0,0,0.8)',
    ].join(';')

    // Title + close button
    const titleRow = document.createElement('div')
    titleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px'
    const title = document.createElement('div')
    title.textContent = `Name this ${this.entityLabel}`
    title.style.cssText = 'font-size:14px;font-weight:bold;color:#ddd;letter-spacing:0.3px'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.style.cssText = 'background:none;border:none;color:#888;font-size:16px;cursor:pointer;padding:0;line-height:1'
    closeBtn.addEventListener('click', () => this._cancel())
    titleRow.appendChild(title)
    titleRow.appendChild(closeBtn)
    box.appendChild(titleRow)

    const nameInput = document.createElement('input')

    // Suggestion chips — omitted when hideSuggestions is set (e.g. FP Threat/Trade flow
    // where the entity is already named and we just want the player to confirm/edit).
    if (!this.hideSuggestions && suggestions.length > 0) {
      const chipsLabelRow = document.createElement('div')
      chipsLabelRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px'
      const chipsLabel = document.createElement('div')
      chipsLabel.textContent = 'Suggestions'
      chipsLabel.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.8px'
      chipsLabelRow.appendChild(chipsLabel)

      const regenBtn = document.createElement('button')
      regenBtn.textContent = '🔄 Regenerate'
      regenBtn.title = 'Generate new suggestions'
      regenBtn.style.cssText = [
        'background:none', 'border:none', 'color:#7ab', 'font-size:11px',
        'cursor:pointer', 'font-family:Arial', 'padding:0',
      ].join(';')
      regenBtn.addEventListener('click', (e) => {
        e.preventDefault()
        const fresh = generateNames(this.entityKind, this.subType, this.producedResource)
        this._renderChips(chipsRow, fresh, nameInput)
      })
      chipsLabelRow.appendChild(regenBtn)
      box.appendChild(chipsLabelRow)

      const chipsRow = document.createElement('div')
      chipsRow.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-bottom:14px'
      this._renderChips(chipsRow, suggestions, nameInput)
      box.appendChild(chipsRow)
    }

    // Name input
    const nameLabel = document.createElement('div')
    nameLabel.textContent = this.nameOptional ? 'Name (optional)' : 'Name'
    nameLabel.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px'
    box.appendChild(nameLabel)

    nameInput.type = 'text'
    if (this.prefillName) nameInput.value = this.prefillName
    nameInput.placeholder = this.nameOptional ? 'Enter a name (optional)…' : 'Enter a name…'
    nameInput.style.cssText = [
      'width:100%', 'box-sizing:border-box', 'padding:7px 10px',
      'background:#111', 'border:1px solid #555', 'border-radius:4px',
      'color:#fff', 'font-size:13px', 'font-family:Arial', 'margin-bottom:10px',
      'outline:none',
    ].join(';')
    nameInput.addEventListener('click', (e) => e.stopPropagation())
    nameInput.addEventListener('mousedown', (e) => e.stopPropagation())
    box.appendChild(nameInput)

    // Error message
    const errorEl = document.createElement('div')
    errorEl.style.cssText = 'color:#f66;font-size:11px;margin-bottom:8px;min-height:14px'
    box.appendChild(errorEl)

    // Description textarea
    const descLabel = document.createElement('div')
    descLabel.textContent = 'Description (optional)'
    descLabel.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px'
    box.appendChild(descLabel)

    const descInput = document.createElement('textarea')
    descInput.placeholder = 'Describe this place…'
    descInput.rows = 3
    descInput.style.cssText = [
      'width:100%', 'box-sizing:border-box', 'padding:7px 10px',
      'background:#111', 'border:1px solid #555', 'border-radius:4px',
      'color:#ccc', 'font-size:12px', 'font-family:Arial', 'resize:vertical',
      'margin-bottom:14px', 'outline:none',
    ].join(';')
    descInput.addEventListener('click', (e) => e.stopPropagation())
    descInput.addEventListener('mousedown', (e) => e.stopPropagation())
    box.appendChild(descInput)

    // Buttons row
    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display:flex;gap:8px'

    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = 'Cancel'
    cancelBtn.style.cssText = [
      'flex:1', 'padding:8px', 'background:transparent',
      'border:1px solid #555', 'border-radius:5px', 'color:#aaa',
      'font-size:13px', 'cursor:pointer', 'font-family:Arial',
    ].join(';')
    cancelBtn.addEventListener('click', () => this._cancel())

    const applyBtn = document.createElement('button')
    applyBtn.textContent = 'Apply'
    applyBtn.style.cssText = [
      'flex:2', 'padding:8px', 'background:#4a7c59',
      'border:1px solid #5a9c69', 'border-radius:5px', 'color:#fff',
      'font-size:13px', 'font-weight:bold', 'cursor:pointer', 'font-family:Arial',
    ].join(';')
    applyBtn.addEventListener('click', () => {
      const err = validateName(nameInput.value, this.nameOptional)
      if (err) { errorEl.textContent = err; return }
      errorEl.textContent = ''
      this.close()
      this.onApply(nameInput.value.trim(), descInput.value.trim())
    })

    // Allow Enter key to submit
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { applyBtn.click(); e.preventDefault() }
      if (e.key === 'Escape') this._cancel()
    })
    descInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._cancel()
    })

    btnRow.appendChild(cancelBtn)
    btnRow.appendChild(applyBtn)
    box.appendChild(btnRow)

    overlay.appendChild(box)
    document.body.appendChild(overlay)
    this._el = overlay

    requestAnimationFrame(() => nameInput.focus())
  }

  _cancel() {
    this.close()
    this.onCancel()
  }

  // (Re)populates chipsRow with one chip button per suggestion — shared by the initial
  // render and the "Regenerate" button so both build chips identically.
  _renderChips(chipsRow, suggestions, nameInput) {
    chipsRow.innerHTML = ''
    suggestions.forEach(s => {
      const chip = document.createElement('button')
      chip.textContent = s
      chip.style.cssText = [
        'text-align:left', 'padding:6px 10px', 'background:#2a2a2a',
        'border:1px solid #444', 'border-radius:4px', 'color:#ccc',
        'font-size:12px', 'cursor:pointer', 'font-family:Arial',
        'transition:background 0.1s,border-color 0.1s',
      ].join(';')
      chip.addEventListener('mouseenter', () => { chip.style.background = '#333'; chip.style.borderColor = '#666' })
      chip.addEventListener('mouseleave', () => { chip.style.background = '#2a2a2a'; chip.style.borderColor = '#444' })
      chip.addEventListener('click', () => { nameInput.value = s; nameInput.focus() })
      chipsRow.appendChild(chip)
    })
  }
}
