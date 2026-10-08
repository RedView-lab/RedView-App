// ---------------------------------------------------------------------------
// Couche réseau IGN — registre des AbortController (par usage), init des
// fetchs, limitation du débit WMS (quota de 40 req/s) et nouvelles tentatives
// sur les backends geopf instables.
// ---------------------------------------------------------------------------

// Registre des AbortController en cours. Chaque fetch de sous-tuile IGN (MNS,
// HIGHRES, WMS terrain) y enregistre son contrôleur pendant la requête réseau.
// `cancelInFlightIGN()` les annule tous avec USER_CANCEL_REASON ; les
// gestionnaires d'erreur de chaque fetch testent alors la raison du signal et
// sautent l'écriture en cache négatif (sinon les tuiles qu'on vient de tuer
// seraient mises sur liste noire pour IGN_NULL_TTL_TRANSIENT, et la nouvelle
// demande émise ~50 ms plus tard pour la nouvelle vue renverrait null sans
// jamais toucher le réseau).
const ignActiveControllers = new Set();
// Registre des contrôleurs par usage — rempli en parallèle d'ignActiveControllers
// quand ignFetchInit est appelé avec { purpose }. Utilisé seulement par
// cancelInFlightIGNByPurpose, qui annule un usage précis sans toucher à
// l'ensemble global (les fetchs du fond de carte continuent).
const ignActiveControllersByPurpose = new Map();

function ignFetchInit(extra) {
  const purpose = extra && typeof extra === 'object' ? extra.purpose || null : null;
  const mapTile = extra && typeof extra === 'object' ? extra.mapTile || null : null;
  const priority = isIGNBackgroundPurpose(purpose) ? 'low' : 'high';
  // Retire les champs internes au SW `purpose` / `mapTile` avant de les passer
  // à l'init du fetch — ce ne sont pas des options RequestInit valides et elles
  // seraient ignorées, mais les garder hors de l'étalement évite de futures
  // surprises de linter ou de typage.
  const fetchExtra = (extra && typeof extra === 'object')
    ? Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'purpose' && k !== 'mapTile'))
    : (extra || {});
  const controller = new AbortController();
  controller._purpose = purpose;
  controller._mapTile = mapTile;
  const timeout = setTimeout(() => {
    try { controller.abort('rv-ign-timeout'); } catch { /* ignore */ }
  }, IGN_FETCH_TIMEOUT_MS);
  ignActiveControllers.add(controller);
  let purposeBucket = null;
  if (purpose) {
    purposeBucket = ignActiveControllersByPurpose.get(purpose);
    if (!purposeBucket) {
      purposeBucket = new Set();
      ignActiveControllersByPurpose.set(purpose, purposeBucket);
    }
    purposeBucket.add(controller);
  }
  const cleanup = () => {
    clearTimeout(timeout);
    ignActiveControllers.delete(controller);
    if (purposeBucket) purposeBucket.delete(controller);
  };
  return {
    controller,
    cleanup,
    init: { signal: controller.signal, priority, ...fetchExtra },
  };
}

// ── Backends instables de la Géoplateforme ────────────────────────────
// Mesuré sur data.geopf.fr (2026-10-01) :
//   - 13 à 35 % des requêtes GetMap LiDAR HD échouent en HTTP 400
//     ServiceException « LayerNotDefined » : certains nœuds derrière le
//     répartiteur de charge ne connaissent pas la couche. La même URL réussit
//     à la tentative suivante (40/40 tuiles récupérées en 3 tentatives au plus).
//   - Le WMS-Raster est limité à 40 requêtes/s par IP ; au-delà, geopf répond
//     429 et bloque le WMS (seulement lui) pendant 5 s. Le WMTS n'a pas de limite
//     (https://geoservices.ign.fr/documentation/services/limite-d-usage).
// Les deux étaient mis en cache comme un échec passager, et la tuile retombait
// sur le MNS de corrélation / AWS à 30 m (tuiles de pente vides, lisses ou
// plates au milieu des tuiles LiDAR). Elles sont désormais réessayées ici ;
// toute autre erreur est renvoyée telle quelle à la gestion existante de l'appelant.
const IGN_RETRY_MAX_ATTEMPTS = 3;
const IGN_RETRY_BACKOFF_MS = 600;
const IGN_WMS_RATE_LIMIT_BLOCK_MS = 5000;
// Rester sous le quota WMS de 40 req/s (nouvelles tentatives comprises) plutôt
// que de le découvrir par un blocage de 5 s.
const IGN_WMS_MAX_PER_SECOND = 32;
const ignWmsRecentStarts = [];
// Pause partagée après une 429, pour que les autres requêtes WMS en file ne
// continuent pas à frapper le quota pendant sa remise à zéro.
let ignWmsRateLimitedUntil = 0;

function isIgnWmsUrl(url) {
  return url.startsWith(IGN_WMS_BASE);
}

async function acquireIgnWmsRateSlot(signal) {
  for (;;) {
    const now = Date.now();
    if (ignWmsRateLimitedUntil > now) {
      await ignAbortableDelay(ignWmsRateLimitedUntil - now, signal);
      continue;
    }
    while (ignWmsRecentStarts.length && now - ignWmsRecentStarts[0] >= 1000) ignWmsRecentStarts.shift();
    if (ignWmsRecentStarts.length < IGN_WMS_MAX_PER_SECOND) {
      ignWmsRecentStarts.push(now);
      return;
    }
    await ignAbortableDelay(ignWmsRecentStarts[0] + 1000 - now + 5, signal);
  }
}

function ignAbortableDelay(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), 10_000);
  return null;
}

async function fetchIgnWithRetry(url, init) {
  const isWms = isIgnWmsUrl(url);
  let res = null;
  for (let attempt = 0; attempt < IGN_RETRY_MAX_ATTEMPTS; attempt++) {
    if (isWms) await acquireIgnWmsRateSlot(init?.signal);
    res = await fetch(url, init);
    if (res.ok) return res;
    const lastAttempt = attempt + 1 >= IGN_RETRY_MAX_ATTEMPTS;
    if (res.status === 400) {
      // Petit corps XML : distingue un backend instable d'une requête vraiment invalide.
      let body = '';
      try { body = await res.clone().text(); } catch { /* on garde res */ }
      if (!body.includes('LayerNotDefined')) return res;
      continue;
    }
    if (res.status === 429) {
      const block = parseRetryAfterMs(res.headers.get('Retry-After')) ?? IGN_WMS_RATE_LIMIT_BLOCK_MS;
      if (isWms) {
        // L'obtention du créneau WMS de chaque requête (y compris cette
        // nouvelle tentative) attend la fin du blocage.
        ignWmsRateLimitedUntil = Math.max(ignWmsRateLimitedUntil, Date.now() + block + Math.random() * 300);
      } else if (!lastAttempt) {
        await ignAbortableDelay(block, init?.signal);
      }
      continue;
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      const backoff = parseRetryAfterMs(res.headers.get('Retry-After'))
        ?? IGN_RETRY_BACKOFF_MS * (attempt + 1) + Math.random() * 400;
      if (!lastAttempt) await ignAbortableDelay(backoff, init?.signal);
      continue;
    }
    return res;
  }
  return res;
}

function isIGNUserCancel(controller) {
  return controller.signal.aborted && controller.signal.reason === USER_CANCEL_REASON;
}
