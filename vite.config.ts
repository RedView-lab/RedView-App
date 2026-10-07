import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
// @ts-expect-error JS module without declarations
import { applyVpsTunnel, startDevServices, startVpsTunnel } from './scripts/dev/start-dev-services.mjs'
// @ts-expect-error JS module without declarations
import { parseApiBody, parseApiQuery } from './server/lib/api-request.mjs'
import {
  HttpError,
  bodyLimitFor,
  decodeSafePathname,
  readBodyLimited,
  resolveApiRoute,
  // @ts-expect-error JS module without declarations
} from './server/lib/http-security.mjs'
// @ts-expect-error JS module without declarations
import { serveTileFallback, tileFallbackFamily } from './server/lib/tile-fallbacks.mjs'
// @ts-expect-error JS module without declarations
import { resolveBuildId } from './server/lib/build-id.mjs'

// Identifiant de build (release GlitchTip, tag des sourcemaps, APP_CACHE_EPOCH).
const redviewBuildId: string = resolveBuildId()

/**
 * Vite plugin that serves the API routes (`api/*.ts`) and the tile
 * fallbacks in dev — the dev twin of server.mjs (keep both in sync).
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
          const prebuildScript = path.resolve(__dirname, 'scripts/build/prebuild-api-i18n.mjs')
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
      // on passe par un tunnel SSH (cf. scripts/dev/start-dev-services.mjs).
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

        // 2. Tuiles du Service Worker demandées par une page qu'il ne contrôle
        // pas (même module que server.mjs ; pas de quota en dev).
        const tileFamily = tileFallbackFamily(req.url)
        if (tileFamily) {
          const tileUrl = new URL(req.url, 'http://localhost')
          return serveTileFallback(tileFamily, tileUrl.pathname, tileUrl.searchParams, res)
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
              // Corps plafonné comme en prod
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
              // Build ApiRequest adapter (même décodage que server.mjs)
              const apiReq = Object.assign(req, {
                query: parseApiQuery(urlObj.searchParams),
                cookies: {},
                body: parseApiBody(rawBody, req.headers['content-type']),
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

/**
 * Rapport de bundle (modules, imports et CSS de chaque chunk) écrit hors de
 * dist/ (jamais servi), lu par scripts/quality/check-bundle.mjs : budget et
 * contenu du chargement initial (le gestionnaire de projets ne doit pas tirer
 * l'éditeur 3D).
 */
function redviewBundleReportPlugin(): Plugin {
  const toRelative = (id: string) => path.relative(__dirname, id).split(path.sep).join('/')
  return {
    name: 'redview-bundle-report',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter((output) => output.type === 'chunk')
        .map((chunk) => ({
          fileName: chunk.fileName,
          isEntry: chunk.isEntry,
          isDynamicEntry: chunk.isDynamicEntry,
          facadeModuleId: chunk.facadeModuleId ? toRelative(chunk.facadeModuleId) : null,
          imports: chunk.imports,
          dynamicImports: chunk.dynamicImports,
          importedCss: [...(chunk.viteMetadata?.importedCss ?? [])],
          modules: chunk.moduleIds.map(toRelative),
        }))
      const outDir = path.resolve(__dirname, 'dist-meta')
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, 'bundle-report.json'), JSON.stringify({ chunks }, null, 1))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __REDVIEW_BUILD_ID__: JSON.stringify(redviewBuildId),
  },
  plugins: [react(), redviewDevApiPlugin(), redviewBundleReportPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    // Atteinte seulement par l'import dynamique de la co-édition : pré-groupée
    // au démarrage, sinon sa découverte tardive force une ré-optimisation (504
    // « Outdated Optimize Dep ») et un rechargement de la page en pleine session.
    include: ['fractional-indexing'],
  },
  server: {
    // Exposé sur le LAN uniquement sur demande explicite (REDVIEW_DEV_LAN=1) :
    // le serveur de dev charge tous les secrets du .env dans process.env.
    host: process.env.REDVIEW_DEV_LAN === '1' ? true : 'localhost',
    proxy: {
      // Serveur temps réel de co-édition (server/multiplayer, lancé par startDevServices).
      '/multiplayer': {
        // REDVIEW_MULTIPLAYER_DEV_PORT : un second serveur de dev (autre session) avec son propre serveur temps réel.
        target: `ws://127.0.0.1:${process.env.REDVIEW_MULTIPLAYER_DEV_PORT ?? '17790'}`,
        ws: true,
      },
    },
  },
  build: {
    // Maps produites sans commentaire `sourceMappingURL` : uploadées sur
    // GlitchTip puis supprimées de dist/ au build Docker
    // (scripts/build/upload-sourcemaps.mjs) ; server.mjs ne sert jamais un `.map`.
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

