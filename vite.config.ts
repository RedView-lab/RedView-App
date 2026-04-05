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
  server: {
    proxy: {
      '/api/lidar-zones': {
        target: 'https://data.geopf.fr',
        changeOrigin: true,
        rewrite: (path) => {
          const url = new URL(path, 'http://localhost');
          const page = url.searchParams.get('page') || '1';
          return `/telechargement/resource/LiDARHD-NUALID?limit=100&page=${page}`;
        },
      },
      '/api/lidar-download': {
        target: 'https://data.geopf.fr',
        changeOrigin: true,
        rewrite: (path) => {
          const url = new URL(path, 'http://localhost');
          const zone = url.searchParams.get('zone') || '';
          const file = url.searchParams.get('file') || '';
          return `/telechargement/download/LiDARHD-NUALID/${zone}/${file}`;
        },
      },
    },
  },
})
