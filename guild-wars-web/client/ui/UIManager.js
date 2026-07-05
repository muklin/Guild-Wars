import TerrainTypePanel from './TerrainTypePanel.js'
import DistrictTypePanel from './DistrictTypePanel.js'
import FactionsPanel from './FactionsPanel.js'
import GuildPanel from './GuildPanel.js'
import TutorialWindow from './TutorialWindow.js'
import Settings from '../settings.js'

// Tracks whether the Guild panel has ever auto-opened before, across reloads (see
// showSetupPhase below) — same try/catch-guarded localStorage pattern as config.js's
// stored()/persist() (private mode / no storage just means it auto-shows every time).
const GUILD_PANEL_SHOWN_KEY = 'gw.guildPanelAutoShown'
function hasAutoShownGuildPanel() {
  try { return localStorage.getItem(GUILD_PANEL_SHOWN_KEY) === '1' }
  catch { return false }
}
function markGuildPanelAutoShown() {
  try { localStorage.setItem(GUILD_PANEL_SHOWN_KEY, '1') }
  catch { /* ignore */ }
}

const STAGES = [
  { step: 'Terrain',         label: 'Terrain Setup',       event: 'TERRAIN_COMPLETE' },
  { step: 'CitySubdivision', label: 'City District Setup', event: 'SUBDIVISION_COMPLETE' },
  { step: 'GuildCreation',   label: 'Guild Design',        event: null }
]
const STEP_ORDER = ['Terrain', 'CitySubdivision', 'GuildCreation', 'Complete']

// Resources that cannot be stockpiled — hidden from the resource bar.
const HIDDEN_RESOURCES = new Set(['Basic Food', 'Labour'])
// Always shown even before districts produce them.
const DEFAULT_RESOURCES = ['Gold', 'Security']

// Help text shown in the bottom-right window per phase.
const PHASE_HELP_TEXT = {
  Terrain:         'Take turns to create the landscape, religions, history and larger world that the city exists in',
  CitySubdivision: "Take turns to define the city's leadership, its districts, trade routes, specific threats, traded resources and in general its people.",
  GuildCreation:   'Now design your guild; is it secretive or public, mighty or subversive, magical or mercantile or religious. Where are its headquarters, who does it ally with. Who are its people. What are its strategies to win?',
}

const HELP_POS_KEY = 'gw.helpWindow.pos'
function loadHelpPos() {
  try { return JSON.parse(localStorage.getItem(HELP_POS_KEY)) } catch { return null }
}
function saveHelpPos(x, y) {
  try { localStorage.setItem(HELP_POS_KEY, JSON.stringify({ x, y })) } catch { /* ignore */ }
}

export default class UIManager {
  constructor(eventBus, renderer) {
    this.eventBus = eventBus
    this.renderer = renderer
    this.panels = new Map()
    this.currentStep = null
    this.terrainTypePanel = new TerrainTypePanel(eventBus, renderer)
    this.districtTypePanel = new DistrictTypePanel(eventBus, renderer)
    this.factionsPanel = new FactionsPanel(eventBus)
    this.guildPanel = new GuildPanel(eventBus)
    this.tutorialWindow = new TutorialWindow()
    this._playerName = ''
    this._resourceRegistry = []
    this._guildResources = {}
    this._advancePhaseBtn = null
    this._helpWindow = null
    this._helpTextEl = null
  }

  init() {
    this.createPanels()
    this.setupEventListeners()
  }

  setPlayerName(name) {
    this._playerName = name || ''
  }

  createPanels() {
    const uiContainer = document.createElement('div')
    uiContainer.id = 'ui-container'
    uiContainer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10'
    document.body.appendChild(uiContainer)

    this.createResourceBar(uiContainer)
    this.createRightPanel(uiContainer)
    this.createCenterPanels(uiContainer)
    this.createErrorPopup(uiContainer)
    this.createActionPanel()
    this.createFactionsButton()
    this.createHelpWindow()

    // GuildPanel and FactionsPanel append themselves to document.body
    this.guildPanel.render()
    this.factionsPanel.render()
  }

  setWalkMode(on) {
    const el = document.getElementById('ui-container')
    if (el) el.style.display = on ? 'none' : ''
  }

  createResourceBar(container) {
    const bar = document.createElement('div')
    bar.id = 'resource-bar'
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:32px;background:#111;border-bottom:1px solid #333;color:#fff;font-family:Arial;z-index:20;pointer-events:auto;display:flex;align-items:center;padding:0 12px;gap:0;overflow-x:auto'
    bar.addEventListener('click',     (e) => e.stopPropagation())
    bar.addEventListener('mousedown', (e) => e.stopPropagation())
    container.appendChild(bar)
    this._resourceBar = bar
    this._renderResourceBar()
  }

  createLeftPanels(container) {
    const leftPanel = document.createElement('div')
    leftPanel.id = 'left-panel'
    leftPanel.style.cssText = 'position:fixed;left:0;top:32px;width:200px;height:calc(100% - 32px);background:#000;border-right:2px solid #444;padding:10px;color:#fff;z-index:20;pointer-events:auto'
    leftPanel.addEventListener('click',     (e) => e.stopPropagation())
    leftPanel.addEventListener('mousedown', (e) => e.stopPropagation())
    container.appendChild(leftPanel)
    this.panels.set('left', leftPanel)
  }

  createRightPanel(container) {
    // Right panel retired — FactionsPanel is now a floating window (see createFactionsButton).
    const rightPanel = document.createElement('div')
    rightPanel.id = 'right-panel'
    rightPanel.style.cssText = 'display:none'
    container.appendChild(rightPanel)
    this.panels.set('right', rightPanel)
  }

  createCenterPanels(container) {
    const centerPanel = document.createElement('div')
    centerPanel.id = 'center-panel'
    centerPanel.style.cssText = 'position:fixed;left:200px;right:0;top:32px;z-index:10'
    container.appendChild(centerPanel)
    this.panels.set('center', centerPanel)
  }

  createErrorPopup(container) {
    const errorPopup = document.createElement('div')
    errorPopup.id = 'error-popup'
    errorPopup.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:none;z-index:30;pointer-events:auto'
    const errorBox = document.createElement('div')
    errorBox.style.cssText = 'position:absolute;left:30%;right:30%;top:47%;transform:translateY(-50%);width:40%;background:#2a2a2a;border:2px solid #666;border-radius:4px;padding:20px'

    const message = document.createElement('div')
    message.id = 'error-message'
    message.style.cssText = 'text-align:center;padding:20px;color:#fff'

    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:center'

    const btn = document.createElement('button')
    btn.id = 'error-ok-btn'
    btn.textContent = 'OK'
    btn.style.cssText = 'width:100%;padding:10px;background:#4a7c59;color:#fff;border:1px solid #666;border-radius:3px;cursor:pointer'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const cb = this._confirmCallback
      this.hideError()
      if (cb) cb()
    })

    const cancelBtn = document.createElement('button')
    cancelBtn.id = 'error-cancel-btn'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.style.cssText = 'padding:6px 24px;background:transparent;color:#aaa;border:1px solid #555;border-radius:3px;cursor:pointer;display:none;font-size:12px'
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.hideError()
    })

    btnRow.appendChild(btn)
    btnRow.appendChild(cancelBtn)
    errorBox.appendChild(message)
    errorBox.appendChild(btnRow)
    errorPopup.appendChild(errorBox)
    container.appendChild(errorPopup)
  }

  // ── Action panel (bottom-right) ───────────────────────────────────────────────
  // Fixed panel that hosts the Done/advance-phase button and future action buttons.
  // Blocks click and mousedown so interactions with it never reach the map.

  createActionPanel() {
    const panel = document.createElement('div')
    panel.id = 'action-panel'
    panel.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:25',
      'pointer-events:auto', 'display:none',
      'background:#1a1a1a', 'border:1px solid #555', 'border-radius:8px',
      'padding:10px 12px', 'box-shadow:0 4px 16px rgba(0,0,0,0.6)',
      'font-family:Arial'
    ].join(';')
    panel.addEventListener('click',     (e) => e.stopPropagation())
    panel.addEventListener('mousedown', (e) => e.stopPropagation())

    const terrainBtns = document.createElement('div')
    terrainBtns.id = 'terrain-worldbuilding-btns'
    terrainBtns.style.cssText = 'display:none;flex-direction:column;gap:6px;margin-bottom:8px'
    const WB_ACTIONS = [
      { id: 'add-god-btn',           label: 'Add God',            event: 'ADD_GOD' },
      { id: 'add-magic-btn',         label: 'Add Magic',          event: 'ADD_MAGIC' },
      { id: 'add-foreign-power-btn', label: 'Add Foreign Power',  event: 'ADD_FOREIGN_POWER' },
    ]
    for (const { id, label, event } of WB_ACTIONS) {
      const b = document.createElement('button')
      b.id = id
      b.textContent = label
      b.style.cssText = [
        'display:block', 'width:100%', 'padding:7px 16px',
        'background:#1e2d3a', 'border:1px solid #4a7a9b', 'border-radius:6px',
        'color:#a8c8e0', 'font-size:12px', 'font-weight:bold',
        'cursor:pointer', 'letter-spacing:0.4px'
      ].join(';')
      b.addEventListener('click', () => this.eventBus.emit(event))
      terrainBtns.appendChild(b)
    }
    panel.appendChild(terrainBtns)
    this._terrainWorldbuildingBtns = terrainBtns

    const btn = document.createElement('button')
    btn.id = 'advance-phase-btn'
    btn.style.cssText = [
      'display:block', 'width:100%', 'padding:9px 24px',
      'background:#8b1a1a', 'border:2px solid #c44', 'border-radius:6px',
      'color:#fff', 'font-size:13px', 'font-weight:bold',
      'cursor:pointer', 'letter-spacing:0.5px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.4)'
    ].join(';')
    btn.textContent = 'Done'
    panel.appendChild(btn)

    document.body.appendChild(panel)
    this._advancePhaseBtn = btn
    this._actionPanel = panel
  }

  // ── Factions button (bottom-left) ────────────────────────────────────────────
  // Brown toggle button that opens/closes the floating FactionsPanel.
  // Shown whenever the FactionsPanel is relevant (CitySubdivision onward).

  createFactionsButton() {
    const panel = document.createElement('div')
    panel.id = 'factions-btn-panel'
    panel.style.cssText = [
      'position:fixed', 'bottom:20px', 'left:20px', 'z-index:25',
      'pointer-events:auto', 'display:none',
      'background:#1a1a1a', 'border:1px solid #555', 'border-radius:8px',
      'padding:10px 12px', 'box-shadow:0 4px 16px rgba(0,0,0,0.6)',
      'font-family:Arial'
    ].join(';')
    panel.addEventListener('click',     (e) => e.stopPropagation())
    panel.addEventListener('mousedown', (e) => e.stopPropagation())

    const btn = document.createElement('button')
    btn.id = 'factions-toggle-btn'
    btn.textContent = 'Factions'
    btn.style.cssText = [
      'display:block', 'width:100%', 'padding:9px 24px',
      'background:#5a3a10', 'border:2px solid #a07030', 'border-radius:6px',
      'color:#fff', 'font-size:13px', 'font-weight:bold',
      'cursor:pointer', 'letter-spacing:0.5px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.4)'
    ].join(';')
    btn.addEventListener('click', () => this.factionsPanel.toggle())
    panel.appendChild(btn)

    document.body.appendChild(panel)
    this._factionsPanel = panel
  }

  _setFactionsButtonVisible(visible) {
    if (this._factionsPanel) this._factionsPanel.style.display = visible ? 'block' : 'none'
  }

  _updateAdvancePhaseButton(step) {
    const btn = this._advancePhaseBtn
    const panel = this._actionPanel
    if (!btn || !panel) return
    const stage = STAGES.find(s => s.step === step)
    if (stage?.event) {
      panel.style.display = 'block'
      btn.onclick = () => this.eventBus.emit(stage.event)
    } else {
      panel.style.display = 'none'
      btn.onclick = null
    }
    if (this._terrainWorldbuildingBtns) {
      this._terrainWorldbuildingBtns.style.display = step === 'Terrain' ? 'flex' : 'none'
    }
  }

  updateTerrainWorldbuildingButtons(state) {
    const magicBtn = document.getElementById('add-magic-btn')
    if (magicBtn) magicBtn.textContent = state?.magicSystem ? 'Refine Magic' : 'Add Magic'
  }

  // ── Help Text window ──────────────────────────────────────────────────────────

  createHelpWindow() {
    const el = document.createElement('div')
    el.id = 'help-window'
    el.style.cssText = [
      'position:fixed', 'z-index:25', 'width:260px',
      'background:#111', 'border:1px solid #444', 'border-radius:6px',
      'color:#ccc', 'font-family:Arial', 'font-size:12px', 'line-height:1.5',
      'display:none', 'pointer-events:auto', 'user-select:none'
    ].join(';')

    // Block map interactions — clicks inside the window must not reach the map.
    el.addEventListener('click',     (e) => e.stopPropagation())
    el.addEventListener('mousedown', (e) => e.stopPropagation())

    // Title bar (drag handle) with close button
    const titleBar = document.createElement('div')
    titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#1e1e1e;border-bottom:1px solid #333;border-radius:6px 6px 0 0;cursor:move'
    const titleText = document.createElement('span')
    titleText.textContent = 'Tutorial Information'
    titleText.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:1px'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '×'
    closeBtn.style.cssText = 'background:none;border:none;color:#777;font-size:18px;cursor:pointer;padding:0;line-height:1'
    closeBtn.addEventListener('click', () => { el.style.display = 'none' })
    titleBar.appendChild(titleText)
    titleBar.appendChild(closeBtn)
    el.appendChild(titleBar)

    const textEl = document.createElement('div')
    textEl.style.cssText = 'padding:10px 12px'
    el.appendChild(textEl)
    this._helpTextEl = textEl

    // "Don't show tutorial information" checkbox
    const footer = document.createElement('div')
    footer.style.cssText = 'padding:6px 12px 10px;border-top:1px solid #222'
    const checkLabel = document.createElement('label')
    checkLabel.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:11px;color:#666;cursor:pointer'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.style.cssText = 'cursor:pointer;width:13px;height:13px'
    checkbox.addEventListener('change', () => {
      Settings.showTutorials = !checkbox.checked
    })
    checkLabel.appendChild(checkbox)
    checkLabel.appendChild(document.createTextNode("Don't show tutorial information"))
    this._helpCheckbox = checkbox
    footer.appendChild(checkLabel)
    el.appendChild(footer)

    document.body.appendChild(el)
    this._helpWindow = el
    this._makeHelpDraggable(titleBar)
  }

  _makeHelpDraggable(handle) {
    const el = this._helpWindow
    let startX, startY, startLeft, startTop
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      startX = e.clientX; startY = e.clientY
      startLeft = rect.left; startTop = rect.top
      let didDrag = false
      const onMove = (e) => {
        didDrag = true
        el.style.left = (startLeft + (e.clientX - startX)) + 'px'
        el.style.top  = (startTop  + (e.clientY - startY)) + 'px'
        el.style.right = 'auto'; el.style.bottom = 'auto'
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        if (didDrag) {
          saveHelpPos(parseInt(el.style.left), parseInt(el.style.top))
          // Suppress the click event the browser synthesises after a drag release.
          const suppressClick = (e) => {
            e.stopPropagation()
            document.removeEventListener('click', suppressClick, true)
          }
          document.addEventListener('click', suppressClick, true)
        }
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
  }

  _showHelpWindow(step) {
    const text = PHASE_HELP_TEXT[step]
    if (!text || !this._helpWindow) return
    if (!Settings.showTutorials) return
    this._helpTextEl.textContent = text
    if (this._helpCheckbox) this._helpCheckbox.checked = false

    const saved = loadHelpPos()
    if (saved) {
      this._helpWindow.style.left   = saved.x + 'px'
      this._helpWindow.style.top    = saved.y + 'px'
      this._helpWindow.style.right  = 'auto'
      this._helpWindow.style.bottom = 'auto'
    } else {
      // Default: bottom-right, above the Advance Phase button
      this._helpWindow.style.right  = '20px'
      this._helpWindow.style.bottom = '160px'
      this._helpWindow.style.left   = 'auto'
      this._helpWindow.style.top    = 'auto'
    }
    this._helpWindow.style.display = 'block'
  }

  _hideHelpWindow() {
    if (this._helpWindow) this._helpWindow.style.display = 'none'
  }

  // ── Phase name splash ─────────────────────────────────────────────────────────

  _showPhaseSplash(label) {
    const splash = document.createElement('div')
    splash.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'width:100%', 'height:100%',
      'display:flex', 'align-items:center', 'justify-content:center',
      'pointer-events:none', 'z-index:80',
      'animation:gwSplashFade 5s forwards'
    ].join(';')

    const text = document.createElement('div')
    text.textContent = label
    text.style.cssText = 'color:#fff;font-family:Arial;font-size:48px;font-weight:bold;text-shadow:0 2px 16px rgba(0,0,0,0.8);text-align:center'
    splash.appendChild(text)
    document.body.appendChild(splash)

    // Inject keyframes once
    if (!document.getElementById('gw-splash-style')) {
      const style = document.createElement('style')
      style.id = 'gw-splash-style'
      style.textContent = '@keyframes gwSplashFade { 0%{opacity:1} 60%{opacity:1} 100%{opacity:0} }'
      document.head.appendChild(style)
    }

    splash.addEventListener('animationend', () => splash.remove())
  }

  // ── Phase management ──────────────────────────────────────────────────────────

  showSetupPhase(step) {
    const isNewPhase = step !== this.currentStep
    this.currentStep = step

    if (step === 'Terrain') {
      this._resourceBar.style.display = 'none'
      this.guildPanel.hide()
      this.factionsPanel.hide()
      this._setFactionsButtonVisible(false)
      this._updateAdvancePhaseButton(step)
      if (isNewPhase) {
        this._showHelpWindow(step)
        this._showPhaseSplash('Terrain Setup')
      }
    } else if (step === 'CitySubdivision') {

      this._resourceBar.style.display = ''
      this.guildPanel.hide()
      this._setFactionsButtonVisible(true)
      this._updateAdvancePhaseButton(step)
      if (isNewPhase) {
        this.factionsPanel.show()   // auto-open on entering City Subdivision
        this._showHelpWindow(step)
        this._showPhaseSplash('City District Setup')
      }
    } else if (step === 'GuildCreation' || step === 'Complete') {

      this._resourceBar.style.display = ''
      this._setFactionsButtonVisible(true)
      this._updateAdvancePhaseButton(step)
      if (step === 'GuildCreation') {
        if (isNewPhase) {
          this._showHelpWindow(step)
          this._showPhaseSplash('Guild Design')
          if (!hasAutoShownGuildPanel()) {
            this.guildPanel.show()
            markGuildPanelAutoShown()
          }
        }
      } else {
        this._hideHelpWindow()
      }
    }
    // Re-render the bar after currentStep changes so quantity display (qty visible
    // only in Guild phase) matches the new phase even if updateResources ran first.
    this._renderResourceBar()
  }

  // ── Resource bar ──────────────────────────────────────────────────────────

  _renderResourceBar() {
    const bar = this._resourceBar
    if (!bar) return
    bar.innerHTML = ''

    const combined = [
      ...DEFAULT_RESOURCES,
      ...this._resourceRegistry.filter(r => !HIDDEN_RESOURCES.has(r) && !DEFAULT_RESOURCES.includes(r)),
    ]

    const showQty = this.currentStep === 'GuildCreation' || this.currentStep === 'Complete'
    for (const name of combined) {
      const qty = this._guildResources[name] ?? 0
      const chip = document.createElement('div')
      chip.style.cssText = 'display:flex;align-items:center;gap:4px;padding:0 10px;height:100%;border-right:1px solid #222;white-space:nowrap;font-size:11px'
      chip.innerHTML = `<span style="color:#aaa">${name}</span>`
        + (showQty ? `<span style="color:#fc8;font-weight:bold">${qty}</span>` : '')
      bar.appendChild(chip)
    }
  }

  updateResources(resources) {
    this._resourceRegistry = resources || []
    this._renderResourceBar()
  }

  updateGuild(guild) {
    if (guild) {
      this._guildResources = guild.resources || {}
      this._renderResourceBar()
      this.guildPanel.setData({ guild })
      this.factionsPanel.setGuild(guild)
    }
  }

  // ── Event listeners ────────────────────────────────────────────────────────────

  setupEventListeners() {
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (e.key === 'g' || e.key === 'G') this.guildPanel.toggle()
    })
  }

  // ── Delegated updates ─────────────────────────────────────────────────────

  showError(message) {
    document.getElementById('error-message').textContent = message
    document.getElementById('error-ok-btn').textContent = 'OK'
    document.getElementById('error-cancel-btn').style.display = 'none'
    this._confirmCallback = null
    document.getElementById('error-popup').style.display = 'block'
    setTimeout(() => this.hideError(), 5000)
  }

  showSuccess(message) {
    document.getElementById('error-message').textContent = message
    document.getElementById('error-ok-btn').textContent = 'OK'
    document.getElementById('error-cancel-btn').style.display = 'none'
    this._confirmCallback = null
    document.getElementById('error-popup').style.display = 'block'
    setTimeout(() => this.hideError(), 3000)
  }

  showConfirm(message, ignoreLabel, onIgnore) {
    document.getElementById('error-message').textContent = message
    document.getElementById('error-ok-btn').textContent = ignoreLabel
    document.getElementById('error-cancel-btn').style.display = 'block'
    this._confirmCallback = onIgnore
    document.getElementById('error-popup').style.display = 'block'
  }

  hideError() {
    document.getElementById('error-popup').style.display = 'none'
    this._confirmCallback = null
  }

  updateFactions(factions) {
    this.factionsPanel.update(factions)
    if (!factions.length) this.factionsPanel.setGuild(null)
  }

  updateThreats(threats) {
    this.factionsPanel.updateThreats(threats)
  }
}
