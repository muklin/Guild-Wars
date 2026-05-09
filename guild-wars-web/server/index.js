import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import GameStateManager from './engine/GameStateManager.js'
import SetupPhase from './engine/SetupPhase.js'
import { saveGame, loadGame, listSaves, deleteSave } from './persistence.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = 3001

// Middleware
app.use(express.json())
app.use(express.static(path.join(__dirname, '../dist')))

// Initialize game systems
const gameStateManager = new GameStateManager()
const setupPhase = new SetupPhase(gameStateManager)

// Auto-save after any mutation
async function autoSave() {
  try {
    await saveGame('autosave', {
      gameState: gameStateManager.serialize(),
      setupPhase: setupPhase.serialize()
    })
  } catch (e) {
    console.error('Auto-save failed:', e.message)
  }
}

// Auto-load on startup
try {
  const data = await loadGame('autosave')
  gameStateManager.deserialize(data.gameState)
  setupPhase.deserialize(data.setupPhase || {})
  console.log(`Auto-loaded save from ${data.savedAt} (phase: ${data.gameState.currentPhase}, step: ${data.setupPhase?.currentStep})`)
} catch {
  console.log('No auto-save found, starting fresh')
}

// Routes

// GET     - Return full game state
app.get('/api/state', (req, res) => {
  res.json({
    ...gameStateManager.getStateSnapshot(),
    setupStep: setupPhase.currentStep
  })
})

// POST /api/setup/init - Initialize setup phase
app.post('/api/setup/init', async (req, res) => {
  try {
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
app.post('/api/setup/terrain/assign', async (req, res) => {
  try {
    const { regionId, terrainType } = req.body
    const result = setupPhase.assignTerrainToRegion(regionId, terrainType)
    await autoSave()
    res.json({
      ok: result.ok,
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

app.post('/api/setup/terrain/edge', async (req, res) => {
  try {
    const { edgeId, edgeType } = req.body
    const result = setupPhase.assignEdgeType(edgeId, edgeType)
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
app.post('/api/setup/terrain/done', async (req, res) => {
  try {
    const result = setupPhase.finishTerrain()
    await autoSave()
    res.json({
      ok: true,
      step: 'CitySubdivision',
      districts: gameStateManager.cityDistrictData.districts || [],
      log: result.log
    })
  } catch (error) {
    console.error('Terrain done error:', error)
    res.status(400).json({
      ok: false,
      error: error.message
    })
  }
})

// POST /api/setup/subdivision/assign - Assign district class
app.post('/api/setup/subdivision/assign', async (req, res) => {
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

// POST /api/setup/subdivision/done - Finish city subdivision
app.post('/api/setup/subdivision/done', async (req, res) => {
  try {
    const result = setupPhase.finishSubdivision()
    await autoSave()
    res.json({
      ok: true,
      step: 'DistrictSetup',
      log: result.log
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
app.post('/api/setup/guild', async (req, res) => {
  try {
    const { guildName, leaderName, leaderClass, secondName, secondClass } = req.body
    const result = setupPhase.createPlayerGuild(guildName, leaderName, leaderClass, secondName, secondClass)
    await autoSave()
    res.json({
      ok: result.ok,
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
      setupPhase: setupPhase.serialize()
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

// Start server
app.listen(PORT, () => {
  console.log(`Guild Wars server running on http://localhost:${PORT}`)
})
