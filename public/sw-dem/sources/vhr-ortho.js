// ---------------------------------------------------------------------------
// Very-high-resolution orthophoto tiles (/vhr-tiles/{z}/{x}/{y}?r=1|2)
//
// Mapbox Satellite in France is the IGN 20 cm BD ORTHO up to z19. A few
// cities (Rennes…) additionally get a 5 cm PCRS at z20 only — Mapbox's own
// z21 there falls back to the 20 cm ortho upscaled 4×. The IGN Géoplateforme
// publishes those very-high-resolution mosaics directly:
//   - PCRS.LAMB93                    5 cm  Plan Corps de Rue Simplifié
//                                          (Rennes, Vannes, Saint-Malo, Niort,
//                                          Poitiers, Toulouse…)
//   - THR.ORTHOIMAGERY.ORTHOPHOTOS   5–10 cm (Paris, Marseille…)
// This overlay draws them above Mapbox Satellite from z18 to z21 wherever
// they exist and answers a transparent tile everywhere else, so the Mapbox
// imagery (20 cm, or its own high-res patches such as Lyon) shows through.
//
// WMS-R reprojects to EPSG:3857 server-side. Measured 2026-10-02:
//   - ~0.2–0.5 s per tile;
//   - no data is painted PURE WHITE: PNGs are always 8-bit RGB (TRANSPARENT
//     and BGCOLOR are ignored), an empty JPEG is a uniform 1.6 KB white tile;
//   - stacking two layers in one GetMap returns only the last one when that
//     one is empty → one request per layer;
//   - the coverage renders at every scale (64 px of a z14 tile = one pixel
//     per z20 tile), which is what the coverage masks below rely on.
// The WMS quota (40 req/s per IP, shared with the LiDAR slope pipeline) is
// enforced by fetchIgnWithRetry (ign-fetcher.js).
// ---------------------------------------------------------------------------

const VHR_CACHE_NAME = `vhr-tiles-v1-${MAP_CACHE_EPOCH}`;
const VHR_MIN_Z = 18;
const VHR_MAX_Z = 21;
const VHR_TILE_SIZE = 256;
// Native resolution is 5 cm: a 512 px z21 tile (2.5 cm/px) would only be
// upsampled server-side, so retina tiles stop at z20.
const VHR_RETINA_MAX_Z = 20;

// Highest priority first. Bboxes from the WMS capabilities (west, south,
// east, north) — no mask request is issued outside them.
const VHR_LAYERS = [
  { id: 'PCRS.LAMB93', bbox: [-5.5, 41.0, 10.0, 51.5] },
  { id: 'THR.ORTHOIMAGERY.ORTHOPHOTOS', bbox: [0.03, 43.15, 6.03, 49.7] },
];

const VHR_MASK_Z = 14;
const VHR_MASK_SIZE = 64;
// Coverage grows slowly (new PCRS deliveries); a fortnight keeps the masks
// warm without pinning an outdated footprint for good.
const VHR_MASK_MAX_AGE_MS = 14 * 24 * 3600_000;
const VHR_MASK_MEMORY_MAX = 512;

const VHR_CONCURRENCY = 8;
const VHR_QUEUE_MAX = 240;
const VHR_FETCH_TIMEOUT_MS = 12_000;
const VHR_HOT_CACHE_MAX = 160;
// No-data white, with a margin for the resampling blend along coverage edges.
const VHR_NODATA_MIN = 250;
const VHR_FRINGE_MIN = 200;
const VHR_FRINGE_PASSES = 2;
// CacheStorage bound: ~40 KB per retina JPEG tile → ~200 MB at most.
const VHR_DISK_MAX_ENTRIES = 5000;
const VHR_DISK_TRIM_EVERY = 250;

// ── Small helpers ───────────────────────────────────────────────────────

function vhrMercatorBBox(z, x, y) {
  const world = 2 * Math.PI * 6378137;
  const size = world / (1 << z);
  const minX = -world / 2 + x * size;
  const maxY = world / 2 - y * size;
  return [minX, maxY - size, minX + size, maxY];
}

function vhrTileLngLatBounds(z, x, y) {
  const n = 2 ** z;
  const lng = (tx) => (tx / n) * 360 - 180;
  const lat = (ty) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return { west: lng(x), east: lng(x + 1), north: lat(y), south: lat(y + 1) };
}

function vhrLayerTouchesTile(layer, z, x, y) {
  const b = vhrTileLngLatBounds(z, x, y);
  const [w, s, e, n] = layer.bbox;
  return !(b.east < w || b.west > e || b.north < s || b.south > n);
}

function buildVhrWmsUrl(layerId, z, x, y, px, format) {
  const [minX, minY, maxX, maxY] = vhrMercatorBBox(z, x, y);
  return (
    `${IGN_WMS_BASE}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap` +
    `&LAYERS=${layerId}&STYLES=&CRS=EPSG:3857` +
    `&BBOX=${minX.toFixed(3)},${minY.toFixed(3)},${maxX.toFixed(3)},${maxY.toFixed(3)}` +
    `&WIDTH=${px}&HEIGHT=${px}` +
    `&FORMAT=${format === 'png' ? 'image%2Fpng' : 'image%2Fjpeg'}`
  );
}

function isVhrNoData(rgba, i) {
  return rgba[i] >= VHR_NODATA_MIN && rgba[i + 1] >= VHR_NODATA_MIN && rgba[i + 2] >= VHR_NODATA_MIN;
}

async function readVhrPixels(blob, size) {
  const img = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    return { canvas, ctx, image: ctx.getImageData(0, 0, size, size) };
  } finally {
    img.close();
  }
}

// Clears the no-data white reachable from the tile border (4-connected).
// A white roof or car inside the covered area is not connected to the
// outside through pure white and keeps its pixels.
function knockOutVhrNoData(image) {
  const { width, height, data } = image;
  const seen = new Uint8Array(width * height);
  const stack = [];
  const push = (px, py) => {
    const p = py * width + px;
    if (seen[p]) return;
    seen[p] = 1;
    if (isVhrNoData(data, p * 4)) stack.push(p);
  };
  for (let px = 0; px < width; px++) { push(px, 0); push(px, height - 1); }
  for (let py = 0; py < height; py++) { push(0, py); push(width - 1, py); }
  let cleared = 0;
  while (stack.length > 0) {
    const p = stack.pop();
    data[p * 4 + 3] = 0;
    cleared++;
    const px = p % width;
    const py = (p - px) / width;
    if (px > 0) push(px - 1, py);
    if (px < width - 1) push(px + 1, py);
    if (py > 0) push(px, py - 1);
    if (py < height - 1) push(px, py + 1);
  }
  if (cleared === 0) return 0;
  // The resampling blends the coverage edge into a 1–2 px whitish fringe
  // that stays under the pure-white threshold.
  for (let pass = 0; pass < VHR_FRINGE_PASSES; pass++) {
    const fringe = [];
    for (let p = 0; p < width * height; p++) {
      const i = p * 4;
      if (data[i + 3] === 0) continue;
      if (data[i] < VHR_FRINGE_MIN || data[i + 1] < VHR_FRINGE_MIN || data[i + 2] < VHR_FRINGE_MIN) continue;
      const px = p % width;
      if ((px > 0 && data[i - 1] === 0) || (px < width - 1 && data[i + 7] === 0)
        || (p >= width && data[i - width * 4 + 3] === 0) || (p < width * (height - 1) && data[i + width * 4 + 3] === 0)) {
        fringe.push(i);
      }
    }
    for (const i of fringe) data[i + 3] = 0;
    cleared += fringe.length;
  }
  return cleared;
}


// ── Concurrency limiter (LIFO: the latest viewport is served first) ───────

let vhrActive = 0;
const vhrQueue = [];

function scheduleVhr(fn) {
  return new Promise((resolve, reject) => {
    vhrQueue.push({ fn, resolve, reject });
    while (vhrQueue.length > VHR_QUEUE_MAX) {
      vhrQueue.shift().resolve(PRUNED_SENTINEL);
    }
    drainVhr();
  });
}

function drainVhr() {
  while (vhrActive < VHR_CONCURRENCY && vhrQueue.length > 0) {
    const { fn, resolve, reject } = vhrQueue.pop();
    vhrActive++;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        vhrActive--;
        drainVhr();
      });
  }
}

async function fetchVhrImage(url) {
  const result = await scheduleVhr(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('rv-vhr-timeout'), VHR_FETCH_TIMEOUT_MS);
    try {
      const res = await fetchIgnWithRetry(url, { signal: controller.signal });
      if (!res.ok) return null;
      // WMS exceptions can come back as 200 text/xml.
      const type = (res.headers.get('Content-Type') || '').toLowerCase();
      if (!type.startsWith('image/')) return null;
      return await res.blob();
    } finally {
      clearTimeout(timer);
    }
  });
  return result === PRUNED_SENTINEL ? null : result;
}

// ── Coverage masks (one 64 px alpha grid per layer and z14 tile) ──────────

// key → { alpha: Uint8Array | null } (null alpha = no coverage at all)
const vhrMaskMemory = new Map();
const vhrMaskInflight = new Map();

function vhrMaskMemoryPut(key, entry) {
  if (vhrMaskMemory.has(key)) vhrMaskMemory.delete(key);
  vhrMaskMemory.set(key, entry);
  if (vhrMaskMemory.size > VHR_MASK_MEMORY_MAX) {
    vhrMaskMemory.delete(vhrMaskMemory.keys().next().value);
  }
}

// 255 = covered, 0 = no data (white). A mask pixel averages ~25 m of
// imagery, so only a genuinely empty area reads white; a bright snowfield
// mistaken for a hole only falls back to Mapbox.
async function decodeVhrMask(blob) {
  const { image } = await readVhrPixels(blob, VHR_MASK_SIZE);
  const alpha = new Uint8Array(VHR_MASK_SIZE * VHR_MASK_SIZE);
  let any = false;
  for (let i = 0; i < alpha.length; i++) {
    if (isVhrNoData(image.data, i * 4)) continue;
    alpha[i] = 255;
    any = true;
  }
  return any ? alpha : null;
}

// Resolves to { alpha } or undefined when the mask could not be fetched
// (the caller then answers a transparent tile: Mapbox stays visible).
async function getVhrMask(layer, mx, my) {
  const key = `${layer.id}/${mx}/${my}`;
  const mem = vhrMaskMemory.get(key);
  if (mem) return mem;
  let inflight = vhrMaskInflight.get(key);
  if (inflight) return inflight;

  inflight = (async () => {
    const cache = await caches.open(VHR_CACHE_NAME);
    const cacheKey = new Request(`/vhr-mask/${key}`);
    let blob = null;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const fetchedAt = Number(cached.headers.get('X-Fetched-At') || 0);
      if (Date.now() - fetchedAt < VHR_MASK_MAX_AGE_MS) blob = await cached.blob();
    }
    if (!blob) {
      const url = buildVhrWmsUrl(layer.id, VHR_MASK_Z, mx, my, VHR_MASK_SIZE, 'png');
      try {
        blob = await fetchVhrImage(url);
      } catch {
        blob = null;
      }
      if (!blob) return undefined;
      cache.put(cacheKey, new Response(blob, {
        headers: { 'Content-Type': blob.type || 'image/png', 'X-Fetched-At': String(Date.now()) },
      })).catch(() => {});
    }
    const entry = { alpha: await decodeVhrMask(blob) };
    vhrMaskMemoryPut(key, entry);
    return entry;
  })()
    .catch(() => undefined)
    .finally(() => vhrMaskInflight.delete(key));
  vhrMaskInflight.set(key, inflight);
  return inflight;
}

// 'none' | 'partial' | 'full' for tile (z, x, y) under one mask. A coverage
// edge hidden inside a mask pixel is caught on the tile itself (buildVhrTile).
function classifyVhrCoverage(alpha, z, x, y) {
  if (!alpha) return 'none';
  const dz = z - VHR_MASK_Z;
  const span = VHR_MASK_SIZE / (1 << dz); // mask pixels per tile side
  const ox = (x - ((x >> dz) << dz)) * span;
  const oy = (y - ((y >> dz) << dz)) * span;
  const x0 = Math.floor(ox);
  const y0 = Math.floor(oy);
  const x1 = Math.ceil(ox + span);
  const y1 = Math.ceil(oy + span);

  let covered = 0;
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      if (alpha[py * VHR_MASK_SIZE + px] > 0) covered++;
    }
  }
  if (covered === 0) return 'none';
  return covered === (x1 - x0) * (y1 - y0) ? 'full' : 'partial';
}

// Layers to draw for a tile, highest priority first, or null when a mask
// could not be read.
async function planVhrTile(z, x, y) {
  const dz = z - VHR_MASK_Z;
  const mx = x >> dz;
  const my = y >> dz;
  const plan = [];
  for (const layer of VHR_LAYERS) {
    if (!vhrLayerTouchesTile(layer, z, x, y)) continue;
    const mask = await getVhrMask(layer, mx, my);
    if (!mask) return null;
    const coverage = classifyVhrCoverage(mask.alpha, z, x, y);
    if (coverage === 'none') continue;
    plan.push({ layer, coverage });
    // A fully covered higher-priority layer hides everything below it.
    if (coverage === 'full') break;
  }
  return plan;
}

// ── Tile assembly ────────────────────────────────────────────────────────

async function buildVhrTile(z, x, y, px) {
  const plan = await planVhrTile(z, x, y);
  if (!plan || plan.length === 0) return null;

  if (plan.length === 1 && plan[0].coverage === 'full') {
    const blob = await fetchVhrImage(buildVhrWmsUrl(plan[0].layer.id, z, x, y, px, 'jpeg'));
    if (!blob) return null;
    // Checked on the tile itself: no-data white touching the border means a
    // coverage edge the 25 m mask missed (or an empty answer).
    const cleared = knockOutVhrNoData((await readVhrPixels(blob, px)).image);
    if (cleared === 0) return { blob, type: 'image/jpeg' };
    if (cleared === px * px) return null;
    plan[0] = { layer: plan[0].layer, coverage: 'partial' };
  }

  // Partial coverage: lossless PNGs whose border-connected no-data white is
  // cleared, lowest priority painted first. A fully covered layer (always the
  // last of the plan) comes as JPEG.
  const blobs = await Promise.all(plan.map(({ layer, coverage }) => fetchVhrImage(
    buildVhrWmsUrl(layer.id, z, x, y, px, coverage === 'full' ? 'jpeg' : 'png'),
  )));
  const out = new OffscreenCanvas(px, px);
  const outCtx = out.getContext('2d');
  let painted = 0;
  for (let i = plan.length - 1; i >= 0; i--) {
    if (!blobs[i]) continue;
    const { canvas, ctx, image } = await readVhrPixels(blobs[i], px);
    const cleared = knockOutVhrNoData(image);
    if (cleared === px * px) continue;
    if (cleared > 0) ctx.putImageData(image, 0, 0);
    outCtx.drawImage(canvas, 0, 0);
    painted++;
  }
  if (painted === 0) return null;
  return { blob: await out.convertToBlob({ type: 'image/png' }), type: 'image/png' };
}

// ── Request handler ─────────────────────────────────────────────────────

const vhrInflight = new Map();
const VHR_HOT_CACHE = new Map();

function vhrHotGet(key) {
  const entry = VHR_HOT_CACHE.get(key);
  if (!entry) return null;
  VHR_HOT_CACHE.delete(key);
  VHR_HOT_CACHE.set(key, entry);
  return entry;
}

function vhrHotPut(key, entry) {
  if (VHR_HOT_CACHE.has(key)) VHR_HOT_CACHE.delete(key);
  VHR_HOT_CACHE.set(key, entry);
  if (VHR_HOT_CACHE.size > VHR_HOT_CACHE_MAX) {
    VHR_HOT_CACHE.delete(VHR_HOT_CACHE.keys().next().value);
  }
}

function vhrHotClear() {
  VHR_HOT_CACHE.clear();
  vhrMaskMemory.clear();
}

let vhrPutsSinceTrim = 0;

// Keys come back in insertion order: the oldest tiles go first. Masks are
// tiny and kept.
async function maybeTrimVhrCache(cache) {
  if (++vhrPutsSinceTrim < VHR_DISK_TRIM_EVERY) return;
  vhrPutsSinceTrim = 0;
  const keys = (await cache.keys()).filter((req) => !req.url.includes('/vhr-mask/'));
  const excess = keys.length - VHR_DISK_MAX_ENTRIES;
  if (excess <= 0) return;
  const drop = excess + Math.floor(VHR_DISK_MAX_ENTRIES * 0.2);
  await Promise.all(keys.slice(0, drop).map((req) => cache.delete(req)));
}

function vhrImageResponse(entry) {
  return new Response(entry.blob, {
    status: 200,
    headers: { 'Content-Type': entry.type, 'Cache-Control': 'public, max-age=604800' },
  });
}

async function handleVhrRequest(z, x, y, retina) {
  if (z < VHR_MIN_Z || z > VHR_MAX_Z) return transparentResponse();
  const px = retina && z <= VHR_RETINA_MAX_Z ? VHR_TILE_SIZE * 2 : VHR_TILE_SIZE;
  const key = `/vhr-tiles/${z}/${x}/${y}?px=${px}`;

  const hot = vhrHotGet(key);
  if (hot) return vhrImageResponse(hot);

  let inflight = vhrInflight.get(key);
  if (!inflight) {
    inflight = (async () => {
      const cache = await caches.open(VHR_CACHE_NAME);
      const cacheKey = new Request(key);
      const cached = await cache.match(cacheKey);
      if (cached) {
        const entry = { blob: await cached.blob(), type: cached.headers.get('Content-Type') || 'image/jpeg' };
        vhrHotPut(key, entry);
        return entry;
      }
      let entry = null;
      try {
        entry = await buildVhrTile(z, x, y, px);
      } catch (err) {
        if (isSwDebug()) console.warn('[sw-dem][vhr] tile failed', z, x, y, err);
        entry = null;
      }
      if (!entry) return null;
      vhrHotPut(key, entry);
      cache.put(cacheKey, vhrImageResponse(entry)).then(() => maybeTrimVhrCache(cache)).catch(() => {});
      return entry;
    })().finally(() => vhrInflight.delete(key));
    vhrInflight.set(key, inflight);
  }

  const entry = await inflight;
  return entry ? vhrImageResponse(entry) : transparentResponse();
}
