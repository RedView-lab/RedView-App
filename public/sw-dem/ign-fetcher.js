// ---------------------------------------------------------------------------
// IGN tile fetching with in-memory LRU cache + concurrency limiter
// ---------------------------------------------------------------------------

const ignTileCache = new Map();
let activeIGN = 0;
const ignQueue = [];

function evict(cache, max) {
  if (cache.size <= max) return;
  const iter = cache.keys();
  const toDelete = cache.size - Math.floor(max * 0.75);
  for (let i = 0; i < toDelete; i++) {
    const k = iter.next().value;
    if (k !== undefined) cache.delete(k);
  }
}

function scheduleIGN(fn) {
  return new Promise((resolve, reject) => {
    ignQueue.push({ fn, resolve, reject });
    drainIGN();
  });
}

function drainIGN() {
  while (activeIGN < IGN_CONCURRENCY && ignQueue.length > 0) {
    const { fn, resolve, reject } = ignQueue.shift();
    activeIGN++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeIGN--;
        drainIGN();
      });
  }
}

function buildDEMTileURL(z, col, row) {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_DEM_LAYER}&STYLE=normal` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&TILEMATRIXSET=${IGN_DEM_TILEMATRIXSET}` +
    `&TILEMATRIX=${z}&TILEROW=${row}&TILECOL=${col}`
  );
}

async function getIGNTile(z, col, row) {
  const key = `${z}/${col}/${row}`;
  if (ignTileCache.has(key)) return ignTileCache.get(key);

  return scheduleIGN(async () => {
    if (ignTileCache.has(key)) return ignTileCache.get(key);

    const url = buildDEMTileURL(z, col, row);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        ignTileCache.set(key, null);
        return null;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== IGN_SRC_TILE_SIZE * IGN_SRC_TILE_SIZE * 4) {
        ignTileCache.set(key, null);
        return null;
      }
      const data = decodeBIL32(buf);
      evict(ignTileCache, IGN_CACHE_MAX);
      ignTileCache.set(key, data);
      return data;
    } catch {
      ignTileCache.set(key, null);
      return null;
    }
  });
}
