#!/usr/bin/env node
// Exports a subset of a saved game's cityDistrictData (plot/block/junction +
// adjacent geometry) into a testBlocks.json-shaped file, for the buildingparts
// preview harness (client/preview/blockpreview.js). Pure read of server/saves/*.json
// — does not touch the running server or GameStateManager.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import PlotVoronoiGenerator, { markSquareBlocks } from '../server/engine/CityGenerator/PlotVoronoiGenerator.js'
import LandmarkPlacer from '../server/engine/CityGenerator/buildings/LandmarkPlacer.js'
import { gutterRoadEdges } from '../server/engine/CityGenerator/CityBlockGenerator.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAVES_DIR = path.join(__dirname, '..', 'server', 'saves')
const DEFAULT_OUT = path.join(__dirname, '..', 'client', 'preview', 'testBlocks.json')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else { args[key] = next; i++ }
  }
  return args
}

function usage() {
  console.log(`
Usage: node tools/exportPlot.mjs --save <name> (--plot <id> | --block <id> | --junction <id>) [--out <path>]

  --save <name>     Save file name (without .json) under server/saves/, e.g. "autosave"
  --file <path>     Or: direct path to a save .json file, instead of --save
  --plot <id>       Export the block containing this plot, plus all junctions/streets
                     bordering that block.
  --block <id>      Export this block, plus all junctions/streets bordering it, plus
                     every block that also touches those same streets.
  --junction <id>   Export this junction, plus the junctions/streets it connects to
                     directly, plus every block bordering those streets.
  --out <path>      Output path (default: client/preview/testBlocks.json)
`)
}

const args = parseArgs(process.argv.slice(2))
const hasSource = args.save || args.file
const hasTarget = args.plot !== undefined || args.block !== undefined || args.junction !== undefined
if (!hasSource || !hasTarget) { usage(); process.exit(1) }

const savePath = args.file ? path.resolve(args.file) : path.join(SAVES_DIR, `${args.save}.json`)
if (!fs.existsSync(savePath)) {
  console.error(`Save file not found: ${savePath}`)
  process.exit(1)
}

const saveRaw = JSON.parse(fs.readFileSync(savePath, 'utf8'))
const cityData = saveRaw.gameState?.cityDistrictData ?? saveRaw.cityDistrictData
if (!cityData) {
  console.error('Could not find cityDistrictData in save file (looked at .gameState.cityDistrictData and .cityDistrictData).')
  process.exit(1)
}

const { districts = [], blocks = [], streetGraph, landmarkBuildings = [] } = cityData
const junctions = streetGraph?.junctions ?? []
const junctionById = new Map(junctions.map(j => [j.id, j]))

// Save files never persist cityDistrictData.plots — server/index.js re-derives them on
// load (SetupPhase.regeneratePlots()) instead of storing them, so a saved plots array is
// always empty on disk. Mirror that same regeneration here (city-block plots only; this
// tool doesn't need terrain plots) so --plot/--block exports actually have plots to hand
// to the buildingparts preview instead of silently exporting zero every time.
let plots = cityData.plots ?? []
if (!plots.length && blocks.length && junctions.length) {
  markSquareBlocks(blocks, districts)
  const { footprints } = new LandmarkPlacer().generate(blocks, districts)
  const roadEdges = gutterRoadEdges(junctions)
  ;({ plots } = new PlotVoronoiGenerator().generate(blocks, districts, junctions, roadEdges, footprints))
  console.log(`(save file had no persisted plots — regenerated ${plots.length} from blocks/junctions)`)
}

const roadIdsOfBlock = (block) => new Set((block.streetEdges || []).map(e => e.roadId).filter(Boolean))

// Junctions whose connections[] reference any of the given roadIds — collects BOTH
// endpoints of each matching street (the junction owning the connection, and its toId).
function junctionsForRoadIds(roadIds) {
  const ids = new Set()
  for (const j of junctions) {
    for (const conn of (j.connections || [])) {
      if (roadIds.has(conn.roadId)) { ids.add(j.id); ids.add(conn.toId) }
    }
  }
  return ids
}

function blocksForRoadIds(roadIds, excludeBlockId = null) {
  return blocks.filter(b => {
    if (b.id === excludeBlockId) return false
    const br = roadIdsOfBlock(b)
    for (const r of br) if (roadIds.has(r)) return true
    return false
  })
}

const findBlockById = (id) => blocks.find(b => b.id === id)
const findPlotById = (id) => plots.find(p => p.id === id)

const includedBlocks = new Map()   // id -> block
let includedJunctionIds = new Set()
let label = ''

if (args.plot !== undefined) {
  const plotId = Number(args.plot)
  const plot = findPlotById(plotId)
  if (!plot) { console.error(`Plot ${plotId} not found.`); process.exit(1) }
  const block = findBlockById(plot.blockId)
  if (!block) { console.error(`Plot ${plotId} references missing block ${plot.blockId}.`); process.exit(1) }
  includedBlocks.set(block.id, block)
  includedJunctionIds = junctionsForRoadIds(roadIdsOfBlock(block))
  label = `plot ${plotId} (block ${block.id})`
} else if (args.block !== undefined) {
  const blockId = Number(args.block)
  const block = findBlockById(blockId)
  if (!block) { console.error(`Block ${blockId} not found.`); process.exit(1) }
  includedBlocks.set(block.id, block)
  const roadIds = roadIdsOfBlock(block)
  includedJunctionIds = junctionsForRoadIds(roadIds)
  for (const nb of blocksForRoadIds(roadIds, block.id)) includedBlocks.set(nb.id, nb)
  label = `block ${blockId}`
} else {
  const junctionId = Number(args.junction)
  const junction = junctionById.get(junctionId)
  if (!junction) { console.error(`Junction ${junctionId} not found.`); process.exit(1) }
  includedJunctionIds.add(junction.id)
  const roadIds = new Set((junction.connections || []).map(c => c.roadId).filter(Boolean))
  for (const id of junctionsForRoadIds(roadIds)) includedJunctionIds.add(id)
  for (const b of blocksForRoadIds(roadIds)) includedBlocks.set(b.id, b)
  label = `junction ${junctionId}`
}

const includedBlockIds = new Set(includedBlocks.keys())
const outBlocks = [...includedBlocks.values()]
const outPlots = plots.filter(p => includedBlockIds.has(p.blockId))
const outJunctions = junctions.filter(j => includedJunctionIds.has(j.id))
const districtIds = new Set([...outBlocks.map(b => b.districtId), ...outPlots.map(p => p.districtId)])
const outDistricts = districts.filter(d => districtIds.has(d.id))
const outLandmarks = landmarkBuildings.filter(l => districtIds.has(l.districtId))

const out = {
  cityDistrictData: {
    districts: outDistricts,
    streetGraph: { junctions: outJunctions },
    blocks: outBlocks,
    plots: outPlots,
    landmarkBuildings: outLandmarks,
  },
  _exportMeta: {
    source: path.relative(path.join(__dirname, '..'), savePath),
    query: label,
    exportedAt: new Date().toISOString(),
  },
}

const outPath = args.out ? path.resolve(args.out) : DEFAULT_OUT
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8')
console.log(
  `Exported ${label}: ${outBlocks.length} block(s), ${outPlots.length} plot(s), ` +
  `${outJunctions.length} junction(s), ${outDistricts.length} district(s) -> ${outPath}`
)
