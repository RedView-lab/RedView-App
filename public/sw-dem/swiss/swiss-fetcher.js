// ---------------------------------------------------------------------------
// Fetcher swissSURFACE3D — catalogue STAC + cache COG + ordonnanceur de plages
// ---------------------------------------------------------------------------
// Trois niveaux de cache, avec gestion des nuls tenant compte du TTL :
//
//   1. Cache des cellules STAC  : (Ekm, Nkm) → { url, year } | null
//        Indique quel fichier COG contient une cellule LV95 de 1 km.
//   2. Cache des en-têtes COG   : url → { width, tileOffsets, … } | null
//        En-tête TIFF analysé ; dit comment récupérer les tuiles internes par plage.
//   3. Cache des tuiles internes : `${url}#${tileIndex}` → Float32Array | null
//        Tuile Float32 décompressée (en général 256×256 = 256 Ko).
//
// Concurrence : chaque fetch réseau (STAC, en-tête COG, plage COG) passe par
// `swissScheduleFetch()`, pour que le pipeline n'ouvre jamais plus de
// SWISS_CONCURRENCY flux HTTP/2 à la fois. Même logique LIFO / élagage des plus
// anciens que l'ordonnanceur IGN, avec notre propre SWISS_PRUNED_SENTINEL.
// ---------------------------------------------------------------------------

// ─── Concurrency limiter ────────────────────────────────────────────────────
let _swissActive = 0;
const _swissQueue = [];
let _swissPrunedTotal = 0;

function swissScheduleFetch(fn) {
  return new Promise((resolve, reject) => {
    _swissQueue.push({ fn, resolve, reject, ts: performance.now() });
    let pruned = 0;
    while (_swissQueue.length > SWISS_QUEUE_MAX) {
      let oldestIdx = 0, oldestTs = _swissQueue[0].ts;
      for (let i = 1; i < _swissQueue.length; i++) {
        if (_swissQueue[i].ts < oldestTs) { oldestTs = _swissQueue[i].ts; oldestIdx = i; }
      }
      const stale = _swissQueue.splice(oldestIdx, 1)[0];
      stale.resolve(SWISS_PRUNED_SENTINEL);
      pruned++;
    }
    if (pruned > 0) {
      _swissPrunedTotal += pruned;
      if (DEBUG) console.warn(`[swiss][queue] pruned ${pruned} (lifetime=${_swissPrunedTotal})`);
    }
    drainSwissQueue();
  });
}

function drainSwissQueue() {
  while (_swissActive < SWISS_CONCURRENCY && _swissQueue.length > 0) {
    const { fn, resolve, reject } = _swissQueue.pop(); // LIFO
    _swissActive++;
    fn().then(resolve).catch(reject).finally(() => {
      _swissActive--;
      drainSwissQueue();
    });
  }
}

// Fonction d'appui de fetch par plage utilisée par le lecteur COG. Renvoie
// toujours ArrayBuffer | null. Réessaie jusqu'à SWISS_COG_RANGE_RETRIES fois sur
// délai dépassé / erreur réseau (PAS sur une 4xx HTTP, définitive). Chaque
// nouvelle tentative prend un nouveau créneau, pour ne pas bloquer la tête de file.
async function swissRangeFetch(url, offset, length) {
  for (let attempt = 1; attempt <= SWISS_COG_RANGE_RETRIES; attempt++) {
    const result = await swissScheduleFetch(async () => {
      try {
        const res = await fetch(url, {
          headers: { Range: `bytes=${offset}-${offset + length - 1}` },
          signal: AbortSignal.timeout(SWISS_COG_RANGE_TIMEOUT_MS),
          priority: 'high',
        });
        if (!res.ok && res.status !== 206) {
          // Définitif : 4xx → pas de nouvelle tentative. 5xx → nouvelle tentative.
          if (res.status >= 400 && res.status < 500) {
            console.warn(`[swiss][range] HTTP ${res.status} ${url} bytes=${offset}-${offset + length - 1} (no retry)`);
            return { _permanent: true, value: null };
          }
          console.warn(`[swiss][range] HTTP ${res.status} ${url} bytes=${offset}-${offset + length - 1} (attempt ${attempt}/${SWISS_COG_RANGE_RETRIES})`);
          return null;
        }
        return { _permanent: true, value: await res.arrayBuffer() };
      } catch (err) {
        const msg = err?.message || String(err);
        const isTransientNetworkError =
          err?.name === 'TimeoutError' ||
          err?.name === 'TypeError' ||
          msg.includes('timed out') ||
          msg.includes('aborted') ||
          msg.includes('Failed to fetch');
        if (!isTransientNetworkError) {
          console.warn(`[swiss][range] error ${url} (no retry):`, msg);
          return { _permanent: true, value: null };
        }
        console.warn(`[swiss][range] retryable ${url} (attempt ${attempt}/${SWISS_COG_RANGE_RETRIES}):`, msg);
        return null;
      }
    });
    if (result === SWISS_PRUNED_SENTINEL) return null;
    if (result && typeof result === 'object' && result._permanent) return result.value;
    if (attempt < SWISS_COG_RANGE_RETRIES) {
      // Courte attente avec gigue, pour ne pas tous réessayer au même instant.
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
    }
  }
  return null;
}

// ─── STAC cell-resolution cache ─────────────────────────────────────────────
// Map key: `${Ekm}/${Nkm}` → { url } | { _null, ts, ttl }
const _stacCellCache = new Map();
const _stacCellInflight = new Map();

// Requêtes en cours par super-fenêtre : indexées par le bloc aligné sur
// SWISS_STAC_GRID (`${EkmGrid}/${NkmGrid}`). Chaque cellule du bloc rejoint la
// même promesse : on ne lance jamais deux requêtes STAC qui se recoupent pour le
// même voisinage. Les journaux du 24 avril montraient 5+ requêtes de bbox
// presque identiques expirant en même temps, car la déduplication se faisait
// par cellule seulement.
const _stacWindowInflight = new Map();

function evictMap(cache, max) {
  if (cache.size <= max) return;
  const iter = cache.keys();
  const toDelete = cache.size - Math.floor(max * 0.75);
  for (let i = 0; i < toDelete; i++) {
    const k = iter.next().value;
    if (k !== undefined) cache.delete(k);
  }
}

function _stacCellGet(key) {
  const e = _stacCellCache.get(key);
  if (!e) return { hit: false };
  if (e._null) {
    if (Date.now() - e.ts < e.ttl) return { hit: true, url: null };
    _stacCellCache.delete(key);
    return { hit: false };
  }
  return { hit: true, url: e.url };
}

function _stacCellSetNull(key, ttl) {
  _stacCellCache.set(key, { _null: true, ts: Date.now(), ttl });
  evictMap(_stacCellCache, SWISS_STAC_CELL_CACHE_MAX);
}

// Lance une seule requête STAC par bbox couvrant jusqu'à une super-fenêtre de
// 5×5 km, pour résoudre de nombreuses cellules voisines en un aller-retour. Les
// items renvoyés sont ensuite répartis dans le cache par cellule.
//
// Renvoie :
//   { ok: true,  cellBest }  — STAC a réussi (cellBest peut être vide si la
//                              bbox n'a vraiment aucune donnée publiée)
//   { ok: false }            — échec réseau passager (délai dépassé, 5xx,
//                              élagage). L'appelant NE DOIT PAS marquer les
//                              cellules comme nul définitif ; le rendu suivant
//                              réessaie.
//
// Grammaire de l'ID d'item :  swisssurface3d-raster_{année}_{Ekm}-{Nkm}
// L'href de l'asset est l'URL canonique du COG voulu.
async function _resolveSwissCellsViaStac(EkmMin, EkmMax, NkmMin, NkmMax) {
  // La bbox STAC est en WGS84. On convertit les coins.
  const sw = lv95ToWGS84(EkmMin * 1000, NkmMin * 1000);
  const ne = lv95ToWGS84((EkmMax + 1) * 1000, (NkmMax + 1) * 1000);

  // L'API STAC de swisstopo plafonne `limit` à 100 entités par page et pagine via
  // un `cursor` opaque porté par le lien rel="next" de la réponse. On suit ce
  // curseur jusqu'à SWISS_STAC_MAX_PAGES, pour qu'une grande fenêtre de
  // découverte (14×14 km) soit entièrement résolue au lieu d'être tronquée en
  // silence à 100 entités → cellules manquantes → plaques plates.
  const firstUrl =
    `${SWISS_STAC_BASE}` +
    `?bbox=${sw.lng.toFixed(6)},${sw.lat.toFixed(6)},${ne.lng.toFixed(6)},${ne.lat.toFixed(6)}` +
    `&limit=${SWISS_STAC_PAGE_LIMIT}`;

  const fetchPage = (pageUrl) => swissScheduleFetch(async () => {
    try {
      const res = await fetch(pageUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(SWISS_STAC_FETCH_TIMEOUT_MS),
        priority: 'high',
      });
      if (!res.ok) {
        // 4xx → permanent (treat as "ok, zero features"). 5xx → transient.
        if (res.status >= 400 && res.status < 500) {
          console.warn(`[swiss][stac] HTTP ${res.status} ${pageUrl} (permanent)`);
          return { _permanent: true, value: { features: [] } };
        }
        console.warn(`[swiss][stac] HTTP ${res.status} ${pageUrl} (transient)`);
        return null;
      }
      return { _permanent: true, value: await res.json() };
    } catch (e) {
      console.warn(`[swiss][stac] fetch error ${pageUrl}:`, e?.message || e);
      return null; // transient (timeout, network)
    }
  });

  // Accumule les entités de toutes les pages du curseur. Toute page en échec
  // passager abandonne la résolution de toute la fenêtre (return {ok:false}),
  // pour ne jamais marquer de cellules en nul définitif sur une lecture partielle.
  const allFeatures = [];
  let nextUrl = firstUrl;
  let page = 0;
  while (nextUrl && page < SWISS_STAC_MAX_PAGES) {
    const json = await fetchPage(nextUrl);
    // Élagage ou échec réseau passager → on dit à l'appelant de réessayer, on
    // NE marque PAS les cellules comme nul définitif.
    if (!json || json === SWISS_PRUNED_SENTINEL) {
      console.warn(`[swiss][stac] transient failure (page ${page}) for bbox ${sw.lng.toFixed(3)},${sw.lat.toFixed(3)},${ne.lng.toFixed(3)},${ne.lat.toFixed(3)}`);
      return { ok: false };
    }
    const payload = json._permanent ? json.value : json;
    if (!payload || !Array.isArray(payload.features)) {
      console.warn(`[swiss][stac] malformed payload (page ${page}) for bbox ${sw.lng.toFixed(3)},${sw.lat.toFixed(3)},${ne.lng.toFixed(3)},${ne.lat.toFixed(3)}`);
      return { ok: false };
    }
    for (const feat of payload.features) allFeatures.push(feat);
    page++;
    // Suit le lien rel="next" s'il existe et que la page était pleine (une page
    // incomplète signifie que le catalogue est épuisé pour cette bbox).
    nextUrl = null;
    if (payload.features.length >= SWISS_STAC_PAGE_LIMIT && Array.isArray(payload.links)) {
      const link = payload.links.find((l) => l && l.rel === 'next' && l.href);
      if (link) nextUrl = link.href;
    }
  }

  if (typeof swLog !== 'undefined' && swLog.isDebug()) {
    swLog.debug(
      'swiss',
      `%c bbox %c ${sw.lng.toFixed(3)},${sw.lat.toFixed(3)},${ne.lng.toFixed(3)},${ne.lat.toFixed(3)} \u2192 ${allFeatures.length} features (${page} page${page === 1 ? '' : 's'})`,
      'background:#D52B1E;color:#fff;padding:1px 4px;border-radius:2px', '',
    );
  }

  // Regroupe les entités par (Ekm, Nkm) en gardant l'année la plus récente par cellule.
  const cellBest = new Map();
  for (const feat of allFeatures) {
    const id = feat.id || '';
    const m = id.match(/^swisssurface3d-raster_(\d{4})_(\d+)-(\d+)$/);
    if (!m) continue;
    const year = parseInt(m[1], 10);
    const Ekm = parseInt(m[2], 10);
    const Nkm = parseInt(m[3], 10);
    const cellKey = `${Ekm}/${Nkm}`;

    // Choisit l'asset COG (il peut aussi y avoir xyz.zip, etc.)
    let cogHref = null;
    if (feat.assets) {
      for (const [assetKey, asset] of Object.entries(feat.assets)) {
        if (assetKey.endsWith('.tif') && (asset?.type || '').includes('tiff')) {
          cogHref = asset.href;
          break;
        }
      }
    }
    if (!cogHref) continue;

    const prev = cellBest.get(cellKey);
    if (!prev || prev.year < year) {
      cellBest.set(cellKey, { year, url: cogHref });
    }
  }

  // STAC a réussi. On écrit les cellules résolues dans le cache ; les cellules
  // non résolues de la fenêtre interrogée reçoivent un nul DÉFINITIF (le
  // catalogue a parlé : aucune donnée publiée pour cette cellule kilométrique).
  for (let Ekm = EkmMin; Ekm <= EkmMax; Ekm++) {
    for (let Nkm = NkmMin; Nkm <= NkmMax; Nkm++) {
      const key = `${Ekm}/${Nkm}`;
      const best = cellBest.get(key);
      if (best) {
        _stacCellCache.set(key, { url: best.url, year: best.year });
      } else {
        _stacCellSetNull(key, SWISS_NULL_TTL_PERMANENT);
      }
    }
  }
  evictMap(_stacCellCache, SWISS_STAC_CELL_CACHE_MAX);
  return { ok: true, cellBest };
}

// Sentinelle renvoyée par getCOGUrlForCell() quand STAC a échoué passagèrement
// (délai réseau dépassé, 5xx, élagage de file). Se distingue de `null`, qui
// signifie « STAC a réussi et il n'y a aucune donnée publiée ici ». Les
// appelants DOIVENT la traiter comme « réessayer au prochain rendu, NE PAS
// empoisonner le cache négatif de zone ».
const SWISS_STAC_TRANSIENT = Object.freeze({ _swissStacTransient: true });

async function getCOGUrlForCell(Ekm, Nkm) {
  const key = `${Ekm}/${Nkm}`;
  const cached = _stacCellGet(key);
  if (cached.hit) return cached.url;

  // Alignement sur une grille fixe, pour que toute cellule du même bloc se
  // résolve de façon déterministe par la MÊME requête STAC (déduplication par
  // super-fenêtre). Sans cela, les cellules sœurs lancent des requêtes 5×5 qui
  // se recoupent et saturent la file → délais dépassés (voir les journaux du
  // 24 avril).
  const G = SWISS_STAC_GRID;
  const EkmGrid = Math.floor(Ekm / G) * G;
  const NkmGrid = Math.floor(Nkm / G) * G;
  const windowKey = `${EkmGrid}/${NkmGrid}`;

  const readCellOrTransient = (windowOk) => {
    const after = _stacCellGet(key);
    if (after.hit) return after.url; // résolue (URL ou nul définitif)
    // STAC n'a pas rendu de verdict pour cette cellule. Si la requête de fenêtre
    // a réussi mais que la cellule n'était pas dans sa bbox, on la traite comme
    // nulle. Sinon c'est passager — l'appelant réessaiera.
    return windowOk ? null : SWISS_STAC_TRANSIENT;
  };

  // Per-cell inflight (legacy path).
  if (_stacCellInflight.has(key)) return _stacCellInflight.get(key);

  // Requête en cours par fenêtre : une autre cellule du même bloc a déjà lancé
  // la requête STAC. On l'attend, puis on lit cette cellule dans le cache.
  const existingWindow = _stacWindowInflight.get(windowKey);
  if (existingWindow) {
    return existingWindow.then((res) => readCellOrTransient(res?.ok === true));
  }

  const windowPromise = (async () => {
    try {
      return await _resolveSwissCellsViaStac(
        EkmGrid, EkmGrid + G - 1,
        NkmGrid, NkmGrid + G - 1,
      );
    } catch (e) {
      if (DEBUG) console.warn('[swiss][stac] failed', e);
      return { ok: false };
    }
  })().finally(() => _stacWindowInflight.delete(windowKey));

  _stacWindowInflight.set(windowKey, windowPromise);

  const promise = windowPromise
    .then((res) => readCellOrTransient(res?.ok === true))
    .finally(() => _stacCellInflight.delete(key));

  _stacCellInflight.set(key, promise);
  return promise;
}

// ─── COG header cache ───────────────────────────────────────────────────────
// Map key: url → cog descriptor | { _null, ts, ttl }
const _cogHeaderCache = new Map();
const _cogHeaderInflight = new Map();

const SWISS_HEADER_INITIAL_BYTES = 32_768; // 32 Ko — GDAL écrit IFD0 et toutes les IFD d'aperçu dans l'en-tête « fantôme » de début (< 4 Ko en tout) ; la boucle de nouveau fetch d'openSwissCOG couvre le rare cas hors norme
const SWISS_HEADER_MAX_BYTES = 524_288;

function _headerGet(url) {
  const e = _cogHeaderCache.get(url);
  if (!e) return { hit: false };
  if (e._null) {
    if (Date.now() - e.ts < e.ttl) return { hit: true, cog: null };
    _cogHeaderCache.delete(url);
    return { hit: false };
  }
  return { hit: true, cog: e };
}

function _headerSetNull(url, ttl) {
  _cogHeaderCache.set(url, { _null: true, ts: Date.now(), ttl });
  evictMap(_cogHeaderCache, SWISS_HEADER_CACHE_MAX);
}

async function openSwissCOG(url) {
  const cached = _headerGet(url);
  if (cached.hit) return cached.cog;
  if (_cogHeaderInflight.has(url)) return _cogHeaderInflight.get(url);

  const promise = (async () => {
    let bytesNeeded = SWISS_HEADER_INITIAL_BYTES;
    let cog = null;
    // Boucle de tentatives sur deux axes :
    //   networkAttempt : 1..SWISS_COG_HEADER_RETRIES (nouvelle tentative sur délai dépassé / 5xx)
    //   sizeAttempt :    0..1 (nouveau fetch d'une plage plus grande si l'en-tête ne tient pas)
    // On n'empoisonne pas le cache négatif sur un seul délai dépassé — un TTL
    // court + une nouvelle tentative laissent l'utilisateur continuer à se
    // déplacer sans 60 s de noir.
    let networkAttempt = 0;
    let sizeAttempt = 0;
    let permanentParseFail = false;
    while (sizeAttempt < 2 && networkAttempt < SWISS_COG_HEADER_RETRIES) {
      const buf = await swissScheduleFetch(async () => {
        try {
          const res = await fetch(url, {
            headers: { Range: `bytes=0-${bytesNeeded - 1}` },
            signal: AbortSignal.timeout(SWISS_COG_HEADER_TIMEOUT_MS),
            priority: 'high',
          });
          if (!res.ok && res.status !== 206) {
            // 4xx → permanent (file deleted / wrong URL)
            if (res.status >= 400 && res.status < 500) {
              console.warn(`[swiss][header] HTTP ${res.status} ${url} (permanent)`);
              return { _permanent: true, value: null };
            }
            console.warn(`[swiss][header] HTTP ${res.status} ${url} (attempt ${networkAttempt + 1}/${SWISS_COG_HEADER_RETRIES})`);
            return null;
          }
          return { _permanent: true, value: await res.arrayBuffer() };
        } catch (e) {
          const msg = e?.message || String(e);
          const isTimeout = e?.name === 'TimeoutError' || msg.includes('timed out') || msg.includes('aborted');
          if (!isTimeout) {
            console.warn(`[swiss][header] fetch error ${url} (no retry):`, msg);
            return { _permanent: true, value: null };
          }
          console.warn(`[swiss][header] timeout ${url} (attempt ${networkAttempt + 1}/${SWISS_COG_HEADER_RETRIES})`);
          return null;
        }
      });
      if (buf === SWISS_PRUNED_SENTINEL) {
        // File élaguée en cours de route. On n'empoisonne pas le cache, le prochain déplacement réessaiera.
        return null;
      }
      // Résultat réseau définitif (4xx, erreur ou succès)
      if (buf && typeof buf === 'object' && buf._permanent) {
        if (!buf.value) {
          _headerSetNull(url, SWISS_NULL_TTL_PERMANENT);
          return null;
        }
        try {
          const parsed = await parseSwissCOGHeader(url, new Uint8Array(buf.value));
          if (parsed && parsed._needMoreBytes) {
            bytesNeeded = Math.min(parsed._needMoreBytes + 1024, SWISS_HEADER_MAX_BYTES);
            if (sizeAttempt === 1) {
              permanentParseFail = true;
              break;
            }
            sizeAttempt++;
            networkAttempt = 0; // remise à zéro des tentatives réseau pour le fetch plus grand
            continue;
          }
          cog = parsed;
          break;
        } catch (err) {
          console.warn(`[swiss][header] parse failed for ${url}:`, err.message);
          permanentParseFail = true;
          break;
        }
      }
      // Transient (timeout / 5xx) — retry
      networkAttempt++;
      if (networkAttempt < SWISS_COG_HEADER_RETRIES) {
        await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
      }
    }
    if (!cog) {
      // Échec d'analyse définitif → TTL long. Passager (toutes les tentatives
      // ont expiré) → TTL très court, pour que le prochain déplacement réessaie
      // au lieu de tout noircir.
      _headerSetNull(url, permanentParseFail ? SWISS_NULL_TTL_PERMANENT : SWISS_NULL_TTL_TRANSIENT);
      return null;
    }
    if (typeof swLog !== 'undefined' && swLog.isDebug()) {
      swLog.debug(
        'swiss',
        `%c OK %c ${url.split('/').pop()} \u2192 ${cog.levels.length} levels (${cog.levels.map((l) => `${l.width}\u00d7${l.height}@${l.pixelScaleX.toFixed(2)}m`).join(', ')}), origin=(${cog.originE.toFixed(0)},${cog.originN.toFixed(0)})`,
        'background:#4CAF50;color:#fff;padding:1px 4px;border-radius:2px', '',
      );
    }
    _cogHeaderCache.set(url, cog);
    evictMap(_cogHeaderCache, SWISS_HEADER_CACHE_MAX);
    return cog;
  })().finally(() => _cogHeaderInflight.delete(url));

  _cogHeaderInflight.set(url, promise);
  return promise;
}

// ─── Internal-tile cache ────────────────────────────────────────────────────
// Map key: `${url}#${tileIndex}` → Float32Array | null marker
const _tileCache = new Map();
const _tileInflight = new Map();

function _tileGet(key) {
  const e = _tileCache.get(key);
  if (!e) return { hit: false };
  if (e._null) {
    if (Date.now() - e.ts < e.ttl) return { hit: true, data: null };
    _tileCache.delete(key);
    return { hit: false };
  }
  return { hit: true, data: e };
}

function _tileSetNull(key, ttl) {
  _tileCache.set(key, { _null: true, ts: Date.now(), ttl });
  evictMap(_tileCache, SWISS_TILE_CACHE_MAX);
}

async function getCOGInternalTile(cog, levelIdx, tileIndex) {
  const key = `${cog.url}#L${levelIdx}#${tileIndex}`;
  const cached = _tileGet(key);
  if (cached.hit) return cached.data;
  if (_tileInflight.has(key)) return _tileInflight.get(key);

  const promise = (async () => {
    try {
      const data = await fetchAndDecodeTile(cog, levelIdx, tileIndex, swissRangeFetch);
      if (!data) {
        _tileSetNull(key, SWISS_NULL_TTL_TRANSIENT);
        return null;
      }
      _tileCache.set(key, data);
      evictMap(_tileCache, SWISS_TILE_CACHE_MAX);
      return data;
    } catch (e) {
      console.warn(`[swiss][tile] decode failed`, e);
      _tileSetNull(key, SWISS_NULL_TTL_TRANSIENT);
      return null;
    }
  })().finally(() => _tileInflight.delete(key));

  _tileInflight.set(key, promise);
  return promise;
}

// Lecteur de cache synchrone — renvoie le Float32Array décodé s'il est déjà
// résident, sinon null. Utilisé par l'échantillonneur bilinéaire synchrone
// après un préchargement qui a garanti la présence des tuiles nécessaires.
function getCOGInternalTileCached(cog, levelIdx, tileIndex) {
  const e = _tileCache.get(`${cog.url}#L${levelIdx}#${tileIndex}`);
  if (!e || e._null) return null;
  return e;
}

// ─── Préchargement multi-tuiles regroupé ────────────────────────────────────
// Regroupe les tuiles internes demandées d'un niveau de COG en suites de plages
// d'octets contiguës et émet UNE requête Range par suite. swisstopo écrit les
// tuiles d'un niveau de façon contiguë dans l'ordre du fichier : une cellule qui
// a besoin de plusieurs tuiles voisines (zoom natif / élevé) passe de N requêtes
// HTTP à ~1. Chaque tuile est quand même décodée individuellement (chacune est
// compressée à part) et mise en cache sous sa propre clé, pour que
// getCOGInternalTile() et l'échantillonneur synchrone la retrouvent ensuite.
const SWISS_RANGE_MERGE_GAP = 16 * 1024;      // fusionne les tuiles distantes de ≤ 16 Ko dans le fichier
const SWISS_RANGE_MAX_SPAN = 6 * 1024 * 1024; // cap a single coalesced fetch at 6 MB

async function prefetchCOGTilesCoalesced(cog, levelIdx, tileIndices) {
  const level = cog.levels[levelIdx];
  if (!level) return;

  // Déduplication + retrait des tuiles déjà en cache ou en cours ; collecte de leurs plages d'octets.
  const seen = new Set();
  const need = [];
  for (const ti of tileIndices) {
    if (seen.has(ti)) continue;
    seen.add(ti);
    const key = `${cog.url}#L${levelIdx}#${ti}`;
    if (_tileGet(key).hit) continue;
    if (_tileInflight.has(key)) continue;
    const offset = level.tileOffsets[ti];
    const length = level.tileByteCounts[ti];
    if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) {
      _tileSetNull(key, SWISS_NULL_TTL_TRANSIENT);
      continue;
    }
    need.push({ ti, offset, length, key });
  }
  if (need.length === 0) return;

  need.sort((a, b) => a.offset - b.offset);

  // Build contiguous runs (merge tiles whose gap ≤ MERGE_GAP, span ≤ MAX_SPAN).
  const runs = [];
  let cur = null;
  for (const t of need) {
    const end = t.offset + t.length;
    if (cur && t.offset - cur.end <= SWISS_RANGE_MERGE_GAP && end - cur.start <= SWISS_RANGE_MAX_SPAN) {
      cur.tiles.push(t);
      if (end > cur.end) cur.end = end;
    } else {
      cur = { start: t.offset, end, tiles: [t] };
      runs.push(cur);
    }
  }

  await Promise.all(runs.map(async (run) => {
    if (run.tiles.length === 1) {
      // Isolée — on passe par le chemin normal cache / en cours (aucun gain de fusion).
      await getCOGInternalTile(cog, levelIdx, run.tiles[0].ti);
      return;
    }
    const span = run.end - run.start;
    const fetchPromise = swissRangeFetch(cog.url, run.start, span);
    // Enregistre une promesse en cours par tuile dérivée du fetch partagé, pour
    // qu'une construction concurrente de n'importe laquelle de ces tuiles se
    // déduplique sur cette requête.
    const tilePromises = run.tiles.map((t) => {
      const p = fetchPromise
        .then(async (buf) => {
          if (!buf) { _tileSetNull(t.key, SWISS_NULL_TTL_TRANSIENT); return null; }
          const sub = buf.slice(t.offset - run.start, t.offset - run.start + t.length);
          const data = await decodeSwissTileBytes(level, levelIdx, t.ti, sub);
          if (!data) { _tileSetNull(t.key, SWISS_NULL_TTL_TRANSIENT); return null; }
          _tileCache.set(t.key, data);
          evictMap(_tileCache, SWISS_TILE_CACHE_MAX);
          return data;
        })
        .finally(() => {
          if (_tileInflight.get(t.key) === p) _tileInflight.delete(t.key);
        });
      _tileInflight.set(t.key, p);
      return p;
    });
    await Promise.all(tilePromises);
  }));
}
async function sampleSwissElevation(E, N) {
  if (
    E < SWISS_LV95_BOUNDS.Emin || E > SWISS_LV95_BOUNDS.Emax ||
    N < SWISS_LV95_BOUNDS.Nmin || N > SWISS_LV95_BOUNDS.Nmax
  ) return NaN;

  const Ekm = Math.floor(E / 1000);
  const Nkm = Math.floor(N / 1000);
  const url = await getCOGUrlForCell(Ekm, Nkm);
  if (!url || url === SWISS_STAC_TRANSIENT) return NaN;
  const cog = await openSwissCOG(url);
  if (!cog) return NaN;
  return sampleSwissCOG(cog, 0, E, N, (lvl, idx) => getCOGInternalTile(cog, lvl, idx));
}
