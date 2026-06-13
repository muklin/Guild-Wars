import express from 'express'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import GameStateManager from './engine/GameStateManager.js'
import SetupPhase from './engine/SetupPhase.js'
import MultiplayerManager from './engine/MultiplayerManager.js'
import { saveGame, loadGame, listSaves, deleteSave } from './persistence.js'
import { TRAIT_BY_ID } from '../shared/guildTraits.js'
import { UPGRADE_BY_ID } from '../shared/hqUpgrades.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Bump when the bundled asset set changes, so an older Electron client can warn
// (see ADR-0004 version-skew guard).
const ASSET_VERSION = 1

const app = express()
const PORT = 3001

// Middleware
app.use(express.json())
app.use(express.static(path.join(__dirname, '../dist')))
app.use('/resources', express.static(path.join(__dirname, '../resources')))

// Initialize game systems
const gameStateManager = new GameStateManager()
const setupPhase = new SetupPhase(gameStateManager)
const mp = new MultiplayerManager()

// Push a "state changed" nudge to every connected client; each refetches its own
// (per-seat redacted) view via GET /api/state. Assigned once the ws server exists.
let broadcast = () => {}

// Auto-save after any mutation, then notify all clients to refetch.
async function autoSave() {
  try {
    await saveGame('autosave', {
      gameState: gameStateManager.serialize(),
      setupPhase: setupPhase.serialize(),
      multiplayer: mp.serialize()
    })
  } catch (e) {
    console.error('Auto-save failed:', e.message)
  }
  broadcast()
}

// Auto-load on startup
try {
  const data = await loadGame('autosave')
  gameStateManager.deserialize(data.gameState)
  setupPhase.deserialize(data.setupPhase || {})
  mp.deserialize(data.multiplayer || {})
  console.log(`Auto-loaded save from ${data.savedAt} (phase: ${data.gameState.currentPhase}, step: ${data.setupPhase?.currentStep})`)
  // Migrate old saves that pre-date street graph generation
  if (gameStateManager.cityDistrictData?.districts?.length && !gameStateManager.cityDistrictData.streetGraph) {
    setupPhase._generateStreetGraph()
    await autoSave()
    console.log('Migrated save: generated missing street graph')
  }
} catch {
  console.log('No auto-save found, starting fresh')
}

// ── Multiplayer middleware ─────────────────────────────────────────────────────
// Turn-gating: once a game has started with seats, mutating Setup routes are only
// allowed for the active seat in the current sub-phase's Initiative order. With no
// seats joined (single-player / dev), gating is bypassed entirely so the existing
// flow is unchanged.
function requireActiveSeat(req, res, next) {
  if (mp.seats.size === 0 || !mp.started) return next()
  const step = setupPhase.currentStep
  const seatKey = req.header('X-Seat-Key')
  if (!mp.isActive(seatKey, step)) {
    return res.status(409).json({
      ok: false,
      error: "It is not your turn.",
      activeSeatId: mp.activeSeatId(step)
    })
  }
  next()
}

// Resolve the calling seat (or null) from the X-Seat-Key header.
function seatOf(req) {
  return mp.resolveByKey(req.header('X-Seat-Key'))
}

// Routes

// GET     - Return full game state (+ this seat's redacted multiplayer view)
app.get('/api/state', (req, res) => {
  res.json({
    ...gameStateManager.getStateSnapshot(),
    setupStep: setupPhase.currentStep,
    resourceRegistry: setupPhase.resourceRegistry,
    threats: setupPhase.threats,
    tradingDestinations: setupPhase.tradingDestinations,
    factions: setupPhase.factions,
    assetVersion: ASSET_VERSION,
    multiplayer: mp.getStateForSeat(req.header('X-Seat-Key'))
  })
})

// ── Identity / lobby / turn / tokens / secrets ─────────────────────────────────

// POST /api/join - claim a seat under a name; returns the seat key.
app.post('/api/join', async (req, res) => {
  try {
    const seat = mp.join(req.body?.name)
    await autoSave()
    res.json({ ok: true, seatId: seat.id, seatKey: seat.seatKey, name: seat.name })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/lobby/roll-initiative - d20 per seat, fix the order.
app.post('/api/lobby/roll-initiative', async (req, res) => {
  try {
    const order = mp.rollInitiative()
    await autoSave()
    res.json({ ok: true, order })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/lobby/start - leave the lobby, begin Terrain Setup.
app.post('/api/lobby/start', async (req, res) => {
  try {
    mp.start()
    mp.onStepChanged()
    // Generate the shared world on start if one hasn't been created yet, so Terrain
    // Setup begins with regions for everyone.
    if (!(gameStateManager.worldTerrainData?.regions?.length)) {
      setupPhase.initialize()
    }
    await autoSave()
    res.json({ ok: true, started: true })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/turn/pass - the active seat ends its turn (and marks itself passed).
app.post('/api/turn/pass', async (req, res) => {
  try {
    const seat = seatOf(req)
    if (!seat) return res.status(401).json({ ok: false, error: 'Unknown seat' })
    const step = setupPhase.currentStep
    if (seat.id !== mp.activeSeatId(step)) {
      return res.status(409).json({ ok: false, error: 'It is not your turn.', activeSeatId: mp.activeSeatId(step) })
    }
    const nextSeatId = mp.pass(seat.id, step)
    await autoSave()
    res.json({ ok: true, activeSeatId: nextSeatId, allPassed: mp.allPassed() })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/tokens/adjust - adjust a seat's Token counter (manual, human-driven).
app.post('/api/tokens/adjust', async (req, res) => {
  try {
    const { seatId, kind, delta } = req.body
    const tokens = mp.adjustToken(seatId, kind, delta)
    await autoSave()
    res.json({ ok: true, seatId, tokens })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/secret - store a private datum for the calling seat.
app.post('/api/secret', async (req, res) => {
  try {
    const seat = seatOf(req)
    if (!seat) return res.status(401).json({ ok: false, error: 'Unknown seat' })
    const { key, value } = req.body
    if (!key) return res.status(400).json({ ok: false, error: 'A secret key is required' })
    mp.putSecret(seat.id, key, value)
    await autoSave()
    res.json({ ok: true })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/secret/reveal - move one of the calling seat's secrets into shared state.
app.post('/api/secret/reveal', async (req, res) => {
  try {
    const seat = seatOf(req)
    if (!seat) return res.status(401).json({ ok: false, error: 'Unknown seat' })
    const revealed = mp.revealSecret(seat.id, req.body?.key)
    if (!revealed) return res.status(404).json({ ok: false, error: 'No such secret' })
    await autoSave()
    res.json({ ok: true, revealed })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/init - Initialize setup phase
app.post('/api/setup/init', async (req, res) => {
  try {
    if (mp.seats.size === 0) throw new Error('No players have joined — use Join Game or Play Solo first')
    // Clear stale guild references so auto-creation in subdivision/done runs fresh.
    for (const seat of mp.seats.values()) seat.guildId = null
    const result = setupPhase.initialize()
    await autoSave()
    res.json({
      ok: true,
      ...result
    })
  } catch (error) {
    console.error('Setup init error:', error)
    res.status(400).json({
      ok: false,
      error: error.message
    })
  }
})

// POST /api/setup/terrain/assign - Assign terrain to region
app.post('/api/setup/terrain/assign', requireActiveSeat, async (req, res) => {
  try {
    const { regionId, terrainType, description } = req.body
    const result = setupPhase.assignTerrainToRegion(regionId, terrainType, description)
    await autoSave()
    res.json({
      ok: result.ok,
      clearedEdgeIds: result.clearedEdgeIds,
      regions: gameStateManager.worldTerrainData.regions,
      log: result.log
    })
  } catch (error) {
    console.error('Terrain assign error:', error)
    res.status(400).json({
      ok: false,
      error: error.message
    })
  }
})

app.post('/api/setup/terrain/edge', requireActiveSeat, async (req, res) => {
  try {
    const { edgeId, edgeType, description } = req.body
    const result = setupPhase.assignEdgeType(edgeId, edgeType, description)
    await autoSave()
    res.json({
      ok: result.ok,
      edges: gameStateManager.worldTerrainData.edges,
      log: result.log
    })
  } catch (error) {
    console.error('Edge assign error:', error)
    res.status(400).json({
      ok: false,
      error: error.message
    })
  }
})

// POST /api/setup/terrain/done - Finish terrain placement
app.post('/api/setup/terrain/done', requireActiveSeat, async (req, res) => {
  try {
    const result = setupPhase.finishTerrain()
    mp.onStepChanged()   // entering City Subdivision (Reversed Initiative)
    await autoSave()
    res.json({
      ok: true,
      step: 'CitySubdivision',
      cityDistrictData: gameStateManager.cityDistrictData,
      log: result.log
    })
  } catch (error) {
    console.error('Terrain done error:', error)
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/threat - Add a threat at an edge region
app.post('/api/setup/threat', requireActiveSeat, async (req, res) => {
  try {
    const { regionId, description, name } = req.body
    const result = setupPhase.addThreat(regionId, description, name)
    await autoSave()
    res.json({ ok: true, threats: result.threats, factions: setupPhase.factions, log: result.log })
  } catch (error) {
    console.error('Add threat error:', error)
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/trade - Add a trading destination at an edge region
app.post('/api/setup/trade', requireActiveSeat, async (req, res) => {
  try {
    const { regionId, description, name, buys, sells } = req.body
    const result = setupPhase.addTradingDestination(regionId, description, name, buys, sells)
    await autoSave()
    res.json({ ok: true, tradingDestinations: result.tradingDestinations, trade: result.trade, factions: result.factions, resourceRegistry: result.resourceRegistry, log: result.log })
  } catch (error) {
    console.error('Add trade error:', error)
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/city/preview - Provisionally set a district's type and generate its streets
app.post('/api/setup/city/preview', requireActiveSeat, async (req, res) => {
  try {
    const { districtId, districtType, residentialClass, LeadershipClass } = req.body
    const result = setupPhase.previewDistrictType(districtId, districtType, residentialClass, LeadershipClass)
    await autoSave()
    res.json({ ok: result.ok, cityDistrictData: gameStateManager.cityDistrictData, log: result.log })
  } catch (error) {
    console.error('District preview error:', error)
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/city/assign - Apply (lock) a city district with its resources
app.post('/api/setup/city/assign', requireActiveSeat, async (req, res) => {
  try {
    const { districtId, districtType, description, producedResource, secondProducedResource, consumedResources, residentialClass, LeadershipClass } = req.body
    const result = setupPhase.assignDistrictType(districtId, districtType, description, producedResource, consumedResources, residentialClass, LeadershipClass, secondProducedResource)
    await autoSave()
    res.json({ ok: result.ok, resourceRegistry: result.resourceRegistry, factions: result.factions, cityDistrictData: gameStateManager.cityDistrictData, log: result.log })
  } catch (error) {
    console.error('District assign error:', error)
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/city/regenerate - Reseed a not-yet-locked district's streets
app.post('/api/setup/city/regenerate', requireActiveSeat, async (req, res) => {
  try {
    const { districtId } = req.body
    const result = setupPhase.regenerateDistrict(districtId)
    await autoSave()
    res.json({ ok: result.ok, factions: setupPhase.factions, cityDistrictData: gameStateManager.cityDistrictData, log: result.log })
  } catch (error) {
    console.error('District regenerate error:', error)
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/city/revert - Discard a provisional district back to blank
app.post('/api/setup/city/revert', requireActiveSeat, async (req, res) => {
  try {
    const { districtId } = req.body
    const result = setupPhase.revertDistrict(districtId)
    await autoSave()
    res.json({ ok: result.ok, cityDistrictData: gameStateManager.cityDistrictData, log: result.log })
  } catch (error) {
    console.error('District revert error:', error)
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/city/edge - Assign type to a city edge
app.post('/api/setup/city/edge', requireActiveSeat, async (req, res) => {
  try {
    const { edgeId, edgeType, description } = req.body
    const result = setupPhase.assignCityEdgeType(edgeId, edgeType, description)
    await autoSave()
    res.json({ ok: result.ok, log: result.log })
  } catch (error) {
    console.error('City edge assign error:', error)
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/subdivision/assign - Assign district class
app.post('/api/setup/subdivision/assign', requireActiveSeat, async (req, res) => {
  try {
    const { districtId, districtClass } = req.body
    const result = setupPhase.assignDistrictClass(districtId, districtClass)
    await autoSave()
    res.json({
      ok: result.ok,
      districts: gameStateManager.cityDistrictData.districts || [],
      log: result.log
    })
  } catch (error) {
    console.error('District assign error:', error)
    res.status(400).json({
      ok: false,
      error: error.message
    })
  }
})

// POST /api/setup/terrain-district - Assign a district type to a terrain region
app.post('/api/setup/terrain-district', requireActiveSeat, async (req, res) => {
  try {
    const { regionId, districtType, description, producedResource, consumedResources } = req.body
    const result = setupPhase.assignTerrainDistrict(regionId, districtType, description, producedResource, consumedResources)
    await autoSave()
    res.json({ ok: true, resourceRegistry: result.resourceRegistry, factions: result.factions, log: result.log })
  } catch (error) {
    console.error('Terrain district assign error:', error)
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/subdivision/done - Finish city subdivision → auto-create one guild per seat
app.post('/api/setup/subdivision/done', requireActiveSeat, async (req, res) => {
  try {
    const t0 = performance.now()
    const result = setupPhase.finishSubdivision()
    console.log(`[perf] finishSubdivision (all districts): ${(performance.now()-t0).toFixed(1)}ms`)
    mp.onStepChanged()

    // Auto-create one guild per seat.
    const seats = [...mp.seats.values()]
    if (seats.length === 0) throw new Error('No players have joined — cannot finish subdivision without at least one seat')
    for (const seat of seats) {
      if (!seat.guildId) {
        const gr = setupPhase.createPlayerGuild({ name: '', seatId: seat.id })
        seat.guildId = gr.guild.id
      }
    }

    await autoSave()
    res.json({
      ok: true,
      step: 'Complete',
      log: result.log,
      factions: setupPhase.factions,
      cityDistrictData: gameStateManager.cityDistrictData,
      guilds: Array.from(gameStateManager.guilds.values()),
    })
  } catch (error) {
    console.error('Subdivision done error:', error)
    res.status(400).json({
      ok: false,
      error: error.message
    })
  }
})

// POST /api/setup/guild - Create player guild
app.post('/api/setup/guild', requireActiveSeat, async (req, res) => {
  try {
    const { guildName, headquarters } = req.body
    const seat = seatOf(req)
    const result = setupPhase.createPlayerGuild({
      name: guildName, headquarters, seatId: seat?.id ?? null
    })
    if (seat && result.guild) seat.guildId = result.guild.id
    await autoSave()
    res.json({
      ok: result.ok,
      guild: result.guild,
      guilds: Array.from(gameStateManager.guilds.values()),
      step: 'Complete',
      log: result.log
    })
  } catch (error) {
    console.error('Guild creation error:', error)
    res.status(400).json({
      ok: false,
      error: error.message
    })
  }
})

// POST /api/setup/guild/rename - Rename the player's guild
app.post('/api/setup/guild/rename', async (req, res) => {
  try {
    const { name } = req.body
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'Name required' })
    const seat = seatOf(req)
    const guilds = Array.from(gameStateManager.guilds.values())
    const guild = seat ? guilds.find(g => g.seatId === seat.id) : guilds[0]
    if (!guild) return res.status(404).json({ ok: false, error: 'No guild found' })
    if (guild.nameLocked) return res.status(400).json({ ok: false, error: 'Guild name has already been set and cannot be changed' })
    guild.name = name.trim()
    guild.nameLocked = true
    await autoSave()
    res.json({ ok: true, guild, guilds: Array.from(gameStateManager.guilds.values()) })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/guild/character/levelup
app.post('/api/setup/guild/character/levelup', async (req, res) => {
  try {
    const { charId, classChoice } = req.body
    const seat = seatOf(req)
    if (!seat) return res.status(401).json({ ok: false, error: 'Unknown seat' })
    if ((seat.tokens?.character ?? 0) < 1) return res.status(400).json({ ok: false, error: 'No Character tokens remaining' })
    const guild = Array.from(gameStateManager.guilds.values()).find(g => g.seatId === seat.id)
    if (!guild) return res.status(404).json({ ok: false, error: 'No guild found' })
    const ch = guild.characters?.find(c => c.id === charId)
    if (!ch) return res.status(404).json({ ok: false, error: 'Character not found' })
    if (ch.level === 0 && !classChoice?.trim()) return res.status(400).json({ ok: false, error: 'Class required for first level up' })
    seat.tokens.character -= 1
    ch.level += 1
    if (ch.level === 1 && classChoice?.trim()) ch.class = classChoice.trim()
    if (ch.role === 'recruit') ch.role = 'member'
    await autoSave()
    res.json({ ok: true, guild, tokens: seat.tokens })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/guild/character/role
app.post('/api/setup/guild/character/role', async (req, res) => {
  try {
    const { charId, role } = req.body
    const VALID_ROLES = ['guild-leader', 'guild-second', 'member']
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ ok: false, error: 'Invalid role' })
    const seat = seatOf(req)
    if (!seat) return res.status(401).json({ ok: false, error: 'Unknown seat' })
    const guild = Array.from(gameStateManager.guilds.values()).find(g => g.seatId === seat.id)
    if (!guild) return res.status(404).json({ ok: false, error: 'No guild found' })
    const ch = guild.characters?.find(c => c.id === charId)
    if (!ch) return res.status(404).json({ ok: false, error: 'Character not found' })
    if (ch.role === 'recruit') return res.status(400).json({ ok: false, error: 'Recruits must level up before changing role' })
    ch.role = role
    await autoSave()
    res.json({ ok: true, guild })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/guild/trait - purchase a guild trait
app.post('/api/setup/guild/trait', async (req, res) => {
  try {
    const { traitId } = req.body
    if (!TRAIT_BY_ID.has(traitId)) return res.status(400).json({ ok: false, error: 'Unknown trait' })
    const seat = seatOf(req)
    if (!seat) return res.status(401).json({ ok: false, error: 'Unknown seat' })
    if ((seat.tokens?.guild ?? 0) < 1) return res.status(400).json({ ok: false, error: 'No Guild tokens remaining' })
    const guild = Array.from(gameStateManager.guilds.values()).find(g => g.seatId === seat.id)
    if (!guild) return res.status(404).json({ ok: false, error: 'No guild found' })
    if (!guild.traits) guild.traits = []
    if (guild.traits.includes(traitId)) return res.status(400).json({ ok: false, error: 'Trait already owned' })
    const trait = TRAIT_BY_ID.get(traitId)
    if (trait.requiresHQType?.length) {
      const hq = guild.headquarters
      if (!hq) return res.status(400).json({ ok: false, error: 'This trait requires a Headquarters to be set first.' })
      const districts = gameStateManager.cityDistrictData?.districts || []
      const hqDistrict = districts.find(d => d.id === hq.districtId)
      const hqType = hqDistrict?.assignedType
      if (!hqType || !trait.requiresHQType.includes(hqType)) {
        return res.status(400).json({ ok: false, error: `Requires HQ in a ${trait.requiresHQType.join(' or ')} district.` })
      }
    }
    seat.tokens.guild -= 1
    guild.traits.push(traitId)
    await autoSave()
    res.json({ ok: true, guild, tokens: seat.tokens })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// POST /api/setup/guild/hq-upgrade - purchase an HQ upgrade
app.post('/api/setup/guild/hq-upgrade', async (req, res) => {
  try {
    const { upgradeId } = req.body
    if (!UPGRADE_BY_ID.has(upgradeId)) return res.status(400).json({ ok: false, error: 'Unknown upgrade' })
    const seat = seatOf(req)
    if (!seat) return res.status(401).json({ ok: false, error: 'Unknown seat' })
    const guild = Array.from(gameStateManager.guilds.values()).find(g => g.seatId === seat.id)
    if (!guild) return res.status(404).json({ ok: false, error: 'No guild found' })
    if (!guild.hqUpgrades) guild.hqUpgrades = []
    if (guild.hqUpgrades.includes(upgradeId)) return res.status(400).json({ ok: false, error: 'Upgrade already owned' })
    const upgrade = UPGRADE_BY_ID.get(upgradeId)
    // Validate sufficient resources
    for (const [resource, amount] of Object.entries(upgrade.cost)) {
      const held = guild.resources?.[resource] ?? 0
      if (held < amount) return res.status(400).json({ ok: false, error: `Not enough ${resource} (need ${amount}, have ${held})` })
    }
    // Deduct costs
    for (const [resource, amount] of Object.entries(upgrade.cost)) {
      guild.resources[resource] = (guild.resources[resource] ?? 0) - amount
    }
    guild.hqUpgrades.push(upgradeId)
    // Side effect: Grand Guildhall grants +10 Standing with all factions
    if (upgradeId === 'grand-guildhall') {
      if (!guild.standing) guild.standing = {}
      for (const f of setupPhase.factions) {
        guild.standing[f.id] = Math.min(100, (guild.standing[f.id] ?? 50) + 10)
      }
    }
    await autoSave()
    res.json({ ok: true, guild })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// --- Persistence endpoints ---

// GET /api/saves - list available saves
app.get('/api/saves', async (req, res) => {
  try {
    res.json({ ok: true, saves: await listSaves() })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

// POST /api/save - save current state to named slot
app.post('/api/save', async (req, res) => {
  try {
    const name = req.body.name || 'autosave'
    const result = await saveGame(name, {
      gameState: gameStateManager.serialize(),
      setupPhase: setupPhase.serialize(),
      multiplayer: mp.serialize()
    })
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

// POST /api/load - load state from named slot
app.post('/api/load', async (req, res) => {
  try {
    const name = req.body.name || 'autosave'
    const data = await loadGame(name)
    gameStateManager.clear()
    gameStateManager.deserialize(data.gameState)
    setupPhase.deserialize(data.setupPhase || {})
    mp.clear()
    mp.deserialize(data.multiplayer || {})
    await autoSave()
    res.json({ ok: true, savedAt: data.savedAt, state: gameStateManager.getStateSnapshot() })
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message })
  }
})

// DELETE /api/saves/:name - delete a save
app.delete('/api/saves/:name', async (req, res) => {
  try {
    await deleteSave(req.params.name)
    res.json({ ok: true })
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message })
  }
})

// Fallback - serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'))
})

// Start server (HTTP + WebSocket on the same port)
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

// A client opens a socket and (optionally) identifies its seat with a hello message
// so we can track connected/disconnected. Broadcasts are content-free nudges: each
// client refetches its own per-seat redacted state via GET /api/state.
wss.on('connection', (socket) => {
  socket.seatKey = null
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'hello' && msg.seatKey) {
        socket.seatKey = msg.seatKey
        mp.setConnected(msg.seatKey, true)
        broadcast()
      }
    } catch { /* ignore malformed frames */ }
  })
  socket.on('close', () => {
    if (socket.seatKey) {
      mp.setConnected(socket.seatKey, false)
      broadcast()
    }
  })
})

broadcast = () => {
  const payload = JSON.stringify({ type: 'sync' })
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(payload)
  }
}

server.listen(PORT, () => {
  console.log(`Guild Wars server running on http://localhost:${PORT} (ws: /ws)`)
})
