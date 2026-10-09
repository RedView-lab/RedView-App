import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import { APP_BUILD_ID, APP_CACHE_EPOCH, ensureAppCacheEpochReset } from './shared/lib/appCacheEpoch'
import { logger } from './shared/lib/logger'
import { AppI18nProvider } from './shared/i18n'
import { GlobalErrorBoundary } from './shared/components/GlobalErrorBoundary'
import { scrubBreadcrumb, scrubErrorEvent } from './shared/lib/errorReportScrub'
import { initAppTheme } from './shared/lib/appTheme'
import { initAnalytics } from './shared/lib/analytics'
import { installStaleBuildRecovery } from './shared/lib/staleBuild'
import './features/map3d/hooks/useMap/serviceWorker'
import './shared/styles/typography.css'
import './shared/styles/theme.css'
import './index.css'
import './shared/styles/glass.css'
import './shared/styles/dropdown.css'
import './shared/styles/dialog.css'
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
      // Chunk d'un ancien build (Firefox, Safari, CSS ; Chromium = « Failed to
      // fetch dynamically imported module ») : attendu après chaque déploiement.
      'error loading dynamically imported module',
      'Importing a module script failed',
      'Unable to preload CSS',
      'Load failed',
      'cancelled',
      'Extension context invalidated',
    ],
    // URLs réduites à leur chemin (jeton de réinitialisation, coordonnées des
    // requêtes) : shared/lib/errorReportScrub.ts.
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    beforeSend(event) {
      // VITE_SENTRY_ALLOW_LOCAL=1 au build : envoi depuis localhost (vérifier
      // les sourcemaps d'un build local, cf. scripts/build/upload-sourcemaps.mjs).
      const allowLocal = import.meta.env.VITE_SENTRY_ALLOW_LOCAL === '1'
      if (!allowLocal && typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
        return null
      }
      return scrubErrorEvent(event)
    },
  })
}

// Onglet d'un ancien build après un déploiement : rechargement ou toast
// (shared/lib/staleBuild.ts).
installStaleBuildRecovery()

// Avant le premier rendu : pas de flash du mauvais thème.
initAppTheme()

// Mesure d'audience anonyme (tracker first-party chargé au repos, prod seulement).
initAnalytics({ surface: 'app', release: APP_BUILD_ID })

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
