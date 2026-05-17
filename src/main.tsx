import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { APP_BUILD_ID, APP_CACHE_EPOCH, ensureAppCacheEpochReset } from './shared/lib/appCacheEpoch'
import './features/map3d/hooks/useMap/serviceWorker'
import './index.css'
import App from './App.tsx'

async function bootstrap(): Promise<void> {
  const didResetCacheEpoch = await ensureAppCacheEpochReset()

  console.info('[app] build', {
    buildId: APP_BUILD_ID,
    cacheEpoch: APP_CACHE_EPOCH,
    cacheReset: didResetCacheEpoch,
  })

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
