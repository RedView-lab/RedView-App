// ---------------------------------------------------------------------------
// Orthophoto tiles — IGN ortho clipped to France border polygon
// ---------------------------------------------------------------------------

// France border polygon (loaded lazily from /france-border.json)
let francePoly = null;
let francePolyBBoxes = null;
let francePolyLoading = null;

async function ensureFrancePoly() {
  if (francePoly) return true;
  if (francePolyLoading) return francePolyLoading;
  francePolyLoading = (async () => {
    let response;
    const staticCache = await caches.open(STATIC_CACHE_NAME);
    response = await staticCache.match('/france-border.json');
    if (!response) {
      response = await fetch('/france-border.json');
      if (response.ok) staticCache.put('/france-border.json', response.clone());
    }
    return response.json();
  })()
    .then(geo => {
      francePoly = geo.coordinates;
      francePolyBBoxes = francePoly.map(polygon => {
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const ring of polygon) {
          for (const [lng, lat] of ring) {
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
        }
        return [minLng, minLat, maxLng, maxLat];
      });
      return true;
    })
    .catch(err => {
      console.error('[sw-dem] Failed to load France polygon:', err);
      francePoly = null;
      francePolyLoading = null;
      return false;
    });
  return francePolyLoading;
}

// ---------------------------------------------------------------------------
// Point-in-polygon (ray-casting)
// ---------------------------------------------------------------------------

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInFrance(lng, lat) {
  for (let p = 0; p < francePoly.length; p++) {
    const [bw, bs, be, bn] = francePolyBBoxes[p];
    if (lng < bw || lng > be || lat < bs || lat > bn) continue;
    const polygon = francePoly[p];
    if (pointInRing(lng, lat, polygon[0])) {
      let inHole = false;
      for (let h = 1; h < polygon.length; h++) {
        if (pointInRing(lng, lat, polygon[h])) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tile classification (inside / border / outside France polygon)
// ---------------------------------------------------------------------------

function classifyOrthoTile(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  let insideCount = 0;
  const N = 5;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const lng = b.west + (b.east - b.west) * (i + 0.5) / N;
      const lat = b.south + (b.north - b.south) * (j + 0.5) / N;
      if (pointInFrance(lng, lat)) insideCount++;
    }
  }
  const total = N * N;
  if (insideCount > 0 && insideCount < total) return 'border';
  if (hasPolyVertexInTile(b)) return 'border';
  return insideCount === total ? 'inside' : 'outside';
}

function hasPolyVertexInTile(b) {
  for (let p = 0; p < francePoly.length; p++) {
    const [bw, bs, be, bn] = francePolyBBoxes[p];
    if (be < b.west || bw > b.east || bn < b.south || bs > b.north) continue;
    for (const ring of francePoly[p]) {
      for (const [lng, lat] of ring) {
        if (lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Canvas masking — clip IGN tile to France border
// ---------------------------------------------------------------------------

function lngToTilePx(lng, z, tileX, size) {
  const n = 1 << z;
  return (((lng + 180) / 360) * n - tileX) * size;
}

function latToTilePy(lat, z, tileY, size) {
  const n = 1 << z;
  const latRad = lat * Math.PI / 180;
  const mercY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return (mercY - tileY) * size;
}

async function maskOrthoTile(imgBlob, z, tileX, tileY) {
  const img = await createImageBitmap(imgBlob);
  const canvas = new OffscreenCanvas(ORTHO_TILE_SIZE, ORTHO_TILE_SIZE);
  const ctx = canvas.getContext('2d');
  const b = mercatorTileBounds(z, tileX, tileY);

  ctx.beginPath();
  for (let p = 0; p < francePoly.length; p++) {
    const [bw, bs, be, bn] = francePolyBBoxes[p];
    if (be < b.west - 1 || bw > b.east + 1 || bn < b.south - 1 || bs > b.north + 1) continue;

    for (const ring of francePoly[p]) {
      let first = true;
      for (const [lng, lat] of ring) {
        const px = lngToTilePx(lng, z, tileX, ORTHO_TILE_SIZE);
        const py = latToTilePy(lat, z, tileY, ORTHO_TILE_SIZE);
        if (first) { ctx.moveTo(px, py); first = false; }
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
  }
  ctx.clip();
  ctx.drawImage(img, 0, 0, ORTHO_TILE_SIZE, ORTHO_TILE_SIZE);
  img.close(); // Release GPU memory
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob;
}

// ---------------------------------------------------------------------------
// Ortho tile URL builder & helpers
// ---------------------------------------------------------------------------

function buildOrthoTileURL(z, x, y) {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_ORTHO_LAYER}&STYLE=normal&FORMAT=image%2Fjpeg` +
    `&TILEMATRIXSET=${IGN_ORTHO_TILEMATRIXSET}` +
    `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`
  );
}

let _transparentBlob = null;
async function getTransparentBlob() {
  if (!_transparentBlob) {
    const c = new OffscreenCanvas(1, 1);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 1, 1);
    _transparentBlob = await c.convertToBlob({ type: 'image/png' });
  }
  return _transparentBlob;
}

async function transparentResponse() {
  const blob = await getTransparentBlob();
  return new Response(blob, {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

// ---------------------------------------------------------------------------
// Ortho request handler
// ---------------------------------------------------------------------------

async function handleOrthoRequest(z, x, y) {
  const cache = await caches.open(ORTHO_CACHE_NAME);
  const cacheKey = new Request(`/ortho-tiles/${z}/${x}/${y}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const polyLoaded = await ensureFrancePoly();

    if (!polyLoaded) {
      const url = buildOrthoTileURL(z, x, y);
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) return await transparentResponse();
      return new Response(await res.blob(), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' },
      });
    }

    if (!tileOverlapsFrance(z, x, y)) {
      return await transparentResponse();
    }

    const classification = classifyOrthoTile(z, x, y);

    if (classification === 'outside') {
      return await transparentResponse();
    }

    const url = buildOrthoTileURL(z, x, y);
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return await transparentResponse();

    // Validate that the IGN response is actually an image
    const contentType = (res.headers.get('Content-Type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      return await transparentResponse();
    }

    let response;
    if (classification === 'inside') {
      response = new Response(await res.blob(), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' },
      });
    } else {
      const imgBlob = await res.blob();
      const maskedPng = await maskOrthoTile(imgBlob, z, x, y);
      response = new Response(maskedPng, {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' },
      });
    }

    cache.put(cacheKey, response.clone());
    return response;
  } catch (err) {
    // Silently handle aborted requests (user panning/zooming cancels stale tiles)
    if (err && err.name === 'AbortError') {
      return await transparentResponse();
    }
    console.error('[sw-dem] Ortho error', z, x, y, err);
    return await transparentResponse();
  }
}
