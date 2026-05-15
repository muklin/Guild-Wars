# Guild Wars Web

A Three.js + Node.js web port of the Guild Wars strategy game.

## Setup

```bash
npm install
npm run dev
```

This starts:
- **Vite dev server** on http://localhost:5173 with HMR
- **Express server** on http://localhost:3001 (proxied via Vite)

## Project Structure

- **client/** - Three.js rendering and HTML UI
  - `rendering/` - Three.js scene, camera, terrain/edge meshes
  - `ui/` - UIManager and panel classes
  - `api/` - REST API wrapper
  - `core/` - EventBus for decoupled communication

- **server/** - Node.js game engine
  - `engine/` - GameStateManager, SetupPhase, game logic
  - `engine/voronoi/` - Voronoi terrain generation (stub for now)
  - `engine/domain/` - Guild, District, Faction data models

## Development Status

### Phase 1: Setup Phase + Three.js World
- ✅ Project scaffold
- ✅ Three.js terrain/edge rendering
- ✅ Camera controller (WASD + scroll)
- ✅ Input handling (click detection)
- ✅ Express server with REST routes
- ✅ GameStateManager
- ⏳ Terrain assignment UI flow
- ⏳ City subdivision
- ⏳ Voronoi algorithm (currently stubbed with grid layout)

### Phase 2: Game Loop
- PlanningPhase
- ExecutionPhase (combat)
- UpkeepPhase / BillsPhase
- Action system

### Phase 3: Polish
- WebSocket for planning timer
- Camera improvements
- Full Voronoi implementation

## Current Limitations

- Voronoi terrain is stubbed with a grid layout (will be replaced with real Bowyer-Watson algorithm)
- No persistence yet (in-memory only)
- Single player only

## How to Play

1. **Terrain Setup**: Click terrain regions to select them, choose a type (Plains, Desert, etc.), click "Apply"
2. **City Subdivision**: Click city districts, assign classes (Market, Military, etc.)
3. **Guild Creation**: Enter your guild and leader names

## Architecture Notes

- **Server-authoritative**: All game logic runs on server; client is a thin renderer
- **REST API**: Client sends intent via POST, server returns updated state
- **EventBus**: Decoupled UI/rendering communication on client side
- **Orthographic Camera**: Isometric view suitable for RTS-style games
