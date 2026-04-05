import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import type { Plugin } from 'vite'

/**
 * Dev middleware that replicates the Vercel serverless function
 * for /api/ign-dem/{z}/{x}/{y} — processes IGN BIL tiles into Terrain-RGB PNGs.
 * In production, Vercel handles this via api/ign-dem/[z]/[x]/[y].ts.
 */
function ignDemDevPlugin(): Plugin {
  return {
    name: 'ign-dem-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/ign-dem\/(\d+)\/(\d+)\/(\d+)/);
        if (!match) return next();

        try {
          // Dynamic import of the serverless function's core logic
          const handler = await import('./api/ign-dem/[z]/[x]/[y]');

          // Create a minimal mock of VercelRequest/VercelResponse
          const fakeReq = { method: req.method, query: { z: match[1], x: match[2], y: match[3] } };
          let statusCode = 200;
          const headers: Record<string, string> = {};

          const fakeRes = {
            status(code: number) { statusCode = code; return fakeRes; },
            json(data: unknown) { res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
            send(data: Buffer) { res.writeHead(statusCode, headers); res.end(data); },
            end() { res.writeHead(statusCode, headers); res.end(); },
            setHeader(k: string, v: string) { headers[k] = v; },
          };

          await handler.default(fakeReq as any, fakeRes as any);
        } catch (err) {
          console.error('[ign-dem-dev]', err);
          res.writeHead(500);
          res.end('Internal Server Error');
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
