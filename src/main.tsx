import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import { APP_BUILD_ID, APP_CACHE_EPOCH, ensureAppCacheEpochReset } from './shared/lib/appCacheEpoch'
import { logger } from './shared/lib/logger'
import { AppI18nProvider } from './shared/i18n'
import { GlobalErrorBoundary } from './shared/components/GlobalErrorBoundary'
import './features/map3d/hooks/useMap/serviceWorker'
import './index.css'
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
      if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
        return null
      }
      return event
    },
  })
}

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
