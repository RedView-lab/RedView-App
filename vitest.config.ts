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
      'server/lib/__tests__/**/*.test.ts',
      'test/**/*.test.ts',
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
    // `npm run test:coverage` (étape `test` de `check --full`, donc de la CI).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'api/**/*.ts', 'server/**/*.{ts,mjs}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/__tests__/**',
        '**/*.d.ts',
        'src/shared/test/**',
        // Générés (wasm-bindgen, prebuild-api-i18n).
        'src/features/fitPredictor/engine/pkg/**',
        'src/features/lidar/lib/laz/pkg/**',
        'api/_lib/translations-data.ts',
      ],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      // Cliquet : planchers ~2 points sous la mesure (globale et persistance : 2026-10-08 ; autres zones : 2026-10-07 ; 3 pour le
      // serveur temps réel, dont les tests dépendent du timing : ±0,1 point
      // d'un passage à l'autre). Un test supprimé ou un module critique qui
      // grossit sans tests fait échouer `check --full` ; on remonte les
      // planchers quand la couverture progresse, on ne les baisse pas.
      // Global = tout le code inclus (22,0 % des instructions le 2026-10-08 : l'UI et la
      // carte comptent, la plupart ne se testent qu'en E2E) ; chaque zone
      // ci-dessous a en plus son propre plancher.
      thresholds: {
        statements: 20,
        branches: 17,
        functions: 19,
        lines: 20,
        // Frontières de sécurité et de persistance (CLAUDE.md : tests
        // unitaires d'abord pour elles).
        'src/features/collab/**': { statements: 81, branches: 75, functions: 80, lines: 85 },
        'server/multiplayer/**': { statements: 77, branches: 65, functions: 78, lines: 81 },
        'server/lib/{http-security,project-access}.mjs': { statements: 92, branches: 86, functions: 92, lines: 93 },
        'api/_lib/{accountDeletion,projectSharing}.ts': { statements: 86, branches: 74, functions: 96, lines: 89 },
        'src/features/comments/lib/**': { statements: 75, branches: 71, functions: 84, lines: 78 },
        'src/features/livePresence/lib/**': { statements: 87, branches: 78, functions: 83, lines: 90 },
        // Persistance des projets (62,1 % le 2026-10-08) : le vrai code sur le
        // faux SDK Appwrite du banc + fake-indexeddb (src/shared/test/projectPersistence.ts) ;
        // la simulation script-test-bench/audit/a-persistence-sim.ts garde les gros scénarios.
        'src/shared/services/projects/**': { statements: 60, branches: 54, functions: 61, lines: 64 },
        'src/shared/services/storage/**': { statements: 84, branches: 86, functions: 66, lines: 90 },
        // Ce que sauvegarde une modification, autosave, ouverture, Ctrl+S.
        'src/features/itineraryPanel/lib/project/layers.ts': { statements: 97, branches: 92, functions: 98, lines: 98 },
        'src/pages/Dashboard/hooks/useDashboardProject{Sync,State}.ts': { statements: 83, branches: 70, functions: 84, lines: 85 },
        'src/features/itineraryPanel/components/ItineraryPanelContainer/useProjectSave.ts': { statements: 98, branches: 95, functions: 98, lines: 98 },
      },
    },
  },
})
