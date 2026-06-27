import Settings from '../settings.js'

const POS_KEY = 'gw.tutorialWindow.pos'

function loadPos() {
  try { return JSON.parse(localStorage.getItem(POS_KEY)) } catch { return null }
}
function savePos(x, y) {
  try { localStorage.setItem(POS_KEY, JSON.stringify({ x, y })) } catch { /* ignore */ }
}

export default class TutorialWindow {
  constructor() {
    this._el = null
    this._build()
  }

  _build() {
    const el = document.createElement('div')
    el.id = 'tutorial-window'
    el.style.cssText = [
      'position:fixed', 'z-index:60', 'width:320px',
      'background:#1a1a1a', 'border:1px solid #555', 'border-radius:6px',
      'color:#ddd', 'font-family:Arial', 'font-size:13px', 'line-height:1.5',
      'box-shadow:0 4px 16px rgba(0,0,0,0.6)', 'display:none', 'pointer-events:auto',
      'user-select:none'
    ].join(';')

    // Title bar (drag handle)
    const titleBar = document.createElement('div')
    titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#2a2a2a;border-bottom:1px solid #444;border-radius:6px 6px 0 0;cursor:move'
    const title = document.createElement('span')
    title.textContent = 'Tutorial Information'
    title.style.cssText = 'font-weight:bold;font-size:12px;color:#aaa;text-transform:uppercase;letter-spacing:1px'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '×'
    closeBtn.style.cssText = 'background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;padding:0;line-height:1'
    closeBtn.addEventListener('click', () => this.hide())
    titleBar.appendChild(title)
    titleBar.appendChild(closeBtn)
    el.appendChild(titleBar)

    // Body
    const body = document.createElement('div')
    body.style.cssText = 'padding:12px 14px'
    this._messageEl = document.createElement('p')
    this._messageEl.style.cssText = 'margin:0 0 14px 0;line-height:1.5'
    body.appendChild(this._messageEl)

    // Close button
    const dismissBtn = document.createElement('button')
    dismissBtn.textContent = 'Close'
    dismissBtn.style.cssText = 'display:block;width:100%;padding:8px;background:#3a3a3a;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;font-size:13px;margin-bottom:8px'
    dismissBtn.addEventListener('click', () => this.hide())
    body.appendChild(dismissBtn)

    // Disable tutorials checkbox
    const checkLabel = document.createElement('label')
    checkLabel.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:#888;cursor:pointer;padding:4px 0'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.style.cssText = 'cursor:pointer;width:14px;height:14px'
    checkbox.addEventListener('change', () => {
      Settings.showTutorials = !checkbox.checked
    })
    checkLabel.appendChild(checkbox)
    checkLabel.appendChild(document.createTextNode("Don't show tutorial information"))
    this._checkbox = checkbox
    body.appendChild(checkLabel)

    el.appendChild(body)

    // Block map interactions — stop propagation at the window boundary.
    el.addEventListener('click',     (e) => e.stopPropagation())
    el.addEventListener('mousedown', (e) => e.stopPropagation())

    document.body.appendChild(el)
    this._el = el
    this._makeDraggable(titleBar)
    this._applyPosition()
  }

  _applyPosition() {
    const saved = loadPos()
    if (saved) {
      this._el.style.left = saved.x + 'px'
      this._el.style.top  = saved.y + 'px'
    } else {
      // Default: center of screen
      this._el.style.left = Math.round((window.innerWidth - 320) / 2) + 'px'
      this._el.style.top  = Math.round(window.innerHeight / 3) + 'px'
    }
  }

  _makeDraggable(handle) {
    let startX, startY, startLeft, startTop
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = this._el.getBoundingClientRect()
      startX = e.clientX; startY = e.clientY
      startLeft = rect.left; startTop = rect.top
      let didDrag = false
      const onMove = (e) => {
        didDrag = true
        const x = startLeft + (e.clientX - startX)
        const y = startTop  + (e.clientY - startY)
        this._el.style.left = x + 'px'
        this._el.style.top  = y + 'px'
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        if (didDrag) {
          savePos(parseInt(this._el.style.left), parseInt(this._el.style.top))
          // Suppress the click the browser synthesises after a drag release.
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

  // Show with the given text if tutorials are enabled.
  show(text) {
    if (!Settings.showTutorials) return
    this._messageEl.textContent = text
    this._checkbox.checked = false
    this._el.style.display = 'block'
  }

  hide() {
    this._el.style.display = 'none'
  }
}
