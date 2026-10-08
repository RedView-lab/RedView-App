// ---------------------------------------------------------------------------
// Récupération de repli HIGHRES (DEM à 5 m) — même schéma que le MNS, mais
// sur ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES et le TileMatrixSet WGS84G_6_14.
// Partage le limiteur de concurrence IGN (même serveur geopf) mais utilise un
// cache de tuiles en mémoire distinct, pour que les entrées MNS et HIGHRES ne
// s'évincent pas mutuellement.
// ---------------------------------------------------------------------------
const highresTileCache = new Map();
const highresInflight = new Map();
const HIGHRES_CACHE_MAX = 300;

function buildHighresTileURL(z, col, row) {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_DEM_FALLBACK_LAYER}&STYLE=normal` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&TILEMATRIXSET=${IGN_DEM_FALLBACK_TILEMATRIXSET}` +
    `&TILEMATRIX=${z}&TILEROW=${row}&TILECOL=${col}`
  );
}

function getCachedHighres(key) {
  if (!highresTileCache.has(key)) return { hit: false };
  const entry = highresTileCache.get(key);
  if (entry instanceof Float32Array) return { hit: true, data: entry };
  if (entry && entry._null) {
    if (Date.now() - entry.ts < entry.ttl) return { hit: true, data: null };
    highresTileCache.delete(key);
    return { hit: false };
  }
  if (entry === null) { highresTileCache.delete(key); return { hit: false }; }
  return { hit: true, data: entry };
}

function cacheHighresNull(key, errorType) {
  const ttl = errorType === 'permanent' ? IGN_NULL_TTL_PERMANENT : IGN_NULL_TTL_TRANSIENT;
  highresTileCache.set(key, { _null: true, ts: Date.now(), ttl, errorType });
}

async function getHighresTile(z, col, row) {
  const key = `hr/${z}/${col}/${row}`;
  const cached = getCachedHighres(key);
  if (cached.hit) return cached.data;

  if (highresInflight.has(key)) return highresInflight.get(key);

  const promise = scheduleIGN(async () => {
    const cached2 = getCachedHighres(key);
    if (cached2.hit) return cached2.data;

    const url = buildHighresTileURL(z, col, row);
    const { controller, cleanup, init } = ignFetchInit();
    try {
      const res = await fetchIgnWithRetry(url, init);
      if (!res.ok) {
        cacheHighresNull(key, res.status === 404 ? 'permanent' : 'transient');
        return null;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== IGN_SRC_TILE_SIZE * IGN_SRC_TILE_SIZE * 4) {
        cacheHighresNull(key, 'permanent');
        return null;
      }
      const data = decodeBIL32(buf);
      evict(highresTileCache, HIGHRES_CACHE_MAX);
      highresTileCache.set(key, data);
      return data;
    } catch {
      if (isIGNUserCancel(controller)) return null;
      cacheHighresNull(key, 'transient');
      return null;
    } finally {
      cleanup();
    }
  }).then((result) => {
    if (result === PRUNED_SENTINEL) return null;
    return result;
  }).finally(() => {
    highresInflight.delete(key);
  });

  highresInflight.set(key, promise);
  return promise;
}

// Repli HIGHRES avec repli de zoom (même schéma, 2 niveaux au plus)
async function getHighresTileWithFallback(z, col, row) {
  const data = await getHighresTile(z, col, row);
  if (data) return { data, actualZ: z, actualCol: col, actualRow: row };

  const minZ = Math.max(IGN_DEM_FALLBACK_MINZOOM, z - 2);
  let fbCol = col;
  let fbRow = row;
  for (let fbZ = z - 1; fbZ >= minZ; fbZ--) {
    fbCol = fbCol >> 1;
    fbRow = fbRow >> 1;
    const fbData = await getHighresTile(fbZ, fbCol, fbRow);
    if (fbData) {
      return { data: fbData, actualZ: fbZ, actualCol: fbCol, actualRow: fbRow };
    }
  }
  return null;
}
