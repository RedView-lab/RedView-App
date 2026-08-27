import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
// @ts-expect-error JS module without declarations
import { startDevServices } from './scripts/start-dev-services.mjs'

const redviewBuildId = (
  process.env.VERCEL_GIT_COMMIT_SHA
  || process.env.GITHUB_SHA
  || process.env.npm_package_version
  || 'dev'
).slice(0, 12)

/**
 * Vite plugin that serves serverless API routes (`api/*.ts`) and handles
 * rewrites locally without needing `vercel dev`.
 */
function redviewDevApiPlugin(): Plugin {
  return {
    name: 'redview-dev-api',
    configResolved(config) {
      // Ensure .env and .env.local variables are available in process.env for API handlers
      const env = loadEnv(config.mode, process.cwd(), '')
      for (const [key, value] of Object.entries(env)) {
        if (process.env[key] === undefined) {
          process.env[key] = value
        }
      }

      // Auto-generate translations data if not present
      const translationsDataFile = path.resolve(__dirname, 'api/_lib/translations-data.ts')
      if (!fs.existsSync(translationsDataFile)) {
        try {
          const prebuildScript = path.resolve(__dirname, 'scripts/prebuild-api-i18n.mjs')
          if (fs.existsSync(prebuildScript)) {
            import('child_process').then((cp) => cp.execSync(`node "${prebuildScript}"`))
          }
        } catch (e) {
          console.warn('[redview-dev-api] Warning running prebuild-api-i18n:', e)
        }
      }
    },
    configureServer(server: ViteDevServer) {
      // Auto-start BRouter (17777) and POI server (17778)
      startDevServices().catch((err: unknown) => {
        console.warn('[redview-dev-api] Error starting dev services:', err)
      })

      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next()

        // 1. Rewrite /viewer to /viewer.html
        if (req.url === '/viewer' || req.url.startsWith('/viewer?') || req.url.startsWith('/viewer/')) {
          const queryIndex = req.url.indexOf('?')
          const query = queryIndex !== -1 ? req.url.slice(queryIndex) : ''
          req.url = '/viewer.html' + query
          return next()
        }

        // 2. Bypass /api/lidar which is handled by Vite proxy to IGN
        if (req.url.startsWith('/api/lidar')) {
          return next()
        }

        // 3. Match /api/* routes to api/*.ts handlers
        if (req.url.startsWith('/api/')) {
          const urlObj = new URL(req.url, 'http://localhost')
          let pathname = urlObj.pathname

          // Normalize /api/openmeteo/... to /api/openmeteo
          if (pathname.startsWith('/api/openmeteo')) {
            pathname = '/api/openmeteo'
          }

          const relPath = pathname.replace(/^\/api\//, '')
          const candidateFile = path.resolve(__dirname, 'api', `${relPath}.ts`)

          if (fs.existsSync(candidateFile)) {
            try {
              // Parse query parameters
              const query: Record<string, string | string[]> = {}
              for (const [key, value] of urlObj.searchParams.entries()) {
                if (key in query) {
                  const existing = query[key]
                  if (Array.isArray(existing)) {
                    existing.push(value)
                  } else {
                    query[key] = [existing, value]
                  }
                } else {
                  query[key] = value
                }
              }

              // Read and parse request body
              const chunks: Buffer[] = []
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                for await (const chunk of req) {
                  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
                }
              }
              const rawBody = Buffer.concat(chunks)
              const contentType = (req.headers['content-type'] || '').toLowerCase()
              let parsedBody: unknown = rawBody

              if (contentType.includes('application/json')) {
                try {
                  parsedBody = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf-8')) : {}
                } catch {
                  parsedBody = rawBody.toString('utf-8')
                }
              } else if (
                contentType.includes('text/') ||
                contentType.includes('application/x-www-form-urlencoded')
              ) {
                parsedBody = rawBody.toString('utf-8')
              }

              // Build VercelRequest adapter
              const vercelReq = Object.assign(req, {
                query,
                cookies: {},
                body: parsedBody,
                [Symbol.asyncIterator]: async function* () {
                  yield rawBody
                },
              })

              // Build VercelResponse adapter
              const vercelRes = Object.assign(res, {
                status(code: number) {
                  res.statusCode = code
                  return vercelRes
                },
                json(data: unknown) {
                  if (!res.headersSent) {
                    res.setHeader('Content-Type', 'application/json; charset=utf-8')
                  }
                  res.end(JSON.stringify(data))
                  return vercelRes
                },
                send(data: unknown) {
                  if (Buffer.isBuffer(data)) {
                    res.end(data)
                  } else if (typeof data === 'string') {
                    res.end(data)
                  } else {
                    vercelRes.json(data)
                  }
                  return vercelRes
                },
                redirect(statusOrUrl: string | number, url?: string) {
                  if (typeof statusOrUrl === 'string') {
                    res.writeHead(307, { Location: statusOrUrl })
                  } else {
                    res.writeHead(statusOrUrl, { Location: url! })
                  }
                  res.end()
                  return vercelRes
                },
              })

              // Load module with Vite SSR (compiles TS automatically)
              const mod = await server.ssrLoadModule(candidateFile)
              const handler = mod.default || mod

              if (typeof handler === 'function') {
                await handler(vercelReq, vercelRes)
                return
              } else {
                console.error(`[redview-dev-api] Handler in ${candidateFile} is not a function`)
                res.statusCode = 500
                res.end(JSON.stringify({ error: `Handler in ${relPath}.ts is not a function` }))
                return
              }
            } catch (err) {
              console.error(`[redview-dev-api] Error handling ${req.url}:`, err)
              if (!res.headersSent) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(
                  JSON.stringify({
                    error: 'Internal dev server API error',
                    detail: err instanceof Error ? err.message : String(err),
                  }),
                )
              }
              return
            }
          }
        }

        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __REDVIEW_BUILD_ID__: JSON.stringify(redviewBuildId),
  },
  plugins: [react(), redviewDevApiPlugin()],
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
          const match = p.match(/\/api\/lidar\/wmts\/(\d+)\/(\d+)\/(\d+)/)
          if (match) {
            const [, zoom, row, col] = match
            return `/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX=${zoom}&TILEROW=${row}&TILECOL=${col}`
          }
          return p
        },
      },
      '/api/lidar': {
        target: 'https://data.geopf.fr',
        changeOrigin: true,
        rewrite: (p) => {
          // /api/lidar/zones?page=N → /telechargement/resource/LiDARHD-NUALID?page=N
          if (p.startsWith('/api/lidar/zones')) {
            return p.replace('/api/lidar/zones', '/telechargement/resource/LiDARHD-NUALID')
          }
          // /api/lidar/download/ZONE/FILE → /telechargement/download/LiDARHD-NUALID/ZONE/FILE
          return p.replace('/api/lidar/download/', '/telechargement/download/LiDARHD-NUALID/')
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

