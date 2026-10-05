import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Autonome : ne pas importer vite.config.ts. Son plugin de dev charge le .env,
// démarre BRouter / le serveur POI et ouvre le tunnel SSH vers le VPS.
export default defineConfig({
  define: {
    __REDVIEW_BUILD_ID__: JSON.stringify('test'),
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    include: [
      'src/**/*.test.{ts,tsx}',
      'api/**/__tests__/**/*.test.ts',
      'server/__tests__/**/*.test.ts',
      'server/multiplayer/**/*.test.ts',
    ],
    environment: 'node',
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
})
