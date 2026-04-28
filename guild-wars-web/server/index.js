import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import GameStateManager from './engine/GameStateManager.js'
import SetupPhase from './engine/SetupPhase.js'

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

// Routes

// GET     - Return full game state
app.get('/api/state', (req, res) => {
  res.json(gameStateManager.getStateSnapshot())
})

// POST /api/setup/init - Initialize setup phase
app.post('/api/setup/init', (req, res) => {
  try {
    const result = setupPhase.initialize()
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
app.post('/api/setup/terrain/assign', (req, res) => {
  try {
    const { regionId, terrainType } = req.body
    const result = setupPhase.assignTerrainToRegion(regionId, terrainType)
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

// POST /api/setup/terrain/done - Finish terrain placement
app.post('/api/setup/terrain/done', (req, res) => {
  try {
    const result = setupPhase.finishTerrain()
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
app.post('/api/setup/subdivision/assign', (req, res) => {
  try {
    const { districtId, districtClass } = req.body
    const result = setupPhase.assignDistrictClass(districtId, districtClass)
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
app.post('/api/setup/subdivision/done', (req, res) => {
  try {
    const result = setupPhase.finishSubdivision()
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
app.post('/api/setup/guild', (req, res) => {
  try {
    const { guildName, leaderName, leaderClass, secondName, secondClass } = req.body
    const result = setupPhase.createPlayerGuild(guildName, leaderName, leaderClass, secondName, secondClass)
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

// Fallback - serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'))
})

// Start server
app.listen(PORT, () => {
  console.log(`Guild Wars server running on http://localhost:${PORT}`)
})
