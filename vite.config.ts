import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const redviewBuildId = (
  process.env.VERCEL_GIT_COMMIT_SHA
  || process.env.GITHUB_SHA
  || process.env.npm_package_version
  || 'dev'
).slice(0, 12)

// https://vite.dev/config/
export default defineConfig({
  define: {
    __REDVIEW_BUILD_ID__: JSON.stringify(redviewBuildId),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api/lidar/wmts': {
        target: 'https://data.geopf.fr',
        changeOrigin: true,
        rewrite: (p) => {
          // /api/lidar/wmts/19/row/col → /wmts?SERVICE=WMTS&...&TILEMATRIX=19&TILEROW=row&TILECOL=col
          const match = p.match(/\/api\/lidar\/wmts\/(\d+)\/(\d+)\/(\d+)/);
          if (match) {
            const [, zoom, row, col] = match;
            return `/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX=${zoom}&TILEROW=${row}&TILECOL=${col}`;
          }
          return p;
        },
      },
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
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        viewer: path.resolve(__dirname, 'viewer.html'),
      },
    },
  },
})
