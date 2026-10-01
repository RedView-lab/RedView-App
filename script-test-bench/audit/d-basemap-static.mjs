/**
 * Audit D (basemap) — static regression checks on the basemap switch / style
 * bootstrap code paths (no browser available, so these assert the exact code
 * shapes that cause the issues documented in findings-D-basemap.md).
 *
 * Run:  node script-test-bench/audit/d-basemap-static.mjs
 * Exit 1 if any issue still reproduces.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const lineOf = (src, needle) => src.split('\n').findIndex((l) => l.includes(needle)) + 1;
let failures = 0;
const fail = (id, msg) => { failures += 1; console.log(`FAIL ${id}: ${msg}`); };
const pass = (id, msg) => console.log(`ok   ${id}: ${msg}`);

// DB-init-race: stuck-shell watchdog (4 s) armed BEFORE awaiting the themed
// style prefetch (timeout 6 s) → on a slow Styles API the map loads twice.
{
  const useMap = read('src/features/map3d/hooks/useMap/index.ts');
  const prefetch = read('src/features/map3d/hooks/useMap/stylePrefetch.ts');
  const watchdog = Number(/STUCK_SHELL_WATCHDOG_MS = (\d+)/.exec(useMap)?.[1]);
  const timeout = Number(/STYLE_PREFETCH_TIMEOUT_MS = (\d+)/.exec(prefetch)?.[1]);
  const armLine = lineOf(useMap, '      armStuckShellWatchdog();');
  const awaitLine = lineOf(useMap, 'styleInput = await resolveStyleInput(basemapConfig.styleUrl);');
  if (watchdog < timeout && armLine > 0 && armLine < awaitLine) {
    fail('init-double-load', `watchdog ${watchdog} ms armed at index.ts:${armLine} before the prefetch await at :${awaitLine} (timeout ${timeout} ms): a 4–6 s style fetch triggers setStyle(outdoors URL) then setStyle(themed) again`);
  } else pass('init-double-load', 'watchdog no longer races the prefetch');
}

// DB-theme-fallback: a failed prefetch silently renders the UNTHEMED Outdoors
// style under the "Standard (clair/sombre)" label.
{
  const prefetch = read('src/features/map3d/hooks/useMap/stylePrefetch.ts');
  if (/catch \(error\) \{\s*console\.warn\('\[map3d\] style prefetch failed, falling back to URL', error\);\s*return getBaseStyleUrl\(styleUrl\);/.test(prefetch)) {
    fail('theme-fallback', `stylePrefetch.ts:${lineOf(prefetch, 'return getBaseStyleUrl(styleUrl);')} returns the raw outdoors-v12 URL for redview:// themes on any fetch error/timeout (dark theme shows a light map)`);
  } else pass('theme-fallback', 'themed fallback handled');
}

// DB-weather-updateImage: every `styledata` re-runs ensureLayer → ImageSource.updateImage(sameUrl),
// which mapbox-gl 3.x does not short-circuit (re-fetch + decode + texture upload per burst).
{
  const sm = read('src/features/weather/overlay/useWeatherOverlay/useWeatherStyleManager.ts');
  const hook = read('src/features/weather/overlay/useWeatherOverlay/hook.ts');
  const mb = read('node_modules/mapbox-gl/dist/mapbox-gl-dev.js');
  const upd = mb.slice(mb.indexOf('  updateImage(options) {'), mb.indexOf('  updateImage(options) {') + 400);
  const mbNoShortCircuit = /this\.options\.url = options\.url;\s*this\.load\(/.test(upd);
  const unconditional = /\} else \{\s*existingSource\.updateImage\(\{ url, coordinates: coords \}\);/.test(sm);
  const fromStyleData = /ensureLayer\(layer\.key, layer\.mode, item\.url, item\.coords\)/.test(hook);
  if (mbNoShortCircuit && unconditional && fromStyleData) {
    fail('weather-updateImage', `hook.ts:${lineOf(hook, 'ensureLayer(layer.key, layer.mode, item.url, item.coords)')} (styledata) → useWeatherStyleManager.ts:${lineOf(sm, 'existingSource.updateImage({ url, coordinates: coords });')} reloads each active weather image on every styledata burst`);
  } else pass('weather-updateImage', 'no redundant image reload');
}

// DB-overlays-isMapLoaded: Dashboard's mapLoaded (fed to every ControlPanel /
// Itinerary overlay hook) never drops on a basemap switch → overlays must and do
// rely on style.load/styledata listeners. Informational (exit unaffected).
{
  const dash = read('src/pages/Dashboard/index.tsx');
  const falses = (dash.match(/setMapLoaded\(false\)/g) ?? []).length;
  console.log(`info overlays-isMapLoaded: Dashboard setMapLoaded(false) occurs ${falses}× (project close / editor close only) → isMapLoaded stays true across basemap switches`);
}

// DB-quality-profile-throttle: profile reload is a leading-edge throttle with no
// trailing call and is dropped while a reload is in progress.
{
  const reload = read('src/features/map3d/hooks/useMap/controller/reload.ts');
  if (/if \(now - lastProfileReloadAt < PROFILE_RELOAD_DEBOUNCE_MS\) return;/.test(reload) && /if \(st\.reloadInProgress\) return;/.test(reload)) {
    fail('profile-change-dropped', `reload.ts:${lineOf(reload, 'if (now - lastProfileReloadAt < PROFILE_RELOAD_DEBOUNCE_MS) return;')}/${lineOf(reload, 'if (st.reloadInProgress) return;')} drop a DEM profile change (no trailing re-run) → terrain can stay on the previous MNT/MNS profile`);
  } else pass('profile-change-dropped', 'profile changes are not dropped');
}

console.log(failures ? `\nFAILURES: ${failures}` : '\nall checks passed');
process.exit(failures ? 1 : 0);
