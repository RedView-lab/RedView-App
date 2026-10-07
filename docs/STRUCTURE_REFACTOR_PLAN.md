# RedView-App — `src/` structure convention

Where a file goes in `src/`, and why. This replaces the 2025 migration plan
(`src/lib`, `src/components`, Supabase…): that migration is done, and the last pass
(2026-10-08, commits `refactor(shared|auth,poi,collab|centerPanel|dashboard)`) brought
every folder to the convention below. Moves only, no behaviour change.

## Top level

```text
src/
  main.tsx, App.tsx, index.css   bootstrap (theme, error reporting, session, lazy Dashboard)
  pages/                         one folder per page (composition roots)
  features/                      product domains (feature-sliced)
  shared/                        code used by several features, with no business owner
  types/                         ambient declarations only (*.d.ts for untyped packages)
```

Nothing else at the root of `src/`: no `src/lib`, no `src/components`, no `src/utils`.

## `shared/` — seven folders, one role each

| Folder | Holds | Examples |
|---|---|---|
| `components/` | React components (a folder when it has a CSS file or helpers) | `RedViewLogo.tsx`, `UserAvatar/`, `AppToaster/` |
| `hooks/` | generic React hooks | `useLatestRef`, `useHorizontalScrollOverflow` |
| `lib/` | pure functions and small framework-free modules (no I/O to our backend) | `appScale`, `appTheme`, `notify`, `terrarium`, `analytics/` |
| `services/` | I/O: Appwrite, TanStack Query client, project persistence | `appwrite.ts`, `queryClient.ts`, `projects/`, `storage/idbProjectStore.ts` |
| `styles/` | global CSS tokens and shared visual layers | `theme.css`, `typography.css`, `dialog.css` |
| `i18n/` | translation runtime and the `{ fr, en }` pair files | `AppI18nProvider`, `config/translations/*` |
| `test/` | test helpers shared by several test files | `renderHook.ts` |

There is no `shared/ui` or `shared/utils`: « ui » was split into `components/`
(toaster) and `lib/` (`notify`), « utils » into `lib/` (thumbnails, project location)
and `services/` (project persistence, IndexedDB). A new shared file picks one of the
seven folders above; if none fits, it probably belongs to a feature.

## Feature shell

```text
features/<name>/
  index.ts        public API (optional, see below)
  types.ts        public types (or types/ when large)
  components/     React components
  hooks/          React hooks
  lib/            pure logic, data files (e.g. poi/lib/poi-taxonomy.json), workers' logic
  context/        React contexts/stores (optional)
  styles/         feature CSS when several components share it (optional)
  queries/        TanStack Query hooks for server state (optional)
  <subdomain>/    a coherent sub-area with its own components/hooks/lib (optional)
```

Rules:

1. **The root of a feature holds only `index.ts`, `types.ts`/`types/`, `config.ts`
   and sub-folders.** A component, hook or helper at the root goes into
   `components/`, `hooks/` or `lib/`.
2. **Tests sit next to the module** (`foo.ts` → `foo.test.ts`). A test that spans
   several sub-areas sits in their common parent (`centerPanel/tools/toolDisarm.test.tsx`).
3. **Sub-domains are named folders, not a generic `subfeatures/`.** A sub-domain is a
   folder with its own shell, used for a real product area:
   `centerPanel/flyover`, `centerPanel/tools/<tool>`, `lidar/viewer`,
   `weather/overlay`, `weather/radar`, `controlPanel/sections`,
   `projectBrowser/{account,billing,settings}`, `collab/{client,model,room,sim}`,
   `livePresence/engine`, `comments/bridge`. Several sibling sub-domains of the same
   kind are grouped (`centerPanel/tools/` holds chartPlacement, forbiddenZones,
   routeDragWaypoint, routeMerge, routeSplit and tracer).
4. **Documented exception — a wire contract stays at the root.** `collab/protocol.ts`,
   `wire.ts`, `schema.ts`, `realtime.ts` and `routeChunks.ts` are imported by
   `server/multiplayer` and the benches as the protocol between client and server;
   they stay at the feature root so that contract is visible and stable, with the
   tests that exercise it end to end (`collab.test.ts`, `presence.test.ts`).

## Public API and barrels

- A feature has an `index.ts` when other features consume a real public surface
  (providers, a main component, public hooks). Import such a feature through it.
- **Exception (CLAUDE.md):** a module that the barrel re-exports, directly or
  transitively, imports concrete modules, never the barrel — otherwise it closes
  an import cycle (`npm run cycles` must stay at 0).
- **The shell never imports the `map3d`/`controlPanel` barrels** (`npm run bundle:check`
  keeps mapbox-gl and the editor off the project-browser critical path).
- Leaf features with a handful of deep imports (`contourLines`, `labels`, `slope`,
  `poi`) deliberately have no barrel: a `poi` barrel would put its Mapbox marker
  layer and CSS on paths that only need `poi/types`, and would create cycles with
  `map3d`. Their public surface is `types.ts` plus the `lib/` modules named by their
  importers.

## `pages/`

A page is a composition root, with the same shell:

```text
pages/Dashboard/
  index.tsx        the page
  editorLoader.ts  lazy entry of the 3D editor (kept at the root: it is the split point)
  components/      page-only UI (DashboardEditor, place search, loading)
  hooks/           page-only hooks (useDashboardChrome, useDashboardProjectState, …)
  lib/             page-only helpers (layout, dashboardProjectCache, editorReadyMeter)
```

## Styles

- Every font size goes through `shared/styles/typography.css` tokens; colours through
  `shared/styles/theme.css` (see CLAUDE.md « Typography » and « Themes »).
- A component with its own CSS keeps it next to it (`UserAvatar/UserAvatar.css`);
  a feature whose components share a shell uses `styles/` with an `index.css`.
- Inline styles only for values computed at runtime.

## Where does this file go?

1. Used by one feature only → inside that feature.
2. Used by several features and owned by none → `shared/`, in the folder of its role.
3. It does I/O with our backend → `shared/services/` (or the feature's `queries/`).
4. It is a coherent area with its own components, hooks and logic → a named sub-domain folder.
5. Another feature needs a deep internal of it → either that internal is public
   (export it from `index.ts`/`types.ts`) or the code is in the wrong feature.

## Moving files

Moves use `git mv` (history kept). Every import is rewritten in the same commit,
including paths outside `src/` (benches under `script-test-bench/`, `server/`,
`scripts/`, comments, CLAUDE.md); `npm run check` (typecheck, typecheck:bench, lint,
test, knip, cycles) must be green on each commit.
