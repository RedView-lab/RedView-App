import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import { APP_BUILD_ID, APP_CACHE_EPOCH, ensureAppCacheEpochReset } from './shared/lib/appCacheEpoch'
import { logger } from './shared/lib/logger'
import { AppI18nProvider } from './shared/i18n'
import { GlobalErrorBoundary } from './shared/components/GlobalErrorBoundary'
import { initAppTheme } from './shared/lib/appTheme'
import './features/map3d/hooks/useMap/serviceWorker'
import './shared/styles/typography.css'
import './shared/styles/theme.css'
import './index.css'
import './shared/styles/glass.css'
import './shared/styles/dropdown.css'
import App from './App.tsx'

const sentryDsn = import.meta.env.VITE_SENTRY_DSN || 'https://560280d647da4557b67bd2e937b5893f@errors.redview.tech/1'

if (sentryDsn && !sentryDsn.includes('placeholder')) {
  Sentry.init({
    dsn: sentryDsn,
    release: APP_BUILD_ID,
    environment: import.meta.env.MODE || 'production',
    ignoreErrors: [
      'ResizeObserver loop',
      'ResizeObserver loop completed with undelivered notifications',
      'AbortError',
      'The operation was aborted',
      'NetworkError',
      'Failed to fetch',
      'Load failed',
      'cancelled',
      'Extension context invalidated',
    ],
    beforeSend(event) {
      // VITE_SENTRY_ALLOW_LOCAL=1 au build : envoi depuis localhost (vérifier
      // les sourcemaps d'un build local, cf. scripts/upload-sourcemaps.mjs).
      const allowLocal = import.meta.env.VITE_SENTRY_ALLOW_LOCAL === '1'
      if (!allowLocal && typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
        return null
      }
      return event
    },
  })
}

// Après un déploiement, les chunks hashés de l'ancien build n'existent plus
// (404) : un import paresseux échoue. On recharge la page une seule fois pour
// récupérer le nouvel index.html ; le garde sessionStorage évite les boucles.
const PRELOAD_ERROR_RELOAD_KEY = 'redview:preload-error-reload-at'
const PRELOAD_ERROR_RELOAD_GUARD_MS = 60_000
window.addEventListener('vite:preloadError', (event) => {
  try {
    const lastReloadAt = Number(sessionStorage.getItem(PRELOAD_ERROR_RELOAD_KEY) || 0)
    if (Date.now() - lastReloadAt < PRELOAD_ERROR_RELOAD_GUARD_MS) return
    sessionStorage.setItem(PRELOAD_ERROR_RELOAD_KEY, String(Date.now()))
  } catch {
    return
  }
  event.preventDefault()
  window.location.reload()
})

// Avant le premier rendu : pas de flash du mauvais thème.
initAppTheme()

async function bootstrap(): Promise<void> {
  const didResetCacheEpoch = await ensureAppCacheEpochReset()

  logger.app.info('build', {
    buildId: APP_BUILD_ID,
    cacheEpoch: APP_CACHE_EPOCH,
    cacheReset: didResetCacheEpoch,
  })

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <GlobalErrorBoundary>
        <AppI18nProvider>
          <App />
        </AppI18nProvider>
      </GlobalErrorBoundary>
    </StrictMode>,
  )
}

void bootstrap()
