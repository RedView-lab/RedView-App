// ---------------------------------------------------------------------------
// Ordonnancement des requêtes IGN — partagé par tous les fetchs geopf (MNS
// WMTS, HIGHRES, WMS terrain/MNS) : cache de tuiles en mémoire + déduplication
// des requêtes en cours, étiquettes d'usage, files de priorité à trois niveaux
// (fond de carte > slope-visible > slope-warm) servies du centre vers les bords,
// et limiteur de concurrence dynamique.
// ---------------------------------------------------------------------------

const ignTileCache = new Map();
const ignInflight = new Map(); // Déduplication : fetchs en cours par clé
let activeIGN = 0;
let activeIGNBackground = 0;
let activeIGNSlopeVisible = 0;
// ── Ordonnancement à trois niveaux (réécriture du 20 mai) ─────────────
// Fond de carte (sans étiquette d'usage) > slope-visible > slope-warm.
//
// Avant cette réécriture, le fond de carte et slope-visible partageaient la
// même file « de premier plan », avec un sous-plafond souple pour
// slope-visible. En pratique, avec un dépilement LIFO, une fois la file
// saturée par slope-visible, les requêtes getIGNTile/getHighresTile du fond de
// carte arrivées APRÈS la rafale de pente se retrouvaient en queue et étaient
// dépilées ensuite — très bien — MAIS toutes les entrées slope-visible mises en
// file pendant le même cycle d'inactivité occupaient déjà chaque créneau IGN.
// Chaque requête du fond de carte attendait alors derrière plus de 40 fetchs
// simultanés de sous-tuiles de pente.
//
// La correction donne au fond de carte SA PROPRE file, dépilée avant de toucher
// à celle de slope-visible. Slope-visible garde le LIFO et un sous-plafond
// dynamique ; un chargement de pente isolé (aucun fond de carte en file) a tout
// le budget, donc les mesures dédiées à la pente à 1 m ne changent pas.
const ignForegroundQueue = [];   // fond de carte (purpose === null/undefined)
const ignSlopeVisibleQueue = []; // PURPOSE_SLOPE_VISIBLE
const ignBackgroundQueue = [];   // PURPOSE_SLOPE_WARM
let ignPrunedTotal = 0; // Compteur cumulé, pour le diagnostic

// Étiquettes d'usage — séparent les fetchs de pente à 1 m visibles du travail
// de fond (réparation des jointures, remise en cache), pour que les premières
// tuiles de pente affichées n'attendent pas derrière des préchauffages
// opportunistes. Les deux étiquettes restent propres à la pente : l'annulation
// peut les abandonner sans toucher au trafic IGN du fond de carte.
const PURPOSE_SLOPE_VISIBLE = 'slope-visible';
const PURPOSE_SLOPE_WARM = 'slope-warm';
const PURPOSE_SLOPE_ZONE = 'slope-zone';
const PURPOSE_DEM_PREFETCH = 'dem-prefetch';

let ignViewportCenter = null;

function setIGNViewportCenter(center) {
  if (center && Number.isFinite(center.lng) && Number.isFinite(center.lat)) {
    ignViewportCenter = { lng: center.lng, lat: center.lat };
  }
}

function wgs84TileCenter(z, col, row) {
  const matrixWidth = 1 << (z + 1);
  const matrixHeight = 1 << z;
  const lng = ((col + 0.5) / matrixWidth) * 360 - 180;
  const lat = 90 - ((row + 0.5) / matrixHeight) * 180;
  return { lng, lat };
}

function isIGNBackgroundPurpose(purpose) {
  return purpose === PURPOSE_SLOPE_WARM || purpose === PURPOSE_DEM_PREFETCH;
}

function isIGNSlopeVisiblePurpose(purpose) {
  return purpose === PURPOSE_SLOPE_VISIBLE;
}

function isIGNSlopeZonePurpose(purpose) {
  return purpose === PURPOSE_SLOPE_ZONE;
}

// ── Rasters d'altitude WMS : octets en cours de transfert ─────────────
// Un raster GetMap LiDAR HD pèse de 370 Ko (MNS, 1×) à 1,5 Mo (MNT, 2×). Lancés
// jusqu'à IGN_CONCURRENCY (40 à 64) à la fois, ils se partageaient la ligne du
// client jusqu'à ce que la plupart dépassent IGN_FETCH_TIMEOUT_MS. Mesuré le
// 2026-10-04 sur une ligne d'environ 2 Mo/s : 16 rasters en parallèle prenaient
// 2,4 s chacun, 40 en prenaient 7,4 s, 64 en prenaient 12,6 s (médiane ; 23 s au
// maximum, plus des 429) — téléchargements abandonnés, octets gaspillés et
// tuiles de remplacement : 42 % des tuiles de relief d'une vidéo de survol en
// 0,40 m. Le débit de la ligne est le même avec quelques Mo en vol : chaque
// raster arrive en ~2 s, du centre vers les bords, pendant que les autres
// attendent en file, hors du délai de fetch (qui démarre avec la tâche).
const IGN_WMS_INFLIGHT_BYTES_MAX = 4_500_000;
let activeIGNWmsBytes = 0;

function canStartIGNEntry(entry) {
  return !entry.wmsBytes
    || activeIGNWmsBytes === 0
    || activeIGNWmsBytes + entry.wmsBytes <= IGN_WMS_INFLIGHT_BYTES_MAX;
}

function firstStartableIGNIndex(queue) {
  for (let i = 0; i < queue.length; i++) if (canStartIGNEntry(queue[i])) return i;
  return -1;
}

function lastStartableIGNIndex(queue) {
  for (let i = queue.length - 1; i >= 0; i--) if (canStartIGNEntry(queue[i])) return i;
  return -1;
}

function totalIGNQueueLength() {
  return ignForegroundQueue.length
    + ignSlopeVisibleQueue.length
    + ignBackgroundQueue.length;
}

function currentIGNBackgroundConcurrency() {
  if (ignForegroundQueue.length > 0 || ignSlopeVisibleQueue.length > 0) {
    return Math.max(4, Math.min(12, Math.floor(IGN_CONCURRENCY * 0.25)));
  }
  return IGN_CONCURRENCY;
}

// Sous-plafond dynamique de la concurrence IGN pour slope-visible.
//
// - Si des requêtes du fond de carte sont en file, slope-visible est limité à
//   ~30 % du budget pour que les fetchs DEM / ortho / highres du fond de carte
//   aient toujours au moins ~70 % des créneaux tout de suite. C'est la
//   régression visible qu'on ne cesse de corriger : pentes actives, le monde 3D
//   gèle parce que chaque créneau IGN est pris par les sous-tuiles de pente.
// - Si aucun fond de carte n'est en file (test de charge dédié aux pentes,
//   fenêtre d'inactivité du préchargement), slope-visible peut consommer tout
//   le budget, pour qu'une vue de pente seule se charge à pleine vitesse.
function currentIGNSlopeVisibleCap() {
  if (ignForegroundQueue.length > 0) {
    return Math.max(4, Math.floor(IGN_CONCURRENCY * 0.3));
  }
  return IGN_CONCURRENCY;
}

function pushIGNEntry(entry) {
  if (isIGNSlopeZonePurpose(entry.purpose)) {
    // Les requêtes de zone ont la priorité absolue — directement dans la file de premier plan
    ignForegroundQueue.push(entry);
    return;
  }
  if (isIGNBackgroundPurpose(entry.purpose)) {
    ignBackgroundQueue.push(entry);
    return;
  }
  if (isIGNSlopeVisiblePurpose(entry.purpose)) {
    ignSlopeVisibleQueue.push(entry);
    return;
  }
  ignForegroundQueue.push(entry);
}

function popNextIGNEntry() {
  // 1. Fond de carte / pente de zone (premier plan) — priorité absolue.
  //    On choisit le candidat le plus proche du centre de la vue, pour que le centre de l'écran se charge d'abord !
  //    Priorité stricte : tant qu'elle a des entrées, rien d'autre ne démarre —
  //    même quand ses rasters WMS attendent que les octets en vol arrivent.
  if (ignForegroundQueue.length > 0) {
    if (ignForegroundQueue.length === 1 || !ignViewportCenter) {
      // FIFO quand le centre est inconnu (Mapbox envoie d'abord les tuiles du centre)
      const idx = firstStartableIGNIndex(ignForegroundQueue);
      return idx < 0 ? null : { entry: ignForegroundQueue.splice(idx, 1)[0], background: false };
    }
    let bestIdx = -1;
    let minD2 = Infinity;
    const cLng = ignViewportCenter.lng;
    const cLat = ignViewportCenter.lat;
    for (let i = 0; i < ignForegroundQueue.length; i++) {
      const e = ignForegroundQueue[i];
      if (!e.hasCoords || !canStartIGNEntry(e)) continue;
      const dLng = e.lng - cLng;
      const dLat = e.lat - cLat;
      const d2 = dLng * dLng + dLat * dLat;
      if (d2 < minD2) {
        minD2 = d2;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) bestIdx = firstStartableIGNIndex(ignForegroundQueue);
    return bestIdx < 0 ? null : { entry: ignForegroundQueue.splice(bestIdx, 1)[0], background: false };
  }
  // 2. Slope-visible — seulement quand la file du fond de carte est vide, et
  //    seulement jusqu'à son plafond dynamique, pour qu'une seule rafale de
  //    pente ne puisse jamais monopoliser tous les créneaux.
  if (
    ignSlopeVisibleQueue.length > 0
    && activeIGNSlopeVisible < currentIGNSlopeVisibleCap()
  ) {
    const idx = lastStartableIGNIndex(ignSlopeVisibleQueue);
    if (idx >= 0) return { entry: ignSlopeVisibleQueue.splice(idx, 1)[0], background: false };
  }
  // 3. Arrière-plan (préchargement / slope-warm) — budget de concurrence séparé,
  //    pour que les préchauffages ne puissent pas affamer le fond de carte ni slope-visible.
  if (ignBackgroundQueue.length === 0) return null;
  if (activeIGNBackground >= currentIGNBackgroundConcurrency()) return null;
  const idx = firstStartableIGNIndex(ignBackgroundQueue);
  return idx < 0 ? null : { entry: ignBackgroundQueue.splice(idx, 1)[0], background: true };
}

function pruneOldestIGNEntry() {
  if (totalIGNQueueLength() === 0) return null;

  let targetQueue = null;
  let targetIdx = -1;
  let oldestTs = Infinity;

  const considerQueue = (queue) => {
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].ts < oldestTs) {
        oldestTs = queue[i].ts;
        targetIdx = i;
        targetQueue = queue;
      }
    }
  };

  // On élague d'abord les entrées d'arrière-plan les plus anciennes (ce sont des
  // préchauffages), puis slope-visible (annulable), et enfin le fond de carte
  // (le plus coûteux à perdre, car Mapbox l'attend activement).
  considerQueue(ignBackgroundQueue);
  considerQueue(ignSlopeVisibleQueue);
  considerQueue(ignForegroundQueue);
  if (!targetQueue || targetIdx < 0) return null;
  return targetQueue.splice(targetIdx, 1)[0] || null;
}

function evict(cache, max) {
  if (cache.size <= max) return;
  const iter = cache.keys();
  const toDelete = cache.size - Math.floor(max * 0.75);
  for (let i = 0; i < toDelete; i++) {
    const k = iter.next().value;
    if (k !== undefined) cache.delete(k);
  }
}

// `mapTile` ({ key: 'z/x/y', requestedAt }) marque le travail fait pour une
// tuile DEM demandée par la carte elle-même, pour que pruneUnwantedMapDemWork()
// puisse l'abandonner dès que la carte n'attend plus cette tuile.
// `options.wmsBytes` : taille du raster WMS que la tâche télécharge
// (IGN_WMS_INFLIGHT_BYTES_MAX).
function scheduleIGN(fn, purpose, coords, mapTile = null, options = {}) {
  return new Promise((resolve, reject) => {
    let lng = 0, lat = 0;
    let hasCoords = false;
    if (coords && typeof coords.z === 'number' && typeof coords.col === 'number') {
      const c = wgs84TileCenter(coords.z, coords.col, coords.row);
      lng = c.lng;
      lat = c.lat;
      hasCoords = true;
    } else if (coords && Number.isFinite(coords.lng) && Number.isFinite(coords.lat)) {
      // lng/lat directs (requêtes WMS par tuile Mercator) — ordre depuis le centre.
      lng = coords.lng;
      lat = coords.lat;
      hasCoords = true;
    }
    pushIGNEntry({
      fn,
      resolve,
      reject,
      ts: performance.now(),
      purpose: purpose || null,
      mapTile,
      wmsBytes: Math.max(0, Number(options?.wmsBytes) || 0),
      lng,
      lat,
      hasCoords,
    });
    // Quand la file déborde, on abandonne les entrées les plus ANCIENNES par
    // date d'entrée en file (tuiles demandées pendant un déplacement précédent)
    // plutôt que la tête de file. La vue courante survit ainsi aux déplacements rapides.
    let pruned = 0;
    while (totalIGNQueueLength() > IGN_QUEUE_MAX) {
      const stale = pruneOldestIGNEntry();
      if (!stale) break;
      stale.resolve(PRUNED_SENTINEL);
      pruned++;
    }
    if (pruned > 0) {
      ignPrunedTotal += pruned;
      if (DEBUG) console.warn(`[sw-dem][queue] pruned ${pruned} stale (queue=${totalIGNQueueLength()}, lifetime=${ignPrunedTotal})`);
    }
    drainIGN();
  });
}

function drainIGN() {
  while (activeIGN < IGN_CONCURRENCY && totalIGNQueueLength() > 0) {
    // LIFO : prend l'élément le plus récent — priorité aux tuiles de la vue courante sur les anciennes
    const next = popNextIGNEntry();
    if (!next?.entry) break;
    const { entry, background } = next;
    const { fn, resolve, reject, purpose, wmsBytes } = entry;
    activeIGN++;
    activeIGNWmsBytes += wmsBytes;
    if (background) activeIGNBackground++;
    const isSlopeVisible = purpose === PURPOSE_SLOPE_VISIBLE;
    if (isSlopeVisible) activeIGNSlopeVisible++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeIGN--;
        activeIGNWmsBytes = Math.max(0, activeIGNWmsBytes - wmsBytes);
        if (background) activeIGNBackground = Math.max(0, activeIGNBackground - 1);
        if (isSlopeVisible) activeIGNSlopeVisible = Math.max(0, activeIGNSlopeVisible - 1);
        drainIGN();
      });
  }
}

// Vide les entrées IGN spéculatives en file mais pas encore lancées (pente,
// préchargement, préchauffages) en résolvant chacune en PRUNED_SENTINEL.
// Envoyé par le navigateur à chaque geste de l'utilisateur (`zoomstart` /
// `movestart`) par le message SW `CANCEL_STALE_DEM`, pour que le travail
// spéculatif de la vue précédente ne garde pas les créneaux IGN.
//
// Les entrées du fond de carte (sans usage) sont gardées : le début d'un geste
// ne dit rien des tuiles DEM dont la carte a encore besoin — après une rotation
// ou une inclinaison, c'est presque toutes. Les vider faisait retomber
// exactement ces tuiles sur le MNS de corrélation / le relief à 30 m (le bug
// « la 3D tombe à 30 m quand je tourne la caméra »). Le travail périmé du fond
// de carte est désormais abandonné tuile par tuile, dès que la carte ne
// l'attend plus (pruneUnwantedMapDemWork / DEM_WANTED_TILES).
//
// Renvoie le nombre d'entrées élaguées, pour le diagnostic.
function flushIGNQueue() {
  const total = totalIGNQueueLength();
  if (total === 0) return 0;
  // Garde dans la file de premier plan les entrées du fond de carte et PURPOSE_SLOPE_ZONE.
  const keptForeground = [];
  while (ignForegroundQueue.length > 0) {
    const entry = ignForegroundQueue.pop();
    if (!entry.purpose || entry.purpose === PURPOSE_SLOPE_ZONE) {
      keptForeground.unshift(entry);
    } else {
      entry.resolve(PRUNED_SENTINEL);
    }
  }
  for (const entry of keptForeground) ignForegroundQueue.push(entry);

  while (ignSlopeVisibleQueue.length > 0) {
    const stale = ignSlopeVisibleQueue.pop();
    stale.resolve(PRUNED_SENTINEL);
  }
  while (ignBackgroundQueue.length > 0) {
    const stale = ignBackgroundQueue.pop();
    stale.resolve(PRUNED_SENTINEL);
  }
  const pruned = total - keptForeground.length;
  if (pruned > 0) {
    ignPrunedTotal += pruned;
    if (DEBUG) console.warn(`[sw-dem][queue] flushed ${pruned} stale on viewport change`);
  }
  return pruned;
}
