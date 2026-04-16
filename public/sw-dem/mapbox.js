// ---------------------------------------------------------------------------
// Mapbox DEM tile fetching (passthrough for non-France areas)
// ---------------------------------------------------------------------------

// Mapbox Terrain DEM v1 native max zoom — beyond this, Mapbox returns
// overzoomed (interpolated) tiles that are progressively flatter.
const MAPBOX_DEM_MAXZOOM = 14;

async function fetchMapboxTile(z, x, y) {
  if (!mapboxToken) return null;

  // Clamp to Mapbox native maxzoom — requesting z15+ returns
  // server-side overzoomed tiles with less elevation detail.
  // Better to let Mapbox GL's GPU handle overzooming from z14 tiles.
  const fetchZ = Math.min(z, MAPBOX_DEM_MAXZOOM);
  const fetchX = fetchZ < z ? x >> (z - fetchZ) : x;
  const fetchY = fetchZ < z ? y >> (z - fetchZ) : y;
  const clamped = fetchZ < z;

  const url = `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/${fetchZ}/${fetchX}/${fetchY}@2x.pngraw?access_token=${mapboxToken}`;
  try {
    const t0 = performance.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const dt = (performance.now() - t0).toFixed(0);

    if (!res.ok) {
      console.warn(
        `[sw-dem][mapbox] %c FAIL %c ${z}/${x}/${y}${clamped ? ` (clamped→${fetchZ}/${fetchX}/${fetchY})` : ''} — HTTP ${res.status}, ${dt}ms`,
        'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', ''
      );
      return null;
    }

    const blob = await res.blob();
    const img = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });

    console.log(
      `[sw-dem][mapbox] %c OK %c ${z}/${x}/${y}${clamped ? ` (clamped→${fetchZ})` : ''} ${img.width}x${img.height} blob=${blob.size}B, ${dt}ms`,
      'background:#4CAF50;color:#fff;padding:2px 4px;border-radius:2px', ''
    );

    // If we clamped zoom, extract the sub-tile via overzoom
    if (clamped) {
      // Return the parent blob — the caller (handleDemRequest) will
      // overzoom it via overzoomDemTile if needed, OR we can do it here
      // for a single-step fetch+overzoom.
      const result = await overzoomDemTile(blob, fetchZ, fetchX, fetchY, z, x, y);
      img.close();
      if (result) {
        console.log(
          `[sw-dem][mapbox] %c OVERZOOM %c ${fetchZ}/${fetchX}/${fetchY}→${z}/${x}/${y} (mapbox clamped overzoom)`,
          'background:#FF9800;color:#fff;padding:2px 4px;border-radius:2px', ''
        );
      }
      return result;
    }

    if (img.width === DEM_TILE_SIZE && img.height === DEM_TILE_SIZE) {
      img.close();
      return blob;
    }
    // Resample to DEM_TILE_SIZE × DEM_TILE_SIZE using raw PNG encoder
    // to avoid sRGB gamma corruption of terrain-RGB elevation data.
    const canvas = new OffscreenCanvas(DEM_TILE_SIZE, DEM_TILE_SIZE);
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    ctx.drawImage(img, 0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE);
    img.close();
    const imageData = ctx.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE);
    return buildRawPng(DEM_TILE_SIZE, DEM_TILE_SIZE, imageData.data);
  } catch (err) {
    console.warn(`[sw-dem][mapbox] %c ERROR %c ${z}/${x}/${y} — ${err.message || err}`, 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '');
    return null;
  }
}
