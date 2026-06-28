const MAGIC_CONCEPTS = [
  { id: 'dnd-schools',  label: 'Schools of Magic',       tagline: 'D&D — Arcane, Divine, Nature, Psionic, and more' },
  { id: 'psionics',     label: 'Psionics',               tagline: 'Mind-over-matter — telekinesis, telepathy, and psychic force' },
  { id: 'mtg-lands',    label: 'Land as Power Source',   tagline: 'Magic: the Gathering — mana drawn from the terrain itself' },
  { id: 'allomancy',    label: 'Allomancy',              tagline: 'Mistborn — swallow metals to gain extraordinary powers' },
  { id: 'warrens',      label: 'Warrens',                tagline: 'Malazan — chaotic paths through a warren of raw power' },
  { id: 'luxins',       label: 'Luxin / Chromaturgy',    tagline: 'Lightbringer — draft light into solid coloured matter' },
  { id: 'one-power',    label: 'The One Power',          tagline: 'Wheel of Time — weave elemental powers of Earth, Fire, Water, Air and Spirit' },
  { id: 'true-names',   label: 'True Names / Words',     tagline: 'Earthsea / Babel — language and names as the fabric of magic' },
  { id: 'technology',   label: 'Technology / Science',   tagline: 'Technological Advances - technological advancements appear as magic to the uninitiated' },
  { id: 'custom',       label: 'Custom',                 tagline: 'Define your own unique magic system from scratch' },

]

export default class MagicSystemDialog {
  constructor({ existingSystem, onApply, onCancel }) {
    this.existingSystem = existingSystem || null
    this.onApply = onApply
    this.onCancel = onCancel
    this._el = null
    this._selectedConcept = null
  }

  open() {
    if (this._el) return
    if (this.existingSystem) {
      this._renderRefineMode()
    } else {
      this._renderPage1()
    }
  }

  close() {
    if (this._el) { this._el.remove(); this._el = null }
  }

  _overlay() {
    const overlay = document.createElement('div')
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.65)',
      'z-index:200', 'display:flex', 'align-items:center', 'justify-content:center',
      'pointer-events:auto',
    ].join(';')
    overlay.addEventListener('click', e => e.stopPropagation())
    overlay.addEventListener('mousedown', e => e.stopPropagation())
    return overlay
  }

  _box() {
    const box = document.createElement('div')
    box.style.cssText = [
      'background:#1a1a1a', 'border:1px solid #555', 'border-radius:8px',
      'padding:20px 24px', 'width:400px', 'font-family:Arial', 'color:#fff',
      'box-shadow:0 8px 32px rgba(0,0,0,0.8)', 'max-height:80vh', 'overflow-y:auto',
    ].join(';')
    return box
  }

  _titleRow(text) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px'
    const title = document.createElement('div')
    title.textContent = text
    title.style.cssText = 'font-size:14px;font-weight:bold;color:#ddd;letter-spacing:0.3px'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.style.cssText = 'background:none;border:none;color:#888;font-size:16px;cursor:pointer;padding:0;line-height:1'
    closeBtn.addEventListener('click', () => { this.close(); this.onCancel() })
    row.appendChild(title); row.appendChild(closeBtn)
    return row
  }

  _renderPage1() {
    const overlay = this._overlay()
    const box = this._box()
    box.appendChild(this._titleRow('Add Magic System'))

    const hint = document.createElement('div')
    hint.textContent = 'Select the magic system archetype for this world. Only one can be defined.'
    hint.style.cssText = 'font-size:12px;color:#888;margin-bottom:12px;line-height:1.4'
    box.appendChild(hint)

    let selectedCard = null
    const cards = []

    MAGIC_CONCEPTS.forEach(concept => {
      const card = document.createElement('button')
      card.style.cssText = [
        'display:block', 'width:100%', 'padding:10px 12px', 'margin-bottom:6px',
        'background:#2a2a2a', 'border:2px solid #444', 'border-radius:6px',
        'color:#ddd', 'text-align:left', 'cursor:pointer', 'font-family:Arial',
      ].join(';')
      card.innerHTML = `<div style="font-size:13px;font-weight:bold;margin-bottom:3px">${concept.label}</div><div style="font-size:11px;color:#777;line-height:1.4">${concept.tagline}</div>`
      card.addEventListener('click', () => {
        this._selectedConcept = concept
        cards.forEach(c => { c.style.background = '#2a2a2a'; c.style.borderColor = '#444' })
        card.style.background = '#1e3a2e'; card.style.borderColor = '#5a9c69'
        selectedCard = card
        nextBtn.disabled = false; nextBtn.style.opacity = '1'
      })
      card._concept = concept
      cards.push(card)
      box.appendChild(card)
    })

    const nextBtn = document.createElement('button')
    nextBtn.textContent = 'Next →'
    nextBtn.disabled = true
    nextBtn.style.cssText = [
      'width:100%', 'padding:9px', 'margin-top:8px',
      'background:#2471a3', 'border:1px solid #4a9bdc', 'border-radius:6px', 'color:#fff',
      'font-size:13px', 'font-weight:bold', 'cursor:pointer', 'opacity:0.4'
    ].join(';')
    nextBtn.addEventListener('click', () => {
      if (!this._selectedConcept) return
      this.close()
      this._renderPage2()
    })
    box.appendChild(nextBtn)

    overlay.appendChild(box)
    document.body.appendChild(overlay)
    this._el = overlay
  }

  _renderPage2() {
    const overlay = this._overlay()
    const box = this._box()
    box.appendChild(this._titleRow('Add Magic System — Details'))

    const conceptDisplay = document.createElement('div')
    conceptDisplay.style.cssText = 'font-size:12px;color:#5a9c69;margin-bottom:10px'
    conceptDisplay.textContent = `System: ${this._selectedConcept.label}`
    box.appendChild(conceptDisplay)

    const nameLabel = document.createElement('div')
    nameLabel.textContent = 'Name'
    nameLabel.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px'
    box.appendChild(nameLabel)
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.value = this._selectedConcept.id !== 'custom' ? this._selectedConcept.label : ''
    nameInput.placeholder = 'Name this magic system…'
    nameInput.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;background:#111;border:1px solid #555;border-radius:4px;color:#fff;font-size:13px;font-family:Arial;margin-bottom:8px;outline:none'
    nameInput.addEventListener('click', e => e.stopPropagation())
    nameInput.addEventListener('mousedown', e => e.stopPropagation())
    box.appendChild(nameInput)

    const errorEl = document.createElement('div')
    errorEl.style.cssText = 'color:#f66;font-size:11px;margin-bottom:8px;min-height:14px'
    box.appendChild(errorEl)

    const descLabel = document.createElement('div')
    descLabel.textContent = 'Description (optional)'
    descLabel.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px'
    box.appendChild(descLabel)
    const descInput = document.createElement('textarea')
    descInput.placeholder = 'Describe how magic works in this world…'
    descInput.rows = 4
    descInput.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;background:#111;border:1px solid #555;border-radius:4px;color:#ccc;font-size:12px;font-family:Arial;resize:vertical;margin-bottom:14px;outline:none'
    descInput.addEventListener('click', e => e.stopPropagation())
    descInput.addEventListener('mousedown', e => e.stopPropagation())
    box.appendChild(descInput)

    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display:flex;gap:8px'
    const backBtn = document.createElement('button')
    backBtn.textContent = '← Back'
    backBtn.style.cssText = 'flex:1;padding:8px;background:transparent;border:1px solid #555;border-radius:5px;color:#aaa;font-size:13px;cursor:pointer;font-family:Arial'
    backBtn.addEventListener('click', () => { this.close(); this._renderPage1() })
    const applyBtn = document.createElement('button')
    applyBtn.textContent = 'Apply'
    applyBtn.style.cssText = 'flex:2;padding:8px;background:#4a7c59;border:1px solid #5a9c69;border-radius:5px;color:#fff;font-size:13px;font-weight:bold;cursor:pointer;font-family:Arial'
    applyBtn.addEventListener('click', () => {
      const name = nameInput.value.trim()
      if (!name || name.length < 2) { errorEl.textContent = 'Please enter a name.'; return }
      errorEl.textContent = ''
      this.close()
      this.onApply({ conceptType: this._selectedConcept.id, name, description: descInput.value.trim() })
    })
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyBtn.click() })
    btnRow.appendChild(backBtn); btnRow.appendChild(applyBtn)
    box.appendChild(btnRow)

    overlay.appendChild(box)
    document.body.appendChild(overlay)
    this._el = overlay
    requestAnimationFrame(() => {
      nameInput.focus()
      nameInput.select()
    })
  }

  _renderRefineMode() {
    const overlay = this._overlay()
    const box = this._box()
    box.appendChild(this._titleRow('Refine Magic System'))

    const current = this.existingSystem
    const info = document.createElement('div')
    info.style.cssText = 'background:#111;border:1px solid #333;border-radius:6px;padding:10px 12px;margin-bottom:14px'
    info.innerHTML = `<div style="font-size:13px;font-weight:bold;color:#5a9c69;margin-bottom:4px">${current.name}</div><div style="font-size:11px;color:#666;margin-bottom:6px">Type: ${current.conceptType || 'custom'}</div><div style="font-size:12px;color:#888;line-height:1.4">${current.description || '(No description yet)'}</div>`
    box.appendChild(info)

    const hint = document.createElement('div')
    hint.textContent = 'Add further details or refine the description.'
    hint.style.cssText = 'font-size:12px;color:#888;margin-bottom:12px;line-height:1.4'
    box.appendChild(hint)

    const descLabel = document.createElement('div')
    descLabel.textContent = 'Additional Description'
    descLabel.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px'
    box.appendChild(descLabel)
    const descInput = document.createElement('textarea')
    descInput.placeholder = 'Add details about how magic works in this world…'
    descInput.rows = 4
    descInput.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;background:#111;border:1px solid #555;border-radius:4px;color:#ccc;font-size:12px;font-family:Arial;resize:vertical;margin-bottom:14px;outline:none'
    descInput.addEventListener('click', e => e.stopPropagation())
    descInput.addEventListener('mousedown', e => e.stopPropagation())
    box.appendChild(descInput)

    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display:flex;gap:8px'
    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = 'Cancel'
    cancelBtn.style.cssText = 'flex:1;padding:8px;background:transparent;border:1px solid #555;border-radius:5px;color:#aaa;font-size:13px;cursor:pointer;font-family:Arial'
    cancelBtn.addEventListener('click', () => { this.close(); this.onCancel() })
    const applyBtn = document.createElement('button')
    applyBtn.textContent = 'Refine'
    applyBtn.style.cssText = 'flex:2;padding:8px;background:#4a7c59;border:1px solid #5a9c69;border-radius:5px;color:#fff;font-size:13px;font-weight:bold;cursor:pointer;font-family:Arial'
    applyBtn.addEventListener('click', () => {
      const addition = descInput.value.trim()
      const newDesc = addition
        ? (current.description ? `${current.description}\n\n${addition}` : addition)
        : current.description || ''
      this.close()
      this.onApply({ conceptType: current.conceptType, name: current.name, description: newDesc })
    })
    btnRow.appendChild(cancelBtn); btnRow.appendChild(applyBtn)
    box.appendChild(btnRow)

    overlay.appendChild(box)
    document.body.appendChild(overlay)
    this._el = overlay
    requestAnimationFrame(() => descInput.focus())
  }
}
