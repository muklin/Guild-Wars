import Settings from '../settings.js'
import { bringToFront, remove } from './ViewStack.js'

export default class SystemWindow {
  constructor(eventBus, getPlayerName) {
    this.eventBus = eventBus
    this.getPlayerName = getPlayerName
    this._el = null
    this._backdrop = null
    this._settingsVisible = false
    this._settingsEl = null
    this._view = null
    this._build()
  }

  _build() {
    // Semi-transparent white backdrop that blocks map interaction
    const backdrop = document.createElement('div')
    backdrop.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(255,255,255,0.5);z-index:90;display:none'
    backdrop.addEventListener('click', (e) => e.stopPropagation())
    backdrop.addEventListener('mousedown', (e) => e.stopPropagation())
    document.body.appendChild(backdrop)
    this._backdrop = backdrop

    // Window panel
    const el = document.createElement('div')
    el.style.cssText = [
      'position:fixed', 'z-index:91',
      'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'width:340px', 'background:#1e1e1e', 'border:1px solid #555',
      'border-radius:8px', 'color:#ddd', 'font-family:Arial',
      'box-shadow:0 8px 32px rgba(0,0,0,0.8)', 'display:none', 'pointer-events:auto'
    ].join(';')
    el.addEventListener('click', (e) => e.stopPropagation())
    el.addEventListener('mousedown', (e) => { e.stopPropagation(); this._bringToFront() })
    document.body.appendChild(el)
    this._el = el

    this._view = { el, close: () => this.hide() }
    this._render()
  }

  _render() {
    const el = this._el
    el.innerHTML = ''

    // Title bar
    const titleBar = document.createElement('div')
    titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#2a2a2a;border-bottom:1px solid #444;border-radius:8px 8px 0 0'
    const title = document.createElement('span')
    title.textContent = 'Menu'
    title.style.cssText = 'font-weight:bold;font-size:14px;color:#fff'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '×'
    closeBtn.style.cssText = 'background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;padding:0;line-height:1'
    closeBtn.addEventListener('click', () => this.hide())
    titleBar.appendChild(title)
    titleBar.appendChild(closeBtn)
    el.appendChild(titleBar)

    const body = document.createElement('div')
    body.style.cssText = 'padding:20px'

    // Player name
    const nameRow = document.createElement('div')
    nameRow.style.cssText = 'margin-bottom:20px;font-size:13px;color:#aaa'
    const nameLabel = document.createElement('span')
    nameLabel.textContent = 'Player: '
    const nameValue = document.createElement('span')
    nameValue.textContent = this.getPlayerName() || '—'
    nameValue.style.cssText = 'color:#fff;font-weight:bold'
    nameRow.appendChild(nameLabel)
    nameRow.appendChild(nameValue)
    body.appendChild(nameRow)

    // Buttons
    const btnStyle = 'display:block;width:100%;padding:10px;margin-bottom:10px;background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;cursor:pointer;font-size:13px;text-align:left'

    const newGameBtn = document.createElement('button')
    newGameBtn.textContent = 'New Game'
    newGameBtn.style.cssText = btnStyle + ';color:#e55;border-color:#633'
    newGameBtn.addEventListener('click', () => {
      if (confirm('Start a new game? All current progress will be discarded.')) {
        this.hide()
        this.eventBus.emit('NEW_GAME')
      }
    })
    body.appendChild(newGameBtn)

    const settingsBtn = document.createElement('button')
    settingsBtn.textContent = this._settingsVisible ? '▾ Settings' : '▸ Settings'
    settingsBtn.style.cssText = btnStyle
    settingsBtn.addEventListener('click', () => {
      this._settingsVisible = !this._settingsVisible
      this._render()
    })
    body.appendChild(settingsBtn)

    // Settings panel (inline, toggled)
    if (this._settingsVisible) {
      const settingsPanel = document.createElement('div')
      settingsPanel.style.cssText = 'background:#141414;border:1px solid #333;border-radius:4px;padding:12px;margin-bottom:10px'

      const tutRow = document.createElement('label')
      tutRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;color:#ccc;cursor:pointer'
      const tutCheck = document.createElement('input')
      tutCheck.type = 'checkbox'
      tutCheck.checked = Settings.showTutorials
      tutCheck.style.cursor = 'pointer'
      tutCheck.addEventListener('change', () => { Settings.showTutorials = tutCheck.checked })
      tutRow.appendChild(tutCheck)
      tutRow.appendChild(document.createTextNode('Show tutorials'))
      settingsPanel.appendChild(tutRow)
      body.appendChild(settingsPanel)
    }

    el.appendChild(body)
  }

  _bringToFront() {
    bringToFront(this._view)
    this._backdrop.style.zIndex = '90'
    this._el.style.zIndex = '91'
  }

  show() {
    this._render()
    this._backdrop.style.display = 'block'
    this._el.style.display = 'block'
    bringToFront(this._view)
    // bringToFront overwrites z-index with a low counter value — restore
    // ours so the panel sits above the backdrop and all other UI.
    this._backdrop.style.zIndex = '90'
    this._el.style.zIndex = '91'
  }

  hide() {
    this._backdrop.style.display = 'none'
    this._el.style.display = 'none'
    remove(this._view)
  }

  isVisible() {
    return this._el.style.display !== 'none'
  }
}
