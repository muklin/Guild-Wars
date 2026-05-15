export default {
  root: '.',
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/resources': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
}
