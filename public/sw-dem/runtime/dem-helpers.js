// ---------------------------------------------------------------------------
// Fonctions de réponse partagées et repli sûr par overzoom du parent, utilisés
// par handleDemRequest et par le garde-fou de santé.
//
// Extrait de sw-dem.js (3 mai).
// ---------------------------------------------------------------------------

function buildDemResponse(pngBlob, demSource, shortCache, healthStatus = 'ok') {
  const cachedAt = Date.now();
  const shortTtlMs = shortCache ? 15_000 : 0;
  return new Response(pngBlob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      // TTL de 30 jours sur les tuiles DEM positives. Les DEM AWS Terrarium
      // comme les DEM LiDAR IGN / suisses sont des données de référence
      // statiques — garder le cache du SW chaud d'une session à l'autre évite de
      // repayer les zones déjà visitées, et c'est le plus gros levier sur le SKU
      // Raster Tiles.
      'Cache-Control': shortCache
        ? `public, max-age=${Math.max(1, Math.ceil(shortTtlMs / 1000))}`
        : 'public, max-age=2592000',
      'X-DEM-Source': demSource,
      'X-DEM-Health': healthStatus,
      'x-cached-at': String(cachedAt),
      ...(shortTtlMs > 0 ? { 'x-cache-ttl-ms': String(shortTtlMs) } : {}),
    },
  });
}

// 204 No Content : signal canonique « pas de tuile ici » pour le rendu du
// terrain, qui réutilise le maillage de la tuile parente au lieu d'afficher un trou.
// Raison 204 d'une construction dont le travail IGN a été annulé (voir
// computeDemRequest) : une requête fusionnée dessus reconstruit au lieu de
// garder cette réponse vide.
const DEM_CANCELLED_REASON = 'cancelled';

function noTileResponse(reason) {
  return new Response(null, {
    status: 204,
    headers: { 'X-DEM-Reason': reason },
  });
}

// PNG transparent minimal de 1×1, repli sûr quand la donnée DEM est absente.
// Généré avec node:zlib (deflate + CRC32) et vérifié bloc par bloc : l'ancien
// littéral avait un CRC IDAT / Adler-32 faux, et les navigateurs le rejetaient.
const TRANSPARENT_PNG = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUA' +
  'Aen63NgAAAAASUVORK5CYII='
), (c) => c.charCodeAt(0));

function transparentTileResponse() {
  return new Response(TRANSPARENT_PNG.slice(), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'X-Tile-Type': 'transparent',
    },
  });
}

function isExpertFallbackRiskTile(z, x, y) {
  return z >= 12 && (
    tileOverlapsFrance(z, x, y)
    || tileOverlapsOverseasFrance(z, x, y)
    || tileOverlapsSwitzerland(z, x, y)
    || tileOverlapsNorway(z, x, y)
    || tileOverlapsSpain(z, x, y)
  );
}

function resolveDemProfile(url) {
  return url.searchParams.get('rv-dem-profile') === 'terrain' ? 'terrain' : 'default';
}

function resolveDemProfileFromRequest(request) {
  try {
    return resolveDemProfile(new URL(request.url, self.location.origin));
  } catch {
    return 'default';
  }
}

function resolveDemRequestPurposeFromRequest(request) {
  try {
    const url = new URL(request.url, self.location.origin);
    const purpose = url.searchParams.get('rv-purpose');
    if (purpose) return purpose;
    if (url.searchParams.get('pf') === '1') return 'dem-prefetch';
    return null;
  } catch {
    return null;
  }
}

// Les tuiles de terrain de la carte elle-même portent `rv-src=map`
// (buildDemTilesTemplate dans features/map3d/hooks/useMap/demTiles.ts). Les
// autres lecteurs de /dem-tiles (ombres solaires, pente, préchargement,
// overzoom du parent) ne le font jamais : seules les requêtes de la carte sont
// jugées par les instantanés DEM_WANTED_TILES qu'elle envoie.
function isMapDemTileRequest(request) {
  try {
    return new URL(request.url, self.location.origin).searchParams.get('rv-src') === 'map';
  } catch {
    return false;
  }
}

// La carte hors écran de l'export vidéo du survol (cloneLiveStyle dans
// features/centerPanel/flyover/video/videoMap.ts) marque ses tuiles de terrain
// `rv-src=video` : voir handleVideoDemRequest().
function isVideoDemTileRequest(request) {
  try {
    return new URL(request.url, self.location.origin).searchParams.get('rv-src') === 'video';
  } catch {
    return false;
  }
}

function buildDemCacheKey(z, x, y, demProfile) {
  const profileQuery = demProfile === 'terrain' ? '?rv-dem-profile=terrain' : '';
  return new Request(`/dem-tiles/${z}/${x}/${y}${profileQuery}`);
}

function shouldSkipUnsafeOverzoomParent(parentResp, z, x, y) {
  const parentShortTtlMs = parseInt(parentResp.headers.get('x-cache-ttl-ms') || '0', 10);
  const parentHealth = (parentResp.headers.get('X-DEM-Health') || 'ok').toLowerCase();
  if (parentHealth !== 'ok') return true;

  if (!isExpertFallbackRiskTile(z, x, y)) return false;

  if (parentShortTtlMs > 0) return true;

  const parentSource = (parentResp.headers.get('X-DEM-Source') || '').toLowerCase();
  if (!parentSource) return true;

  return parentSource.startsWith('aws-terrarium')
    || parentSource.startsWith('aws-emergency')
    || parentSource.startsWith('mapbox')
    || parentSource.startsWith('overzoom')
    || parentSource.includes('fastpath');
}

function shouldAllowParentOverzoomFallback(z, x, y) {
  if (z <= MAPBOX_DEM_MAXZOOM) return true;
  return isExpertFallbackRiskTile(z, x, y);
}

// Statistiques d'altitude (min/max/moyenne) de la partie de la tuile parente
// DÉJÀ disponible la plus proche qui couvre (z, x, y). Utilisées par le
// garde-fou de santé pour comparer une tuile fraîchement construite à son ancêtre.
//
// Contrairement à tryParentOverzoom, ne construit jamais rien : niveau chaud et
// CacheStorage seulement (pas de handleDemRequest → pas de fetch WMS, pas de
// chaîne récursive de parents), et pas d'aller-retour overzoom Catmull-Rom +
// encodage + décodage PNG — les statistiques sont lues directement dans le
// sous-rectangle du parent. Renvoie { stats, source, parentZ }, ou null quand
// aucun parent utilisable n'est en cache.
async function findCachedParentStats(cache, z, x, y, demProfile = 'default') {
  if (!shouldAllowParentOverzoomFallback(z, x, y)) return null;
  const minParentZ = Math.max(0, z - DEM_OVERZOOM_MAX_DEPTH);
  const levels = [];
  for (let pZ = z - 1; pZ >= minParentZ; pZ--) levels.push(pZ);
  if (levels.length === 0) return null;

  // Niveau chaud d'abord (même identité de Blob → succès du cache de décodage),
  // puis une seule passe parallèle de lectures CacheStorage pour les niveaux manqués.
  const candidates = levels.map((pZ) => {
    const key = buildDemCacheKey(pZ, x >> (z - pZ), y >> (z - pZ), demProfile);
    const hot = (typeof demHotGet === 'function') ? demHotGet(key.url) : null;
    return { pZ, key, hot };
  });
  const matched = await Promise.all(candidates.map((c) => (
    c.hot ? null : cache.match(c.key).catch(() => null)
  )));

  for (let i = 0; i < candidates.length; i++) {
    const { pZ, hot } = candidates[i];
    let headers;
    let blobPromise;
    if (hot) {
      headers = new Headers(hot.headers);
      blobPromise = Promise.resolve(hot.blob);
    } else {
      const resp = matched[i];
      if (!resp || resp.status !== 200) continue;
      headers = resp.headers;
      blobPromise = resp.blob();
    }
    const headerView = { headers };
    if (shouldSkipUnsafeOverzoomParent(headerView, z, x, y)) continue;

    try {
      const parentElevations = await decodeTerrainRGBBlob(await blobPromise);
      const size = Math.round(Math.sqrt(parentElevations.length));
      const dz = z - pZ;
      const span = size >> dz;
      if (span < 1) continue;
      const x0 = (x - ((x >> dz) << dz)) * span;
      const y0 = (y - ((y >> dz) << dz)) * span;
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let count = 0;
      for (let py = y0; py < y0 + span; py++) {
        const row = py * size;
        for (let px = x0; px < x0 + span; px++) {
          const v = parentElevations[row + px];
          if (!Number.isFinite(v)) continue;
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
          count++;
        }
      }
      if (count === 0) continue;
      return {
        stats: { valid: true, min, max, mean: sum / count, range: max - min },
        source: headers.get('X-DEM-Source') || 'unknown',
        parentZ: pZ,
      };
    } catch {
      /* on essaie l'ancêtre suivant */
    }
  }
  return null;
}

// `options.cachedOnly` : ne suréchantillonne qu'un ancêtre déjà dans le niveau
// chaud / CacheStorage — ne lance jamais de construction récursive de parent (fetch WMS).
async function tryParentOverzoom(cache, z, x, y, depth, demProfile = 'default', options = {}) {
  if (depth > 0) return null;
  if (!shouldAllowParentOverzoomFallback(z, x, y)) return null;

  const minParentZ = Math.max(0, z - DEM_OVERZOOM_MAX_DEPTH);
  for (let pZ = z - 1; pZ >= minParentZ; pZ--) {
    const pX = x >> (z - pZ);
    const pY = y >> (z - pZ);
    const parentKey = buildDemCacheKey(pZ, pX, pY, demProfile);

    // Chemin rapide : niveau chaud en mémoire (voir DEM_HOT_CACHE dans
    // hot-caches.js). L'overzoom est sur le chemin critique de chaque échec de
    // cache en FR/CH/ES/NO à z>14 et de chaque rafraîchissement à TTL court ;
    // sauter ici CacheStorage pour les parents déjà chauds retire encore 5 à
    // 25 ms × profondeur de parents (jusqu'à 4) du chemin lent de chaque tuile
    // de la vue en attente.
    let parentResp = null;
    const parentHotKey = parentKey.url;
    const parentHot = (typeof demHotGet === 'function') ? demHotGet(parentHotKey) : null;
    if (parentHot) {
      parentResp = demHotResponse(parentHot);
    } else {
      parentResp = await cache.match(parentKey);
    }
    if (!parentResp || parentResp.status !== 200) {
      if (options.cachedOnly) continue;
      parentResp = await handleDemRequest(parentKey, pZ, pX, pY, depth + 1, demProfile);
    }
    if (!parentResp || parentResp.status !== 200) continue;

    const parentSource = parentResp.headers.get('X-DEM-Source') || 'unknown';
    if (shouldSkipUnsafeOverzoomParent(parentResp, z, x, y)) {
      if (DEBUG) {
        console.warn(
          `[sw-dem][expert-fallback] skip parent ${pZ}/${pX}/${pY} for ${z}/${x}/${y} src=${parentSource}`,
        );
      }
      continue;
    }

    try {
      const parentBlob = await parentResp.clone().blob();
      const overzoomed = await overzoomDemTile(parentBlob, pZ, pX, pY, z, x, y);
      if (overzoomed) {
        // Rejette les overzooms de parent qui s'effondrent en un raster plat à
        // zéro sur la France / la Suisse. Une tuile z14 en cache décodée tout à 0
        // (tuile Mapbox / AWS sur une poche sans donnée, remplaçant décodé à
        // zéro) se propagerait sinon comme une dalle parfaitement plate à chaque
        // tuile enfant qui y retombe. On passe au zoom parent suivant.
        if (isExpertFallbackRiskTile(z, x, y)) {
          try {
            const overzoomedElev = await decodeTerrainRGBBlob(overzoomed);
            const stats = summarizeDemElevations(overzoomedElev);
            if (isFlatlinedInlandStats(stats, z, x, y)) {
              if (DEBUG) console.warn(
                `[sw-dem][overzoom] skip flat-inland parent ${pZ}/${pX}/${pY} for ${z}/${x}/${y} src=${parentSource}`,
              );
              continue;
            }
          } catch { /* si le décodage échoue, on accepte comme avant */ }
        }
        return { blob: overzoomed, source: `overzoom-z${pZ}:${parentSource}` };
      }
    } catch (err) {
      if (DEBUG) console.warn(`[sw-dem] overzoom failed ${pZ}/${pX}/${pY}`, err);
    }
  }
  return null;
}
