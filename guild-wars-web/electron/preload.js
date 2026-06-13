const { contextBridge } = require('electron')

// Inject runtime config the renderer reads in client/config.js. isElectron flips the
// connect screen into thin-client mode (a server address is required; no solo). An
// empty assetBase means absolute /resources/... paths resolve against the app://
// origin, i.e. the bundled resources/ dir served by main.js.
contextBridge.exposeInMainWorld('__GW_CONFIG__', { isElectron: true, assetBase: '' })
