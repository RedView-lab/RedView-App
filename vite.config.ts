import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    include: ['copc'],
  },
  worker: {
    format: 'es',
  },
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'lidar-viewer': path.resolve(__dirname, 'lidar-viewer.html'),
      },
    },
  },
  assetsInclude: ['**/*.wgsl'],
})
