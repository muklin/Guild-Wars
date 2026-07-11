// Shared 8-point compass ring visual — originally built inline for ForeignPowerDialog's
// direction picker, extracted so the persistent Top-down/Iso HUD compass (WorldRenderer/
// rendering/Compass.js) can use the exact same look rather than a second hand-drawn
// version. Owns only the passive ring/ticks/labels + camera-sync rotation; callers that
// need interactive elements (arcs, a preview needle — see ForeignPowerDialog) append
// them into `.ring`, the rotating <g> group, using the same rotate(bearing) convention
// the ticks use (bearing in degrees, clockwise from north).
export default class CompassRing {
  // bgFill: 'none' lets a caller overlay the ring on top of its own background content
  // (see Minimap.js's Walk Mode compass, layered over the live map bitmap) instead of
  // the default opaque dark disc.
  // contrastBand: draws a semi-opaque dark annulus in the outer portion of the ring
  // (where the tick lines/labels live) so they stay legible over ANY background —
  // needed specifically alongside bgFill:'none', where the centre is fully transparent
  // and the label contrast otherwise depends entirely on whatever happens to be behind
  // it (confirmed live: N/E/S/NE/SE/NW unreadable against a bright patch of map).
  // contrastBandWidth: how far the band extends inward from the outer edge — pass the
  // exact margin between your own inner content circle and this ring's outer radius so
  // the band's inner edge butts up against it precisely, with no gap (confirmed live: a
  // mismatched default left an 8px unstyled seam between Minimap's map circle and the
  // band).
  // lineInnerRadius: tick lines normally run from the very centre (0) out to radius —
  // fine against an opaque bg, but with bgFill:'none' they'd cut straight across
  // whatever the caller is showing in the centre (confirmed live: lines drawn over the
  // Walk Mode Avatar marker). Set to the caller's own inner content radius to keep tick
  // lines confined to the outer band, matching contrastBandWidth's footprint.
  constructor({ size = 260, radius = 110, bgFill = '#0e0e0e', contrastBand = false, contrastBandWidth = 26, lineInnerRadius = 0 } = {}) {
    this.size = size
    this.radius = radius
    const svgNS = 'http://www.w3.org/2000/svg'

    const svg = document.createElementNS(svgNS, 'svg')
    svg.setAttribute('width', size)
    svg.setAttribute('height', size)
    svg.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`)
    svg.style.cssText = 'display:block;transform-origin:top center'
    this.svg = svg

    this.svgWrapper = document.createElement('div')
    this.svgWrapper.style.cssText = `width:${size}px;overflow:hidden`
    this.svgWrapper.appendChild(svg)

    // Rotating group — background, ticks, and labels all live here so a single
    // rotate() transform (see update()) reorients the whole ring at once.
    this.ring = document.createElementNS(svgNS, 'g')
    svg.appendChild(this.ring)

    const bg = document.createElementNS(svgNS, 'circle')
    bg.setAttribute('cx', '0'); bg.setAttribute('cy', '0'); bg.setAttribute('r', radius)
    bg.setAttribute('fill', bgFill); bg.setAttribute('stroke', '#444'); bg.setAttribute('stroke-width', '1.5')
    this.ring.appendChild(bg)

    if (contrastBand) {
      // A stroked (not filled) circle draws a band centred ON the given radius — offset
      // the radius inward by half the stroke width so the band's OUTER edge lands
      // exactly on the ring's own outer edge, matching bg's border.
      const band = document.createElementNS(svgNS, 'circle')
      band.setAttribute('cx', '0'); band.setAttribute('cy', '0')
      band.setAttribute('r', radius - contrastBandWidth / 2)
      band.setAttribute('fill', 'none')
      band.setAttribute('stroke', 'rgba(0,0,0,0.55)')
      band.setAttribute('stroke-width', String(contrastBandWidth))
      this.ring.appendChild(band)
    }

    const tickRing = document.createElementNS(svgNS, 'circle')
    tickRing.setAttribute('cx', '0'); tickRing.setAttribute('cy', '0'); tickRing.setAttribute('r', radius - 16)
    tickRing.setAttribute('fill', 'none'); tickRing.setAttribute('stroke', '#2a2a2a'); tickRing.setAttribute('stroke-width', '1')
    this.ring.appendChild(tickRing)

    const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
    this._dirTextEls = []
    this._dirTextPos = []
    for (let i = 0; i < 8; i++) {
      const isCardinal = i % 2 === 0
      const rad = (i * 45 - 90) * Math.PI / 180
      const x1 = Math.cos(rad) * lineInnerRadius, y1 = Math.sin(rad) * lineInnerRadius
      const x2 = Math.cos(rad) * radius, y2 = Math.sin(rad) * radius
      const lx = Math.cos(rad) * (radius - 8), ly = Math.sin(rad) * (radius - 8)

      const line = document.createElementNS(svgNS, 'line')
      line.setAttribute('x1', x1);  line.setAttribute('y1', y1)
      line.setAttribute('x2', x2);  line.setAttribute('y2', y2)
      line.setAttribute('stroke', isCardinal ? '#444' : '#2a2a2a')
      line.setAttribute('stroke-width', isCardinal ? '0.75' : '0.5')
      this.ring.appendChild(line)

      const txt = document.createElementNS(svgNS, 'text')
      txt.setAttribute('x', '0'); txt.setAttribute('y', '0')
      txt.setAttribute('text-anchor', 'middle'); txt.setAttribute('dominant-baseline', 'middle')
      txt.setAttribute('fill', isCardinal ? '#aaa' : '#666')
      txt.setAttribute('font-size', isCardinal ? '13' : '9')
      txt.setAttribute('font-weight', isCardinal ? 'bold' : 'normal')
      txt.setAttribute('font-family', 'Arial')
      txt.setAttribute('transform', `translate(${lx},${ly})`)
      txt.textContent = DIRS[i]
      this.ring.appendChild(txt)
      this._dirTextEls.push(txt)
      this._dirTextPos.push([lx, ly])
    }

    this.ringRot = 0
    this.squish = 0.5
  }

  // azimuthRadians: CameraController.azimuth. topDown: CameraController._topDown (the
  // ring lies flat, squish=1, in top-down; tilted 0.5 in the normal angled iso view —
  // matching the camera's own elevation change).
  update(azimuthRadians, topDown) {
    this.squish = topDown ? 1.0 : 0.5
    // azimuth = PI/2 is the standard N-at-top view (see CameraController.centerOnMap's
    // doc comment), so subtract 90° such that ringRot = 0 (N at top) there.
    this.ringRot = 90 - (azimuthRadians * 180 / Math.PI)
    this.svg.style.transform = `scaleY(${this.squish})`
    this.svgWrapper.style.height = `${Math.round(this.size * this.squish)}px`
    this.ring.setAttribute('transform', `rotate(${this.ringRot})`)
    const invSquish = this.squish > 0 ? 1 / this.squish : 1
    this._dirTextEls.forEach((el, i) => {
      const [lx, ly] = this._dirTextPos[i]
      el.setAttribute('transform', `translate(${lx},${ly}) rotate(${-this.ringRot}) scale(1,${invSquish})`)
    })
  }
}
