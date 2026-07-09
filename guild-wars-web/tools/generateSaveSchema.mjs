// Regenerates docs/schemas/json-schema-autosave.json from a real save file, by
// inferring a JSON Schema (draft-04, matching the existing file's style) from its
// actual shape. Run this any time the save format changes:
//   node tools/generateSaveSchema.mjs [path/to/save.json]
// Defaults to server/saves/autosave.json.
//
// Matches the existing schema file's established (if unusual) conventions rather than
// "best practice" JSON Schema — in particular, a dictionary-shaped object (e.g.
// worldTerrainData.edges, keyed by "regionA-regionB") gets every one of its CURRENT
// keys spelled out as its own named property, not a patternProperties/additionalProperties
// wildcard. That means re-running this script against a save with different region/
// district ids will legitimately change which edge keys appear — that's expected, not
// a bug in the generator.
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const _dir = dirname(fileURLToPath(import.meta.url))
const savePath = process.argv[2] || join(_dir, '../server/saves/autosave.json')
const outPath = join(_dir, '../docs/schemas/json-schema-autosave.json')

function inferValue(v) {
  if (v === null || v === undefined) return {}
  if (Array.isArray(v)) {
    if (v.length === 0) return { type: 'array', items: { required: [], properties: {} } }
    const merged = v.map(inferValue).reduce((acc, s) => (acc ? mergeSchemas(acc, s) : s), null)
    return { type: 'array', uniqueItems: true, minItems: 1, items: merged }
  }
  const t = typeof v
  if (t === 'string') return v.length > 0 ? { type: 'string', minLength: 1 } : { type: 'string' }
  if (t === 'number') return { type: 'number' }
  if (t === 'boolean') return { type: 'boolean' }
  if (t === 'object') {
    const keys = Object.keys(v)
    const properties = {}
    for (const k of keys) properties[k] = inferValue(v[k])
    return { type: 'object', properties, required: keys }
  }
  return {}
}

// Merge two schemas inferred from sibling ARRAY ITEMS (not from unrelated fields) —
// properties widen to the union (a field only some items have is still documented),
// required narrows to the intersection (only fields every item actually had).
function mergeSchemas(a, b) {
  const aEmpty = !a || Object.keys(a).length === 0
  const bEmpty = !b || Object.keys(b).length === 0
  if (aEmpty) return b
  if (bEmpty) return a
  if (a.type !== b.type) return a   // heterogeneous array items — rare in this codebase, keep the first shape seen

  if (a.type === 'object') {
    const properties = { ...a.properties }
    for (const k of Object.keys(b.properties)) {
      properties[k] = properties[k] ? mergeSchemas(properties[k], b.properties[k]) : b.properties[k]
    }
    const required = (a.required || []).filter(k => (b.required || []).includes(k))
    return { type: 'object', properties, required }
  }
  if (a.type === 'array') {
    return { type: 'array', uniqueItems: true, minItems: 1, items: mergeSchemas(a.items, b.items) }
  }
  if (a.type === 'string') {
    return (a.minLength === 1 && b.minLength === 1) ? { type: 'string', minLength: 1 } : { type: 'string' }
  }
  return a   // number/boolean: same type, nothing further to reconcile
}

const save = JSON.parse(readFileSync(savePath, 'utf8'))
const root = inferValue(save)
const schema = { '$schema': 'http://json-schema.org/draft-04/schema#', description: '', ...root }

writeFileSync(outPath, JSON.stringify(schema, null, 2) + '\n')
console.log(`Wrote ${outPath} from ${savePath}`)
