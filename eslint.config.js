import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

const BENCH_IMPORT_MESSAGE = 'script-test-bench/ est absent de l’image de prod : déplacer le code partagé dans src/ (p. ex. src/shared/test/).'

// Erreurs existantes figées dans eslint-suppressions.json (cliquet) : toute
// nouvelle erreur échoue ; `npx eslint . --prune-suppressions` après correction.
export default defineConfig([
  globalIgnores([
    'dist',
    // Générés (wasm-bindgen, prebuild-api-i18n, npm run lidar:index).
    'src/features/fitPredictor/engine/pkg/**',
    'src/features/lidar/lib/laz/pkg/**',
    'script-test-bench/pace-accuracy/.*-pkg/**',
    'api/_lib/translations-data.ts',
    'src/features/lidar/lib/japan/japanLazIndex.ts',
    'src/features/lidar/lib/nz/nzLazIndex.ts',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Même convention que `noUnusedParameters` de tsc : `_x` = inutilisé exprès.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      // `catch {}` best-effort (stockage, caches) : autorisé, les autres blocs vides non.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `let { a, b } = …` dont seul `b` est réaffecté : pas d'erreur.
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  {
    // Code livré (et ses tests) : jamais de dépendance vers les bancs. script-test-bench/
    // est hors de l'image Docker (.dockerignore) : un import y passait en local et
    // cassait `tsc -b` au build de prod (2026-10-08).
    files: ['src/**/*.{ts,tsx}', 'api/**/*.ts', 'server/**/*.{ts,mjs}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/script-test-bench/**'], message: BENCH_IMPORT_MESSAGE }] }],
      // `import('…')` (vi.mock) et `typeof import('…')` échappent à la règle précédente.
      'no-restricted-syntax': ['error',
        { selector: 'ImportExpression[source.value=/script-test-bench/]', message: BENCH_IMPORT_MESSAGE },
        { selector: 'TSImportType Literal[value=/script-test-bench/]', message: BENCH_IMPORT_MESSAGE },
      ],
    },
  },
  {
    // Serveur de prod (livré dans l'image Docker).
    files: ['server.mjs', 'server/lib/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // Scripts de recette (tsx/node) : manipulent des réponses JSON brutes et des mocks.
    files: ['script-test-bench/audit/**/*.ts', 'script-test-bench/pace-accuracy/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
])
