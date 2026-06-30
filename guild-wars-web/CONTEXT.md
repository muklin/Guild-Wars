# Guild Wars Web — General

A collaborative city-building and guild-competition game. The web app manages setup (terrain, city, streets, guilds) and the live game loop (round phases, actions, factions, resources). This context covers the full server-and-client system.

**See also:**
- [CONTEXT_WorldTerrain.md](CONTEXT_WorldTerrain.md) — World terrain, districts, streets, blocks, plots (all spatial concepts)
- [CONTEXT_BuildingsRoofs.md](CONTEXT_BuildingsRoofs.md) — Parametric buildings, roofs
- [CONTEXT_PhasesEntitiesCards.md](CONTEXT_PhasesEntitiesCards.md) — Setup/game phases, guilds, factions, cards
- [CONTEXT_ResourcesServices.md](CONTEXT_ResourcesServices.md) — Gold, Labour, and other resources

## Language

### Multiplayer & Turns

**Player**:
A human participant in a game. A player controls exactly one Guild.
_Avoid_: user, client

**Seat**:
A player's claimed place in a game — a name plus a server-issued Seat key. Created by joining a host's server; one game has a fixed set of seats.
_Avoid_: account, session, slot

**Seat key**:
The per-seat credential a client attaches to every request so the server knows which player is acting. Deliberately *not* called a "token".
_Avoid_: token (reserved for the game Token economy), session id, auth token

**Initiative**:
The server-fixed turn order, set by an in-app d20 roll per seat, that drives whose turn it is during the Setup sub-phases.
_Avoid_: turn order, play order

**Reversed Initiative**:
Initiative walked back-to-front. District Setup proceeds in Reversed Initiative; Terrain Setup and Guild Creation proceed in forward Initiative.
_Avoid_: reverse order

**Token**:
A per-player game counter spent during play — one of Veto, Guild, Character, or Round Token. Distinct from a Seat key (which is the auth credential).
_Avoid_: seat key, credential

**Lobby**:
The pre-Setup state where seats gather and Initiative is rolled before Terrain Setup begins.
_Avoid_: waiting room, staging

### Walk Mode

**Avatar**:
The player's walking figure in Walk Mode — body, head, position, and heading. Rendered in WalkMode.js and CharacterSheet.js (which still use internal names like `_char`/`characterPosition` — not renamed by the minimap feature that introduced this term).
_Avoid_: character (reserved for the Character Token), player model

## UI Rules

**Click blocking**: Every floating panel, window, or fixed UI element must stop both `click` and `mousedown` from reaching the 3-D map beneath it. Add `el.addEventListener('click', (e) => e.stopPropagation())` and `el.addEventListener('mousedown', (e) => e.stopPropagation())` at the root element of every UI surface.

**Drag-then-click pass-through**: When a draggable window is released after being dragged, the browser synthesises a `click` event at the release position, which can hit the map. Fix: track `didDrag` in the drag handler; on `mouseup`, if `didDrag` is true register a one-shot capture-phase click handler (`document.addEventListener('click', fn, true)`) that calls `e.stopPropagation()` and immediately removes itself.

**Full-screen modal input blocking**: When a full-screen blocking modal (e.g. the system/menu dialogue) is open, call `renderer.cameraController.setEnabled(false)` to disable WASD, mouse-wheel zoom, and middle-click pan in addition to stopping click/mousedown propagation. Re-enable with `setEnabled(true)` when the modal closes. The action panel (bottom-right, hosts Done and future action buttons) follows the same click-blocking rule and should always be a panel element, never a bare floating button.

## Rendering Rules

**Ground plane at Y = 0, no layering**: Every polygon that sits on the ground plane (terrain plots, city block plots, streets, squares, city block fills) is rendered at exactly `GROUND_Y = 0`. There are no fudge-factor offsets (e.g. +0.002 or −0.001). The ground is a set of perfectly abutting polygons where every (X, Z) point is covered by exactly one polygon — no z-fighting, no layering. Do NOT introduce Y-offset hacks to resolve z-fighting; instead ensure non-overlapping geometry is generated at the data level. (The **Y = 0** clause is provisional pending the per-point z-height feature — see TODO.md "Groundplane Z-height"; the **perfect-abutment / exactly-one-polygon-per-(X,Z)** clause is permanent and is what the Groundplane contiguity bug fixes restore.)
