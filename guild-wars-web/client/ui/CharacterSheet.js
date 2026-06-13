import { bringToFront } from './GuildPanel.js'

const ABILITY_LABELS = [
  { key: 'str', label: 'STR' },
  { key: 'dex', label: 'DEX' },
  { key: 'con', label: 'CON' },
  { key: 'int', label: 'INT' },
  { key: 'wis', label: 'WIS' },
  { key: 'cha', label: 'CHA' },
]

const RACE_LABELS = {
  human: 'Human', elf: 'Elf', dwarf: 'Dwarf',
  halfOrc: 'Half-Orc', halfling: 'Halfling', gnome: 'Gnome',
}

// Pool of open sheets keyed by character id.
const _openSheets = new Map()

function _modifier(score) {
  const m = Math.floor((score - 10) / 2)
  return m >= 0 ? `+${m}` : `${m}`
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]))
}

function _makeDraggable(el) {
  let dragging = false, ox = 0, oy = 0
  el.addEventListener('mousedown', e => {
    const tb = el.querySelector('.cs-title-bar')
    if (!tb || !tb.contains(e.target)) return
    dragging = true
    const r = el.getBoundingClientRect()
    ox = e.clientX - r.left
    oy = e.clientY - r.top
    e.preventDefault()
  })
  document.addEventListener('mousemove', e => {
    if (!dragging) return
    el.style.left = (e.clientX - ox) + 'px'
    el.style.top  = (e.clientY - oy) + 'px'
  })
  document.addEventListener('mouseup', () => { dragging = false })
}

function _build(ch) {
  const el = document.createElement('div')
  el.style.cssText = [
    'position:fixed',
    'width:420px',
    'background:rgba(18,18,18,0.95)',
    'border:1px solid #555',
    'border-radius:6px',
    'z-index:51',
    'pointer-events:auto',
    'font-family:Arial',
    'color:#fff',
    'overflow:hidden',
    // Offset each new sheet slightly so stacked sheets are visible
    `left:${Math.min(window.innerWidth - 440, 200 + _openSheets.size * 24)}px`,
    `top:${Math.min(window.innerHeight - 420, 150 + _openSheets.size * 24)}px`,
  ].join(';')

  el.addEventListener('mousedown', () => bringToFront(el))
  _makeDraggable(el)

  // Title bar
  const titleBar = document.createElement('div')
  titleBar.className = 'cs-title-bar'
  titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(0,0,0,0.45);border-bottom:1px solid #444;cursor:move'
  const titleEl = document.createElement('span')
  titleEl.textContent = ch.name
  titleEl.style.cssText = 'font-size:13px;font-weight:bold;user-select:none'
  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cssText = 'background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;line-height:1;padding:0 4px'
  closeBtn.addEventListener('click', () => {
    el.remove()
    _openSheets.delete(ch.id)
  })
  titleBar.appendChild(titleEl)
  titleBar.appendChild(closeBtn)
  el.appendChild(titleBar)

  // Body
  const body = document.createElement('div')
  body.style.cssText = 'padding:16px'

  // Header info
  const header = document.createElement('div')
  header.style.cssText = 'margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #333'
  const raceLabel = RACE_LABELS[ch.race] || ch.race || '—'
  const classLabel = ch.class || '—'
  header.innerHTML = `
    <div style="font-size:18px;font-weight:bold;margin-bottom:6px">${_esc(ch.name)}</div>
    <div style="display:flex;gap:16px;font-size:11px;color:#aaa">
      <span>Race: <b style="color:#ccc">${_esc(raceLabel)}</b></span>
      <span>Class: <b style="color:#ccc">${_esc(classLabel)}</b></span>
      <span>Level: <b style="color:#ccc">${ch.level}</b></span>
    </div>
    <div style="font-size:11px;color:#888;margin-top:4px;text-transform:capitalize">
      Role: ${_esc(ch.role?.replace('-', ' ') || '—')}
    </div>
  `
  body.appendChild(header)

  // Ability scores grid (2 columns × 3 rows)
  const scoresLabel = document.createElement('div')
  scoresLabel.textContent = 'Ability Scores'
  scoresLabel.style.cssText = 'font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px'
  body.appendChild(scoresLabel)

  const grid = document.createElement('div')
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px'
  const scores = ch.abilityScores || {}
  for (const { key, label } of ABILITY_LABELS) {
    const val = scores[key] ?? '—'
    const mod = typeof val === 'number' ? _modifier(val) : ''
    const cell = document.createElement('div')
    cell.style.cssText = 'background:#1a1a2a;border:1px solid #334;border-radius:4px;padding:8px;text-align:center'
    cell.innerHTML = `<div style="font-size:10px;color:#888;margin-bottom:4px">${label}</div>`
      + `<div style="font-size:22px;font-weight:bold;color:#fff">${val}</div>`
      + `<div style="font-size:12px;color:#7fd">${mod}</div>`
    grid.appendChild(cell)
  }
  body.appendChild(grid)

  el.appendChild(body)
  return el
}

const CharacterSheet = {
  open(ch) {
    if (_openSheets.has(ch.id)) {
      // Focus the existing sheet
      bringToFront(_openSheets.get(ch.id))
      return
    }
    const el = _build(ch)
    document.body.appendChild(el)
    bringToFront(el)
    _openSheets.set(ch.id, el)
  },
}

export default CharacterSheet
