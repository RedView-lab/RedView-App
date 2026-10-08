/**
 * Audit D (fond de carte) — contrôles de régression statiques sur les chemins
 * de code du changement de fond de carte / de l'amorçage du style (pas de
 * navigateur disponible : on vérifie donc la forme exacte du code qui cause les
 * problèmes documentés dans findings-D-basemap.md).
 *
 * Lancement :  node script-test-bench/audit/d-basemap-static.mjs
 * Sortie 1 si un problème se reproduit encore.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const lineOf = (src, needle) => src.split('\n').findIndex((l) => l.includes(needle)) + 1;
let failures = 0;
const fail = (id, msg) => { failures += 1; console.log(`FAIL ${id}: ${msg}`); };
const pass = (id, msg) => console.log(`ok   ${id}: ${msg}`);

// DB-init-race : le garde-fou de coque bloquée (4 s) est armé AVANT d'attendre
// le préchargement du style thématisé (délai 6 s) → avec une API Styles lente,
// la carte se charge deux fois.
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

// DB-theme-fallback : un préchargement raté affiche sans bruit le style
// Outdoors NON thématisé sous le libellé « Standard (clair/sombre) ».
{
  const prefetch = read('src/features/map3d/hooks/useMap/stylePrefetch.ts');
  if (/catch \(error\) \{\s*console\.warn\('\[map3d\] style prefetch failed, falling back to URL', error\);\s*return getBaseStyleUrl\(styleUrl\);/.test(prefetch)) {
    fail('theme-fallback', `stylePrefetch.ts:${lineOf(prefetch, 'return getBaseStyleUrl(styleUrl);')} returns the raw outdoors-v12 URL for redview:// themes on any fetch error/timeout (dark theme shows a light map)`);
  } else pass('theme-fallback', 'themed fallback handled');
}

// DB-weather-updateImage : chaque `styledata` relance ensureLayer → ImageSource.updateImage(sameUrl),
// que mapbox-gl 3.x ne court-circuite pas (nouvelle requête + décodage + envoi de texture à chaque rafale).
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

// DB-overlays-isMapLoaded : le mapLoaded du Dashboard (passé à chaque hook de
// surcouche du ControlPanel / de l'itinéraire) ne retombe jamais lors d'un
// changement de fond → les surcouches doivent compter, et comptent, sur les
// écouteurs style.load / styledata. Informatif (sans effet sur la sortie).
{
  const dash = read('src/pages/Dashboard/index.tsx');
  const falses = (dash.match(/setMapLoaded\(false\)/g) ?? []).length;
  console.log(`info overlays-isMapLoaded: Dashboard setMapLoaded(false) occurs ${falses}× (project close / editor close only) → isMapLoaded stays true across basemap switches`);
}

// DB-quality-profile-throttle : le rechargement de profil est un étranglement
// sur front montant sans appel final, abandonné pendant un rechargement en cours.
{
  const reload = read('src/features/map3d/hooks/useMap/controller/reload.ts');
  if (/if \(now - lastProfileReloadAt < PROFILE_RELOAD_DEBOUNCE_MS\) return;/.test(reload) && /if \(st\.reloadInProgress\) return;/.test(reload)) {
    fail('profile-change-dropped', `reload.ts:${lineOf(reload, 'if (now - lastProfileReloadAt < PROFILE_RELOAD_DEBOUNCE_MS) return;')}/${lineOf(reload, 'if (st.reloadInProgress) return;')} drop a DEM profile change (no trailing re-run) → terrain can stay on the previous MNT/MNS profile`);
  } else pass('profile-change-dropped', 'profile changes are not dropped');
}

console.log(failures ? `\nFAILURES: ${failures}` : '\nall checks passed');
process.exit(failures ? 1 : 0);
