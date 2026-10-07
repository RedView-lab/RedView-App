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
    setupFiles: ['./vitest.setup.ts'],
    // Le runner CI (4 vCPU) fait tourner tsc, ESLint, madge et knip en même
    // temps que Vitest : un test de 0,7 s y a dépassé 5 s (53e53a3). En local
    // le délai par défaut reste, pour qu'un test devenu lent s'y voie.
    ...(process.env.CI ? { testTimeout: 20_000, hookTimeout: 30_000 } : {}),
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
})
