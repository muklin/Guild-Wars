import nameLibrary from '../../shared/nameLibrary.js'

const COLOUR_SWATCHES = [
  { label: 'Red',    value: '#c0392b' },
  { label: 'Orange', value: '#d35400' },
  { label: 'Gold',   value: '#d4ac0d' },
  { label: 'Green',  value: '#1e8449' },
  { label: 'Teal',   value: '#148f77' },
  { label: 'Blue',   value: '#2471a3' },
  { label: 'Purple', value: '#7d3c98' },
  { label: 'Silver', value: '#aab7b8' },
]

function angleToLabel(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[Math.round(((deg + 360) % 360) / 45) % 8]
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function generateForeignPowerNames() {
  const g = nameLibrary.global
  const nouns = nameLibrary.foreignPowerNouns || ['Realm', 'Dominion', 'Reach', 'Lands']
  const used = []
  const pick  = arr => arr[Math.floor(Math.random() * arr.length)]
  const pickU = arr => { const p = arr.filter(x => !used.includes(x)); return p.length ? pick(p) : pick(arr) }
  const n1 = () => { const a = pick(g.adjectives); const n = pickU(nouns); used.push(a, n); return `${a} ${n}` }
  const n2 = () => { const n = pickU(nouns); const d = pick(g.dramaticNouns); used.push(n, d); return `${n} of ${d}` }
  const n3 = () => { const p = pick(g.properNames); const n = pickU(nouns); used.push(p, n); return `The ${p} ${n}` }
  const n4 = () => { const p = pick(g.properNames); used.push(p); return p }
  return [n1(), n2(), n3(), n4()]
}

// Two existing FP arcs overlap when their centers are within 45° of each other
// (each arc spans ±22.5°, so edge-to-edge gap becomes 0 at 45° separation).
function isOccupied(bearing, existingForeignPowers) {
  for (const fp of existingForeignPowers) {
    const diff = Math.abs(((bearing - fp.direction) + 360) % 360)
    if (Math.min(diff, 360 - diff) < 45) return true
  }
  return false
}

export default class ForeignPowerDialog {
  constructor({ existingForeignPowers = [], renderer = null, onApply, onCancel }) {
    this.existingForeignPowers = existingForeignPowers
    this._renderer = renderer
    this.onApply   = onApply
    this.onCancel  = onCancel
    this._el       = null
    this._chosenDirection = null
    this._chosenColour    = COLOUR_SWATCHES[0].value
    this._rafId           = null
    this._swatchRow       = null  // kept so colour change can repaint existing FP arcs
  }

  open() {
    if (this._el) return
    this._render()
  }

  close() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null }
    if (this._el)    { this._el.remove(); this._el = null }
  }

  // ── Shared layout helpers ─────────────────────────────────────────────────

  _overlay() {
    const overlay = document.createElement('div')
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.65)',
      'z-index:200', 'display:flex', 'align-items:center', 'justify-content:center',
      'pointer-events:auto',
    ].join(';')
    overlay.addEventListener('click',     e => e.stopPropagation())
    overlay.addEventListener('mousedown', e => e.stopPropagation())
    return overlay
  }

  _box() {
    const box = document.createElement('div')
    box.style.cssText = [
      'background:#1a1a1a', 'border:1px solid #555', 'border-radius:8px',
      'padding:20px 24px', 'width:380px', 'font-family:Arial', 'color:#fff',
      'box-shadow:0 8px 32px rgba(0,0,0,0.8)', 'max-height:90vh', 'overflow-y:auto',
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

  _sectionLabel(text) {
    const el = document.createElement('div')
    el.textContent = text
    el.style.cssText = 'font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px'
    return el
  }

  // ── Main single-page render ───────────────────────────────────────────────

  _render() {
    const overlay = this._overlay()
    const box     = this._box()
    box.appendChild(this._titleRow('Add Foreign Power'))

    const svgNS = 'http://www.w3.org/2000/svg'
    const R    = 110    // compass ring radius (SVG units)
    const SIZE = 260    // SVG element size (square, before CSS squish)

    // ── SVG ──────────────────────────────────────────────────────────────────
    const svg = document.createElementNS(svgNS, 'svg')
    svg.setAttribute('width',   SIZE)
    svg.setAttribute('height',  SIZE)
    svg.setAttribute('viewBox', `${-SIZE/2} ${-SIZE/2} ${SIZE} ${SIZE}`)
    svg.style.cssText = 'display:block;cursor:crosshair;transform-origin:top center'

    const svgWrapper = document.createElement('div')
    svgWrapper.style.cssText = `width:${SIZE}px;overflow:hidden;margin:0 auto 10px`
    svgWrapper.appendChild(svg)

    // Compass ring group (rotates with camera azimuth)
    const compassRing = document.createElementNS(svgNS, 'g')
    svg.appendChild(compassRing)

    const bg = document.createElementNS(svgNS, 'circle')
    bg.setAttribute('cx', '0'); bg.setAttribute('cy', '0'); bg.setAttribute('r', R)
    bg.setAttribute('fill', '#0e0e0e'); bg.setAttribute('stroke', '#444'); bg.setAttribute('stroke-width', '1.5')
    compassRing.appendChild(bg)

    const tickRing = document.createElementNS(svgNS, 'circle')
    tickRing.setAttribute('cx', '0'); tickRing.setAttribute('cy', '0'); tickRing.setAttribute('r', R - 16)
    tickRing.setAttribute('fill', 'none'); tickRing.setAttribute('stroke', '#2a2a2a'); tickRing.setAttribute('stroke-width', '1')
    compassRing.appendChild(tickRing)

    // Direction ticks + labels
    const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
    const dirTextEls = [], dirTextPos = []
    for (let i = 0; i < 8; i++) {
      const isCardinal = i % 2 === 0
      const rad = (i * 45 - 90) * Math.PI / 180
      const x2 = Math.cos(rad) * R, y2 = Math.sin(rad) * R
      const lx = Math.cos(rad) * (R - 8), ly = Math.sin(rad) * (R - 8)

      const line = document.createElementNS(svgNS, 'line')
      line.setAttribute('x1', '0'); line.setAttribute('y1', '0')
      line.setAttribute('x2', x2);  line.setAttribute('y2', y2)
      line.setAttribute('stroke', isCardinal ? '#444' : '#2a2a2a')
      line.setAttribute('stroke-width', isCardinal ? '0.75' : '0.5')
      compassRing.appendChild(line)

      const txt = document.createElementNS(svgNS, 'text')
      txt.setAttribute('x', '0'); txt.setAttribute('y', '0')
      txt.setAttribute('text-anchor', 'middle'); txt.setAttribute('dominant-baseline', 'middle')
      txt.setAttribute('fill', isCardinal ? '#aaa' : '#666')
      txt.setAttribute('font-size', isCardinal ? '13' : '9')
      txt.setAttribute('font-weight', isCardinal ? 'bold' : 'normal')
      txt.setAttribute('font-family', 'Arial')
      txt.setAttribute('transform', `translate(${lx},${ly})`)
      txt.textContent = DIRS[i]
      compassRing.appendChild(txt)
      dirTextEls.push(txt); dirTextPos.push([lx, ly])
    }

    // ── Existing FP arcs (drawn in their own colour, span ±22.5°) ────────────
    const existingArcEls = []
    for (const fp of this.existingForeignPowers) {
      const arcEl = document.createElementNS(svgNS, 'path')
      this._updateExistingArcPath(arcEl, fp, R)
      arcEl.setAttribute('stroke', 'none')
      const t = document.createElementNS(svgNS, 'title')
      t.textContent = fp.name
      arcEl.appendChild(t)
      compassRing.appendChild(arcEl)
      existingArcEls.push({ el: arcEl, fp })

      // Name label along the arc
      const dotRad = (fp.direction - 90) * Math.PI / 180
      const lbl = document.createElementNS(svgNS, 'text')
      lbl.setAttribute('x', '0'); lbl.setAttribute('y', '0')
      lbl.setAttribute('text-anchor', 'middle'); lbl.setAttribute('dominant-baseline', 'middle')
      lbl.setAttribute('fill', fp.colour || '#aaa')
      lbl.setAttribute('font-size', '8')
      lbl.setAttribute('font-family', 'Arial')
      lbl.setAttribute('transform', `translate(${Math.cos(dotRad) * (R - 8)},${Math.sin(dotRad) * (R - 8)})`)
      lbl.textContent = fp.name.length > 12 ? fp.name.slice(0, 11) + '…' : fp.name
      compassRing.appendChild(lbl)
    }

    // ── Rotating preview arc (needle + ±22.5° wedge in chosen colour) ────────
    const previewGroup = document.createElementNS(svgNS, 'g')
    previewGroup.style.display = 'none'
    compassRing.appendChild(previewGroup)

    const previewArc = document.createElementNS(svgNS, 'path')
    previewArc.setAttribute('stroke', 'none')
    previewGroup.appendChild(previewArc)

    const needlePath = document.createElementNS(svgNS, 'path')
    needlePath.setAttribute('d', 'M -2 8 L -2 -68 L -7 -68 L 0 -92 L 7 -68 L 2 -68 L 2 8 Z')
    previewGroup.appendChild(needlePath)

    const pivotDot = document.createElementNS(svgNS, 'circle')
    pivotDot.setAttribute('cx', '0'); pivotDot.setAttribute('cy', '0'); pivotDot.setAttribute('r', '4')
    previewGroup.appendChild(pivotDot)

    const updatePreviewColor = (colour, occupied) => {
      const fill = occupied ? '#c0392b' : colour
      needlePath.setAttribute('fill', fill)
      pivotDot.setAttribute('fill', fill)
      previewArc.setAttribute('fill', occupied ? 'rgba(192,57,43,0.3)' : hexToRgba(colour, 0.3))
    }

    const updatePreviewArc = (bearing) => {
      const halfSpan = 22.5
      const s = (bearing - halfSpan - 90) * Math.PI / 180
      const e = (bearing + halfSpan - 90) * Math.PI / 180
      const x1 = Math.cos(s) * R, y1 = Math.sin(s) * R
      const x2 = Math.cos(e) * R, y2 = Math.sin(e) * R
      previewArc.setAttribute('d', `M 0 0 L ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2} Z`)
    }

    // ── Direction label ───────────────────────────────────────────────────────
    const dirLabel = document.createElement('div')
    dirLabel.style.cssText = 'text-align:center;font-size:13px;color:#aaa;margin-bottom:10px;height:18px'

    // ── Colour swatches (before name, so colour change affects arc preview) ──
    box.appendChild(svgWrapper)
    box.appendChild(dirLabel)

    box.appendChild(this._sectionLabel('Colour'))
    const swatchRow = document.createElement('div')
    swatchRow.style.cssText = 'display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap'
    this._swatchRow = swatchRow
    COLOUR_SWATCHES.forEach(sw => {
      const swatch = document.createElement('div')
      swatch.title = sw.label
      swatch.style.cssText = `width:24px;height:24px;border-radius:4px;background:${sw.value};cursor:pointer;border:2px solid ${this._chosenColour === sw.value ? '#fff' : 'transparent'};box-sizing:border-box`
      swatch.addEventListener('click', () => {
        this._chosenColour = sw.value
        swatchRow.querySelectorAll('div').forEach((s, i) => {
          s.style.borderColor = COLOUR_SWATCHES[i].value === sw.value ? '#fff' : 'transparent'
        })
        if (this._chosenDirection !== null) {
          updatePreviewColor(this._chosenColour, false)
        }
      })
      swatchRow.appendChild(swatch)
    })
    box.appendChild(swatchRow)

    // ── Name suggestions + editable input ────────────────────────────────────
    box.appendChild(this._sectionLabel('Suggestions'))
    const nameInput = document.createElement('input')
    const suggestions = generateForeignPowerNames()
    const chipsRow = document.createElement('div')
    chipsRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-bottom:10px'
    suggestions.forEach(s => {
      const chip = document.createElement('button')
      chip.textContent = s
      chip.style.cssText = 'text-align:left;padding:5px 10px;background:#2a2a2a;border:1px solid #444;border-radius:4px;color:#ccc;font-size:12px;cursor:pointer;font-family:Arial'
      chip.addEventListener('mouseenter', () => { chip.style.background = '#333'; chip.style.borderColor = '#666' })
      chip.addEventListener('mouseleave', () => { chip.style.background = '#2a2a2a'; chip.style.borderColor = '#444' })
      chip.addEventListener('click', () => { nameInput.value = s; nameInput.focus() })
      chipsRow.appendChild(chip)
    })
    box.appendChild(chipsRow)

    box.appendChild(this._sectionLabel('Name'))
    nameInput.type = 'text'
    nameInput.placeholder = 'Choose a suggestion or type your own…'
    nameInput.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;background:#111;border:1px solid #555;border-radius:4px;color:#fff;font-size:13px;font-family:Arial;margin-bottom:8px;outline:none'
    nameInput.addEventListener('click',     e => e.stopPropagation())
    nameInput.addEventListener('mousedown', e => e.stopPropagation())
    box.appendChild(nameInput)

    const errorEl = document.createElement('div')
    errorEl.style.cssText = 'color:#f66;font-size:11px;margin-bottom:8px;min-height:14px'
    box.appendChild(errorEl)

    box.appendChild(this._sectionLabel('Description (optional)'))
    const descInput = document.createElement('textarea')
    descInput.placeholder = 'Describe this foreign power…'
    descInput.rows = 2
    descInput.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;background:#111;border:1px solid #555;border-radius:4px;color:#ccc;font-size:12px;font-family:Arial;resize:vertical;margin-bottom:14px;outline:none'
    descInput.addEventListener('click',     e => e.stopPropagation())
    descInput.addEventListener('mousedown', e => e.stopPropagation())
    box.appendChild(descInput)

    const applyBtn = document.createElement('button')
    applyBtn.textContent = 'Apply'
    applyBtn.disabled = true
    applyBtn.style.cssText = [
      'width:100%', 'padding:9px', 'background:#2471a3',
      'border:1px solid #4a9bdc', 'border-radius:6px', 'color:#fff',
      'font-size:13px', 'font-weight:bold', 'cursor:pointer', 'opacity:0.4'
    ].join(';')

    const updateApplyState = () => {
      const ready = this._chosenDirection !== null
      applyBtn.disabled = !ready
      applyBtn.style.opacity = ready ? '1' : '0.4'
    }

    applyBtn.addEventListener('click', () => {
      if (this._chosenDirection === null) return
      const name = nameInput.value.trim()
      if (!name || name.length < 2) { errorEl.textContent = 'Please enter a name (at least 2 characters).'; return }
      errorEl.textContent = ''
      this.close()
      this.onApply({ direction: this._chosenDirection, name, colour: this._chosenColour, description: descInput.value.trim() })
    })
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyBtn.click() })
    box.appendChild(applyBtn)

    // ── Live state for mouse events ───────────────────────────────────────────
    let ringRot = 0, squish = 0.5

    const getWorldBearing = (e) => {
      const rect = svg.getBoundingClientRect()
      const cx2   = rect.left + rect.width / 2
      const compassCY = rect.top + SIZE * squish / 2
      const vdx  = e.clientX - cx2
      const vdy  = e.clientY - compassCY
      const sdx  = vdx
      const sdy  = squish > 0 ? vdy / squish : vdy
      const screenAngle = (Math.atan2(sdy, sdx) * 180 / Math.PI + 90 + 360) % 360
      return (screenAngle - ringRot + 720) % 360
    }

    const showPreview = (bearing) => {
      const occupied = isOccupied(bearing, this.existingForeignPowers)
      previewGroup.style.display = ''
      previewGroup.setAttribute('transform', `rotate(${bearing})`)
      updatePreviewArc(0)   // arc drawn relative to needle (always centred at 0 before group rotation)
      updatePreviewColor(this._chosenColour, occupied)
      svg.style.cursor = occupied ? 'not-allowed' : 'crosshair'
      return occupied
    }

    svg.addEventListener('mousemove', (e) => {
      const bearing  = getWorldBearing(e)
      const occupied = showPreview(bearing)

      if (occupied) {
        const hovered = this.existingForeignPowers.find(fp => {
          const diff = Math.abs(((bearing - fp.direction) + 360) % 360)
          return Math.min(diff, 360 - diff) < 45
        })
        dirLabel.textContent = hovered ? `${hovered.name}  —  ${angleToLabel(hovered.direction)}` : `Occupied`
        dirLabel.style.color = hovered?.colour || '#c0392b'
      } else if (this._chosenDirection !== null) {
        dirLabel.textContent = `Direction: ${angleToLabel(this._chosenDirection)} (${Math.round(this._chosenDirection)}°)`
        dirLabel.style.color = this._chosenColour
      } else {
        dirLabel.textContent = `${angleToLabel(bearing)}  (${Math.round(bearing)}°)`
        dirLabel.style.color = '#aaa'
      }
    })

    svg.addEventListener('mouseleave', () => {
      if (this._chosenDirection !== null) {
        previewGroup.setAttribute('transform', `rotate(${this._chosenDirection})`)
        previewGroup.style.display = ''
        updatePreviewArc(0)
        updatePreviewColor(this._chosenColour, false)
        dirLabel.textContent = `Direction: ${angleToLabel(this._chosenDirection)} (${Math.round(this._chosenDirection)}°)`
        dirLabel.style.color = this._chosenColour
      } else {
        previewGroup.style.display = 'none'
        dirLabel.textContent = ''
      }
    })

    svg.addEventListener('click', (e) => {
      const bearing = getWorldBearing(e)
      if (isOccupied(bearing, this.existingForeignPowers)) return
      this._chosenDirection = bearing
      previewGroup.setAttribute('transform', `rotate(${bearing})`)
      updatePreviewColor(this._chosenColour, false)
      dirLabel.textContent = `Direction: ${angleToLabel(bearing)} (${Math.round(bearing)}°)`
      dirLabel.style.color = this._chosenColour
      updateApplyState()
    })

    // ── rAF: sync compass ring with camera ────────────────────────────────────
    const tick = () => {
      const cc = this._renderer?.cameraController
      if (cc) {
        squish  = cc._topDown ? 1.0 : 0.5
        // azimuth = π/2 is the standard N-at-top view, so subtract π/2 so that
        // ringRot = 0 (N at top) when the camera is in its default orientation.
        ringRot = 90 - (cc.azimuth * 180 / Math.PI)
      }
      svg.style.transform         = `scaleY(${squish})`
      svgWrapper.style.height     = `${Math.round(SIZE * squish)}px`
      compassRing.setAttribute('transform', `rotate(${ringRot})`)
      if (this._chosenDirection !== null) {
        previewGroup.setAttribute('transform', `rotate(${this._chosenDirection})`)
      }
      const invSquish = squish > 0 ? 1 / squish : 1
      dirTextEls.forEach((el, i) => {
        const [lx, ly] = dirTextPos[i]
        el.setAttribute('transform', `translate(${lx},${ly}) rotate(${-ringRot}) scale(1,${invSquish})`)
      })
      this._rafId = requestAnimationFrame(tick)
    }
    this._rafId = requestAnimationFrame(tick)

    overlay.appendChild(box)
    document.body.appendChild(overlay)
    this._el = overlay
  }

  // Build the SVG arc path for an existing FP (±22.5° arc at fp.direction)
  _updateExistingArcPath(el, fp, R) {
    const s = (fp.direction - 22.5 - 90) * Math.PI / 180
    const e = (fp.direction + 22.5 - 90) * Math.PI / 180
    const x1 = Math.cos(s) * R, y1 = Math.sin(s) * R
    const x2 = Math.cos(e) * R, y2 = Math.sin(e) * R
    el.setAttribute('d', `M 0 0 L ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2} Z`)
    el.setAttribute('fill', hexToRgba(fp.colour || '#888888', 0.35))
  }
}
