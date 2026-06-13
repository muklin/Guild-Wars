# 0004 — Electron thin-client topology: bundled assets, remote API

## Decision

The client ships as a **standalone Electron app** that is a **thin client only** — it
contains no game logic and runs no server. The Express server remains a separate process a
host runs; one server hosts **one game at a time**. On launch the Electron app shows a
**connect** screen where the player types the host's **address** and a **name**, joins, and
receives a Seat key.

The renderer reads two independently configurable bases:

- **`apiBase`** — the typed **remote** server, prepended to API calls (replacing the
  root-relative `fetch('/api...')`), with the Seat key attached as a header.
- **`assetBase`** — the **local, bundled** copy of `resources/` (`.glb` meshes + textures),
  shipped inside the Electron app rather than fetched from the server.

Both default to `''` (same-origin) so the browser/`npm run dev` flow is unchanged.

A **version-skew guard** has the server expose an asset/manifest version; on connect the
client warns if its bundled assets predate what the server expects, preventing silent
missing meshes.

## Why split assets from state

Assets are large and static; shipping them in the app avoids transferring them over the wire
every session and lets the app render even when the host's `/resources` is unavailable. The
cost is that bundled assets can drift from a newer server — accepted, and mitigated by the
version-skew guard.

## Consequences

- Asset loading (`glbPath`/textures, e.g. in `FeatureManager`) and API calls
  (`GameAPI`) must route through `assetBase`/`apiBase` instead of hardcoded `/resources` and
  `/api` roots.
- Distributing a new mesh set means shipping a new Electron build, not just updating the
  server.

## Status

Accepted.

## Context for the three ADR criteria

- **Hard to reverse:** the asset/state split and base-URL threading touch the client's
  loaders, API layer, and build/packaging.
- **Surprising without context:** assets resolve locally while state resolves remotely —
  a future reader would expect one origin for both.
- **Trade-offs:** server-served assets (always current, heavier transfer) vs bundled assets
  (fast/offline, can skew) were weighed; bundled + version-guard was chosen.
