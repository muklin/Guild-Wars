const { app, BrowserWindow, protocol, net } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Guild Wars thin client (ADR-0004). The bundled SPA (dist/) and bundled assets
// (resources/) are served over a custom app:// origin so absolute paths like
// /assets/... and /resources/... resolve from the local bundle, while the game
// API + WebSocket point at a remote server chosen on the connect screen (apiBase).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

function roots() {
  // Packaged: dist/ and resources/ are copied next to the app (process.resourcesPath)
  // via electron-builder extraResources. Dev: they live one level up in guild-wars-web/.
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
  return { dist: path.join(base, 'dist'), resources: path.join(base, 'resources') }
}

function resolveFile(pathname) {
  const { dist, resources } = roots()
  const p = decodeURIComponent(pathname)
  if (p === '/' || p === '') return path.join(dist, 'index.html')
  if (p.startsWith('/resources/')) return path.join(resources, p.slice('/resources/'.length))
  return path.join(dist, p.replace(/^\/+/, ''))
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url)
    return net.fetch(pathToFileURL(resolveFile(pathname)).toString())
  })

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadURL('app://app/index.html')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
