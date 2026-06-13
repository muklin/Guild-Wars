# Guild Wars — Electron thin client

A standalone desktop client (ADR-0004). It contains **no game logic and no server** —
it bundles the built SPA + 3D assets and connects to a host-run server at an address you
type on the connect screen. Large assets (`.glb`, textures) load from the local bundle;
game state + the live WebSocket point at the remote server.

## How it works

- `main.js` registers a custom `app://` protocol and serves:
  - `/` and `/assets/...` → the built SPA in `../dist`
  - `/resources/...` → the bundled 3D assets in `../resources`
- `preload.js` injects `window.__GW_CONFIG__ = { isElectron: true, assetBase: '' }`,
  which `client/config.js` reads. `assetBase: ''` makes absolute `/resources/...` paths
  resolve against the `app://` origin (the local bundle). The API base (`apiBase`) is set
  on the connect screen and is the only thing that points at the remote server.

## Run in development

From the web project root, build the SPA so `dist/` exists, then start Electron:

```sh
cd guild-wars-web
npm install
npm run build          # produces dist/ (the SPA the client serves)

cd electron
npm install            # installs electron + electron-builder
npm start              # launches the thin client (electron .)
```

On the connect screen enter the **host address** (e.g. `http://192.168.1.50:3001`) and a
**name**, then Join. The host runs the server with `npm run server` (or `npm run dev`) from
`guild-wars-web/`.

## Package a distributable

```sh
cd guild-wars-web && npm run build      # refresh dist/ first
cd electron && npm run dist             # electron-builder → installers in electron/dist/
```

`extraResources` in `package.json` copies `../dist` and `../resources` next to the packaged
app; `main.js` reads them from `process.resourcesPath` when `app.isPackaged`.

## Version-skew note (ADR-0004)

The server reports an `assetVersion` on `/api/state`; bump `ASSET_VERSION` in
`server/index.js` whenever the bundled asset set changes, and ship a matching Electron
build, so an out-of-date client can be warned rather than silently missing meshes.
