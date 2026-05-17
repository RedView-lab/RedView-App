import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ensureAppCacheEpochReset } from './shared/lib/appCacheEpoch'
import './features/map3d/hooks/useMap/serviceWorker'
import './index.css'
import App from './App.tsx'

async function bootstrap(): Promise<void> {
  await ensureAppCacheEpochReset()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
