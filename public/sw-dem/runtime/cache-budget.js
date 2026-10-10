// ---------------------------------------------------------------------------
// Plafond des caches de tuiles (CacheStorage)
//
// Sans plafond, les caches de tuiles grossissaient sans fin à force de
// parcourir la France à 0,40 m. Or l'origine partage son quota avec IndexedDB
// (copies locales des projets) et l'OPFS (tuiles LiDAR). Une fois le stockage
// persistant accordé pour le LiDAR, le navigateur ne libère plus rien de
// lui-même (B5-2, audit du 2026-10-10).
//
// Chaque famille a un nombre maximal d'entrées. Une passe d'éviction tourne au
// repos : MAP_CACHE_TRIM_IDLE_MS sans requête de tuile, une fois après le
// démarrage du worker (il est arrêté au bout de quelques dizaines de secondes
// d'inactivité), puis toutes les MAP_CACHE_TRIM_EVERY_REQUESTS requêtes. Elle
// retire les entrées écrites le plus tôt : `keys()` les rend dans l'ordre
// d'insertion (spécification Cache, que Chromium respecte en triant par date
// d'entrée), et une réécriture remet l'entrée à la fin. C'est le même ordre que
// l'en-tête `x-cached-at`, sans lire chaque réponse.
// Le cache des ortho THR (`vhr-tiles-*`) se plafonne lui-même
// (`maybeTrimVhrCache`, masques de couverture exclus).
// ---------------------------------------------------------------------------

const MAP_CACHE_BUDGETS = [
  [CACHE_NAME, 2500],
  [NEGATIVE_CACHE_NAME, 20000],
  [ORTHO_CACHE_NAME, 3000],
  [SLOPE_CACHE_NAME, 3000],
  [ALTITUDE_CACHE_NAME, 1500],
  [CONTOUR_CACHE_NAME, 3000],
];
// Retire 10 % de plus que l'excédent : la passe suivante n'a rien à faire
// avant que la famille ait de nouveau grossi d'autant.
const MAP_CACHE_TRIM_SLACK = 0.1;
const MAP_CACHE_TRIM_IDLE_MS = 8000;
const MAP_CACHE_TRIM_EVERY_REQUESTS = 400;
const MAP_CACHE_DELETE_BATCH = 64;

let mapCacheTrimTimer = null;
let mapCacheTrimRunning = null;
let mapCacheTrimmedOnce = false;
let tileRequestsSinceTrim = 0;

/** Ramène un cache à `maxEntries` en retirant les plus anciennes ; renvoie le nombre retiré. */
async function trimMapCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  if (excess <= 0) return 0;
  const drop = Math.min(keys.length, excess + Math.floor(maxEntries * MAP_CACHE_TRIM_SLACK));
  for (let i = 0; i < drop; i += MAP_CACHE_DELETE_BATCH) {
    await Promise.all(keys.slice(i, Math.min(drop, i + MAP_CACHE_DELETE_BATCH)).map((req) => cache.delete(req)));
  }
  return drop;
}

/** Une passe sur toutes les familles, l'une après l'autre (au mieux : une erreur ne bloque pas les suivantes). */
async function trimMapCaches() {
  let dropped = 0;
  for (const [cacheName, maxEntries] of MAP_CACHE_BUDGETS) {
    try {
      dropped += await trimMapCache(cacheName, maxEntries);
    } catch { /* au mieux */ }
  }
  if (dropped > 0 && typeof DEBUG !== 'undefined' && DEBUG) {
    console.warn(`[sw-dem][cache-budget] ${dropped} tuiles anciennes retirées`);
  }
  return dropped;
}

/** Appelé à chaque requête de tuile (router.js) : arme ou repousse la passe de repos. */
function noteMapTileRequest() {
  tileRequestsSinceTrim += 1;
  if (mapCacheTrimmedOnce && tileRequestsSinceTrim < MAP_CACHE_TRIM_EVERY_REQUESTS) return;
  if (mapCacheTrimTimer !== null) clearTimeout(mapCacheTrimTimer);
  mapCacheTrimTimer = setTimeout(() => {
    mapCacheTrimTimer = null;
    if (mapCacheTrimRunning) return;
    mapCacheTrimmedOnce = true;
    tileRequestsSinceTrim = 0;
    mapCacheTrimRunning = trimMapCaches().finally(() => { mapCacheTrimRunning = null; });
  }, MAP_CACHE_TRIM_IDLE_MS);
}
