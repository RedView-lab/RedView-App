import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import type { Plugin } from 'vite'
import { processDemTile } from './api/lib/dem-processor'

/**
 * Dev middleware that serves /api/ign-dem/{z}/{x}/{y} using the shared DEM processor.
 * In production, Vercel serverless handles this via api/ign-dem/[z]/[x]/[y].ts.
 */
function ignDemDevPlugin(): Plugin {
  return {
    name: 'ign-dem-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/ign-dem\/(\d+)\/(\d+)\/(\d+)/);
        if (!match) return next();

        const z = parseInt(match[1], 10);
        const x = parseInt(match[2], 10);
        const y = parseInt(match[3], 10);

        try {
          const token = process.env.VITE_MAPBOX_TOKEN || process.env.MAPBOX_TOKEN || '';
          const result = await processDemTile(z, x, y, token);

          if (!result) {
            res.writeHead(204);
            res.end();
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(result.data);
        } catch (err) {
          console.error('[ign-dem-dev]', err);
          res.writeHead(500);
          res.end();
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ignDemDevPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
