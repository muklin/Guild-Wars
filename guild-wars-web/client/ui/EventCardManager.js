const MAX_CARDS = 5
const DURATION_MS = 30000
const DEDUP_WINDOW_MS = 3000

function _injectStyles() {
  if (document.getElementById('gw-event-card-style')) return
  const style = document.createElement('style')
  style.id = 'gw-event-card-style'
  style.textContent = `
    @keyframes gwPillDrain {
      from { width: 100% }
      to   { width: 0% }
    }
    /* Card sweeps up from near the bottom of the viewport to its resting position
       at the top-right stack. translateY is relative to the card's final position,
       so a large positive value means "start far below". */
    @keyframes gwCardSweepUp {
      0%   { opacity: 0; transform: translateY(88vh); }
      18%  { opacity: 1; }
      100% { opacity: 1; transform: translateY(0); }
    }
  `
  document.head.appendChild(style)
}

// Right-side Event Card stack, anchored to the top-right of the viewport.
// New cards are prepended (appear at top) and sweep in from the bottom of the
// screen. Vetoable events have a red border and a hover VETO button — except for
// cards belonging to the local player (who cannot veto their own actions).
export default class EventCardManager {
  constructor() {
    this._container = null
    this._cards = []
    this._seenIds = new Map()   // eventId → timestamp, for duplicate-broadcast dedup
  }

  mount() {
    _injectStyles()
    const el = document.createElement('div')
    el.id = 'event-card-stack'
    // Anchored top-right, just below the resource bar. Cards stack downward;
    // newest card is always prepended so it sits at the top.
    el.style.cssText = [
      'position:fixed', 'top:40px', 'right:16px',
      'width:280px', 'z-index:30',
      'display:flex', 'flex-direction:column', 'gap:8px',
      'pointer-events:none', 'font-family:Arial,sans-serif'
    ].join(';')
    document.body.appendChild(el)
    this._container = el
  }

  // event: { id?, seatId, seatName, entityType, entityName, vetoable }
  // mySeatId: local player's seat id (null = unknown / solo with no other players)
  show(event, mySeatId) {
    if (!this._container || !event) return

    // Deduplicate — two WebSocket connections can briefly both deliver the same broadcast.
    if (event.id != null) {
      const now = Date.now()
      for (const [id, ts] of this._seenIds) if (now - ts > DEDUP_WINDOW_MS) this._seenIds.delete(id)
      if (this._seenIds.has(event.id)) return
      this._seenIds.set(event.id, now)
    }

    // Trim oldest (bottom of stack) if full.
    if (this._cards.length >= MAX_CARDS) {
      const oldest = this._cards.pop()
      oldest?.remove()
    }

    const isOwnAction = mySeatId != null && String(event.seatId) === String(mySeatId)
    // Red border only when someone else made a vetoable declaration.
    const borderColor = (event.vetoable && !isOwnAction) ? '#b91c1c' : '#555'

    // ── Card ──
    const card = document.createElement('div')
    card.style.cssText = [
      'position:relative', 'width:100%', 'box-sizing:border-box',
      `border:1px solid ${borderColor}`, 'border-radius:6px',
      'background:#1a1a1a', 'padding:10px 12px 8px',
      'color:#e0d8cc', 'font-size:12px', 'line-height:1.4',
      'pointer-events:auto',
      'animation:gwCardSweepUp 0.7s cubic-bezier(0.22,1,0.36,1) forwards',
      'overflow:hidden'
    ].join(';')

    // ── Text ──
    const text = document.createElement('div')
    text.style.cssText = 'margin-bottom:8px'
    const name  = this._esc(event.seatName  || 'Unknown')
    const type  = this._esc(event.entityType || '')
    const label = this._esc(event.entityName || '')
    text.innerHTML = `<strong style="color:#d4c49a">${name}</strong>: declared a new <em>${type}</em> named <strong>${label}</strong>`
    card.appendChild(text)

    // ── Timer pill ──
    const pillTrack = document.createElement('div')
    pillTrack.style.cssText = 'height:6px;border-radius:3px;background:#222;overflow:hidden'
    const pill = document.createElement('div')
    pill.style.cssText = [
      'height:100%', 'border-radius:3px',
      'background:linear-gradient(to right,#4ade80,#16a34a)',
      `animation:gwPillDrain ${DURATION_MS}ms linear forwards`
    ].join(';')
    pillTrack.appendChild(pill)
    card.appendChild(pillTrack)

    // ── VETO overlay (other players' vetoable events only) ──
    if (event.vetoable && !isOwnAction) {
      const overlay = document.createElement('div')
      overlay.style.cssText = [
        'position:absolute', 'inset:0',
        'display:flex', 'align-items:center', 'justify-content:center',
        'opacity:0', 'transition:opacity 0.15s', 'pointer-events:auto',
        'background:rgba(10,10,10,0.55)', 'border-radius:5px'
      ].join(';')

      const btn = document.createElement('button')
      btn.textContent = 'VETO'
      btn.style.cssText = [
        'width:72px', 'height:72px', 'border-radius:50%',
        'background:rgba(180,20,20,0.92)', 'border:2px solid #ef4444',
        'color:#fff', 'font-size:13px', 'font-weight:bold',
        'cursor:pointer', 'letter-spacing:1px'
      ].join(';')
      btn.addEventListener('click', () => { /* veto mechanic: wired later */ })

      overlay.appendChild(btn)
      card.appendChild(overlay)

      card.addEventListener('mouseenter', () => { overlay.style.opacity = '1' })
      card.addEventListener('mouseleave', () => { overlay.style.opacity = '0' })
    }

    // ── Auto-dismiss after timer: fade out, then collapse height ──
    pill.addEventListener('animationend', () => {
      card.style.transition = 'opacity 0.35s ease-out'
      card.style.opacity = '0'
      setTimeout(() => {
        const h = card.offsetHeight
        card.style.transition = 'max-height 0.25s ease-in, margin-bottom 0.25s ease-in, padding-top 0.25s ease-in, padding-bottom 0.25s ease-in'
        card.style.overflow = 'hidden'
        card.style.maxHeight = h + 'px'
        card.offsetHeight   // force reflow
        card.style.maxHeight = '0'
        card.style.marginBottom = '0'
        card.style.paddingTop = '0'
        card.style.paddingBottom = '0'
        setTimeout(() => {
          card.remove()
          const idx = this._cards.indexOf(card)
          if (idx !== -1) this._cards.splice(idx, 1)
        }, 280)
      }, 370)
    }, { once: true })

    // Prepend so the newest card is always at the top of the stack.
    this._container.insertBefore(card, this._container.firstChild)
    this._cards.unshift(card)
  }

  _esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  }
}
