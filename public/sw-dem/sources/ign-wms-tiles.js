// ---------------------------------------------------------------------------
// Tuiles d'altitude WMS de l'IGN — terrain à 1 m (MNT LiDAR HD) et MNS 0,40 m
// (MNS LiDAR HD) par tuile Mercator, avec leurs propres caches LRU, cache des
// échecs avec TTL et déduplication des requêtes en cours. La géométrie des
// rasters est dans ign-wms-raster.js.
// ---------------------------------------------------------------------------

const terrainWmsTileCache = new Map();
const terrainWmsInflight = new Map();
const TERRAIN_WMS_CACHE_MAX = 300;
const mnsWmsTileCache = new Map();
const mnsWmsInflight = new Map();
// Les grilles WMS brutes ne servent qu'à reconstruire la même tuile — le niveau
// chaud des DEM et CacheStorage répondent à toute nouvelle demande normale —
// donc on garde ce cache petit (96 × 256 Ko ≈ 24 Mo au lieu de ~77 Mo de tas du SW).
const MNS_WMS_CACHE_MAX = 96;

// Centre d'une tuile Mercator, pour servir les fetchs WMS du centre vers les bords.
function mercatorTileCenterCoords(mercZ, mercX, mercY) {
  const b = mercatorTileBounds(mercZ, mercX, mercY);
  return { lng: (b.west + b.east) / 2, lat: (b.north + b.south) / 2 };
}

function getCachedTerrainWms(key) {
  if (!terrainWmsTileCache.has(key)) return { hit: false };
  const entry = terrainWmsTileCache.get(key);
  if (entry instanceof Float32Array) return { hit: true, data: entry };
  if (entry && entry._null) {
    if (Date.now() - entry.ts < entry.ttl) return { hit: true, data: null };
    terrainWmsTileCache.delete(key);
    return { hit: false };
  }
  if (entry === null) {
    terrainWmsTileCache.delete(key);
    return { hit: false };
  }
  return { hit: true, data: entry };
}

function cacheTerrainWmsNull(key, errorType) {
  const ttl = errorType === 'permanent' ? IGN_NULL_TTL_PERMANENT : IGN_NULL_TTL_TRANSIENT;
  terrainWmsTileCache.set(key, { _null: true, ts: Date.now(), ttl, errorType });
}

// Renvoie le raster rééchantillonné, null (pas de donnée / échec passager) ou
// IGN_FETCH_CANCELLED. `mapTile` : voir scheduleIGN().
function terrainWmsCacheKey(mercZ, mercX, mercY) {
  return `wms-mnt/${mercZ}/${mercX}/${mercY}@${ignWmsSupersampleFactor(mercZ)}x`;
}

async function getTerrainWmsTile(mercZ, mercX, mercY, purpose = PURPOSE_SLOPE_VISIBLE, mapTile = null) {
  const supersample = ignWmsSupersampleFactor(mercZ);
  const key = terrainWmsCacheKey(mercZ, mercX, mercY);
  const cached = getCachedTerrainWms(key);
  if (cached.hit) return cached.data;

  if (terrainWmsInflight.has(key)) return terrainWmsInflight.get(key);

  const promise = scheduleIGN(async () => {
    const cached2 = getCachedTerrainWms(key);
    if (cached2.hit) return cached2.data;

    const { controller, cleanup, init } = ignFetchInit({ purpose, mapTile });
    try {
      const { width: srcW, height: srcH } = mnsWmsRequestSize(mercZ, mercX, mercY, supersample);
      // 1. MNT LiDAR HD (sol nu à 0,5 m), 2. RGE ALTI pour les pixels qu'il ne
      // couvre pas. Les deux rasters ont exactement la même géométrie de
      // requête : le comblement des trous est une fusion pixel par pixel avant
      // le rééchantillonnage.
      let raw = await fetchWmsElevationRaster(IGN_LIDAR_MNT_LAYER, mercZ, mercX, mercY, supersample, init);
      let validCount = 0;
      if (raw) {
        for (let i = 0; i < raw.length; i++) if (isValidWmsElevation(raw[i])) validCount++;
      }
      if (validCount < srcW * srcH) {
        const rgeAlti = await fetchWmsElevationRaster(IGN_DEM_FALLBACK_LAYER, mercZ, mercX, mercY, supersample, init);
        if (rgeAlti) {
          if (!raw || validCount === 0) {
            raw = rgeAlti;
          } else {
            for (let i = 0; i < raw.length; i++) {
              if (!isValidWmsElevation(raw[i])) raw[i] = rgeAlti[i];
            }
          }
          validCount = 0;
          for (let i = 0; i < raw.length; i++) if (isValidWmsElevation(raw[i])) validCount++;
        }
      }
      if (!raw) {
        cacheTerrainWmsNull(key, 'transient');
        return null;
      }
      if (validCount === 0) return null;
      const data = mnsWmsResampleToTile(raw, srcW, srcH);
      evict(terrainWmsTileCache, TERRAIN_WMS_CACHE_MAX);
      terrainWmsTileCache.set(key, data);
      return data;
    } catch {
      if (isIGNUserCancel(controller)) return IGN_FETCH_CANCELLED;
      cacheTerrainWmsNull(key, 'transient');
      return null;
    } finally {
      cleanup();
    }
  }, purpose, mercatorTileCenterCoords(mercZ, mercX, mercY), mapTile, { wmsBytes: wmsRasterBytes(mercZ, mercX, mercY, supersample) }).then((result) => {
    if (result === PRUNED_SENTINEL) return IGN_FETCH_CANCELLED;
    return result;
  }).finally(() => {
    terrainWmsInflight.delete(key);
  });

  terrainWmsInflight.set(key, promise);
  return promise;
}

function getCachedMnsWms(key) {
  if (!mnsWmsTileCache.has(key)) return { hit: false };
  const entry = mnsWmsTileCache.get(key);
  if (entry instanceof Float32Array) return { hit: true, data: entry };
  if (entry && entry._null) {
    if (Date.now() - entry.ts < entry.ttl) return { hit: true, data: null };
    mnsWmsTileCache.delete(key);
    return { hit: false };
  }
  if (entry === null) {
    mnsWmsTileCache.delete(key);
    return { hit: false };
  }
  return { hit: true, data: entry };
}

function cacheMnsWmsNull(key, errorType) {
  const ttl = errorType === 'permanent' ? IGN_NULL_TTL_PERMANENT : IGN_NULL_TTL_TRANSIENT;
  mnsWmsTileCache.set(key, { _null: true, ts: Date.now(), ttl, errorType });
}

function mnsWmsCacheKey(mercZ, mercX, mercY) {
  return `mns/${mercZ}/${mercX}/${mercY}@${mnsWmsSupersampleFactor()}x`;
}

// Oublie l'échec passager (délai dépassé, erreur HTTP) mémorisé pour les
// rasters LiDAR HD de cette tuile, pour qu'une nouvelle tentative
// (handleVideoDemRequest) interroge à nouveau geopf au lieu de relire le nul
// pendant IGN_NULL_TTL_TRANSIENT. Un trou de couverture confirmé est gardé.
function forgetTransientWmsFailures(mercZ, mercX, mercY) {
  const entries = [
    [mnsWmsTileCache, mnsWmsCacheKey(mercZ, mercX, mercY)],
    [terrainWmsTileCache, terrainWmsCacheKey(mercZ, mercX, mercY)],
  ];
  for (const [cache, key] of entries) {
    const entry = cache.get(key);
    if (entry && entry._null && entry.errorType !== 'permanent') cache.delete(key);
  }
}

// Vrai seulement quand le WMS LiDAR HD a répondu pour cette tuile sans aucun
// échantillon valide (un vrai trou de couverture) — jamais après un délai
// dépassé, une annulation ou une erreur HTTP.
function isMnsWmsConfirmedEmpty(mercZ, mercX, mercY) {
  const key = mnsWmsCacheKey(mercZ, mercX, mercY);
  // getCachedMnsWms d'abord : il retire une entrée nulle expirée.
  const cached = getCachedMnsWms(key);
  return cached.hit && !cached.data && mnsWmsTileCache.get(key)?.errorType === 'permanent';
}

// Renvoie le raster rééchantillonné, null (pas de donnée / échec passager) ou
// IGN_FETCH_CANCELLED. `mapTile` : voir scheduleIGN().
async function getMnsWmsTile(mercZ, mercX, mercY, purpose = null, mapTile = null) {
  const supersample = mnsWmsSupersampleFactor();
  const { width: srcW, height: srcH } = mnsWmsRequestSize(mercZ, mercX, mercY, supersample);
  const key = mnsWmsCacheKey(mercZ, mercX, mercY);
  const cached = getCachedMnsWms(key);
  if (cached.hit) return cached.data;

  if (mnsWmsInflight.has(key)) return mnsWmsInflight.get(key);

  const promise = scheduleIGN(async () => {
    const cached2 = getCachedMnsWms(key);
    if (cached2.hit) return cached2.data;

    // 1. Principal : le vrai WMS MNS LiDAR HD (modèle de surface à ~0,40 m)
    const { controller, cleanup, init } = ignFetchInit({ purpose, mapTile });
    try {
      let data = null;
      let answered = false;
      try {
        // La requête n'est volontairement PAS carrée en degrés (voir
        // mnsWmsRequestSize) : srcW > srcH, ramené à DEM_TILE_SIZE² par moyenne
        // par blocs et débarrassé du peigne en Y par mnsWmsResampleToTile, qui
        // tient compte de NaN et des bornes (les cellules sans échantillon
        // valide restent NaN).
        const raw = await fetchWmsElevationRaster(IGN_LIDAR_MNS_LAYER, mercZ, mercX, mercY, supersample, init);
        if (raw) {
          answered = true;
          const tiled = mnsWmsResampleToTile(raw, srcW, srcH);
          let tiledValid = 0;
          for (let i = 0; i < tiled.length; i++) if (isValidWmsElevation(tiled[i])) tiledValid++;
          if (tiledValid > 0) data = tiled;
        }
      } catch {
        if (isIGNUserCancel(controller)) return IGN_FETCH_CANCELLED;
      }

      // Pas de repli WMS vers les couches de corrélation HIGHRES / HIGHRES.MNS.
      //
      // Ces produits ne sont jamais servis que suréchantillonnés 2× en Y, quel
      // que soit le CRS du GetMap WMS : mesuré 128 lignes distinctes pour une
      // requête de 256 lignes, et les lignes dupliquées ne sont pas alignées par
      // paires (la suite des lignes rebondit A,B,B,A sur chaque bloc de 4) : ni
      // une requête plus grande ni une moyenne par blocs de 2x2 ne récupèrent
      // les échantillons manquants. Le peigne pair/impair du gradient mesurait
      // 0,70 à 1,23 — pire que le défaut des requêtes carrées en degrés que ce
      // fichier vient de corriger pour le LiDAR HD —, donc le raster de repli
      // réintroduirait exactement l'artefact en tirets sur l'overlay des pentes.
      //
      // Renvoyer null laisse buildIGNTile passer par l'ancien chemin WMTS, qui
      // échantillonne le produit sur sa propre matrice de tuiles WGS84G et ne
      // rééchantillonne donc jamais les lignes.
      if (data) {
        evict(mnsWmsTileCache, MNS_WMS_CACHE_MAX);
        mnsWmsTileCache.set(key, data);
        return data;
      }

      // Un raster bien formé sans aucun échantillon valide est un vrai trou de
      // couverture LiDAR HD : on le mémorise plus longtemps qu'un échec de
      // transport, pour ne pas répéter la requête WMS toutes les 10 s.
      cacheMnsWmsNull(key, answered ? 'permanent' : 'transient');
      return null;
    } catch {
      if (isIGNUserCancel(controller)) return IGN_FETCH_CANCELLED;
      cacheMnsWmsNull(key, 'transient');
      return null;
    } finally {
      cleanup();
    }
  }, purpose, mercatorTileCenterCoords(mercZ, mercX, mercY), mapTile, { wmsBytes: wmsRasterBytes(mercZ, mercX, mercY, supersample) }).then((result) => {
    if (result === PRUNED_SENTINEL) return IGN_FETCH_CANCELLED;
    return result;
  }).finally(() => {
    mnsWmsInflight.delete(key);
  });

  mnsWmsInflight.set(key, promise);
  return promise;
}
