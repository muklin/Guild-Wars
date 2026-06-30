import { resolve } from 'path'

export default {
  root: '.',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), 'index.html'),
        buildingparts: resolve(process.cwd(), 'buildingparts.html'),   // standalone parts gallery
      },
    },
  },
  server: {
    // Bind all interfaces (incl. 127.0.0.1) — without this Vite may bind IPv6-only
    // ([::1]) and a browser resolving localhost→127.0.0.1 hangs. Also enables LAN
    // access for multiplayer testing from other machines.
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/resources': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/game-rules': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true
      }
    }
  }
}
