import nameLibrary from '../../shared/nameLibrary.js'

const DOMAIN_ICONS = {
  War: '⚔️', Death: '💀', Trade: '⚖️', Harvest: '🌾', Sea: '🌊',
  Sky: '☁️', Sun: '☀️', Moon: '🌙', Fire: '🔥', Ice: '❄️',
  Earth: '🏔️', Shadow: '🌑', Knowledge: '📚', Fate: '🎲', Love: '❤️',
  Justice: '⚖️', Trickery: '🃏', Nature: '🌿', Forge: '🔨', Storm: '⚡',
  Healing: '✨', Underworld: '🕳️', Ancestors: '👁️', Time: '⏳',
  Chaos: '🌀', Order: '🔷', Hunt: '🏹', Plague: '☣️', Wealth: '💰',
  Dreams: '💭', Fertility: '🌱', Madness: '🌀', Protection: '🛡️',
}

const DOMAIN_CLUSTER_MAP = {
  War: 'war', Death: 'death', Trade: 'trade', Harvest: 'nature',
  Sea: 'sea', Sky: 'sky', Sun: 'sky', Moon: 'sky', Fire: 'fire',
  Earth: 'nature', Nature: 'nature', Healing: 'nature', Fertility: 'nature',
  Knowledge: 'knowledge', Shadow: 'death', Underworld: 'death',
}

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)] }

function generateGodNames(domains) {
  const parts = nameLibrary.godNameParts || {}
  const global = nameLibrary.global
  const names = []
  const used = new Set()

  const clusters = domains.map(d => DOMAIN_CLUSTER_MAP[d]).filter(Boolean)
  const primaryCluster = clusters[0] || null
  const clusterData = primaryCluster ? parts[primaryCluster] : null

  const make = () => {
    if (clusterData) {
      const prefix = pickRandom(clusterData.prefixes)
      const suffix = pickRandom(clusterData.suffixes)
      return prefix + suffix
    }
    return pickRandom(global.properNames)
  }

  for (let i = 0; i < 4; i++) {
    let name
    let attempts = 0
    do { name = make(); attempts++ } while (used.has(name) && attempts < 20)
    used.add(name)
    names.push(name)
  }
  return names
}

function pickWorldDomains() {
  const all = [...(nameLibrary.godDomains || [])]
  const picked = []
  while (picked.length < 12 && all.length > 0) {
    const idx = Math.floor(Math.random() * all.length)
    picked.push(all.splice(idx, 1)[0])
  }
  return picked
}

export default class GodDialog {
  constructor({ worldDomains, onApply, onCancel }) {
    this._worldDomains = worldDomains || null
    this._newWorldDomains = null
    this.onApply = onApply
    this.onCancel = onCancel
    this._el = null
    this._selectedDomains = []
  }

  open() {
    if (this._el) return
    if (!this._worldDomains) {
      this._newWorldDomains = pickWorldDomains()
    }
    this._renderPage1()
  }

  close() {
    if (this._el) { this._el.remove(); this._el = null }
  }

  _domains() {
    return this._worldDomains || this._newWorldDomains || []
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
      'padding:20px 24px', 'width:380px', 'font-family:Arial', 'color:#fff',
      'box-shadow:0 8px 32px rgba(0,0,0,0.8)',
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
    box.appendChild(this._titleRow('Add God — Domains'))

    const hint = document.createElement('div')
    hint.textContent = 'Select up to 3 domains for this god. (Optional)'
    hint.style.cssText = 'font-size:12px;color:#888;margin-bottom:12px;line-height:1.4'
    box.appendChild(hint)

    const domains = this._domains()
    const selected = new Set(this._selectedDomains)
    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:14px'

    const tiles = []
    domains.forEach((domain, i) => {
      const tile = document.createElement('button')
      const icon = DOMAIN_ICONS[domain] || '✦'
      tile.innerHTML = `<div style="font-size:18px;margin-bottom:3px">${icon}</div><div style="font-size:10px;line-height:1.2">${domain}</div>`
      const isSelected = selected.has(domain)
      tile.style.cssText = [
        'padding:8px 4px', 'border-radius:6px', 'cursor:pointer',
        'font-family:Arial', 'text-align:center',
        `background:${isSelected ? '#2c4f6b' : '#2a2a2a'}`,
        `border:2px solid ${isSelected ? '#4a9bdc' : '#444'}`,
        'color:#ddd', 'transition:background 0.1s',
      ].join(';')
      tile.addEventListener('click', () => {
        if (selected.has(domain)) {
          selected.delete(domain)
          tile.style.background = '#2a2a2a'; tile.style.borderColor = '#444'
        } else {
          if (selected.size >= 3) {
            const first = [...selected][0]
            selected.delete(first)
            const firstTile = tiles.find(t => t._domain === first)
            if (firstTile) { firstTile.style.background = '#2a2a2a'; firstTile.style.borderColor = '#444' }
          }
          selected.add(domain)
          tile.style.background = '#2c4f6b'; tile.style.borderColor = '#4a9bdc'
        }
        selLabel.textContent = selected.size > 0 ? `Selected: ${[...selected].join(', ')}` : 'No domains selected'
      })
      tile._domain = domain
      tiles.push(tile)
      grid.appendChild(tile)
    })
    box.appendChild(grid)

    const selLabel = document.createElement('div')
    selLabel.style.cssText = 'font-size:11px;color:#888;margin-bottom:12px;min-height:16px'
    selLabel.textContent = 'No domains selected'
    box.appendChild(selLabel)

    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display:flex;gap:8px'
    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = 'Cancel'
    cancelBtn.style.cssText = 'flex:1;padding:8px;background:transparent;border:1px solid #555;border-radius:5px;color:#aaa;font-size:13px;cursor:pointer;font-family:Arial'
    cancelBtn.addEventListener('click', () => { this.close(); this.onCancel() })
    const nextBtn = document.createElement('button')
    nextBtn.textContent = 'Next →'
    nextBtn.style.cssText = 'flex:2;padding:8px;background:#2471a3;border:1px solid #4a9bdc;border-radius:5px;color:#fff;font-size:13px;font-weight:bold;cursor:pointer;font-family:Arial'
    nextBtn.addEventListener('click', () => {
      this._selectedDomains = [...selected]
      this.close()
      this._renderPage2()
    })
    btnRow.appendChild(cancelBtn); btnRow.appendChild(nextBtn)
    box.appendChild(btnRow)

    overlay.appendChild(box)
    document.body.appendChild(overlay)
    this._el = overlay
  }

  _renderPage2() {
    const overlay = this._overlay()
    const box = this._box()
    box.appendChild(this._titleRow('Add God — Name'))

    const domainDisplay = document.createElement('div')
    domainDisplay.style.cssText = 'font-size:12px;color:#4a9bdc;margin-bottom:10px'
    domainDisplay.textContent = this._selectedDomains.length > 0
      ? `Domains: ${this._selectedDomains.join(', ')}`
      : 'No domains selected'
    box.appendChild(domainDisplay)

    const suggestions = generateGodNames(this._selectedDomains)

    const chipsLabel = document.createElement('div')
    chipsLabel.textContent = 'Name Suggestions'
    chipsLabel.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px'
    box.appendChild(chipsLabel)

    const nameInput = document.createElement('input')
    const chipsRow = document.createElement('div')
    chipsRow.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-bottom:12px'
    suggestions.forEach(s => {
      const chip = document.createElement('button')
      chip.textContent = s
      chip.style.cssText = 'text-align:left;padding:6px 10px;background:#2a2a2a;border:1px solid #444;border-radius:4px;color:#ccc;font-size:12px;cursor:pointer;font-family:Arial'
      chip.addEventListener('click', () => { nameInput.value = s; nameInput.focus() })
      chipsRow.appendChild(chip)
    })
    box.appendChild(chipsRow)

    const nameLabel = document.createElement('div')
    nameLabel.textContent = 'Name'
    nameLabel.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px'
    box.appendChild(nameLabel)
    nameInput.type = 'text'
    nameInput.placeholder = 'Enter a name…'
    nameInput.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;background:#111;border:1px solid #555;border-radius:4px;color:#fff;font-size:13px;font-family:Arial;margin-bottom:6px;outline:none'
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
    descInput.placeholder = 'Describe this god…'
    descInput.rows = 3
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
      this.onApply({
        domains: this._selectedDomains,
        name,
        description: descInput.value.trim(),
        worldDomains: this._newWorldDomains,
      })
    })
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyBtn.click() })
    btnRow.appendChild(backBtn); btnRow.appendChild(applyBtn)
    box.appendChild(btnRow)

    overlay.appendChild(box)
    document.body.appendChild(overlay)
    this._el = overlay
    requestAnimationFrame(() => nameInput.focus())
  }
}
