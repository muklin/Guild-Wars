// Shared "connected resource/service value stream" graph: builds a Commodity dependency
// DAG from resourceDefinitions (ingredients + specialInput edges) and renders it as an SVG.
// Used by GuildPanel's Resource Flow tab (world-wide, fog-of-war by Standing) and by the
// New Resource dialog during District Setup (a live preview of the resource being drafted).

const TYPE_COLORS = { Raw: '#6a9c40', Resource: '#4aa0d8', Service: '#b080e0', Implicit: '#888' }

// Builds { nodes, edges } for every Commodity reachable (via Recipe ingredients/specialInput)
// from `roots` (an array of resource names). `producersByCommodity` is an optional
// Map<lowercaseName, { producers: Set<string>, known: boolean }> — annotates each node with
// who produces it and whether that's currently visible (Standing fog-of-war); omit it for a
// plain recipe-structure preview (e.g. the New Resource dialog's live graph).
export function buildCommodityGraph(resourceDefinitions, roots, producersByCommodity = new Map()) {
  const nodes = new Map()
  const edges = []

  const ensureNode = (rawName) => {
    const key = rawName.trim().toLowerCase()
    if (nodes.has(key)) return nodes.get(key)
    const def = resourceDefinitions?.[key]
    const producerEntry = producersByCommodity.get(key)
    const node = {
      key,
      name: rawName.trim(),
      type: def?.type || (['labour', 'gold'].includes(key) ? 'Implicit' : 'Resource'),
      producers: producerEntry ? [...producerEntry.producers] : [],
      known: producerEntry ? producerEntry.known : true
    }
    nodes.set(key, node)
    return node
  }

  // `seen` guards against infinite recursion on a corrupted/legacy circular recipe —
  // normal play can never create one (server-side cycle detection), so this is a fallback.
  const visit = (rawName, seen) => {
    const node = ensureNode(rawName)
    if (seen.has(node.key)) return node
    seen.add(node.key)
    const def = resourceDefinitions?.[node.key]
    if (def) {
      const deps = def.type === 'Raw' ? ['Labour', 'Security'] : [...(def.ingredients || []), ...(def.specialInput ? [def.specialInput] : [])]
      for (const dep of deps) {
        if (!dep) continue
        const depNode = visit(dep, seen)
        edges.push({ from: depNode.key, to: node.key })
      }
    }
    return node
  }

  for (const name of roots) if (name) visit(name, new Set())
  return { nodes: [...nodes.values()], edges }
}

// Renders {nodes, edges} as a left-to-right layered SVG DAG (Raw/implicit sources on the
// left, more-refined Commodities to the right) plus a Type-color legend. Returns a wrapper
// element ready to append.
export function renderCommodityGraphSVG(nodes, edges, { emptyMessage = 'Nothing to show yet.' } = {}) {
  if (!nodes.length) {
    const empty = document.createElement('div')
    empty.style.cssText = 'font-size:11px;color:#444;font-style:italic'
    empty.textContent = emptyMessage
    return empty
  }

  const SVG_NS = 'http://www.w3.org/2000/svg'
  const byKey = new Map(nodes.map(n => [n.key, n]))
  const incoming = new Map(nodes.map(n => [n.key, []]))
  for (const e of edges) { if (incoming.has(e.to)) incoming.get(e.to).push(e.from) }

  // Longest-path layering: a node's column = 1 + max(column of its ingredient/input nodes).
  const layerOf = new Map()
  const resolveLayer = (key, visiting) => {
    if (layerOf.has(key)) return layerOf.get(key)
    if (visiting.has(key)) return 0
    visiting.add(key)
    const preds = incoming.get(key) || []
    const l = preds.length ? Math.max(...preds.map(p => resolveLayer(p, visiting))) + 1 : 0
    layerOf.set(key, l)
    return l
  }
  for (const n of nodes) resolveLayer(n.key, new Set())

  const maxLayer = Math.max(...[...layerOf.values()])
  const columns = Array.from({ length: maxLayer + 1 }, () => [])
  for (const n of nodes) columns[layerOf.get(n.key)].push(n)

  const NW = 120, NH = 46, GX = 60, GY = 16, PAD = 16
  const maxRows = Math.max(...columns.map(c => c.length))
  const W = PAD * 2 + (maxLayer + 1) * NW + maxLayer * GX
  const H = PAD * 2 + maxRows * NH + Math.max(0, maxRows - 1) * GY

  columns.forEach((col, ci) => {
    const colH = col.length * NH + Math.max(0, col.length - 1) * GY
    const y0 = (H - colH) / 2
    col.forEach((n, ri) => {
      n.x = PAD + ci * (NW + GX)
      n.y = y0 + ri * (NH + GY)
      n.cx = n.x + NW / 2
      n.cy = n.y + NH / 2
    })
  })

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('width', '100%')
  svg.setAttribute('style', 'display:block')

  const mkEl = (tag, attrs = {}) => {
    const el = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    return el
  }

  const defs = mkEl('defs')
  const marker = mkEl('marker', { id: 'vsg-arrow', markerWidth: '6', markerHeight: '6', refX: '5', refY: '3', orient: 'auto' })
  marker.appendChild(mkEl('path', { d: 'M0,0 L0,6 L6,3 z', fill: '#888' }))
  defs.appendChild(marker)
  svg.appendChild(defs)

  for (const e of edges) {
    const from = byKey.get(e.from), to = byKey.get(e.to)
    if (!from || !to) continue
    svg.appendChild(mkEl('line', {
      x1: from.x + NW, y1: from.cy, x2: to.x, y2: to.cy,
      stroke: '#888', 'stroke-width': '1.5', opacity: '0.5', 'marker-end': 'url(#vsg-arrow)'
    }))
  }

  for (const n of nodes) {
    const color = TYPE_COLORS[n.type] || TYPE_COLORS.Resource
    const dim = n.known === false
    svg.appendChild(mkEl('rect', { x: n.x, y: n.y, width: NW, height: NH, rx: 4, fill: '#0b0b0b', stroke: color, 'stroke-width': '1.5', opacity: dim ? '0.4' : '1' }))
    const nm = dim ? '?' : n.name
    const label = mkEl('text', { x: n.cx, y: n.cy - (n.producers?.length && !dim ? 3 : -3), 'font-size': '9', fill: dim ? '#666' : '#ddd', 'text-anchor': 'middle', 'font-weight': 'bold' })
    label.textContent = nm.length > 16 ? nm.slice(0, 15) + '…' : nm
    svg.appendChild(label)
    if (n.producers?.length && !dim) {
      const producerText = n.producers.join(', ')
      const sub = mkEl('text', { x: n.cx, y: n.cy + 12, 'font-size': '7', fill: '#888', 'text-anchor': 'middle' })
      sub.textContent = producerText.length > 20 ? producerText.slice(0, 19) + '…' : producerText
      svg.appendChild(sub)
    }
  }

  const wrap = document.createElement('div')
  wrap.appendChild(svg)

  const legend = document.createElement('div')
  legend.style.cssText = 'display:flex;gap:12px;margin-top:6px;font-size:10px;color:#888;flex-wrap:wrap'
  for (const [type, color] of Object.entries(TYPE_COLORS)) {
    const item = document.createElement('span')
    item.innerHTML = `<span style="display:inline-block;width:8px;height:8px;background:${color};border-radius:2px;margin-right:4px"></span>${type}`
    legend.appendChild(item)
  }
  wrap.appendChild(legend)
  return wrap
}
