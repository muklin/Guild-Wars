import * as THREE from 'three'
import GameAPI from '../api/GameAPI.js'
import { bringToFront } from './GuildPanel.js'

const PORTRAIT_W = 100
const PORTRAIT_H = 420

function _mkPortrait() {
  const wrapper = document.createElement('div')
  wrapper.style.cssText = `width:${PORTRAIT_W}px;height:${PORTRAIT_H}px;border:1px solid #9b8e76;border-radius:3px;overflow:hidden;background:#1e1828;flex-shrink:0`

  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'display:block'
  wrapper.appendChild(canvas)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setSize(PORTRAIT_W, PORTRAIT_H)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x1e1828)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(35, PORTRAIT_W / PORTRAIT_H, 0.0001, 10)

  // Same proportions as WalkMode
  const PARA_SCALE  = 0.13 / 2.3
  const CHAR_HEIGHT = 1.12 * PARA_SCALE
  const CHAR_RADIUS = 0.25 * PARA_SCALE
  const BODY_HEIGHT = CHAR_HEIGHT * 0.60
  const HEAD_RADIUS = CHAR_HEIGHT * 0.22

  const group = new THREE.Group()

  const bodyMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(CHAR_RADIUS, CHAR_RADIUS, BODY_HEIGHT, 8),
    new THREE.MeshStandardMaterial({ color: 0xffaa44 })
  )
  bodyMesh.position.y = BODY_HEIGHT / 2
  group.add(bodyMesh)

  const headMesh = new THREE.Mesh(
    new THREE.DodecahedronGeometry(HEAD_RADIUS),
    new THREE.MeshStandardMaterial({ color: 0xffcc88 })
  )
  headMesh.position.y = BODY_HEIGHT + HEAD_RADIUS
  group.add(headMesh)

  scene.add(group)
  scene.add(new THREE.AmbientLight(0xfff8f0, 0.7))
  const key = new THREE.DirectionalLight(0xfff4e0, 1.2)
  key.position.set(0.8, 2, 1.5)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x8899cc, 0.4)
  fill.position.set(-1, 0.5, -1)
  scene.add(fill)

  // Frame the full character with a slight 3/4 elevated angle
  const charTop  = BODY_HEIGHT + HEAD_RADIUS * 2
  const centerY  = charTop * 0.55
  const halfFov  = (35 / 2) * Math.PI / 180
  const dist     = (charTop * 0.65) / Math.tan(halfFov)
  camera.position.set(charTop * 0.4, centerY * 1.1, dist)
  camera.lookAt(0, centerY, 0)

  let animId
  const tick = () => {
    animId = requestAnimationFrame(tick)
    group.rotation.y += 0.008
    renderer.render(scene, camera)
  }
  tick()

  return {
    el: wrapper,
    cleanup: () => { cancelAnimationFrame(animId); renderer.dispose() },
  }
}

const RACE_LABELS = {
  human:'Human', elf:'Elf', dwarf:'Dwarf',
  halfOrc:'Half-Orc', halfling:'Halfling', gnome:'Gnome',
}
const ROLE_LABELS = {
  'guild-leader':'Guild Leader', 'guild-second':'Guild Second',
  member:'Member', recruit:'Recruit',
}
const ABILITIES = [
  { key:'str', label:'Strength'     },
  { key:'dex', label:'Dexterity'    },
  { key:'con', label:'Constitution' },
  { key:'int', label:'Intelligence' },
  { key:'wis', label:'Wisdom'       },
  { key:'cha', label:'Charisma'     },
]
const CLASSES = ['Barbarian','Bard','Cleric','Druid','Fighter','Monk','Paladin','Ranger','Rogue','Sorcerer','Warlock','Wizard']

// ch.id → { el, bodyEl, ch, tokens, playerName, onUpdate, classPickMode }
const _sheets = new Map()

function _mod(s)  { return Math.floor(((s ?? 10) - 10) / 2) }
function _ms(s)   { const m = _mod(s); return (m >= 0 ? '+' : '') + m }
function _esc(s)  { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }

const SH = 'background:#f5f0e8;border:1px solid #7a6a52;border-radius:3px;padding:5px'
const LABEL_CSS = 'font-size:7px;text-transform:uppercase;letter-spacing:0.6px;color:#7a6a52;font-weight:bold'

function _labeledField(label, value) {
  const d = document.createElement('div')
  d.style.cssText = 'flex:1;background:#fff;border:1px solid #9b8e76;border-radius:2px;padding:3px 6px;min-width:0'
  d.innerHTML = `<div style="font-size:11px;font-weight:bold;color:#1a1a1a;min-height:15px">${_esc(String(value ?? ''))}</div>`
    + `<div style="${LABEL_CSS};border-top:1px solid #e8e0d0;padding-top:1px;margin-top:1px">${label}</div>`
  return d
}

function _statBox(label, value) {
  const d = document.createElement('div')
  d.style.cssText = 'flex:1;background:#fff;border:2px solid #7a6a52;border-radius:5px;text-align:center;padding:6px 3px'
  d.innerHTML = `<div style="font-size:18px;font-weight:bold;color:#1a1a1a;line-height:1.1">${value}</div>`
    + `<div style="${LABEL_CSS};margin-top:3px">${label}</div>`
  return d
}

function _makeDraggable(el) {
  let drag = false, ox = 0, oy = 0
  el.addEventListener('mousedown', e => {
    const tb = el.querySelector('.cs-title-bar')
    if (!tb || !tb.contains(e.target)) return
    drag = true
    const r = el.getBoundingClientRect()
    ox = e.clientX - r.left; oy = e.clientY - r.top
    e.preventDefault()
  })
  document.addEventListener('mousemove', e => {
    if (!drag) return
    el.style.left = (e.clientX - ox) + 'px'
    el.style.top  = (e.clientY - oy) + 'px'
  })
  document.addEventListener('mouseup', () => { drag = false })
}

function _abilityScore(score) {
  const d = document.createElement('div')
  d.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:1px'
  d.innerHTML = `<div style="font-size:28px;font-weight:bold;color:#1a1a1a;line-height:1">${score}</div>`
    + `<div style="font-size:11px;color:#555">${_ms(score)}</div>`
  return d
}

// Returns roles that still have open slots, excluding this character from the count.
function _openRoles(state) {
  const others = (state.guild?.characters || []).filter(c => c.id !== state.ch.id)
  const leaders = others.filter(c => c.role === 'guild-leader').length
  const seconds = others.filter(c => c.role === 'guild-second').length
  const roles = []
  if (leaders < 1) roles.push(['guild-leader', 'Guild Leader'])
  if (seconds < 2) roles.push(['guild-second', 'Guild Second'])
  roles.push(['member', 'Member'])
  return roles
}

function _mkHeader(state) {
  const { ch } = state
  const canLvl   = (state.tokens?.character ?? 0) > 0
  const isMember = ch.role !== 'recruit'

  const hdr = document.createElement('div')
  hdr.className = 'cs-header'
  hdr.style.cssText = 'display:flex;gap:5px;align-items:stretch'

  const nameBlock = document.createElement('div')
  nameBlock.style.cssText = 'flex:1.2;background:#fff;border:1px solid #9b8e76;border-radius:3px;padding:5px 8px;display:flex;flex-direction:column;justify-content:flex-end'
  nameBlock.innerHTML = `<div style="font-size:20px;font-weight:bold;color:#1a1a1a">${_esc(ch.name)}</div>`
    + `<div style="${LABEL_CSS};border-top:1px solid #e0d8cc;margin-top:4px;padding-top:2px">Character Name</div>`
  hdr.appendChild(nameBlock)

  const metaBlock = document.createElement('div')
  metaBlock.style.cssText = 'flex:2;display:flex;flex-direction:column;gap:3px'

  // ── Row 1: Class & Level (with level-up controls) | Player Name ───────────
  const classLvlWrap = document.createElement('div')
  classLvlWrap.style.cssText = 'flex:1;background:#fff;border:1px solid #9b8e76;border-radius:2px;padding:3px 6px;min-width:0;display:flex;align-items:stretch;gap:4px'

  const classLvlText = document.createElement('div')
  classLvlText.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between'

  if (state.classPickMode) {
    // Class selector replaces the level text
    const classSel = document.createElement('select')
    classSel.style.cssText = 'width:100%;font-size:11px;font-weight:bold;color:#1a1a1a;background:transparent;border:none;outline:none;padding:0;cursor:pointer;flex:1'
    for (const cls of CLASSES) {
      const opt = document.createElement('option'); opt.value = cls; opt.textContent = cls
      classSel.appendChild(opt)
    }
    const lbl = document.createElement('div')
    lbl.style.cssText = `${LABEL_CSS};border-top:1px solid #e8e0d0;padding-top:1px;margin-top:1px`
    lbl.textContent = 'Class & Level'
    classLvlText.appendChild(classSel)
    classLvlText.appendChild(lbl)
    classLvlWrap.appendChild(classLvlText)

    // ✓ / × stacked where ▲ was
    const btnCol = document.createElement('div')
    btnCol.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex-shrink:0;justify-content:center'

    const confirmBtn = document.createElement('button')
    confirmBtn.textContent = '✓'
    confirmBtn.title = 'Confirm Level Up'
    confirmBtn.style.cssText = 'padding:2px 6px;border:none;border-radius:2px;font-size:12px;cursor:pointer;background:#4a7c59;color:#fff;line-height:1.3'
    confirmBtn.addEventListener('click', async () => {
      const cls = classSel.value
      state.classPickMode = false
      confirmBtn.disabled = true
      const res = await GameAPI.levelUpCharacter(ch.id, cls)
      if (res.ok) {
        const updated = res.guild.characters?.find(c => c.id === ch.id)
        if (updated) Object.assign(ch, updated)
        if (res.tokens) state.tokens = res.tokens
        if (res.guild)  state.guild  = res.guild
        _refreshHeader(state)
        if (state.onUpdate) state.onUpdate(res.guild, res.tokens)
      } else {
        state.classPickMode = true
        _refreshHeader(state)
        alert(res.error || 'Level up failed')
      }
    })
    btnCol.appendChild(confirmBtn)

    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = '×'
    cancelBtn.title = 'Cancel'
    cancelBtn.style.cssText = 'padding:2px 6px;border:none;border-radius:2px;font-size:12px;cursor:pointer;background:#7a4a3a;color:#fff;line-height:1.3'
    cancelBtn.addEventListener('click', () => { state.classPickMode = false; _refreshHeader(state) })
    btnCol.appendChild(cancelBtn)

    classLvlWrap.appendChild(btnCol)
  } else {
    // Normal: level text + ▲ button
    classLvlText.innerHTML = `<div style="font-size:11px;font-weight:bold;color:#1a1a1a;min-height:15px">${_esc(ch.class ? `${ch.class} ${ch.level}` : `Level ${ch.level}`)}</div>`
      + `<div style="${LABEL_CSS};border-top:1px solid #e8e0d0;padding-top:1px;margin-top:1px">Class &amp; Level</div>`
    classLvlWrap.appendChild(classLvlText)

    const lvlBtn = document.createElement('button')
    lvlBtn.textContent = '▲'
    lvlBtn.title = 'Level Up — costs 1 Character Token'
    lvlBtn.disabled = !canLvl
    lvlBtn.style.cssText = `flex-shrink:0;align-self:flex-end;padding:2px 6px;border:none;border-radius:2px;font-size:10px;margin-bottom:2px;`
      + `cursor:${canLvl ? 'pointer' : 'not-allowed'};`
      + `background:${canLvl ? '#4a7c59' : '#2a3a2a'};color:${canLvl ? '#fff' : '#555'}`
    lvlBtn.addEventListener('click', () => {
      if (!canLvl) return
      if (ch.level === 0) {
        state.classPickMode = true
        _refreshHeader(state)
      } else {
        lvlBtn.disabled = true
        GameAPI.levelUpCharacter(ch.id, null).then(res => {
          if (res.ok) {
            const updated = res.guild.characters?.find(c => c.id === ch.id)
            if (updated) Object.assign(ch, updated)
            if (res.tokens) state.tokens = res.tokens
            if (res.guild)  state.guild  = res.guild
            _refreshHeader(state)
            if (state.onUpdate) state.onUpdate(res.guild, res.tokens)
          } else {
            lvlBtn.disabled = false
            alert(res.error || 'Level up failed')
          }
        })
      }
    })
    classLvlWrap.appendChild(lvlBtn)
  }

  const r1 = document.createElement('div'); r1.style.cssText = 'display:flex;gap:3px'
  r1.appendChild(classLvlWrap)
  r1.appendChild(_labeledField('Player Name', state.playerName || ''))

  // Row 2: Race | Guild Role (static for recruits, select for members)
  const r2 = document.createElement('div'); r2.style.cssText = 'display:flex;gap:3px'
  r2.appendChild(_labeledField('Race', RACE_LABELS[ch.race] || ch.race || ''))

  if (isMember) {
    const availableRoles = _openRoles(state)
    const roleWrap = document.createElement('div')
    roleWrap.style.cssText = 'flex:1;background:#fff;border:1px solid #9b8e76;border-radius:2px;padding:3px 6px;min-width:0;display:flex;flex-direction:column;justify-content:space-between'

    const roleSel = document.createElement('select')
    roleSel.style.cssText = 'width:100%;font-size:11px;font-weight:bold;color:#1a1a1a;background:transparent;border:none;outline:none;padding:0;cursor:pointer;min-height:15px'
    for (const [val, lbl] of availableRoles) {
      const opt = document.createElement('option')
      opt.value = val; opt.textContent = lbl
      if (ch.role === val) opt.selected = true
      roleSel.appendChild(opt)
    }
    roleSel.addEventListener('change', async () => {
      const role = roleSel.value
      if (role === ch.role) return
      roleSel.disabled = true
      const res = await GameAPI.changeCharacterRole(ch.id, role)
      roleSel.disabled = false
      if (res.ok) {
        const updated = res.guild.characters?.find(c => c.id === ch.id)
        if (updated) Object.assign(ch, updated)
        if (res.guild) state.guild = res.guild
        _refreshHeader(state)
        _refreshActions(state)
        if (state.onUpdate) state.onUpdate(res.guild, state.tokens)
      } else {
        roleSel.value = ch.role  // revert UI
        alert(res.error || 'Role change failed')
      }
    })

    const roleLabel = document.createElement('div')
    roleLabel.style.cssText = `${LABEL_CSS};border-top:1px solid #e8e0d0;padding-top:1px;margin-top:1px`
    roleLabel.textContent = 'Guild Role'

    roleWrap.appendChild(roleSel)
    roleWrap.appendChild(roleLabel)
    r2.appendChild(roleWrap)
  } else {
    r2.appendChild(_labeledField('Guild Role', ROLE_LABELS[ch.role] || ch.role || ''))
  }

  metaBlock.appendChild(r1); metaBlock.appendChild(r2)
  hdr.appendChild(metaBlock)
  return hdr
}

function _mkColumns(state) {
  const ch  = state.ch
  const ab  = ch.abilityScores || {}
  const ac  = 10 + _mod(ab.dex)
  const init = _ms(ab.dex)

  const cols = document.createElement('div')
  cols.style.cssText = `display:grid;grid-template-columns:${PORTRAIT_W}px 168px 1fr;gap:6px;align-items:start`

  // ── PORTRAIT COLUMN ───────────────────────────────────────────────────────
  if (state.portrait) cols.appendChild(state.portrait.el)

  // ── ABILITY SCORES COLUMN ─────────────────────────────────────────────────
  const leftCol = document.createElement('div')
  leftCol.style.cssText = 'display:flex;flex-direction:column;gap:4px'

  for (const a of ABILITIES) {
    const score = ab[a.key] ?? 10
    const block = document.createElement('div')
    block.style.cssText = 'background:#fff;border:1px solid #9b8e76;border-radius:4px;padding:6px 5px;display:flex;flex-direction:column;align-items:center;gap:4px'
    block.appendChild(_abilityScore(score))
    const nameLabel = document.createElement('div')
    nameLabel.style.cssText = 'font-size:8px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:#7a6a52;text-align:center;border-top:1px solid #e0d8cc;padding-top:3px;width:100%'
    nameLabel.textContent = a.label
    block.appendChild(nameLabel)
    leftCol.appendChild(block)
  }

  cols.appendChild(leftCol)

  // ── MIDDLE COLUMN — combat stats, attacks, equipment ─────────────────────
  const midCol = document.createElement('div')
  midCol.style.cssText = 'display:flex;flex-direction:column;gap:4px'

  const combatRow = document.createElement('div')
  combatRow.style.cssText = 'display:flex;gap:4px'
  combatRow.appendChild(_statBox('Armor Class', ac))
  combatRow.appendChild(_statBox('Initiative', init))
  combatRow.appendChild(_statBox('Speed', '30 ft'))
  midCol.appendChild(combatRow)

  const hpBox = document.createElement('div')
  hpBox.style.cssText = SH
  hpBox.innerHTML = `<div style="font-size:9px;color:#888;margin-bottom:3px">Hit Point Maximum &nbsp;<b>—</b></div>`
    + `<div style="height:48px;border:1px solid #c8c0b0;border-radius:2px;margin-bottom:4px"></div>`
    + `<div style="${LABEL_CSS};text-align:center">Current Hit Points</div>`
  midCol.appendChild(hpBox)

  const atkBox = document.createElement('div')
  atkBox.style.cssText = `${SH};flex:1`
  atkBox.innerHTML = `<div style="display:grid;grid-template-columns:1fr 58px 78px;gap:2px;${LABEL_CSS};padding-bottom:3px;border-bottom:1px solid #d0c8b8;margin-bottom:3px">`
    + `<span>Name</span><span>Atk Bonus</span><span>Damage/Type</span></div>`
    + `<div style="height:90px"></div>`
    + `<div style="${LABEL_CSS};border-top:1px solid #d0c8b8;padding-top:3px;text-align:center">Attacks &amp; Spellcasting</div>`
  midCol.appendChild(atkBox)

  const eqBox = document.createElement('div')
  eqBox.style.cssText = `${SH};flex:1;min-height:90px`
  eqBox.innerHTML = `<div style="${LABEL_CSS};margin-bottom:4px">Equipment</div>`
  midCol.appendChild(eqBox)

  cols.appendChild(midCol)
  return cols
}

// Class picker moved inline into the header — actions bar only used for role change if needed.
function _mkActions(state) {
  if (state.ch.role === 'recruit') return null

  // Non-recruits: role change is in the header select; nothing else here.
  return null
}

function _refreshHeader(state) {
  const old = state.bodyEl?.querySelector('.cs-header')
  if (!old) return
  old.replaceWith(_mkHeader(state))
}

function _refreshActions(_state) { /* class picker is now inline in header */ }

function _build(state) {
  const ch    = state.ch
  const count = _sheets.size
  const el    = document.createElement('div')
  el.style.cssText = [
    'position:fixed', 'width:780px', 'max-height:92vh',
    'background:#f5f0e8', 'border:2px solid #7a6a52', 'border-radius:4px',
    'z-index:51', 'pointer-events:auto', 'font-family:Arial,Helvetica,sans-serif',
    'color:#1a1a1a', 'overflow:hidden', 'display:flex', 'flex-direction:column',
    `left:${Math.min(window.innerWidth - 800, 80 + count * 22)}px`,
    `top:${Math.min(window.innerHeight - 580, 40 + count * 22)}px`,
  ].join(';')
  el.addEventListener('mousedown', () => bringToFront(el))
  el.addEventListener('wheel', e => e.stopPropagation(), { passive: true })
  el.addEventListener('keydown', e => e.stopPropagation())
  _makeDraggable(el)
  state.el = el

  const tb = document.createElement('div')
  tb.className = 'cs-title-bar'
  tb.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 10px;background:#4a3828;cursor:move;flex-shrink:0'
  tb.innerHTML = '<span style="font-size:10px;color:#d4c4a0;user-select:none;letter-spacing:1px">DUNGEONS &amp; DRAGONS — CHARACTER SHEET</span>'
  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cssText = 'background:none;border:none;color:#d4c4a0;font-size:18px;cursor:pointer;line-height:1;padding:0 4px'
  closeBtn.addEventListener('click', () => {
    el.remove()
    _sheets.delete(ch.id)
    state.portrait?.cleanup()
  })
  tb.appendChild(closeBtn)
  el.appendChild(tb)

  state.portrait = _mkPortrait()

  const body = document.createElement('div')
  body.style.cssText = 'overflow-y:auto;flex:1;padding:8px;display:flex;flex-direction:column;gap:6px'
  state.bodyEl = body

  body.appendChild(_mkHeader(state))
  body.appendChild(_mkColumns(state))
  el.appendChild(body)
  return el
}

const CharacterSheet = {
  open(ch, { tokens, playerName, guild, onUpdate } = {}) {
    if (_sheets.has(ch.id)) {
      const s = _sheets.get(ch.id)
      if (tokens     !== undefined) s.tokens     = tokens
      if (playerName !== undefined) s.playerName = playerName
      if (guild      !== undefined) s.guild      = guild
      if (onUpdate   !== undefined) s.onUpdate   = onUpdate
      bringToFront(s.el)
      _refreshHeader(s)
      _refreshActions(s)
      return
    }
    const state = {
      ch: { ...ch },
      tokens:      tokens     ?? {},
      playerName:  playerName ?? '',
      guild:       guild      ?? null,
      onUpdate:    onUpdate   ?? null,
      classPickMode: false,
    }
    const el = _build(state)
    document.body.appendChild(el)
    bringToFront(el)
    _sheets.set(ch.id, state)
  },
}

export default CharacterSheet
