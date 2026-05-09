import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const SAVES_DIR = path.join(__dirname, 'saves')

async function ensureSavesDir() {
  await fs.mkdir(SAVES_DIR, { recursive: true })
}

export async function saveGame(name, data) {
  await ensureSavesDir()
  const payload = {
    name,
    savedAt: new Date().toISOString(),
    version: 1,
    ...data
  }
  await fs.writeFile(path.join(SAVES_DIR, `${name}.json`), JSON.stringify(payload, null, 2), 'utf8')
  return { name, savedAt: payload.savedAt }
}

export async function loadGame(name) {
  const content = await fs.readFile(path.join(SAVES_DIR, `${name}.json`), 'utf8')
  return JSON.parse(content)
}

export async function listSaves() {
  await ensureSavesDir()
  const files = await fs.readdir(SAVES_DIR)
  const saves = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const content = await fs.readFile(path.join(SAVES_DIR, file), 'utf8')
      const data = JSON.parse(content)
      saves.push({
        name: data.name || file.replace('.json', ''),
        savedAt: data.savedAt,
        phase: data.gameState?.currentPhase,
        step: data.setupPhase?.currentStep
      })
    } catch {
      // skip corrupt files
    }
  }
  return saves.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
}

export async function deleteSave(name) {
  await fs.unlink(path.join(SAVES_DIR, `${name}.json`))
}
