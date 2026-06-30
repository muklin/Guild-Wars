const POS_KEY = 'gw.rulesWindow.pos'

function loadPos() {
  try { return JSON.parse(localStorage.getItem(POS_KEY)) } catch { return null }
}
function savePos(x, y) {
  try { localStorage.setItem(POS_KEY, JSON.stringify({ x, y })) } catch { /* ignore */ }
}

export default class RulesWindow {
  constructor() {
    this._el = null
    this._build()
  }

  _build() {
    const el = document.createElement('div')
    el.style.cssText = [
      'position:fixed', 'z-index:70', 'width:880px', 'height:82vh',
      'min-width:360px', 'min-height:300px',
      'background:#fff', 'border:2px solid #555', 'border-radius:8px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.8)', 'display:none',
      'flex-direction:column', 'pointer-events:auto', 'user-select:none', 'overflow:hidden'
    ].join(';')
    el.addEventListener('click',     (e) => e.stopPropagation())
    el.addEventListener('mousedown', (e) => e.stopPropagation())
    document.body.appendChild(el)
    this._el = el

    // Title bar (drag handle)
    const titleBar = document.createElement('div')
    titleBar.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:8px 14px', 'background:#2a2a2a', 'border-bottom:1px solid #444',
      'border-radius:6px 6px 0 0', 'cursor:move', 'flex-shrink:0'
    ].join(';')

    const titleText = document.createElement('span')
    titleText.textContent = 'Game Rules'
    titleText.style.cssText = 'font-family:Arial;font-size:13px;font-weight:bold;color:#fff;pointer-events:none'

    const closeBtn = document.createElement('button')
    closeBtn.textContent = '×'
    closeBtn.style.cssText = 'background:none;border:none;color:#aaa;font-size:22px;cursor:pointer;padding:0;line-height:1'
    closeBtn.addEventListener('click', () => this.hide())

    titleBar.appendChild(titleText)
    titleBar.appendChild(closeBtn)
    el.appendChild(titleBar)

    // iframe
    const frame = document.createElement('iframe')
    frame.src = '/game-rules/Rules.html'
    frame.style.cssText = 'width:100%;flex:1;border:none;background:#fff;display:block'
    frame.title = 'Game Rules'
    el.appendChild(frame)

    this._makeDraggable(titleBar)
    this._applyPosition()
  }

  _applyPosition() {
    const saved = loadPos()
    const el = this._el
    if (saved) {
      el.style.left = saved.x + 'px'
      el.style.top  = saved.y + 'px'
    } else {
      el.style.left = Math.max(0, Math.round((window.innerWidth  - 880) / 2)) + 'px'
      el.style.top  = Math.max(0, Math.round((window.innerHeight - window.innerHeight * 0.82) / 2)) + 'px'
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
        this._el.style.left = (startLeft + (e.clientX - startX)) + 'px'
        this._el.style.top  = (startTop  + (e.clientY - startY)) + 'px'
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup',   onUp)
        if (didDrag) {
          savePos(parseInt(this._el.style.left), parseInt(this._el.style.top))
          const suppressClick = (ev) => {
            ev.stopPropagation()
            document.removeEventListener('click', suppressClick, true)
          }
          document.addEventListener('click', suppressClick, true)
        }
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup',   onUp)
    })
  }

  show() {
    this._applyPosition()
    this._el.style.display = 'flex'
  }

  hide() {
    this._el.style.display = 'none'
  }

  toggle() {
    if (this._el.style.display === 'none' || !this._el.style.display) {
      this.show()
    } else {
      this.hide()
    }
  }
}
