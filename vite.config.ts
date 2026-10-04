import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
// @ts-expect-error JS module without declarations
import { applyVpsTunnel, startDevServices, startVpsTunnel } from './scripts/start-dev-services.mjs'
// @ts-expect-error JS module without declarations
import { recolorRadarPng } from './server/radar-recolor.mjs'
// @ts-expect-error JS module without declarations
import { generateSlopeTile, generateAltitudeTile } from './server/terrain-tiles.mjs'
import {
  HttpError,
  bodyLimitFor,
  buildRadarUpstreamUrl,
  decodeSafePathname,
  parseTileCoords,
  readBodyLimited,
  resolveApiRoute,
  // @ts-expect-error JS module without declarations
} from './server/http-security.mjs'
// @ts-expect-error JS module without declarations
import { resolveBuildId } from './server/build-id.mjs'

// Identifiant de build (release GlitchTip, tag des sourcemaps, APP_CACHE_EPOCH).
const redviewBuildId: string = resolveBuildId()

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
        process.env[key] = value
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
      // Amonts du .env sur le VPS : son nginx refuse les postes de dev (403),
      // on passe par un tunnel SSH (cf. scripts/start-dev-services.mjs).
      void startVpsTunnel(process.env)

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

        // 2b. Fallback proxy for /radar-tiles/ when SW is not controlling the page
        if (req.url.startsWith('/radar-tiles/')) {
          try {
            const urlObj = new URL(req.url, 'http://localhost')
            const coords = parseTileCoords(urlObj.pathname, /^\/radar-tiles\/(\d+)\/(\d+)\/(\d+)/)
            // Même allowlist d'hôtes / regex de chemin que server.mjs (anti-SSRF).
            const target: string | null = coords ? buildRadarUpstreamUrl(urlObj.searchParams, coords) : null
            if (target) {
              const upstreamRes = await fetch(target, { signal: AbortSignal.timeout(10_000) })
              if (upstreamRes.ok && (upstreamRes.headers.get('content-type') || '').startsWith('image/')) {
                res.statusCode = 200
                res.setHeader('Content-Type', 'image/png')
                res.setHeader('Cache-Control', 'public, max-age=300')
                const rawBuf = Buffer.from(await upstreamRes.arrayBuffer())
                const pStr = urlObj.searchParams.get('p') || ''
                const finalBuf = pStr ? recolorRadarPng(rawBuf, pStr) : rawBuf
                return res.end(finalBuf)
              }
            }
          } catch (e) {
            console.warn('[vite-radar-tiles-fallback] error:', e)
          }
          // Pas de tuile : 204 jamais mis en cache (même contrat que server.mjs)
          res.statusCode = 204
          res.setHeader('Cache-Control', 'no-store')
          return res.end()
        }

        // 2b'. Sans SW : /dem-tiles et /vhr-tiles n'ont pas de repli (la page
        // non contrôlée utilise AWS Terrarium en direct, Mapbox Satellite reste
        // visible sans l'ortho très haute résolution) et les préchargements `?pf=1` sont
        // inutiles → 204 immédiat (même contrat que server.mjs).
        if (
          req.url.startsWith('/dem-tiles/')
          || req.url.startsWith('/vhr-tiles/')
          || (/^\/(?:radar|slope|altitude)-tiles\//.test(req.url)
            && new URL(req.url, 'http://localhost').searchParams.get('pf') === '1')
        ) {
          res.statusCode = 204
          res.setHeader('Cache-Control', 'no-store')
          return res.end()
        }

        // 2c. Fallback for /slope-tiles/ when SW is not controlling the page
        if (req.url.startsWith('/slope-tiles/')) {
          try {
            const urlObj = new URL(req.url, 'http://localhost')
            const coords = parseTileCoords(urlObj.pathname, /^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)/)
            if (coords) {
              const pngBuf: Buffer | null = await generateSlopeTile(coords.z, coords.x, coords.y)
              if (pngBuf) {
                res.statusCode = 200
                res.setHeader('Content-Type', 'image/png')
                res.setHeader('Cache-Control', 'public, max-age=604800')
                res.setHeader('Access-Control-Allow-Origin', '*')
                res.setHeader('X-Tile-Type', 'slope')
                return res.end(pngBuf)
              }
            }
          } catch (e) {
            console.warn('[vite-slope-tiles-fallback] error:', e)
          }
          // Pas de tuile : 204 jamais mis en cache (même contrat que server.mjs)
          res.statusCode = 204
          res.setHeader('Cache-Control', 'no-store')
          return res.end()
        }

        // 2d. Fallback for /altitude-tiles/
        if (req.url.startsWith('/altitude-tiles/')) {
          try {
            const urlObj = new URL(req.url, 'http://localhost')
            const coords = parseTileCoords(urlObj.pathname, /^\/altitude-tiles\/(\d+)\/(\d+)\/(\d+)/)
            if (coords) {
              const pngBuf: Buffer | null = await generateAltitudeTile(coords.z, coords.x, coords.y)
              if (pngBuf) {
                res.statusCode = 200
                res.setHeader('Content-Type', 'image/png')
                res.setHeader('Cache-Control', 'public, max-age=604800')
                res.setHeader('Access-Control-Allow-Origin', '*')
                res.setHeader('X-Tile-Type', 'altitude')
                return res.end(pngBuf)
              }
            }
          } catch (e) {
            console.warn('[vite-altitude-tiles-fallback] error:', e)
          }
          // Pas de tuile : 204 jamais mis en cache (même contrat que server.mjs)
          res.statusCode = 204
          res.setHeader('Cache-Control', 'no-store')
          return res.end()
        }

        // 3. Match /api/* routes to api/*.ts handlers
        if (req.url.startsWith('/api/')) {
          // Keep process.env fresh with latest .env changes in dev
          try {
            const devEnv = loadEnv(server.config.mode, __dirname, '')
            for (const [key, value] of Object.entries(devEnv)) {
              process.env[key] = value
            }
          } catch {
            // ignore
          }
          // Tunnel vers le VPS (ouvert au démarrage, rouvert s'il est tombé).
          await startVpsTunnel(process.env)
          applyVpsTunnel(process.env)

          const urlObj = new URL(req.url, 'http://localhost')
          const pathname: string | null = decodeSafePathname(urlObj.pathname)
          // Même résolution que server.mjs : pas de `..` encodé, pas de `_lib/`,
          // alias openmeteo/weather/brouter.
          const apiRoute: { route: string; file: string } | null = pathname
            ? resolveApiRoute(path.resolve(__dirname, 'api'), pathname)
            : null

          if (apiRoute) {
            const candidateFile = apiRoute.file
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

              // Read and parse request body (plafonné comme en prod)
              let rawBody: Buffer
              try {
                rawBody = await readBodyLimited(req, bodyLimitFor(apiRoute.route))
              } catch (err) {
                if (err instanceof HttpError) {
                  res.statusCode = (err as Error & { status: number }).status
                  res.setHeader('Content-Type', 'application/json; charset=utf-8')
                  res.setHeader('Connection', 'close')
                  res.on('finish', () => req.destroy())
                  res.end(JSON.stringify({ error: (err as Error).message }))
                  return
                }
                throw err
              }
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

              // Build ApiRequest adapter
              const apiReq = Object.assign(req, {
                query,
                cookies: {},
                body: parsedBody,
                [Symbol.asyncIterator]: async function* () {
                  yield rawBody
                },
              })

              // Build ApiResponse adapter
              const apiRes = Object.assign(res, {
                status(code: number) {
                  res.statusCode = code
                  return apiRes
                },
                json(data: unknown) {
                  if (!res.headersSent) {
                    res.setHeader('Content-Type', 'application/json; charset=utf-8')
                  }
                  res.end(JSON.stringify(data))
                  return apiRes
                },
                send(data: unknown) {
                  if (Buffer.isBuffer(data)) {
                    res.end(data)
                  } else if (typeof data === 'string') {
                    res.end(data)
                  } else {
                    apiRes.json(data)
                  }
                  return apiRes
                },
                redirect(statusOrUrl: string | number, url?: string) {
                  if (typeof statusOrUrl === 'string') {
                    res.writeHead(307, { Location: statusOrUrl })
                  } else {
                    res.writeHead(statusOrUrl, { Location: url! })
                  }
                  res.end()
                  return apiRes
                },
              })

              // Invalidate candidate module in dev so updates are reflected without wiping entire dev graph
              const modNode = server.moduleGraph.getModuleById(candidateFile)
              if (modNode) {
                server.moduleGraph.invalidateModule(modNode)
              }
              const mod = await server.ssrLoadModule(candidateFile)
              const handler = mod.default || mod

              if (typeof handler === 'function') {
                await handler(apiReq, apiRes)
                return
              } else {
                console.error(`[redview-dev-api] Handler in ${candidateFile} is not a function`)
                res.statusCode = 500
                res.end(JSON.stringify({ error: 'Internal Server Error' }))
                return
              }
            } catch (err) {
              console.error(`[redview-dev-api] Error handling ${req.url}:`, err)
              if (!res.headersSent) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ error: 'Internal dev server API error' }))
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
    // Exposé sur le LAN uniquement sur demande explicite (REDVIEW_DEV_LAN=1) :
    // le serveur de dev charge tous les secrets du .env dans process.env.
    host: process.env.REDVIEW_DEV_LAN === '1' ? true : 'localhost',
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
    // Maps produites sans commentaire `sourceMappingURL` : uploadées sur
    // GlitchTip puis supprimées de dist/ au build Docker
    // (scripts/upload-sourcemaps.mjs) ; server.mjs ne sert jamais un `.map`.
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        viewer: path.resolve(__dirname, 'viewer.html'),
      },
    },
  },
})

