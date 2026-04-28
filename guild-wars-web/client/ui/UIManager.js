import TerrainTypePanel from './TerrainTypePanel.js'

export default class UIManager {
  constructor(eventBus, renderer) {
    this.eventBus = eventBus
    this.renderer = renderer
    this.panels = new Map()
    this.currentStep = null
    this.terrainTypePanel = new TerrainTypePanel(eventBus)
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
    this.createRightPanels(uiContainer)
    this.createCenterPanels(uiContainer)
    this.createErrorPopup(uiContainer)
  }

  createTopBar(container) {
    const topBar = document.createElement('div')
    topBar.id = 'top-bar'
    topBar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:120px;background:rgba(0,0,0,0.8);border-bottom:2px solid #444;padding:10px;color:#fff;font-family:Arial;z-index:20;pointer-events:auto'
    topBar.innerHTML = '<div>Setup Phase</div>'
    container.appendChild(topBar)
  }

  createLeftPanels(container) {
    const leftPanel = document.createElement('div')
    leftPanel.id = 'left-panel'
    leftPanel.style.cssText = 'position:fixed;left:0;top:120px;width:200px;height:calc(100% - 120px);background:rgba(0,0,0,0.7);border-right:2px solid #444;padding:10px;color:#fff;z-index:20;pointer-events:auto'
    container.appendChild(leftPanel)
    this.panels.set('left', leftPanel)
  }

  createRightPanels(container) {
    const rightPanel = document.createElement('div')
    rightPanel.id = 'right-panel'
    rightPanel.style.cssText = 'position:fixed;right:0;top:120px;width:400px;height:calc(100% - 120px);background:rgba(0,0,0,0.7);border-left:2px solid #444;padding:10px;color:#fff;z-index:20;pointer-events:auto'
    container.appendChild(rightPanel)
    this.panels.set('right', rightPanel)
  }

  createCenterPanels(container) {
    const centerPanel = document.createElement('div')
    centerPanel.id = 'center-panel'
    centerPanel.style.cssText = 'position:fixed;left:200px;right:400px;top:120px;z-index:10'
    container.appendChild(centerPanel)
    this.panels.set('center', centerPanel)
  }

  createErrorPopup(container) {
    const errorPopup = document.createElement('div')
    errorPopup.id = 'error-popup'
    errorPopup.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:none;z-index:30'
    const errorBox = document.createElement('div')
    errorBox.style.cssText = 'position:absolute;left:30%;right:30%;top:47%;transform:translateY(-50%);width:40%'
    errorBox.innerHTML = '<div id="error-message" style="text-align:center;padding:20px"></div><button id="error-ok-btn" style="width:100%">OK</button>'
    errorPopup.appendChild(errorBox)
    container.appendChild(errorPopup)
    document.getElementById('error-ok-btn').addEventListener('click', () => this.hideError())
  }

  showSetupPhase(step) {
    this.currentStep = step
    const leftPanel = this.panels.get('left')
    const rightPanel = this.panels.get('right')

    if (step === 'Terrain') {
      this.terrainTypePanel.render(leftPanel)
      rightPanel.innerHTML = '<h2>Terrain Setup</h2><p>Click a region to select it, then choose a terrain type.</p>'
    } else if (step === 'CitySubdivision') {
      leftPanel.innerHTML = ''
      rightPanel.innerHTML = '<h2>City Districts</h2><p>Click to assign district classes.</p>'
    } else {
      rightPanel.innerHTML = '<h2>Setup</h2>'
    }
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
