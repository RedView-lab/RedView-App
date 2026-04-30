# RedView-App Structure Refactor Plan

## Objective

Reorganize the application into a predictable, scalable folder structure without changing business behavior.

Scope for the future migration:
- move files and folders
- normalize barrel exports and import paths
- group styles coherently
- clarify feature boundaries

Out of scope for this plan:
- changing feature behavior
- rewriting domain logic
- redesigning UI behavior

## Current Diagnosis

The codebase is not chaotic everywhere, but it mixes several folder conventions that compete with each other.

### What already works

- Most product code is under `src/features`, which is the right top-level boundary.
- Several features already follow a usable pattern with `components`, `hooks`, `lib`, and `types`.
- Some heavier UI areas already isolate CSS into feature-level `styles` folders.
- The `Dashboard` page is now isolated under `src/pages/Dashboard`, which is cleaner than a flat page file.

### What is currently disorganized

#### 1. Multiple feature shapes coexist

Examples:
- `altitude`, `poi`, `weather`, `slope`, `sunlight` use partially similar shells.
- `controlPanel` and `itineraryPanel` use `container`, `sections`, `context`, `styles`, plus root components.
- `centerPanel` contains several tactical modules directly at the feature root: `flyover`, `tracer`, `routeMerge`, `routeSplit`, `forbiddenZones`.
- `projectBrowser` hides most of its complexity under `overlay`.

Result:
- impossible to predict where a new file should live
- hard to know what is public API vs internal implementation

#### 2. CSS organization is inconsistent

Examples:
- `controlPanel/styles/index.css`
- `centerPanel/styles/index.css`
- `itineraryPanel/styles/index.css`
- many other features still use large blocks of `React.CSSProperties` inside `.tsx`

Result:
- styling strategy changes from feature to feature
- visual code is split between CSS files, style constants, and inline objects
- maintenance cost grows quickly

#### 3. Shared code is mixed into `src/lib`

Current root `src/lib` mixes unrelated concerns:
- generic utilities
- service configuration
- a reusable hook

Example:
- `useMiddleClickAutoscroll.ts` sits next to `supabase.ts` and project utility files even though they are not the same category.

#### 4. Public exports are not standardized

Examples:
- some features export only one component from `index.ts`
- some export container + view + stores + types
- some sub-features have their own `index.ts`, others do not

Result:
- consumers import deep internals too often
- feature boundaries leak into the rest of the app

#### 5. Some folders are placeholders or unclear

Examples:
- `analysisPanel` is effectively empty
- `demo` is empty

Result:
- inventory noise
- unclear whether these are deprecated, planned, or forgotten

#### 6. Sub-feature boundaries are not explicit enough

Examples:
- `weather/overlay` behaves like a sub-domain
- `weather/lib/wind` is also a sub-domain
- `centerPanel` root contains tool-like modules that are conceptually different from the panel UI
- `projectBrowser/overlay` is almost a feature inside a feature

Result:
- folder placement reflects history more than architecture

#### 7. Naming rules are not documented

Current naming mix:
- domain features: `weather`, `poi`, `slope`, `lidar`
- panel features: `controlPanel`, `centerPanel`, `itineraryPanel`
- plural/singular is inconsistent: `labels` vs mostly singular folders

Result:
- every new folder name becomes an ad hoc decision

## Structural Principles To Apply

### Principle 1: One standard shell per feature

Every feature should use the same default internal layout, even if some folders are absent initially.

Recommended shell:

```text
featureName/
  index.ts
  types.ts
  constants.ts          optional
  components/
  hooks/
  lib/
  context/              optional
  config/               optional
  styles/               optional, only for complex shared feature styles
  subfeatures/          optional, only when truly justified
```

### Principle 2: Keep feature-local code inside the feature

If code exists only for one feature, it must stay inside that feature.

Do not place feature-specific helpers in root shared folders.

### Principle 3: Create a real shared layer

Everything reused across multiple features should move out of `src/lib` and `src/components` into a single explicit shared area.

Recommended shared layout:

```text
src/shared/
  components/
  hooks/
  services/
  utils/
  types/
```

### Principle 4: Public API only from `index.ts`

Each feature root `index.ts` should expose only the public surface:
- primary component(s)
- provider(s)
- public hooks
- public types

Everything else remains internal and should not be imported through deep unstable paths unless clearly intentional.

### Principle 5: Sub-features must be explicit, not accidental

If a feature contains a coherent internal product area, group it under `subfeatures/` rather than scattering folders at the root.

Examples that fit this model:
- `weather/subfeatures/overlay`
- `weather/subfeatures/wind`
- `centerPanel/subfeatures/tools/flyover`
- `projectBrowser/subfeatures/overlay`

### Principle 6: Styling strategy must be singular

Recommended rule:
- use component-local CSS modules for isolated styling
- use feature `styles/` only for heavy multi-component shells
- reserve inline `CSSProperties` for dynamic runtime values only

This repo is currently half CSS, half inline style system. It needs one dominant rule.

## Recommended Target Tree

```text
src/
  App.tsx
  main.tsx
  index.css
  pages/
    Dashboard/
      index.tsx
      components/
      hooks/
      lib/
      types.ts
  features/
    altitude/
      index.ts
      types.ts
      components/
      hooks/
      lib/
    centerPanel/
      index.ts
      types.ts
      components/
      hooks/
      lib/
      styles/
      subfeatures/
        tools/
          flyover/
          forbiddenZones/
          routeMerge/
          routeSplit/
          tracer/
        analysis/
          chart/
    controlPanel/
      index.ts
      types.ts
      components/
      hooks/
      lib/
      styles/
      subfeatures/
        sections/
    itineraryPanel/
      index.ts
      types.ts
      components/
      hooks/
      lib/
      context/
      styles/
      subfeatures/
        expert/
        timeline/
    labels/
      index.ts
      types.ts
      components/
      hooks/
      lib/
    lidar/
      index.ts
      types.ts
      components/
      hooks/
      lib/
      subfeatures/
        viewer/
        viewerWebgl/
    map3d/
      index.ts
      types.ts
      components/
      hooks/
      lib/
      styles/
      subfeatures/
        overlays/
    mapViewportControls/
      index.ts
      types.ts
      components/
      hooks/
      styles/
    poi/
      index.ts
      types.ts
      components/
      hooks/
      lib/
    projectBrowser/
      index.ts
      types.ts
      components/
      hooks/
      lib/
      styles/
      subfeatures/
        overlay/
    slope/
      index.ts
      types.ts
      components/
      hooks/
      lib/
    snow/
      index.ts
      types.ts
      components/
      hooks/
      lib/
    sunlight/
      index.ts
      types.ts
      components/
      hooks/
      lib/
    weather/
      index.ts
      types.ts
      components/
      hooks/
      lib/
      config/
      subfeatures/
        overlay/
        wind/
  shared/
    components/
      AssetIcon.tsx
      MapCanvasGlassBackdrop.tsx
      PayWall.tsx
      SvgV2Icon.tsx
      index.ts
    hooks/
      useMiddleClickAutoscroll.ts
      index.ts
    services/
      supabase.ts
      index.ts
    utils/
      mapThumbnail.ts
      projectLocation.ts
      projects.ts
      index.ts
    types/
      index.ts
```

## Folder-By-Folder Recommendations

### `src/pages`

Keep page-specific code inside each page folder.

For `Dashboard`, move toward:
- `components/` for page-only UI blocks
- `hooks/` for page-only hooks
- `lib/` for layout helpers and page orchestration helpers

Current files like `useDashboardChrome.ts`, `useDashboardProjectState.ts`, `dashboardStyles.ts`, and `layout.ts` already indicate this split and should become the page-level convention.

### `src/shared`

Create this folder before any large move.

Move here first:
- `src/components/*`
- `src/lib/useMiddleClickAutoscroll.ts`
- `src/lib/supabase.ts`
- generic project helpers from `src/lib/*`

This gives the app a real shared foundation and stops root `src/lib` from growing randomly.

### `src/features/centerPanel`

This feature currently mixes:
- panel shell UI
- chart UI
- route and drawing tools
- flyover tools

It should become one feature with explicit internal subfeatures.

Recommended internal model:

```text
centerPanel/
  components/            shell and composed panel UI
  styles/
  lib/
  subfeatures/
    analysis/
      chart/
    tools/
      flyover/
      tracer/
      routeMerge/
      routeSplit/
      forbiddenZones/
```

### `src/features/controlPanel`

This is one of the closest features to a reusable structure, but it still needs normalization.

What to keep:
- `sections/`
- `styles/`
- typed public API

What to improve:
- convert `container/` into either `hooks/` and `lib/`, or keep it as `containers/` if the project explicitly distinguishes smart/presentational components
- move root utility files like `basemaps.ts`, `persistedState.ts`, `weatherPalette.ts` into `lib/` or `config/`

### `src/features/itineraryPanel`

This is structurally rich but difficult to read because too many concepts coexist at the root.

Current root contains:
- container/view duplication
- context stores
- sections
- expert mode
- timeline internals
- styles
- lineage
- lib

Recommended cleanup:

```text
itineraryPanel/
  components/
  context/
  hooks/
  lib/
  styles/
  subfeatures/
    expert/
    timeline/
    tracing/
```

Not every existing folder must survive as-is. The goal is to reduce root noise.

### `src/features/map3d`

This feature is technically strong but structurally inconsistent in hooks.

Current issue:
- both `hooks/useMap.ts` and `hooks/useMap/` exist

That is a smell. Choose one convention only:
- either `hooks/useMap.ts`
- or `hooks/useMap/index.ts` with colocated support files under `hooks/useMap/`

Do not keep both patterns in the same feature.

### `src/features/weather`

Weather should be treated as a feature with clear internal sub-domains.

Recommended split:

```text
weather/
  components/
  hooks/
  lib/
  config/
  subfeatures/
    overlay/
    wind/
```

This avoids having one sub-domain under `overlay/` and another under `lib/wind/`.

### `src/features/projectBrowser`

This folder is currently conceptually inverted: the interesting part lives under `overlay/`.

You should either:
- promote `overlay` to the actual feature structure inside `subfeatures/overlay`
- or flatten it if overlay is the only real UI mode

### Empty or placeholder features

Decide explicitly for:
- `analysisPanel`
- `demo`

Each should be either:
- removed
- documented as placeholder with a README
- or populated according to the standard shell

## CSS Refactor Rule Set

To avoid recreating disorder after moving folders, use these rules.

### Rule A

If a component has mostly isolated styling, use a colocated CSS module:

```text
components/
  RouteCard.tsx
  RouteCard.module.css
```

### Rule B

If many components share a large shell style system, keep a feature-level `styles/` folder:

Examples that justify it:
- `controlPanel`
- `itineraryPanel`
- `centerPanel`

### Rule C

If a style value is dynamic at runtime, keep it inline, but keep static appearance in CSS.

Good inline use:
- width from state
- transform from runtime computation
- chart coordinates from data

Bad inline use:
- whole panel appearance
- typography
- borders
- colors
- spacing systems

## Import Policy To Enforce During Migration

When the move happens, import cleanup should follow these rules:

### Allowed

- feature public imports from feature root
- shared imports from `src/shared/*`
- local relative imports inside one feature

### Avoid

- deep imports into another feature internals
- root-level generic dumping grounds like `src/lib` growing further
- mixed aliases and long relative paths for the same concept

Recommended mental model:
- cross-feature import goes through the feature public API unless there is a deliberate internal contract
- feature-local internals stay local

## Migration Order

This should not be done in one large move.

### Phase 1: Foundation

1. Create `src/shared/`
2. Define the standard feature shell in a repo guideline
3. Freeze naming conventions
4. Decide CSS rule set

### Phase 2: Lowest-risk moves

1. Move root shared utilities out of `src/lib`
2. Move root shared UI out of `src/components`
3. Clean placeholder folders `demo` and `analysisPanel`

### Phase 3: Normalize simple features

Do first:
- `altitude`
- `poi`
- `snow`
- `sunlight`
- `slope`
- `labels`

These are the least risky templates for the rest.

### Phase 4: Normalize technical heavy features

Then:
- `map3d`
- `weather`
- `lidar`

These need careful handling because they have deeper internals and more runtime coupling.

### Phase 5: Normalize panel features

Last:
- `controlPanel`
- `centerPanel`
- `itineraryPanel`
- `projectBrowser`

These have the most UI orchestration and the most nested concepts.

## Practical Decision Rules

When you hesitate about file placement, apply these tests.

### Test 1

If the file is used by only one feature, keep it inside that feature.

### Test 2

If the file is reused by several features and has no business ownership, move it to `src/shared`.

### Test 3

If a folder contains a coherent product area with its own UI, hooks, and logic, make it a sub-feature.

### Test 4

If a folder exists only because history produced it, flatten or rename it.

### Test 5

If another feature must import deep internals from it, its public API is incomplete.

## Recommended Next Step

Do not start by moving everything.

Start with a non-destructive structural pass:
- create `src/shared`
- define naming and export rules
- choose one CSS strategy
- then migrate one feature at a time with import repair and validation

The best pilot candidates are:
- `altitude`
- `poi`
- `controlPanel`

They will reveal whether the convention is practical before touching the heaviest folders.