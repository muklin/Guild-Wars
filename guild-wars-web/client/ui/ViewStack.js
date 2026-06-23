// A z-order stack of dialogue windows (CharacterSheet, GuildPanel, …). A window
// registers itself with bringToFront() once when it opens, and again on every
// click/drag-start, so it reorders to the top both visually (z-index) and logically (for
// the Esc handler below). Esc closes whichever window is currently on top of the stack.
//
// A "view" is any { el: HTMLElement, close: () => void } — `close` should make the
// window go away (hide it, or remove it from the DOM) AND call remove(view) itself so the
// stack stays accurate regardless of how the window was closed (Esc, a × button, …).

const BASE_Z = 50
let zCounter = BASE_Z
const stack = []   // bottom → top

function applyZ(el) { el.style.zIndex = ++zCounter }

// Move `view` to the top of the stack (registering it if new) and bump its z-index.
// Call when a dialogue opens, and again on every click/drag-start.
export function bringToFront(view) {
  const i = stack.indexOf(view)
  if (i !== -1) stack.splice(i, 1)
  stack.push(view)
  applyZ(view.el)
}

// Remove `view` from the stack. Call from within a window's own close logic so Esc never
// tries to close an already-closed window.
export function remove(view) {
  const i = stack.indexOf(view)
  if (i !== -1) stack.splice(i, 1)
}

// Close whichever window is currently on top. Returns true if something was closed.
function closeTop() {
  const view = stack[stack.length - 1]
  if (!view) return false
  view.close()
  return true
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (closeTop()) e.preventDefault()
})
