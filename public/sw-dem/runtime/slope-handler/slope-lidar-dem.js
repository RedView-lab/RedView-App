// ---------------------------------------------------------------------------
// Traitement des tuiles de pente — résolveur de DEM (lit les tuiles DEM du terrain 3D)
//
// L'overlay demande exactement les tuiles de la pyramide DEM du terrain
// (slope-source.ts, TERRAIN_ALIGNED_RASTER_TILE_SIZE) : une tuile de pente est
// donc calculée à partir de la tuile DEM que le maillage du terrain a déjà
// chargée — niveau chaud, CacheStorage, ou construction en cours du terrain
// lui-même. Une tuile de pente ne construit elle-même une tuile DEM que sur un
// vrai échec de cache (choix explicite 0,40 m / 1 m différent du profil 3D,
// bande de LOD d'une vue inclinée) ; les voisines ne sont jamais construites.
// Le chemin à 30 m lit directement AWS Terrarium (CDN gratuit, requêtes fusionnées).
// ---------------------------------------------------------------------------

const FAST30M_DEM_INFLIGHT = new Map();

function demHeaderValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  if (Array.isArray(headers)) {
    const lower = name.toLowerCase();
    const entry = headers.find(([k]) => String(k).toLowerCase() === lower);
    return entry ? entry[1] : null;
  }
  return null;
}

// L'IGN est la seule source dont les constructions surface (MNS) et sol nu
// (MNT) diffèrent ; les tuiles AWS, suisses, norvégiennes et espagnoles sont
// identiques dans les deux profils.
function isDemProfileAgnosticSource(source) {
  return !/ign/i.test(source || '');
}

async function fetchFast30mDemResponse(z, x, y, demCache) {
  const awsKey = new Request(`/dem-tiles/${z}/${x}/${y}?rv-dem-profile=fast-30m`);
  const hot = demHotGet(awsKey.url);
  if (hot) return demHotResponse(hot);
  if (demCache) {
    const cached = await demCache.match(awsKey);
    if (cached && cached.status === 200) {
      try { demHotPut(awsKey.url, await cached.clone().blob(), Array.from(cached.headers.entries())); } catch { /* ignore */ }
      return cached;
    }
  }
  if (typeof fetchAWSTerrainTile !== 'function') return null;
  // Fusionnées : une tuile DEM à 30 m est à la fois une tuile propre et jusqu'à
  // quatre voisines de tuiles de pente construites en même temps.
  const inflightKey = `${z}/${x}/${y}`;
  let pending = FAST30M_DEM_INFLIGHT.get(inflightKey);
  if (!pending) {
    pending = (async () => {
      const blob = await fetchAWSTerrainTile(z, x, y);
      if (!blob) return null;
      const headers = {
        'Content-Type': 'image/png',
        'X-DEM-Source': 'aws-fast-30m',
        'X-DEM-Health': 'ok',
      };
      try { demHotPut(awsKey.url, blob, Object.entries(headers)); } catch { /* ignore */ }
      if (demCache) {
        try { await demCache.put(awsKey, new Response(blob, { status: 200, headers })); } catch { /* ignore */ }
      }
      return { blob, headers };
    })().finally(() => FAST30M_DEM_INFLIGHT.delete(inflightKey));
    FAST30M_DEM_INFLIGHT.set(inflightKey, pending);
  }
  const built = await pending;
  return built ? new Response(built.blob, { status: 200, headers: built.headers }) : null;
}

// La construction de cette tuile par le terrain lui-même, quand elle est en cours.
async function awaitInflightTerrainDem(z, x, y, demProfile) {
  if (typeof DEM_INFLIGHT === 'undefined' || !DEM_INFLIGHT) return null;
  const inflight = DEM_INFLIGHT.get(`${demProfile}:${z}/${x}/${y}`);
  if (!inflight) return null;
  try {
    const resp = await inflight;
    return resp && resp.status === 200 ? resp.clone() : null;
  } catch {
    return null;
  }
}

// opts.allowBuild (true par défaut) : à false, seul le DEM déjà disponible
// (niveau chaud / CacheStorage / construction en cours du terrain) est renvoyé —
// un échec donne null (ou un remplaçant brièvement en cache) au lieu de lancer
// une nouvelle construction de DEM. La branche AWS à 30 m l'ignore (les tuiles
// AWS coûtent peu).
async function getExistingTerrainDemResponse(z, x, y, demProfile, demCache, sourceDem = '', opts = {}) {
  const allowBuild = opts.allowBuild !== false;
  if (sourceDem === 'fast-30m' || demProfile === 'fast-30m') {
    // Fast-30m utilise strictement AWS Terrarium ; ne passe jamais à l'IGN.
    return fetchFast30mDemResponse(z, x, y, demCache);
  }

  // 1. Niveau chaud — finalize() n'y promeut que des tuiles définitives.
  const key = buildDemCacheKey(z, x, y, demProfile);
  const hot = demHotGet(key.url);
  if (hot) return demHotResponse(hot);

  // 2. CacheStorage. Un remplaçant brièvement en cache (overzoom du parent,
  // secours AWS) n'est PAS la réponse : handleDemRequest() vérifie son TTL et
  // reconstruit la vraie tuile à son expiration — le renvoyer ici figeait la
  // pente sur le remplaçant pour toujours.
  let standIn = null;
  if (demCache) {
    const cached = await demCache.match(key);
    if (cached && cached.status === 200) {
      if (!cached.headers.get('x-cache-ttl-ms')) return cached;
      standIn = cached;
    }
  }

  // 3. Le terrain construit cette même tuile en ce moment.
  const inflight = await awaitInflightTerrainDem(z, x, y, demProfile);
  if (inflight) return inflight;

  // 4. La tuile de l'autre profil, seulement là où les deux profils sont
  // identiques. L'ancien repli inconditionnel mettait des bâtiments dans la
  // pente « terrain 1 m » chaque fois que la 3D tournait sur la surface 0,40 m.
  if (demProfile !== 'default') {
    const other = demHotGet(buildDemCacheKey(z, x, y, 'default').url);
    if (other && isDemProfileAgnosticSource(demHeaderValue(other.headers, 'X-DEM-Source'))) {
      return demHotResponse(other);
    }
  }

  // 5. On la construit — partagée avec le terrain via DEM_INFLIGHT.
  if (!allowBuild) return standIn;
  try {
    if (typeof handleDemRequest === 'function') {
      const built = await handleDemRequest(key, z, x, y, 0, demProfile);
      if (built && built.status === 200) return built;
    }
  } catch { /* ignore */ }
  return null;
}

// ── DEM voisins (Horn + bordure d'interpolation) ──────────────────────

const SLOPE_NEIGHBOUR_DIRECTIONS = [
  ['north', 0, -1],
  ['east', 1, 0],
  ['south', 0, 1],
  ['west', -1, 0],
];

function shouldUseSlopeNeighbourDem(resp, demProfile, sourceDem = '', ownSourceClass = '') {
  if (!resp) return false;
  if (typeof resp.status === 'number' && resp.status !== 200) return false;
  const health = (demHeaderValue(resp.headers, 'X-DEM-Health') || 'ok').toLowerCase();
  if (health !== 'ok') return false;
  const source = (demHeaderValue(resp.headers, 'X-DEM-Source') || '').toLowerCase();

  // Séparation stricte des sources DEM : ne JAMAIS mélanger le DEM AWS à 30 m avec un DEM LiDAR haute résolution !
  if (sourceDem === 'fast-30m') {
    return source.startsWith('aws');
  }
  // HD : raccord seulement avec la même classe de DEM que la tuile propre.
  const neighbourIsAws = source === 'aws-fast-30m' || source.startsWith('aws-terrarium');
  if (neighbourIsAws !== (ownSourceClass === 'aws')) return false;
  if (
    source.startsWith('aws-emergency')
    || source.startsWith('mapbox')
    || source.startsWith('overzoom')
  ) {
    return false;
  }
  return true;
}

/**
 * Les quatre DEM voisins cardinaux d'une tuile de pente, à partir de ce que le
 * terrain a déjà : niveau chaud, CacheStorage, ou sa construction en cours —
 * attendue, puisque les tuiles de la vue sont construites ensemble et que
 * l'attente est ce qui rend une tuile complète aux jointures dès le premier
 * affichage. Une voisine que le terrain n'a jamais demandée (hors de la vue)
 * n'est pas construite : la tuile est servie provisoire et reconstruite quand
 * ce DEM arrive (waitSlopeTileOnDem). Le chemin à 30 m récupère plutôt la
 * voisine AWS.
 *
 * Renvoie { blobs: {north…west: Blob|null}, missing: [[x, y]], standIns: [[x, y]] }
 * — les `standIns` sont utilisés mais brièvement en cache (la tuile n'est pas
 * encore définitive).
 */
async function resolveSlopeNeighbourDems(z, x, y, demProfile, demCache, sourceDem, ownSourceClass) {
  const n = 2 ** z;
  const blobs = { north: null, east: null, south: null, west: null };
  const missing = [];
  const standIns = [];
  await Promise.all(SLOPE_NEIGHBOUR_DIRECTIONS.map(async ([dir, dx, dy]) => {
    const ny = y + dy;
    if (ny < 0 || ny >= n) return; // au-delà des pôles : rien à attendre
    const nx = (x + dx + n) % n; // l'antiméridien boucle
    try {
      const resp = sourceDem === 'fast-30m'
        ? await fetchFast30mDemResponse(z, nx, ny, demCache)
        : await getExistingTerrainDemResponse(z, nx, ny, demProfile, demCache, sourceDem, { allowBuild: false });
      if (!shouldUseSlopeNeighbourDem(resp, demProfile, sourceDem, ownSourceClass)) {
        missing.push([nx, ny]);
        return;
      }
      blobs[dir] = await resp.blob();
      if (resp.headers.get('x-cache-ttl-ms')) standIns.push([nx, ny]);
    } catch {
      missing.push([nx, ny]);
    }
  }));
  return { blobs, missing, standIns };
}
