import App from './App.js'

// Suppress [perf] log lines by default; DebugPanel toggles this via window.__setPerfLog.
const _nativeLog = console.log.bind(console)
let __perfEnabled = false
console.log = (...args) => {
  if (!__perfEnabled && typeof args[0] === 'string' && args[0].startsWith('[perf]')) return
  _nativeLog(...args)
}
window.__setPerfLog = (on) => { __perfEnabled = on }

const app = new App()
app.init()
