// Renders docs/schemas/json-schema-autosave.json as a browsable, collapsible HTML page,
// with a real example value from the current save shown alongside every field. Fully
// static — no client-side JS required, just nested <details> elements — so it works
// equally well opened directly (file://) or served.
//   node tools/generateSchemaViewer.mjs
// Re-run any time the schema is regenerated (see tools/generateSaveSchema.mjs) so the
// two stay in sync — the viewer walks both files in lockstep by key, so a stale pairing
// would show the wrong example for a renamed/moved field.
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const _dir = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(_dir, '../docs/schemas/json-schema-autosave.json')
const savePath = join(_dir, '../server/saves/autosave.json')
const outPath = join(_dir, '../docs/schemas/autosave-schema-viewer.html')

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
const example = JSON.parse(readFileSync(savePath, 'utf8'))

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function formatPrimitive(v) {
  if (v === undefined) return null
  if (v === null) return 'null'
  if (typeof v === 'string') {
    const trimmed = v.length > 90 ? v.slice(0, 90) + '…' : v
    return `"${escapeHtml(trimmed)}"`
  }
  return escapeHtml(String(v))
}

// A dictionary-shaped object (keyed by e.g. "regionA-regionB" or "districtA-districtB")
// is many sibling keys that are all objects — NOT necessarily identical objects.
// Real edges legitimately vary (an assigned edge has description/name, an "outer-N"
// edge has no districtB, an unassigned one has neither), so requiring an exact shape
// match never actually fired. Threshold on key count + "all objects" instead, and pick
// the richest sibling (most properties) as the representative so optional fields like
// assignedType/description/name are still visible in the one example shown.
function isDictLike(properties) {
  const keys = Object.keys(properties)
  if (keys.length < 4) return false
  return keys.every(k => properties[k] && properties[k].type === 'object')
}
function richestKey(properties) {
  return Object.keys(properties).sort((a, b) =>
    Object.keys(properties[b].properties || {}).length - Object.keys(properties[a].properties || {}).length
  )[0]
}

function labelHtml(key, required) {
  if (key == null) return ''
  const req = required ? '<span class="req" title="required">*</span>' : ''
  return `<span class="key">${escapeHtml(key)}</span>${req}`
}

function typeBadge(label, cls) {
  return `<span class="badge badge-${cls}">${escapeHtml(label)}</span>`
}

function renderNode(nodeSchema, ex, keyLabel, required) {
  if (!nodeSchema || Object.keys(nodeSchema).length === 0) {
    const val = formatPrimitive(ex)
    return `<div class="leaf">${labelHtml(keyLabel, required)} ${typeBadge('null / unknown', 'null')}${val != null ? ` <span class="example">${val}</span>` : ''}</div>`
  }

  if (nodeSchema.type === 'object') {
    const propKeys = Object.keys(nodeSchema.properties || {})

    if (isDictLike(nodeSchema.properties)) {
      const repKey = richestKey(nodeSchema.properties)
      const repSchema = nodeSchema.properties[repKey]
      const repExample = ex ? ex[repKey] : undefined
      const otherKeys = propKeys.slice(0, 8).map(k => `<code>${escapeHtml(k)}</code>`).join(', ') + (propKeys.length > 8 ? ', …' : '')
      return `<details class="node">
        <summary>${labelHtml(keyLabel, required)} ${typeBadge(`dictionary · ${propKeys.length} entries`, 'object')}</summary>
        <div class="node-body">
          <p class="note">${propKeys.length} keys in this dictionary, one object per key — shapes vary slightly (e.g. only an assigned edge has description/name). Showing the richest entry (<code>${escapeHtml(repKey)}</code>) as the fullest example. All keys present in the current save: ${otherKeys}</p>
          ${renderNode(repSchema, repExample, repKey, true)}
        </div>
      </details>`
    }

    const body = propKeys.map(k =>
      renderNode(nodeSchema.properties[k], ex ? ex[k] : undefined, k, (nodeSchema.required || []).includes(k))
    ).join('')
    const openAttr = keyLabel == null ? ' open' : ''
    return `<details class="node"${openAttr}>
      <summary>${labelHtml(keyLabel, required)} ${typeBadge('object', 'object')}</summary>
      <div class="node-body">${body}</div>
    </details>`
  }

  if (nodeSchema.type === 'array') {
    const count = Array.isArray(ex) ? ex.length : 0
    const repExample = count ? ex[0] : undefined
    const inner = count
      ? `<p class="note">Showing <code>[0]</code> of ${count}:</p>${renderNode(nodeSchema.items, repExample, null, true)}`
      : `<p class="note">Empty in the current save — no example available.</p>`
    return `<details class="node">
      <summary>${labelHtml(keyLabel, required)} ${typeBadge(`array · ${count} item${count === 1 ? '' : 's'}`, 'array')}</summary>
      <div class="node-body">${inner}</div>
    </details>`
  }

  // primitive: string / number / boolean
  const val = formatPrimitive(ex)
  return `<div class="leaf">${labelHtml(keyLabel, required)} ${typeBadge(nodeSchema.type, nodeSchema.type)}${val != null ? ` <span class="example">${val}</span>` : ''}</div>`
}

const treeHtml = renderNode(schema, example, 'autosave.json', true)

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Savegame Schema — autosave.json</title>
<style>
  :root {
    --bg: #edeee7; --bg-panel: #f8f8f4; --bg-raised: #ffffff;
    --ink: #1c2321; --ink-soft: #59635e; --ink-faint: #8a938d;
    --line: #d9dbd0; --line-strong: #c3c6b8;
    --accent: #2b5d63; --accent-soft: #dfe9e7;
    --obj: #4a6b8a; --obj-soft: #e2e9f0;
    --arr: #8a5f9e; --arr-soft: #efe6f2;
    --str: #3c6e3f; --str-soft: #e0ead9;
    --num: #a3651f; --num-soft: #f2e6d3;
    --bool: #b23a1f; --bool-soft: #f6ddd3;
    --nul: #8a938d; --nul-soft: #eceee9;
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Consolas", "Liberation Mono", monospace;
    --sans: -apple-system, "Segoe UI", "Helvetica Neue", ui-sans-serif, Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14181a; --bg-panel: #1a2022; --bg-raised: #1f2628;
      --ink: #e8ece8; --ink-soft: #a2ada6; --ink-faint: #6c766f;
      --line: #2a3234; --line-strong: #38423f;
      --accent: #74bcc0; --accent-soft: #223335;
      --obj: #8fb0d4; --obj-soft: #202b36;
      --arr: #c39fd6; --arr-soft: #2b2333;
      --str: #82c087; --str-soft: #1c2b1e;
      --num: #dba15b; --num-soft: #2e2416;
      --bool: #e08061; --bool-soft: #2e1e18;
      --nul: #6c766f; --nul-soft: #1c2022;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 15px; line-height: 1.5; }
  .page { max-width: 920px; margin: 0 auto; padding: 48px 24px 96px; }
  header { padding-bottom: 24px; border-bottom: 2px solid var(--ink); margin-bottom: 28px; }
  .eyebrow { font-family: var(--mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 8px; }
  h1 { font-size: 26px; margin: 0 0 10px; }
  header p { margin: 0; color: var(--ink-soft); font-size: 14px; max-width: 70ch; }
  header .src { font-family: var(--mono); font-size: 12.5px; color: var(--ink-faint); margin-top: 10px; }

  details.node { border: 1px solid var(--line); border-radius: 4px; background: var(--bg-panel); margin: 6px 0; }
  details.node > summary {
    cursor: pointer; padding: 8px 12px; font-family: var(--mono); font-size: 13.5px;
    display: flex; align-items: center; gap: 8px; list-style: none;
  }
  details.node > summary::-webkit-details-marker { display: none; }
  details.node > summary::before { content: "▸"; color: var(--ink-faint); font-size: 11px; transition: transform 0.1s; }
  details.node[open] > summary::before { transform: rotate(90deg); }
  details.node > summary:hover { background: var(--bg-raised); }
  .node-body { padding: 4px 12px 10px 26px; border-top: 1px solid var(--line); }

  .leaf { font-family: var(--mono); font-size: 13.5px; padding: 6px 12px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .leaf:hover { background: var(--bg-panel); border-radius: 3px; }

  .key { font-weight: 600; }
  .req { color: var(--bool); margin-left: 1px; }

  .badge {
    font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: 0.03em;
    padding: 2px 7px; border-radius: 3px; text-transform: lowercase; white-space: nowrap;
  }
  .badge-object { color: var(--obj); background: var(--obj-soft); }
  .badge-array  { color: var(--arr); background: var(--arr-soft); }
  .badge-string { color: var(--str); background: var(--str-soft); }
  .badge-number { color: var(--num); background: var(--num-soft); }
  .badge-boolean{ color: var(--bool); background: var(--bool-soft); }
  .badge-null   { color: var(--nul); background: var(--nul-soft); }

  .example { color: var(--ink-soft); font-size: 13px; }

  p.note { font-size: 12.5px; color: var(--ink-faint); margin: 6px 0 8px; max-width: 80ch; }
  p.note code { font-family: var(--mono); background: var(--bg-raised); border: 1px solid var(--line); padding: 0.05em 0.35em; border-radius: 3px; }

  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); font-family: var(--mono); font-size: 11px; color: var(--ink-faint); }
</style>
</head>
<body>
<div class="page">
  <header>
    <div class="eyebrow">guild-wars-web — savegame reference</div>
    <h1>Savegame schema — autosave.json</h1>
    <p>Every field in the save format, with its type and a real example value pulled from the current save. Click any row to expand it. Dictionary-shaped objects (many keys sharing one structure, e.g. terrain edges keyed by region pair) are collapsed to one representative entry, with every other key still listed.</p>
    <div class="src">Schema: docs/schemas/json-schema-autosave.json · Example data: server/saves/autosave.json · Generated ${new Date().toISOString()}</div>
  </header>
  ${treeHtml}
  <footer>Regenerate after any save-format change: node tools/generateSaveSchema.mjs &amp;&amp; node tools/generateSchemaViewer.mjs</footer>
</div>
</body>
</html>
`

writeFileSync(outPath, html)
console.log(`Wrote ${outPath}`)
