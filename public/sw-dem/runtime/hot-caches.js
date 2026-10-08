// ---------------------------------------------------------------------------
// Niveaux chauds en mémoire (Map utilisée en LRU) devant CacheStorage pour les
// points d'accès DEM, pente, altitude et ortho : les tuiles en cache répondent
// en < 1 ms.
// ---------------------------------------------------------------------------

// ──────────────────────────────────────────────────────────────────────────
// DEM_HOT_CACHE — LRU en mémoire des blobs de tuiles DEM servis récemment.
//
// Motivation : chaque succès de cache paie aujourd'hui `caches.open(CACHE_NAME)`
// (~1 à 5 ms) + `cache.match(key)` (~5 à 25 ms sur un CacheStorage sur disque).
// Un seul dézoom d'une vue inclinée à 60° en z14 demande ~25 à 50 tuiles, et un
// changement de style satellite/topo redemande ~150 tuiles en quelques
// centaines de ms. Même quand toutes les tuiles sont déjà en cache sur disque,
// les allers-retours CacheStorage cumulés atteignent 0,5 à 2,5 s de pure E/S sur
// le fil du SW — exactement le genre de blocage qui donne l'impression que « la
// carte rame ».
//
// Ce niveau chaud se place DEVANT CacheStorage et renvoie une Response neuve
// (clone du blob) en < 1 ms. Des taux de succès au-delà de 80 % sont courants
// pendant une session où l'utilisateur zoome / se déplace dans la même région.
//
// Budget : 192 entrées × ~120 Ko de PNG terrain-RGB en moyenne ≈ 23 Mo au pic —
// négligeable face au jeu de travail de plus d'1 Go que Mapbox garde lui-même en
// textures WebGL.
//
// Éviction : Map classique utilisée en LRU. On réinsère à chaque lecture pour
// que l'ordre d'itération suive la récence, puis on retire les clés les plus
// anciennes au-delà du plafond. Pas d'expiration — les entrées sont invalidées
// par changement d'époque (le nom du cache change → l'activation purge tout → le
// cache chaud survit mais ne contient que des références périmées jamais
// relues, car l'URL de cacheKey intègre l'époque via demProfile et les
// messages PURGE appellent demHotClear).
// ──────────────────────────────────────────────────────────────────────────
const DEM_HOT_CACHE_DEFAULT_MAX = 512;
let DEM_HOT_CACHE_MAX = DEM_HOT_CACHE_DEFAULT_MAX;
const DEM_HOT_CACHE = new Map();

function demHotGet(keyStr) {
  const entry = DEM_HOT_CACHE.get(keyStr);
  if (!entry) return null;
  // Refresh LRU position
  DEM_HOT_CACHE.delete(keyStr);
  DEM_HOT_CACHE.set(keyStr, entry);
  return entry;
}

function demHotPut(keyStr, blob, headerInit) {
  if (!blob) return;
  if (DEM_HOT_CACHE.has(keyStr)) DEM_HOT_CACHE.delete(keyStr);
  DEM_HOT_CACHE.set(keyStr, { blob, headers: headerInit });
  if (DEM_HOT_CACHE.size > DEM_HOT_CACHE_MAX) {
    const drop = DEM_HOT_CACHE.size - Math.floor(DEM_HOT_CACHE_MAX * 0.85);
    const iter = DEM_HOT_CACHE.keys();
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      DEM_HOT_CACHE.delete(k);
    }
  }
}

function demHotClear() {
  DEM_HOT_CACHE.clear();
}

// Reconstruit une Response neuve à partir d'une entrée du cache chaud. Chaque
// appel reçoit sa propre enveloppe Response (peu coûteuse) adossée au MÊME Blob
// (sans copie sur la plupart des moteurs — le rendu incrémente juste un compteur
// de références interne).
function demHotResponse(entry) {
  return new Response(entry.blob, { status: 200, headers: entry.headers });
}

// Redimensionne à chaud le niveau chaud des DEM. Appelé quand la pente ou l'altitude est activée.
let _slopeActive = false;
let _altitudeActive = false;

function syncDemHotCacheCapacity() {
  if (_slopeActive || _altitudeActive) {
    setDemHotCacheCapacity(
      (typeof DEM_HOT_CACHE_MAX_SLOPE_ACTIVE !== 'undefined')
        ? DEM_HOT_CACHE_MAX_SLOPE_ACTIVE
        : 2048
    );
  } else {
    setDemHotCacheCapacity(DEM_HOT_CACHE_DEFAULT_MAX);
  }
}

function setDemHotCacheCapacity(newMax) {
  if (!Number.isFinite(newMax) || newMax < 32) return;
  DEM_HOT_CACHE_MAX = newMax;
  if (DEM_HOT_CACHE.size > DEM_HOT_CACHE_MAX) {
    const drop = DEM_HOT_CACHE.size - Math.floor(DEM_HOT_CACHE_MAX * 0.85);
    const iter = DEM_HOT_CACHE.keys();
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      DEM_HOT_CACHE.delete(k);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// SLOPE_HOT_CACHE — LRU en mémoire des PNG de pente servis récemment.
//
// Pendant de DEM_HOT_CACHE devant CacheStorage pour le point d'accès
// /slope-tiles. Chaque succès de cache de pente paie aujourd'hui 5 à 25 ms sur le
// fil du SW pour caches.open() + cache.match(). Lors d'un changement de
// résolution (0,40 m ↔ 1 m) ou d'un retour en arrière, la même vue redemande
// ~25 à 50 tuiles de pente en quelques centaines de ms ; même toutes en cache sur
// disque, la latence CacheStorage cumulée atteint 0,5 à 2 s de pure E/S —
// exactement le symptôme « le changement n'est pas instantané ». Ce niveau
// renvoie une Response neuve en < 1 ms : les tuiles de pente en cache
// s'affichent immédiatement.
//
// Budget : 192 × ~8 Ko de PNG de pente en moyenne ≈ 1,5 Mo au pic — négligeable.
// ──────────────────────────────────────────────────────────────────────────
const SLOPE_HOT_CACHE = new Map();

function slopeHotGet(keyStr) {
  const entry = SLOPE_HOT_CACHE.get(keyStr);
  if (!entry) return null;
  SLOPE_HOT_CACHE.delete(keyStr);
  SLOPE_HOT_CACHE.set(keyStr, entry);
  return entry;
}

function slopeHotPut(keyStr, blob, headerInit) {
  if (!blob) return;
  if (SLOPE_HOT_CACHE.has(keyStr)) SLOPE_HOT_CACHE.delete(keyStr);
  SLOPE_HOT_CACHE.set(keyStr, { blob, headers: headerInit });
  if (SLOPE_HOT_CACHE.size > SLOPE_HOT_CACHE_MAX) {
    const drop = SLOPE_HOT_CACHE.size - Math.floor(SLOPE_HOT_CACHE_MAX * 0.85);
    const iter = SLOPE_HOT_CACHE.keys();
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      SLOPE_HOT_CACHE.delete(k);
    }
  }
}

function slopeHotDelete(keyStr) {
  SLOPE_HOT_CACHE.delete(keyStr);
}

function slopeHotInvalidateZoneDownsampled(zoneHash) {
  if (!zoneHash) return;
  const zoneSub = `zone=${zoneHash}`;
  for (const key of Array.from(SLOPE_HOT_CACHE.keys())) {
    if (key.includes(zoneSub)) {
      SLOPE_HOT_CACHE.delete(key);
    }
  }
}

function slopeHotClear() {
  SLOPE_HOT_CACHE.clear();
}

// Retire toutes les entrées chaudes d'une tuile de pente, quels que soient son
// profil / sa source / sa requête (les clés ont la forme
// `${sourceDem}:${profile}:/slope-tiles/z/x/y?…`).
function slopeHotDeleteTile(z, x, y) {
  const path = `/slope-tiles/${z}/${x}/${y}`;
  for (const key of Array.from(SLOPE_HOT_CACHE.keys())) {
    const at = key.indexOf(path);
    if (at < 0) continue;
    const next = key.charAt(at + path.length);
    if (next === '' || next === '?') SLOPE_HOT_CACHE.delete(key);
  }
}

function slopeHotResponse(entry) {
  return new Response(entry.blob, { status: 200, headers: entry.headers });
}

// ──────────────────────────────────────────────────────────────────────────
// ALTITUDE_HOT_CACHE — LRU en mémoire des PNG d'altitude servis récemment.
//
// Pendant de SLOPE_HOT_CACHE devant CacheStorage pour le point d'accès
// /altitude-tiles. Chaque succès de cache d'altitude paie aujourd'hui 5 à 25 ms
// sur le fil du SW pour caches.open() + cache.match(). Lors d'une désactivation
// puis réactivation, d'une repeinte de Mapbox ou d'un retour en arrière, la même
// vue redemande ~25 à 50 tuiles d'altitude en quelques centaines de ms ; même
// toutes en cache sur disque, la latence CacheStorage cumulée atteint ~0,5 à 2 s
// de pure E/S — exactement le symptôme « l'overlay d'altitude est lent ». Ce
// niveau renvoie une Response neuve en < 1 ms : les tuiles d'altitude en cache
// s'affichent immédiatement.
//
// Budget : 192 × ~4 Ko de PNG d'altitude en moyenne ≈ 0,8 Mo au pic — négligeable.
// ──────────────────────────────────────────────────────────────────────────
const ALTITUDE_HOT_CACHE = new Map();

function altitudeHotGet(keyStr) {
  const entry = ALTITUDE_HOT_CACHE.get(keyStr);
  if (!entry) return null;
  ALTITUDE_HOT_CACHE.delete(keyStr);
  ALTITUDE_HOT_CACHE.set(keyStr, entry);
  return entry;
}

function altitudeHotPut(keyStr, blob, headerInit) {
  if (!blob) return;
  if (ALTITUDE_HOT_CACHE.has(keyStr)) ALTITUDE_HOT_CACHE.delete(keyStr);
  ALTITUDE_HOT_CACHE.set(keyStr, { blob, headers: headerInit });
  if (ALTITUDE_HOT_CACHE.size > ALTITUDE_HOT_CACHE_MAX) {
    const drop = ALTITUDE_HOT_CACHE.size - Math.floor(ALTITUDE_HOT_CACHE_MAX * 0.85);
    const iter = ALTITUDE_HOT_CACHE.keys();
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      ALTITUDE_HOT_CACHE.delete(k);
    }
  }
}

function altitudeHotClear() {
  ALTITUDE_HOT_CACHE.clear();
}

function altitudeHotResponse(entry) {
  return new Response(entry.blob, { status: 200, headers: entry.headers });
}

// ──────────────────────────────────────────────────────────────────────────
// ORTHO_HOT_CACHE — LRU en mémoire des images d'orthophotos servies récemment.
//
// Supprime les allers-retours disque de CacheStorage pour le point d'accès
// /ortho-tiles. Renvoie une Response neuve en < 1 ms : les tuiles
// d'orthophotos en cache s'affichent instantanément.
// Budget : 192 × ~25 Ko de JPEG en moyenne ≈ 4,8 Mo au pic.
// ──────────────────────────────────────────────────────────────────────────
const ORTHO_HOT_CACHE_MAX = 192;
const ORTHO_HOT_CACHE = new Map();

function orthoHotGet(keyStr) {
  const entry = ORTHO_HOT_CACHE.get(keyStr);
  if (!entry) return null;
  ORTHO_HOT_CACHE.delete(keyStr);
  ORTHO_HOT_CACHE.set(keyStr, entry);
  return entry;
}

function orthoHotPut(keyStr, blob, headerInit) {
  if (!blob) return;
  if (ORTHO_HOT_CACHE.has(keyStr)) ORTHO_HOT_CACHE.delete(keyStr);
  ORTHO_HOT_CACHE.set(keyStr, { blob, headers: headerInit });
  if (ORTHO_HOT_CACHE.size > ORTHO_HOT_CACHE_MAX) {
    const drop = ORTHO_HOT_CACHE.size - Math.floor(ORTHO_HOT_CACHE_MAX * 0.85);
    const iter = ORTHO_HOT_CACHE.keys();
    for (let i = 0; i < drop; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      ORTHO_HOT_CACHE.delete(k);
    }
  }
}

function orthoHotClear() {
  ORTHO_HOT_CACHE.clear();
}

function orthoHotResponse(entry) {
  return new Response(entry.blob, { status: 200, headers: entry.headers });
}
