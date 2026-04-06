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
  server: {
    proxy: {
      '/api/lidar': {
        target: 'https://data.geopf.fr',
        changeOrigin: true,
        rewrite: (p) => {
          // /api/lidar/zones?page=N → /telechargement/resource/LiDARHD-NUALID?page=N
          if (p.startsWith('/api/lidar/zones')) {
            return p.replace('/api/lidar/zones', '/telechargement/resource/LiDARHD-NUALID');
          }
          // /api/lidar/download/ZONE/FILE → /telechargement/download/LiDARHD-NUALID/ZONE/FILE
          return p.replace('/api/lidar/download/', '/telechargement/download/LiDARHD-NUALID/');
        },
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        viewer: path.resolve(__dirname, 'viewer.html'),
      },
    },
  },
})
