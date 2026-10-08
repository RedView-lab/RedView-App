// ---------------------------------------------------------------------------
// Récupération des tuiles IGN avec cache LRU en mémoire + limiteur de concurrence
// Cache des échecs avec TTL + repli sur les niveaux de zoom inférieurs
// ---------------------------------------------------------------------------

function buildDEMTileURL(z, col, row) {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_DEM_LAYER}&STYLE=normal` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&TILEMATRIXSET=${IGN_DEM_TILEMATRIXSET}` +
    `&TILEMATRIX=${z}&TILEROW=${row}&TILECOL=${col}`
  );
}

// Met en cache un résultat nul avec ses métadonnées de TTL
function cacheNull(key, errorType) {
  const ttl = errorType === 'permanent' ? IGN_NULL_TTL_PERMANENT : IGN_NULL_TTL_TRANSIENT;
  ignTileCache.set(key, { _null: true, ts: Date.now(), ttl, errorType });
}

// Indique si une entrée en cache est une vraie donnée (Float32Array) ou un nul expiré / actif
function getCached(key) {
  if (!ignTileCache.has(key)) return { hit: false };
  const entry = ignTileCache.get(key);
  // Données de tuile valides (Float32Array)
  if (entry instanceof Float32Array) return { hit: true, data: entry };
  // Entrée nulle avec TTL
  if (entry && entry._null) {
    if (Date.now() - entry.ts < entry.ttl) {
      return { hit: true, data: null }; // Encore dans le TTL — on respecte le nul
    }
    // Expirée — on l'évince et on autorise une nouvelle tentative
    ignTileCache.delete(key);
    return { hit: false };
  }
  // null hérité (sans métadonnées) — évincé
  if (entry === null) {
    ignTileCache.delete(key);
    return { hit: false };
  }
  return { hit: true, data: entry };
}

async function getIGNTile(z, col, row, purpose) {
  const key = `${z}/${col}/${row}`;
  const cached = getCached(key);
  if (cached.hit) return cached.data;

  // Déduplication : si cette tuile est déjà en cours de récupération, on réutilise la promesse en cours
  if (ignInflight.has(key)) return ignInflight.get(key);

  const promise = scheduleIGN(async () => {
    // Nouvelle vérification après obtention du créneau de concurrence
    const cached2 = getCached(key);
    if (cached2.hit) return cached2.data;

    const url = buildDEMTileURL(z, col, row);
    const { controller, cleanup, init } = ignFetchInit();
    try {
      // priority:'high' est une indication de priorité de flux HTTP/2
      // (Chrome/Edge/Safari la respectent nativement, Firefox l'ignore). Les
      // tuiles DEM portent le maillage visible — elles DOIVENT arriver avant les
      // ressources secondaires (analytics, préchargements, etc.) sur la
      // connexion H2 partagée avec geopf. Gain gratuit de ~30 à 80 ms de TTFB
      // dès qu'il y a du trafic de fond sur la connexion.
      const res = await fetchIgnWithRetry(url, init);
      if (!res.ok) {
        const errorType = res.status === 404 ? 'permanent' : 'transient';
        cacheNull(key, errorType);
        return null;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== IGN_SRC_TILE_SIZE * IGN_SRC_TILE_SIZE * 4) {
        cacheNull(key, 'permanent');
        return null;
      }
      const data = decodeBIL32(buf);
      evict(ignTileCache, IGN_CACHE_MAX);
      ignTileCache.set(key, data);
      return data;
    } catch {
      // Pas de cache négatif quand C'EST NOUS qui avons annulé le fetch sur un
      // geste (CANCEL_STALE_DEM) : la nouvelle vue redemande souvent des tuiles
      // qui se recouvrent dans les ~50 ms et doit atteindre le vrai réseau, pas
      // une entrée nulle passagère causée par notre propre annulation.
      if (isIGNUserCancel(controller)) return null;
      cacheNull(key, 'transient');
      return null;
    } finally {
      cleanup();
    }
  }, purpose, { z, col, row }).then((result) => {
    // Si la requête a été élaguée de la file, NE PAS mettre en cache — renvoyer null
    if (result === PRUNED_SENTINEL) return null;
    return result;
  }).finally(() => {
    ignInflight.delete(key);
  });

  ignInflight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Repli sur les niveaux de zoom : essaie les zooms inférieurs quand la tuile manque
// Renvoie { data, actualZ, actualCol, actualRow } ou null
// ---------------------------------------------------------------------------
// Indique si une entrée nulle en cache est une 404 définitive (tuile vraiment absente)
function isCachedPermanent404(key) {
  if (!ignTileCache.has(key)) return false;
  const entry = ignTileCache.get(key);
  return entry && entry._null && entry.errorType === 'permanent';
}

async function getIGNTileWithFallback(z, col, row, deadlineAt, purpose) {
  const data = await getIGNTile(z, col, row, purpose);
  if (data) return { data, actualZ: z, actualCol: col, actualRow: row };

  // Si le zoom natif a renvoyé une 404 confirmée, on réduit la profondeur de
  // repli. La couverture MNS est cohérente d'un zoom à l'autre : si z14 manque
  // définitivement, z11-z13 manquent presque sûrement aussi. On saute le repli
  // profond pour libérer des créneaux de file pour des tuiles qui existent
  // peut-être.
  const key = `${z}/${col}/${row}`;
  const isPermanent = isCachedPermanent404(key);
  const maxDepth = isPermanent ? 1 : IGN_FALLBACK_MAX_DEPTH;
  const minZ = Math.max(IGN_DEM_MINZOOM, z - maxDepth);
  let fbCol = col;
  let fbRow = row;
  for (let fbZ = z - 1; fbZ >= minZ; fbZ--) {
    fbCol = fbCol >> 1;
    fbRow = fbRow >> 1;
    // Contrôle de l'échéance par construction : quand l'appelant (build-tile.js)
    // a dépassé son délai souple, on abandonne la chaîne de repli.
    if (typeof deadlineAt === 'number' && performance.now() >= deadlineAt) {
      const cached = getCached(`${fbZ}/${fbCol}/${fbRow}`);
      if (cached.hit && cached.data) {
        return { data: cached.data, actualZ: fbZ, actualCol: fbCol, actualRow: fbRow };
      }
      return null;
    }
    const fbData = await getIGNTile(fbZ, fbCol, fbRow, purpose);
    if (fbData) {
      return { data: fbData, actualZ: fbZ, actualCol: fbCol, actualRow: fbRow };
    }
    // Optimisation : si le zoom natif et z-1 ont tous deux renvoyé 404, on ne sonde pas plus loin sur le réseau !
    if (fbZ === z - 1) {
      break;
    }
  }

  return null;
}
