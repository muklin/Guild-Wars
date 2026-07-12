// Shared drag-by-handle behavior for floating UI panels. Extracted from the
// independently-duplicated (and correct) implementations in UIManager.js's help
// window and GuildPanel.js — same drag-then-click pass-through fix (see
// CONTEXT.md's "UI Rules"): the browser synthesises a click event at the release
// position after a drag, which would otherwise reach through to the 3-D map
// underneath and clear whatever selection/hover state is currently active.
//
// el: the panel element to move (mutates .style.left/.style.top — the panel must
// already be position:fixed or position:absolute).
// handle: the element that starts a drag on mousedown (usually a title bar).
// onDragEnd(el): optional, called once after a real drag completes (e.g. to persist
// the new position) — never called for a plain click (no movement).
export function makeDraggable(el, handle, { onDragEnd } = {}) {
  let startX, startY, startLeft, startTop
  handle.style.cursor = 'move'
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return   // left-click drag only — don't hijack right-click/middle-click
    e.preventDefault()
    e.stopPropagation()
    const rect = el.getBoundingClientRect()
    startX = e.clientX; startY = e.clientY
    startLeft = rect.left; startTop = rect.top
    let didDrag = false

    const onMove = (e) => {
      didDrag = true
      el.style.left = (startLeft + (e.clientX - startX)) + 'px'
      el.style.top = (startTop + (e.clientY - startY)) + 'px'
      el.style.right = 'auto'
      el.style.bottom = 'auto'
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (didDrag) {
        onDragEnd?.(el)
        // Suppress the click event the browser synthesises after a drag release —
        // without this it falls through to whatever's under the cursor (the 3-D map,
        // most often), clearing the current selection/hover.
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
