import TerrainTypePanel from './TerrainTypePanel.js'
import DistrictClassPanel from './DistrictClassPanel.js'

const STAGES = [
  { step: 'Terrain',         label: 'Terrain Setup',       event: 'TERRAIN_COMPLETE' },
  { step: 'CitySubdivision', label: 'City District Setup', event: 'SUBDIVISION_COMPLETE' },
  { step: 'StreetSetup',     label: 'Street Setup',        event: 'STREET_SETUP_COMPLETE' },
  { step: 'GuildCreation',   label: 'Guild Design',        event: null }
]
const STEP_ORDER = ['Terrain', 'CitySubdivision', 'StreetSetup', 'GuildCreation', 'Complete']

export default class UIManager {
  constructor(eventBus, renderer) {
    this.eventBus = eventBus
    this.renderer = renderer
    this.panels = new Map()
    this.currentStep = null
    this.terrainTypePanel = new TerrainTypePanel(eventBus)
    this.districtClassPanel = new DistrictClassPanel(eventBus)
  }

  init() {
    this.createPanels()
    this.setupEventListeners()
  }

  createPanels() {
    const uiContainer = document.createElement('div')
    uiContainer.id = 'ui-container'
    uiContainer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10'
    document.body.appendChild(uiContainer)
    this.createTopBar(uiContainer)
    this.createLeftPanels(uiContainer)
    this.createCenterPanels(uiContainer)
    this.createErrorPopup(uiContainer)
  }

  createTopBar(container) {
    const topBar = document.createElement('div')
    topBar.id = 'top-bar'
    topBar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:80px;background:rgba(0,0,0,0.85);border-bottom:2px solid #444;color:#fff;font-family:Arial;z-index:20;pointer-events:auto;display:flex;align-items:stretch'

    const lifecycle = document.createElement('div')
    lifecycle.id = 'lifecycle-bar'
    lifecycle.style.cssText = 'flex:1;display:flex;align-items:stretch'
    topBar.appendChild(lifecycle)

    const newGameBtn = document.createElement('button')
    newGameBtn.textContent = 'New Game'
    newGameBtn.style.cssText = 'margin:10px;padding:8px 16px;background:#8b1a1a;color:#fff;border:1px solid #c44;border-radius:3px;cursor:pointer;font-size:13px;white-space:nowrap;align-self:center'
    newGameBtn.addEventListener('click', () => {
      if (confirm('Start a new game? All current terrain will be discarded.')) {
        this.eventBus.emit('NEW_GAME')
      }
    })
    topBar.appendChild(newGameBtn)

    container.appendChild(topBar)
  }

  createLeftPanels(container) {
    const leftPanel = document.createElement('div')
    leftPanel.id = 'left-panel'
    leftPanel.style.cssText = 'position:fixed;left:0;top:80px;width:200px;height:calc(100% - 80px);background:rgba(0,0,0,0.7);border-right:2px solid #444;padding:10px;color:#fff;z-index:20;pointer-events:auto'
    container.appendChild(leftPanel)
    this.panels.set('left', leftPanel)
  }

  createCenterPanels(container) {
    const centerPanel = document.createElement('div')
    centerPanel.id = 'center-panel'
    centerPanel.style.cssText = 'position:fixed;left:200px;right:0;top:80px;z-index:10'
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

    const btn = document.createElement('button')
    btn.id = 'error-ok-btn'
    btn.textContent = 'OK'
    btn.style.cssText = 'width:100%;padding:10px;background:#4a7c59;color:#fff;border:1px solid #666;border-radius:3px;cursor:pointer'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.hideError()
    })

    errorBox.appendChild(message)
    errorBox.appendChild(btn)
    errorPopup.appendChild(errorBox)
    container.appendChild(errorPopup)
  }

  showSetupPhase(step) {
    this.currentStep = step
    this._renderLifecycleBar(step)

    const leftPanel = this.panels.get('left')
    leftPanel.innerHTML = ''

    if (step === 'Terrain') {
      this.terrainTypePanel.render(leftPanel)
    } else if (step === 'CitySubdivision') {
      this.districtClassPanel.render(leftPanel)
    }
  }

  _renderLifecycleBar(activeStep) {
    const bar = document.getElementById('lifecycle-bar')
    if (!bar) return
    bar.innerHTML = ''

    const currentIndex = STEP_ORDER.indexOf(activeStep)

    STAGES.forEach((stage, i) => {
      const stageIndex = STEP_ORDER.indexOf(stage.step)
      const isActive = stage.step === activeStep
      const isComplete = stageIndex < currentIndex

      const cell = document.createElement('div')
      cell.style.cssText = `flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:6px 4px;border-right:1px solid #333;background:${isActive ? 'rgba(74,124,89,0.3)' : isComplete ? 'rgba(255,255,255,0.05)' : 'transparent'};${isActive ? 'border-bottom:2px solid #4a7c59;' : ''}`

      const name = document.createElement('div')
      name.textContent = (isComplete ? '✓ ' : '') + stage.label
      name.style.cssText = `font-size:12px;font-weight:${isActive ? 'bold' : 'normal'};color:${isActive ? '#fff' : isComplete ? '#777' : '#555'};text-align:center;margin-bottom:4px`
      cell.appendChild(name)

      if (isActive && stage.event) {
        const doneBtn = document.createElement('button')
        doneBtn.textContent = 'Done'
        doneBtn.style.cssText = 'padding:3px 14px;background:#4a7c59;color:#fff;border:1px solid #6a9c79;border-radius:3px;cursor:pointer;font-size:11px'
        doneBtn.addEventListener('click', () => this.eventBus.emit(stage.event))
        cell.appendChild(doneBtn)
      }

      bar.appendChild(cell)
    })
  }

  showError(message) {
    document.getElementById('error-message').textContent = message
    document.getElementById('error-popup').style.display = 'block'
    setTimeout(() => this.hideError(), 5000)
  }

  showSuccess(message) {
    document.getElementById('error-message').textContent = message
    document.getElementById('error-popup').style.display = 'block'
    setTimeout(() => this.hideError(), 3000)
  }

  hideError() {
    document.getElementById('error-popup').style.display = 'none'
  }

  setupEventListeners() {}
}
