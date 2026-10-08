# Code structure

[← Docs index](../README.md) · [Repository](../../README.md)

Where a file goes in `src/` and `public/`, and why. The rules below apply to
every folder today. [`npm run check`](../../scripts/README.md) enforces the
parts a tool can check: no unused file or export (knip), no import cycle (madge).

## Where does this file go?

Ask these questions in order:

1. **Is it used by one feature only?** Put it inside that feature.
2. **Is it used by several features and owned by none?** Put it in `shared/`, in
   the folder of its role ([see below](#shared--seven-folders-one-role-each)).
3. **Does it do I/O with our backend?** Put it in `shared/services/`, or in the
   feature's `queries/` for TanStack Query hooks.
4. **Is it a coherent area with its own components, hooks and logic?** Give it a
   named sub-domain folder inside its feature.
5. **Does another feature need a deep internal of it?** Then either that internal
   is public (export it from `index.ts` or `types.ts`), or the code sits in the
   wrong feature.

## Top level of `src/`

```text
src/
  main.tsx, App.tsx, index.css   bootstrap: theme, error reporting, session, lazy Dashboard
  pages/                         one folder per page (composition roots)
  features/                      product domains, feature-sliced
  shared/                        code used by several features, with no business owner
  types/                         ambient declarations only (*.d.ts for untyped packages)
```

Nothing else lives at the root of `src/`. There is no `src/lib`, `src/components` or `src/utils`.

## `shared/` — seven folders, one role each

| Folder | Holds | Examples |
|---|---|---|
| `components/` | React components (a folder when there is a CSS file or helpers) | `RedViewLogo.tsx`, `UserAvatar/`, `AppToaster/` |
| `hooks/` | Generic React hooks | `useLatestRef`, `useHorizontalScrollOverflow` |
| `lib/` | Pure functions and small framework-free modules, with no I/O to our backend | `appScale`, `appTheme`, `notify`, `terrarium`, `analytics/` |
| `services/` | I/O: Appwrite, the TanStack Query client, project persistence | `appwrite.ts`, `queryClient.ts`, `projects/`, `storage/idbProjectStore.ts` |
| `styles/` | Global CSS tokens and shared visual layers | `theme.css`, `typography.css`, `dialog.css` |
| `i18n/` | Translation runtime and the `{ fr, en }` pair files | `AppI18nProvider`, `config/translations/` |
| `test/` | Test helpers shared by several test files | `renderHook.ts` |

There is no `shared/ui` and no `shared/utils`. A new shared file goes in one of
the seven folders above. If none fits, it probably belongs to a feature.

## Shape of a feature

```text
features/<name>/
  index.ts        public API (optional, see "Public API and barrels")
  types.ts        public types (types/ when large)
  components/     React components
  hooks/          React hooks
  lib/            pure logic, data files (e.g. poi/lib/poi-taxonomy.json), the logic run by workers
  context/        React contexts and stores (optional)
  styles/         feature CSS shared by several components (optional)
  queries/        TanStack Query hooks for server state (optional)
  <subdomain>/    a coherent sub-area with its own components/, hooks/, lib/ (optional)
```

1. **The root of a feature holds only `index.ts`, `types.ts` or `types/`,
   `config.ts`, and sub-folders.** A component, hook or helper found at the root
   moves into `components/`, `hooks/` or `lib/`.
2. **Tests sit next to their module:** `foo.ts` → `foo.test.ts`. A test that
   spans several sub-areas sits in their common parent, for example
   `centerPanel/tools/toolDisarm.test.tsx`.
3. **Sub-domains get a real name, never a generic `subfeatures/`.** Examples:
   `centerPanel/flyover`, `centerPanel/tools/<tool>`, `lidar/viewer`,
   `weather/overlay`, `weather/radar`, `controlPanel/sections`,
   `projectBrowser/{account,billing,settings}`, `collab/{client,model,room,sim}`,
   `livePresence/engine`, `comments/bridge`. Sibling sub-domains of the same
   kind are grouped together: `centerPanel/tools/` holds `chartPlacement`,
   `forbiddenZones`, `routeDragWaypoint`, `routeMerge`, `routeSplit` and `tracer`.
4. **One documented exception: a wire contract stays at the root.**
   `collab/protocol.ts`, `wire.ts`, `schema.ts`, `realtime.ts` and
   `routeChunks.ts` form the protocol between client and server. `server/multiplayer`
   and the benches import them. They stay at the feature root, with the tests that
   exercise them end to end (`collab.test.ts`, `presence.test.ts`), so that the
   contract stays visible and stable.

## Public API and barrels

- **When there is an `index.ts`, import the feature through it.** A feature has
  one when other features consume a real public surface: providers, a main
  component, public hooks.
- **Inside a feature, never import its own barrel.** A module that the barrel
  re-exports, directly or transitively, imports concrete modules. Otherwise it
  closes an import cycle, and `npm run cycles` must stay at zero.
- **Keep the project browser light.** The shell never imports the `map3d` or
  `controlPanel` barrels: `npm run bundle:check` keeps mapbox-gl and the 3D
  editor off its critical path.
- **Some small features have no barrel on purpose:** `contourLines`, `labels`,
  `slope` and `poi`. A `poi` barrel would pull its Mapbox marker layer and CSS
  into modules that only need `poi/types`, and would create cycles with `map3d`.
  Their public surface is `types.ts` plus the `lib/` modules their importers name.

## `pages/`

A page is a composition root, with the same shape as a feature:

```text
pages/Dashboard/
  index.tsx        the page
  editorLoader.ts  lazy entry of the 3D editor (kept at the root: it is the code-split point)
  components/      page-only UI (DashboardEditor, place search, loading screen)
  hooks/           page-only hooks (useDashboardChrome, useDashboardProjectState, …)
  lib/             page-only helpers (layout, dashboardProjectCache, editorReadyMeter)
```

## Styles

- **Font sizes and colours come from tokens.** Every font size goes through the
  tokens of `shared/styles/typography.css`, every colour through those of
  `shared/styles/theme.css`. The rules are in [`CLAUDE.md`](../../CLAUDE.md),
  under « Typography » and « Themes ».
- **Component CSS sits next to its component**, as in `UserAvatar/UserAvatar.css`.
  When several components of a feature share a stylesheet, it goes in the
  feature's `styles/` folder, with an `index.css`.
- **Inline styles are for runtime values only:** values computed while the app runs.

## `public/` — static files served as-is

| Path | Holds |
|---|---|
| `icons/ui/` | Interface icons, drawn as masks in `currentColor` through `SvgV2Icon` |
| `icons/poi/` | POI glyphs, pins and badges, the POI cluster icon of the analysis chart |
| `icons/context-menu/` | Icons of the map and POI context menus |
| `flags/` | Country flags of the country and language selectors |
| `brand/` | The RedView logo, in its two colour variants |
| `images/` | Raster images (settings previews, link-preview image `images/og/`) |
| `sw-dem.js`, `sw-dem/` | The tile Service Worker. Any change needs a bump of the cache stamp in the header of `sw-dem.js`. |
| root files | Favicons, app icons, `robots.txt`, the WebAssembly binaries, `france-border.json` |

The code refers to these files by absolute URL (`/icons/ui/…`). Knip does not
see them, so after moving or deleting a file, build the app and check that every
URL the code uses still exists in `dist/`.

## Moving files

- Move files with `git mv`, so their history is kept.
- Rewrite every import in the same commit, including references outside `src/`:
  benches, `server/`, `scripts/`, comments, `CLAUDE.md`.
- `npm run check` must be green on each commit.
- Several sessions can share one working tree. Commit an explicit file list
  (`git commit -- <files>`), never a whole folder.
