import CompassRing from '../ui/CompassRing.js'

// Top-down / Iso mode compass — the persistent HUD widget shown bottom-centre (kept
// clear of the bottom-right action panel's Add God/Magic/Foreign Power + Advance Phase
// buttons, and of Minimap.js's own bottom-right spot in Walk Mode). Built on the same
// CompassRing used by ForeignPowerDialog's direction picker, so both compasses in the
// game share one visual.

const SIZE = 260   // matches ForeignPowerDialog's compass exactly (see CompassRing.js)
const RADIUS = 110

export default class Compass {
  constructor() {
    this._ring = new CompassRing({ size: SIZE, radius: RADIUS })

    this._el = document.createElement('div')
    // top/left:auto explicitly override index.html's global `canvas { top:0; left:0 }`
    // rule — see Minimap.js's matching comment (this uses an SVG, not canvas, but the
    // same override is needed here).
    this._el.style.cssText = `position:fixed;top:auto;bottom:20px;left:50%;transform:translateX(-50%);width:${SIZE}px;display:none;pointer-events:none;z-index:50;filter:drop-shadow(0 4px 16px rgba(0,0,0,0.6))`
    this._el.appendChild(this._ring.svgWrapper)
    document.body.appendChild(this._el)
  }

  show() { this._el.style.display = '' }
  hide() { this._el.style.display = 'none' }

  update(azimuth, topDown) {
    this._ring.update(azimuth, topDown)
  }
}
