// Centralized runtime config: where to reach the API, where to load assets from,
// and the seat key identifying this player to the server.
//
// Both bases default to '' (same-origin), so the browser/Vite dev build is
// unchanged: '/api...' hits the Vite proxy and '/resources/...' is served locally.
// The Electron app injects window.__GW_CONFIG__ (assetBase → bundled resources)
// and the connect screen sets apiBase + seatKey (persisted to localStorage).

const injected = (typeof window !== 'undefined' && window.__GW_CONFIG__) || {}

function stored(key) {
  try { return (typeof localStorage !== 'undefined' && localStorage.getItem(key)) || '' }
  catch { return '' }
}
function persist(key, value) {
  try {
    if (typeof localStorage === 'undefined') return
    if (value) localStorage.setItem(key, value); else localStorage.removeItem(key)
  } catch { /* ignore (private mode / no storage) */ }
}

const config = {
  // Remote game server. '' = same-origin (dev via Vite proxy).
  apiBase: injected.apiBase ?? stored('gw.apiBase'),
  // Local bundled assets. '' = same-origin (server-served in dev).
  assetBase: injected.assetBase ?? '',
  // Per-seat credential attached to every request (see CONTEXT.md: Seat key).
  seatKey: stored('gw.seatKey'),
}

// True when running inside the Electron thin client (set by electron/preload.js).
export const isElectron = !!injected.isElectron

export function setApiBase(url) {
  config.apiBase = (url || '').replace(/\/$/, '')
  persist('gw.apiBase', config.apiBase)
}

export function setSeatKey(key) {
  config.seatKey = key || ''
  persist('gw.seatKey', config.seatKey)
}

// Resolve an asset path like '/resources/foo.glb' against assetBase.
export function assetUrl(path) {
  return `${config.assetBase}${path}`
}

export default config
